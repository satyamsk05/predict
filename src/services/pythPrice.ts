import { logger } from '../utils/logger.js';

/**
 * Pyth Hermes price feed.
 *
 * Predict.fun settles BTC rounds against a Pyth price feed (see
 * `market.variantData.priceFeedId`), NOT against Binance spot. Using the same
 * oracle for the bot's trend/lock comparison keeps the displayed "UP/DOWN"
 * state in sync with what the market will actually settle on.
 *
 * Default feed id: Pyth BTC/USD (the standard one across all Pyth chains).
 * Override with PYTH_FEED_ID if Predict.fun uses a different feed.
 */
const DEFAULT_BTC_USD_FEED =
  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

const HERMES_URL =
  process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network';
const FEED_ID = (process.env.PYTH_FEED_ID || DEFAULT_BTC_USD_FEED).replace(/^0x/, '');

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
    this.started = true;
    void this.poll();
  }

  private async poll() {
    await this.fetchOnce();
    // 2s normally, back off to 10s when Hermes is unreachable so we don't
    // hammer a failing endpoint.
    const interval = this.consecutiveFailures > 3 ? 10_000 : 2_000;
    this.timer = setTimeout(() => void this.poll(), interval);
  }

  private async fetchOnce() {
    try {
      const res = await fetch(
        `${HERMES_URL}/v2/updates/price/latest?ids[]=0x${FEED_ID}`,
        { signal: AbortSignal.timeout(5_000) }
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
      if (this.consecutiveFailures <= 3 || this.consecutiveFailures % 30 === 0) {
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
