import { Wallet, ethers } from 'ethers';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getProvider } from '../../utils/provider.js';
import type {
  OpenOrder,
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

/**
 * fetch + rate-limit handling. The API answers 429 *without* processing the
 * request and without Retry-After; `RateLimit-Reset` (seconds) says when the
 * window reopens. Because a 429 request was never processed, retrying is safe
 * for POSTs too. The signal is rebuilt per attempt so each try gets a full timeout.
 */
const MAX_429_RETRIES = 2;
const MAX_429_WAIT_MS = 10_000;

async function apiFetch(
  url: string,
  init: Omit<RequestInit, 'signal'> & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...rest, signal: timeoutSignal(timeoutMs) });
    if (res.status !== 429 || attempt >= MAX_429_RETRIES) return res;
    const reset = Number(res.headers.get('ratelimit-reset'));
    const waitMs = Math.min(
      MAX_429_WAIT_MS,
      (Number.isFinite(reset) && reset > 0 ? reset * 1000 : 1000 * (attempt + 1)) +
        Math.floor(Math.random() * 300)
    );
    logger.warn({ url: url.split('?')[0], waitMs, attempt: attempt + 1 }, 'Predict.fun rate limit (429) — waiting');
    await new Promise((r) => setTimeout(r, waitMs));
  }
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
    const statusUpper = typeof outcomeStatus === 'string' ? outcomeStatus.toUpperCase() : '';
    const isResolved =
      raw.isResolved === true ||
      String(tradingStatus || '').toUpperCase() === 'RESOLVED' ||
      statusUpper === 'WON' ||
      statusUpper === 'LOST';

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
      outcomeStatus: statusUpper || undefined,
      isSettled: statusUpper === 'WON',
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
  /** Shared in-flight auth so concurrent callers don't each sign + POST /auth. */
  private jwtInFlight: Promise<string> | null = null;
  /** Optional Predict Account (smart wallet). Per-user instances are EOA-only. */
  private predictAccount: string | undefined;

  constructor(opts: { privateKey?: string; predictAccount?: string } = {}) {
    const privateKey = opts.privateKey !== undefined ? opts.privateKey : config.predictfun.privateKey;

    // Important: an explicit `predictAccount: undefined` must mean "no Predict
    // Account" (per-user EOA wallets). Checking `!== undefined` here used to
    // silently inherit the owner's smart wallet for every member.
    const predictAccount = Object.prototype.hasOwnProperty.call(opts, 'predictAccount')
      ? opts.predictAccount
      : config.predictfun.predictAccount;
    this.predictAccount = (predictAccount || '').trim() || undefined;

    if (privateKey) {
      try {
        this.wallet = new Wallet(privateKey, getProvider());
      } catch (e) {
        logger.warn('Could not initialize wallet with provided private key');
      }
    }
  }

  /** Predict Account (smart wallet) used by this instance, if any. */
  public getPredictAccount(): string | undefined {
    return this.predictAccount;
  }

  public getWalletAddress(): string | null {
    return this.wallet ? this.wallet.address : null;
  }

  /**
   * The address that actually holds funds. With a Predict Account (smart wallet)
   * the EOA only signs — USDT/positions live on the deposit address.
   */
  public getEffectiveAddress(): string | null {
    return this.predictAccount || (this.wallet ? this.wallet.address : null);
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
  public getValidJwt(): Promise<string> {
    if (this.jwtToken && Date.now() < this.jwtExpiresAt - 60 * 60 * 1000) {
      return Promise.resolve(this.jwtToken);
    }

    if (Date.now() < this.authFailUntil) {
      return Promise.reject(
        new Error('Predict.fun auth temporarily paused after recent failure')
      );
    }

    if (!this.jwtInFlight) {
      this.jwtInFlight = this.authenticate().finally(() => {
        this.jwtInFlight = null;
      });
    }
    return this.jwtInFlight;
  }

  private async authenticate(): Promise<string> {
    if (!this.wallet) {
      throw new Error('PREDICTFUN_PRIVATE_KEY not configured or invalid');
    }

    if (!config.predictfun.apiKey && !config.predictfun.isTestnet) {
      throw new Error('PREDICTFUN_API_KEY is not configured');
    }

    try {
      logger.info('Authenticating with Predict.fun API to get JWT...');
      const msgRes = await apiFetch(`${config.predictfun.baseUrl}/auth/message`, {
        headers: this.apiHeaders(),
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

      if (this.predictAccount) {
        // The OrderBuilder that signs Predict Account messages lives on the
        // global signer (backed by the master wallet). A per-user EOA instance
        // must never take this branch — that would sign with the wrong key.
        if (this !== predictFunApi) {
          throw new Error('Predict Account auth is only supported by the global API instance');
        }
        const { predictSigner } = await import('./signer.js');
        await predictSigner.init();
        const builder = predictSigner.getOrderBuilder();
        if (!builder) {
          throw new Error('OrderBuilder required to sign Predict Account auth message');
        }
        signature = await builder.signPredictAccountMessage(message);
        signerAddress = this.predictAccount;
      } else {
        signature = await this.wallet.signMessage(message);
        signerAddress = this.wallet.address;
      }

      // API expects `signer`, NOT `address`
      const authRes = await apiFetch(`${config.predictfun.baseUrl}/auth`, {
        method: 'POST',
        headers: this.apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          signer: signerAddress,
          message,
          signature,
        }),
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

      const res = await apiFetch(url.toString(), {
        headers: this.apiHeaders(),
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

      const res = await apiFetch(url.toString(), {
        headers: this.apiHeaders(),
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
      const res = await apiFetch(`${config.predictfun.baseUrl}/markets/${encodeURIComponent(marketId)}`, {
        headers: this.apiHeaders(),
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
      const res = await apiFetch(
        `${config.predictfun.baseUrl}/markets/${encodeURIComponent(marketId)}/orderbook`,
        {
        headers: this.apiHeaders(),
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
   *
   * The documented query params are only `first` and `after` (cursor from the
   * previous response), so paging follows `cursor` and the resolved/open split
   * is applied client-side from the position's own status fields.
   */
  public async getPositions(opts?: { isResolved?: boolean }): Promise<PredictPosition[]> {
    const MAX_PAGES = 6;
    const PAGE = '100';

    const fetchAll = async (
      base: string,
      headers: Record<string, string>
    ): Promise<PredictPosition[]> => {
      const out: PredictPosition[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(base);
        url.searchParams.set('first', PAGE);
        if (after) url.searchParams.set('after', after);
        const res = await apiFetch(url.toString(), { headers });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`positions ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = (await res.json()) as { data?: any[]; cursor?: string };
        const rows = data.data || [];
        for (const r of rows) {
          const p = normalizePosition(r);
          if (p) out.push(p);
        }
        // Stop on the last page: no cursor, an unchanged cursor, or a short page.
        if (!data.cursor || data.cursor === after || rows.length === 0) break;
        after = data.cursor;
      }
      return out;
    };

    const select = (rows: PredictPosition[]) =>
      opts?.isResolved === undefined ? rows : rows.filter((p) => !!p.isResolved === opts.isResolved);

    try {
      const jwt = await this.getValidJwt();
      return select(
        await fetchAll(
          `${config.predictfun.baseUrl}/positions`,
          this.apiHeaders({ Authorization: `Bearer ${jwt}` })
        )
      );
    } catch (e) {
      // Public fallback by the *funding* address (no JWT)
      const address = this.getEffectiveAddress();
      if (address) {
        try {
          return select(
            await fetchAll(
              `${config.predictfun.baseUrl}/positions/${encodeURIComponent(address)}`,
              this.apiHeaders()
            )
          );
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
   * Resting orders of this wallet (`GET /orders`, default status OPEN).
   * Needs the JWT; paged with the response `cursor` → `after`.
   */
  public async getOpenOrders(): Promise<OpenOrder[]> {
    const jwt = await this.getValidJwt();
    const out: OpenOrder[] = [];
    let after: string | undefined;
    for (let page = 0; page < 3; page++) {
      const url = new URL(`${config.predictfun.baseUrl}/orders`);
      url.searchParams.set('first', '100');
      url.searchParams.set('status', 'OPEN');
      if (after) url.searchParams.set('after', after);
      const res = await apiFetch(url.toString(), {
        headers: this.apiHeaders({ Authorization: `Bearer ${jwt}` }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`orders ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { data?: any[]; cursor?: string };
      for (const r of data.data || []) {
        if (!r?.id) continue;
        const sideRaw = r.order?.side;
        out.push({
          id: String(r.id),
          hash: r.order?.hash ? String(r.order.hash) : undefined,
          marketId: r.marketId != null ? String(r.marketId) : undefined,
          tokenId: r.order?.tokenId ? String(r.order.tokenId) : undefined,
          side: sideRaw === 1 || sideRaw === '1' ? 'SELL' : 'BUY',
          shares: parseShares(r.amount),
          filledShares: parseShares(r.amountFilled),
          makerAmount: r.order?.makerAmount ? String(r.order.makerAmount) : undefined,
          takerAmount: r.order?.takerAmount ? String(r.order.takerAmount) : undefined,
          status: String(r.status || 'OPEN').toUpperCase(),
          raw: r,
        });
      }
      if (!data.cursor || data.cursor === after || !(data.data || []).length) break;
      after = data.cursor;
    }
    return out;
  }

  /**
   * Take orders off the book (`POST /orders/remove`, max 100 ids). This is
   * off-chain only (free, no gas). `rejected` = still inside the market's
   * removal lock window; `noop` = already filled/removed/cancelled.
   */
  public async removeOrders(
    ids: string[]
  ): Promise<{ success: boolean; removed: string[]; noop: string[]; rejected: string[]; error?: string }> {
    const empty = { removed: [], noop: [], rejected: [] } as {
      removed: string[];
      noop: string[];
      rejected: string[];
    };
    if (ids.length === 0) return { success: true, ...empty };
    try {
      const jwt = await this.getValidJwt();
      const res = await apiFetch(`${config.predictfun.baseUrl}/orders/remove`, {
        method: 'POST',
        headers: this.apiHeaders({
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        }),
        body: JSON.stringify({ data: { ids: ids.slice(0, 100) } }),
        timeoutMs: 20_000,
      });
      const text = await res.text();
      let body: any = {};
      try {
        body = JSON.parse(text);
      } catch {
        // non-JSON
      }
      if (!res.ok || body.success === false) {
        return {
          success: false,
          ...empty,
          error: body.message || body.error || `HTTP ${res.status}: ${text.slice(0, 160)}`,
        };
      }
      return {
        success: true,
        removed: Array.isArray(body.removed) ? body.removed.map(String) : [],
        noop: Array.isArray(body.noop) ? body.noop.map(String) : [],
        rejected: Array.isArray(body.rejected) ? body.rejected.map(String) : [],
      };
    } catch (e: any) {
      return { success: false, ...empty, error: e?.message || String(e) };
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

      // Gas always sits on the signing EOA; funds (USDT) may sit on the
      // Predict Account. Report the EOA's BNB: that is what pays for gas.
      const fundingAddress = this.getEffectiveAddress() || this.wallet.address;
      const bnbBalWei = await provider.getBalance(this.wallet.address);
      const bnb = parseFloat(ethers.formatEther(bnbBalWei));

      // Mainnet USDT / Testnet may differ — keep mainnet default
      const usdtAddress = config.predictfun.isTestnet
        ? '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd' // common BSC testnet USDT
        : '0x55d398326f99059fF775485246999027B3197955';
      const erc20Abi = [
        'function balanceOf(address owner) view returns (uint256)',
        'function decimals() view returns (uint8)',
      ];
      const usdtContract = new ethers.Contract(usdtAddress, erc20Abi, provider);
      // A failed balanceOf MUST propagate (-> ok:false). Swallowing it into 0n
      // made a rate-limited RPC look like an empty wallet: the deposit watcher
      // then re-announced the whole balance as a fresh "deposit" on recovery.
      // Only `decimals` may fall back (USDT on BSC is 18).
      const [usdtBalRaw, decimals] = await Promise.all([
        usdtContract.balanceOf(fundingAddress),
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
      apiFetch(`${config.predictfun.baseUrl}/orders`, {
        method: 'POST',
        headers: this.apiHeaders({
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        }),
        body: JSON.stringify(payload, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        ),
        timeoutMs: 20_000,
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

export { PredictFunApi };
export const predictFunApi = new PredictFunApi();
