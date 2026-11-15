import { Wallet, ethers } from 'ethers';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type {
  PredictMarket,
  PredictOrderbook,
  PredictPosition,
  PredictSeriesRound,
} from './types.js';

/** Every REST call is bounded so a hung socket can't stall the whole bot. */
const HTTP_TIMEOUT_MS = 15_000;

function timeoutSignal(ms = HTTP_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** API returns share amounts sometimes in wei, sometimes as decimal shares. */
function parseShares(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === 'string') {
    // A plain integer this large can only be wei (1 share = 1e18).
    if (/^\d+$/.test(raw) && raw.length >= 16) return weiToNumber(raw);
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof raw === 'bigint') return weiToNumber(raw);
  return 0;
}

function weiToNumber(value: string | number | bigint | undefined | null): number {
  if (value === undefined || value === null) return 0;
  try {
    return parseFloat(ethers.formatEther(BigInt(value.toString())));
  } catch {
    const n = parseFloat(String(value));
    return Number.isFinite(n) ? n : 0;
  }
}

function normalizePosition(raw: any): PredictPosition | null {
  // New API shape: { market, outcome, amount, averageBuyPriceUsd, ... }
  if (raw?.market && raw?.outcome) {
    const shares = parseShares(raw.amount);

    const outcomeStatus = raw.outcome?.status;
    const tradingStatus = raw.market?.tradingStatus || raw.market?.status;
    const isResolved =
      raw.isResolved === true ||
      tradingStatus === 'RESOLVED' ||
      outcomeStatus === 'WON' ||
      outcomeStatus === 'LOST';

    return {
      marketId: String(raw.market.id),
      marketTitle: raw.market.title || raw.market.question,
      conditionId: raw.market.conditionId,
      slug: raw.market.slug != null ? String(raw.market.slug) : undefined,
      outcome: raw.outcome.name || String(raw.outcome.indexSet ?? ''),
      tokenId: String(raw.outcome.onChainId || raw.outcome.tokenId || ''),
      shares: Number.isFinite(shares) ? shares : 0,
      avgEntryPrice: String(raw.averageBuyPriceUsd ?? raw.avgEntryPrice ?? '0'),
      currentPrice: raw.outcome?.bestBid?.price != null
        ? String(raw.outcome.bestBid.price)
        : raw.outcome?.bestAsk?.price != null
        ? String(raw.outcome.bestAsk.price)
        : undefined,
      isNegRisk: !!raw.market.isNegRisk,
      isYieldBearing: !!raw.market.isYieldBearing,
      indexSet: raw.outcome.indexSet != null ? String(raw.outcome.indexSet) : undefined,
      outcomeStatus: typeof outcomeStatus === 'string' ? outcomeStatus : undefined,
      isSettled: outcomeStatus === 'WON',
      isResolved,
      pnlUsd: raw.pnlUsd != null ? String(raw.pnlUsd) : undefined,
      valueUsd: raw.valueUsd != null ? String(raw.valueUsd) : undefined,
    };
  }

  // Legacy flat shape fallback
  if (raw?.marketId) {
    return {
      marketId: String(raw.marketId),
      marketTitle: raw.marketTitle,
      conditionId: raw.conditionId,
      slug: raw.slug != null ? String(raw.slug) : undefined,
      outcome: raw.outcome,
      tokenId: String(raw.tokenId || ''),
      shares: parseShares(raw.shares),
      avgEntryPrice: String(raw.avgEntryPrice ?? '0'),
      currentPrice: raw.currentPrice != null ? String(raw.currentPrice) : undefined,
      isNegRisk: !!raw.isNegRisk,
      isYieldBearing: !!raw.isYieldBearing,
      indexSet: raw.indexSet != null ? String(raw.indexSet) : undefined,
      outcomeStatus: typeof raw.status === 'string' ? raw.status : undefined,
      isSettled: !!raw.isSettled,
      isResolved: !!raw.isResolved || !!raw.isSettled,
      pnlUsd: raw.pnlUsd != null ? String(raw.pnlUsd) : undefined,
    };
  }

  return null;
}

class PredictFunApi {
  private jwtToken: string | null = null;
  private jwtExpiresAt: number = 0;
  private wallet: Wallet | null = null;
  private authFailUntil: number = 0;

  constructor() {
    if (config.predictfun.privateKey) {
      try {
        const provider = new ethers.JsonRpcProvider(config.predictfun.rpcUrl);
        // Public RPCs rate-limit hard; keep polling reasonable (override with
        // RPC_POLLING_MS, e.g. 300 for a private endpoint).
        const pollingMs = Number(process.env.RPC_POLLING_MS || 1000);
        (provider as any).pollingInterval =
          Number.isFinite(pollingMs) && pollingMs >= 100 ? Math.round(pollingMs) : 1000;
        this.wallet = new Wallet(config.predictfun.privateKey, provider);
      } catch (e) {
        logger.warn('Could not initialize wallet with provided private key');
      }
    }
  }

  public getWalletAddress(): string | null {
    return this.wallet ? this.wallet.address : null;
  }

  /**
   * The address that actually holds funds. With a Predict Account (smart wallet)
   * the EOA only signs — USDT/positions live on the deposit address.
   */
  public getEffectiveAddress(): string | null {
    return config.predictfun.predictAccount || (this.wallet ? this.wallet.address : null);
  }

  public getWallet(): Wallet | null {
    return this.wallet;
  }

  private apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    // The testnet API has no API-key auth and rejects mainnet keys with 401.
    if (config.predictfun.apiKey && !config.predictfun.isTestnet) {
      headers['x-api-key'] = config.predictfun.apiKey;
    }
    return headers;
  }

  /**
   * Fetch and renew JWT if needed (valid for 24 hours, refreshed at 23 hours)
   */
  public async getValidJwt(): Promise<string> {
    if (this.jwtToken && Date.now() < this.jwtExpiresAt - 60 * 60 * 1000) {
      return this.jwtToken;
    }

    if (Date.now() < this.authFailUntil) {
      throw new Error('Predict.fun auth temporarily paused after recent failure');
    }

    if (!this.wallet) {
      throw new Error('PREDICTFUN_PRIVATE_KEY not configured or invalid');
    }

    if (!config.predictfun.apiKey && !config.predictfun.isTestnet) {
      throw new Error('PREDICTFUN_API_KEY is not configured');
    }

    try {
      logger.info('Authenticating with Predict.fun API to get JWT...');
      const msgRes = await fetch(`${config.predictfun.baseUrl}/auth/message`, {
        headers: this.apiHeaders(),
        signal: timeoutSignal(),
      });

      if (!msgRes.ok) {
        const body = await msgRes.text();
        throw new Error(`Failed to get auth message: ${msgRes.status} ${body.slice(0, 200)}`);
      }

      const msgData = (await msgRes.json()) as { data?: { message?: string } };
      const message = msgData.data?.message;
      if (!message) {
        throw new Error('Invalid message payload from /auth/message');
      }

      // Predict Account (smart wallet) vs EOA
      let signature: string;
      let signerAddress: string;

      if (config.predictfun.predictAccount) {
        const { predictSigner } = await import('./signer.js');
        await predictSigner.init();
        const builder = predictSigner.getOrderBuilder();
        if (!builder) {
          throw new Error('OrderBuilder required to sign Predict Account auth message');
        }
        signature = await builder.signPredictAccountMessage(message);
        signerAddress = config.predictfun.predictAccount;
      } else {
        signature = await this.wallet.signMessage(message);
        signerAddress = this.wallet.address;
      }

      // API expects `signer`, NOT `address`
      const authRes = await fetch(`${config.predictfun.baseUrl}/auth`, {
        method: 'POST',
        headers: this.apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          signer: signerAddress,
          message,
          signature,
        }),
        signal: timeoutSignal(),
      });

      const authText = await authRes.text();
      let authData: { data?: { token?: string }; message?: string; error?: string } = {};
      try {
        authData = JSON.parse(authText);
      } catch {
        // keep raw
      }

      if (!authRes.ok) {
        throw new Error(
          `Failed to exchange token: ${authRes.status} ${authData.message || authData.error || authText.slice(0, 200)}`
        );
      }

      const token = authData.data?.token;
      if (!token) {
        throw new Error('No JWT token returned in /auth response');
      }

      this.jwtToken = token;
      this.jwtExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
      this.authFailUntil = 0;
      logger.info('Successfully authenticated with Predict.fun (JWT acquired)');
      return token;
    } catch (error) {
      // Back off 2 minutes to avoid spamming failed auth every 30s
      this.authFailUntil = Date.now() + 2 * 60 * 1000;
      logger.error({ err: error }, 'Predict.fun authentication failed');
      throw error;
    }
  }

  /**
   * Active BTC 5m round via series API (correct source for startsAt/endsAt/lock price)
   */
  public async getActiveBtc5mRound(): Promise<{
    round: PredictSeriesRound;
    market: PredictMarket;
  } | null> {
    try {
      const slug = config.predictfun.seriesSlug;
      const url = new URL(`${config.predictfun.baseUrl}/series/${slug}/rounds`);
      url.searchParams.set('status', 'ACTIVE');
      url.searchParams.set('first', '5');

      const res = await fetch(url.toString(), {
        headers: this.apiHeaders(),
        signal: timeoutSignal(),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`series rounds failed: ${res.status} ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as { data?: PredictSeriesRound[] };
      const rounds = data.data || [];
      const now = Date.now();

      // Never return an already-expired round: prefer the live window, otherwise
      // the earliest round that has not ended yet.
      const notEnded = rounds.filter((r) => new Date(r.endsAt).getTime() > now);
      const live =
        notEnded.find((r) => new Date(r.startsAt).getTime() <= now) ||
        notEnded.sort(
          (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
        )[0];

      if (!live || !live.markets?.length) return null;

      const market = live.markets[0];
      return { round: live, market };
    } catch (e) {
      logger.error({ err: e }, 'Error fetching active BTC 5m series round');
      return null;
    }
  }

  /**
   * Search and retrieve markets from Predict.fun
   */
  public async getMarkets(query?: string, first = 50): Promise<PredictMarket[]> {
    try {
      const url = new URL(`${config.predictfun.baseUrl}/markets`);
      url.searchParams.set('first', first.toString());
      url.searchParams.set('includeStats', 'true');
      url.searchParams.set('status', 'OPEN');
      if (query) {
        url.searchParams.set('query', query);
      }

      const res = await fetch(url.toString(), {
        headers: this.apiHeaders(),
        signal: timeoutSignal(),
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch markets: ${res.statusText}`);
      }

      const data = (await res.json()) as { data?: PredictMarket[] | { markets?: PredictMarket[] } };
      if (Array.isArray(data.data)) {
        return data.data;
      }
      if (data.data && Array.isArray((data.data as { markets?: PredictMarket[] }).markets)) {
        return (data.data as { markets: PredictMarket[] }).markets;
      }
      return [];
    } catch (e) {
      logger.error({ err: e }, 'Error fetching markets');
      return [];
    }
  }

  /**
   * Get single market by ID
   */
  public async getMarket(marketId: string): Promise<PredictMarket | null> {
    try {
      const res = await fetch(`${config.predictfun.baseUrl}/markets/${marketId}`, {
        headers: this.apiHeaders(),
        signal: timeoutSignal(),
      });

      if (!res.ok) return null;
      const data = (await res.json()) as { data?: PredictMarket };
      return data.data || null;
    } catch (e) {
      logger.error({ err: e, marketId }, 'Error getting market details');
      return null;
    }
  }

  /**
   * Get orderbook for market
   */
  public async getOrderbook(marketId: string): Promise<PredictOrderbook | null> {
    try {
      const res = await fetch(`${config.predictfun.baseUrl}/markets/${marketId}/orderbook`, {
        headers: this.apiHeaders(),
        signal: timeoutSignal(),
      });

      if (!res.ok) return null;
      const data = (await res.json()) as { data?: PredictOrderbook };
      return data.data || null;
    } catch {
      return null;
    }
  }

  /**
   * Get user positions (JWT). Falls back to public-by-address if auth fails.
   */
  public async getPositions(opts?: { isResolved?: boolean }): Promise<PredictPosition[]> {
    const mapList = (rows: any[]): PredictPosition[] =>
      rows.map(normalizePosition).filter((p): p is PredictPosition => !!p);

    try {
      const jwt = await this.getValidJwt();
      const url = new URL(`${config.predictfun.baseUrl}/positions`);
      url.searchParams.set('first', '50');
      if (opts?.isResolved !== undefined) {
        url.searchParams.set('isResolved', String(opts.isResolved));
      }

      const res = await fetch(url.toString(), {
        headers: this.apiHeaders({ Authorization: `Bearer ${jwt}` }),
        signal: timeoutSignal(),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`positions ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { data?: any[] };
      return mapList(data.data || []);
    } catch (e) {
      // Public fallback by the *funding* address (no JWT)
      const address = this.getEffectiveAddress();
      if (address) {
        try {
          const url = new URL(`${config.predictfun.baseUrl}/positions/${address}`);
          url.searchParams.set('first', '50');
          if (opts?.isResolved !== undefined) {
            url.searchParams.set('isResolved', String(opts.isResolved));
          }
          const res = await fetch(url.toString(), {
            headers: this.apiHeaders(),
            signal: timeoutSignal(),
          });
          if (res.ok) {
            const data = (await res.json()) as { data?: any[] };
            return mapList(data.data || []);
          }
        } catch {
          // fall through to the real error
        }
      }
      logger.error({ err: e }, 'Failed to fetch user positions');
      // Do not hide auth/network errors behind an empty list — callers need to know.
      throw e;
    }
  }

  /**
   * Get user USDT balance on BNB Chain.
   * `ok` distinguishes "genuinely zero" from "RPC failed" — callers must not
   * treat a failed fetch as an empty wallet.
   */
  public async getBalance(): Promise<{ usdt: number; bnb: number; ok: boolean }> {
    if (!this.wallet) {
      return { usdt: 0, bnb: 0, ok: false };
    }

    try {
      const provider = this.wallet.provider;
      if (!provider) return { usdt: 0, bnb: 0, ok: false };

      // Gas always sits on the signing EOA; funds may sit on the Predict Account.
      const fundingAddress = this.getEffectiveAddress() || this.wallet.address;
      const [bnbBalWei, eoaBalWei] = await Promise.all([
        provider.getBalance(this.wallet.address),
        fundingAddress === this.wallet.address
          ? Promise.resolve(null)
          : provider.getBalance(fundingAddress).catch(() => null),
      ]);
      const bnb = parseFloat(ethers.formatEther(eoaBalWei ?? bnbBalWei));

      // Mainnet USDT / Testnet may differ — keep mainnet default
      const usdtAddress = config.predictfun.isTestnet
        ? '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd' // common BSC testnet USDT
        : '0x55d398326f99059fF775485246999027B3197955';
      const erc20Abi = [
        'function balanceOf(address owner) view returns (uint256)',
        'function decimals() view returns (uint8)',
      ];
      const usdtContract = new ethers.Contract(usdtAddress, erc20Abi, provider);
      const [usdtBalRaw, decimals] = await Promise.all([
        usdtContract.balanceOf(fundingAddress).catch(() => 0n),
        usdtContract.decimals().catch(() => 18),
      ]);

      const usdt = parseFloat(ethers.formatUnits(usdtBalRaw, decimals));
      return { usdt, bnb, ok: true };
    } catch (e) {
      logger.error({ err: e }, 'Failed to fetch on-chain balances');
      return { usdt: 0, bnb: 0, ok: false };
    }
  }

  /**
   * Submit an order to Predict.fun
   */
  public async postOrder(payload: any): Promise<{ success: boolean; orderId?: string; orderHash?: string; error?: string }> {
    const send = async (jwt: string) =>
      fetch(`${config.predictfun.baseUrl}/orders`, {
        method: 'POST',
        headers: this.apiHeaders({
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        }),
        body: JSON.stringify(payload, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        ),
        signal: timeoutSignal(20_000),
      });

    try {
      let res = await send(await this.getValidJwt());

      // Cached JWT can be revoked server-side. Drop it and retry exactly once.
      if (res.status === 401) {
        this.jwtToken = null;
        this.jwtExpiresAt = 0;
        res = await send(await this.getValidJwt());
      }

      const text = await res.text();
      let body: {
        success?: boolean;
        data?: { orderId?: string; orderHash?: string; hash?: string };
        message?: string;
        error?: string;
      } = {};
      try {
        body = JSON.parse(text);
      } catch {
        // non-JSON error page
      }

      if (!res.ok || body.success === false) {
        return {
          success: false,
          error:
            body.message ||
            body.error ||
            `HTTP ${res.status}: ${body ? text.slice(0, 200) : res.statusText}`,
        };
      }

      return {
        success: true,
        orderId: body.data?.orderId,
        orderHash: body.data?.orderHash || body.data?.hash,
      };
    } catch (e: any) {
      return {
        success: false,
        error: e.message || String(e),
      };
    }
  }
}

export const predictFunApi = new PredictFunApi();
