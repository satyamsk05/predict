import { logger } from '../utils/logger.js';

/**
 * Pyth oracle price — settlement parity with Predict.fun rounds.
 *
 * Predict.fun settles BTC rounds against a Pyth price feed (see
 * `market.variantData.priceFeedId`), NOT against Binance spot.
 *
 * IMPORTANT (late 2026): Pyth's Hermes price-update endpoints now require an
 * API key (HTTP 401 without one). Get a free key and set PYTH_API_KEY —
 * the bot then polls the documented endpoint with a Bearer token. Without a
 * key the service stays dormant and the bot uses the Binance fallback.
 *
 *   1. https://dashboard.pyth.network  → get a free API key
 *   2. .env: PYTH_API_KEY=your_key
 *
 * Feed override: PYTH_FEED_ID (default is the standard Pyth BTC/USD feed).
 */
const DEFAULT_BTC_USD_FEED =
  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

/** Documented Hermes-compatible endpoint for API-key access. */
const DEFAULT_HERMES_URL = 'https://pyth.dourolabs.app/hermes';
const FEED_ID = (process.env.PYTH_FEED_ID || DEFAULT_BTC_USD_FEED).replace(/^0x/, '');
const HERMES_URL = (process.env.PYTH_HERMES_URL || DEFAULT_HERMES_URL).replace(/\/$/, '');
const API_KEY = (process.env.PYTH_API_KEY || '').trim();

/** A price older than this is considered stale and reported as unavailable. */
const STALE_AFTER_MS = 15_000;

class PythPriceService {
  private price: number = 0;
  private lastUpdated: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;
  private started = false;

  public start() {
    if (this.started) return;
    if (!API_KEY) {
      logger.info('PYTH_API_KEY not set — Pyth oracle disabled, using Binance price (set a free key from dashboard.pyth.network for settlement parity)');
      return;
    }
    this.started = true;
    void this.poll();
  }

  private async poll() {
    await this.fetchOnce();
    // 2s normally, back off to 10s when the endpoint misbehaves.
    const interval = this.consecutiveFailures > 3 ? 10_000 : 2_000;
    this.timer = setTimeout(() => void this.poll(), interval);
  }

  private async fetchOnce() {
    try {
      const res = await fetch(
        `${HERMES_URL}/v2/updates/price/latest?ids[]=0x${FEED_ID}`,
        {
          headers: { Authorization: `Bearer ${API_KEY}` },
          signal: AbortSignal.timeout(5_000),
        }
      );
      if (!res.ok) throw new Error(`Hermes HTTP ${res.status}`);

      const data = (await res.json()) as {
        parsed?: Array<{ price?: { price?: string; expo?: number } }>;
      };
      const p = data.parsed?.[0]?.price;
      if (!p || p.price == null || p.expo == null) {
        throw new Error('Unexpected Hermes payload');
      }

      const value = Number(p.price) * 10 ** p.expo;
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid Pyth price: ${p.price}e${p.expo}`);
      }

      this.price = value;
      this.lastUpdated = Date.now();
      this.consecutiveFailures = 0;
    } catch (e: any) {
      this.consecutiveFailures++;
      // Log the first few, then every 30th — no spam.
      if (this.consecutiveFailures <= 2 || this.consecutiveFailures % 30 === 0) {
        logger.warn(
          { err: e?.message, failures: this.consecutiveFailures },
          'Pyth price fetch failed (Binance fallback stays active)'
        );
      }
    }
  }

  /** Fresh oracle price, or 0 when unavailable/stale. */
  public getPrice(): number {
    if (Date.now() - this.lastUpdated > STALE_AFTER_MS) return 0;
    return this.price;
  }

  public isHealthy(): boolean {
    return this.getPrice() > 0;
  }

  public stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.started = false;
  }
}

export const pythPriceService = new PythPriceService();
