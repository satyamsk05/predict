import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Chainlink BTC/USD aggregator on BNB Smart Chain.
 *
 * Predict.fun's 5m BTC markets settle against the Chainlink BTC/USD feed
 * (verified by community bots reading the same aggregator for "price-to-beat"
 * parity). This service polls that on-chain feed directly:
 *
 *   - free, no API key (one eth_call per poll)
 *   - settlement parity: the same number the round settles on
 *   - the aggregator updates on price deviation, typically every ~30-60s
 *
 * Binance spot stays the fallback while this feed is cold/unreachable.
 * Override the feed address with CHAINLINK_BTC_USD_FEED if Predict.fun
 * changes providers.
 */
const DEFAULT_CHAINLINK_BTC_USD = '0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf';

const FEED_ADDRESS = (process.env.CHAINLINK_BTC_USD_FEED || DEFAULT_CHAINLINK_BTC_USD) as string;

/** A price older than this is stale — report 0 so callers fall back to Binance. */
const STALE_AFTER_SEC = 90;
const POLL_INTERVAL_MS = 10_000;

class ChainlinkPriceService {
  private price: number = 0;
  private lastUpdatedAtSec: number = 0;
  private fetchedAt: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;
  private started = false;
  /** Lazily-created ethers Contract (typed as any: view-only, few fields used). */
  private contract: any = null;

  public start() {
    if (this.started) return;
    this.started = true;
    void this.poll();
  }

  private async poll() {
    await this.fetchOnce();
    // Back off to 60s when the RPC keeps failing; 10s normally.
    const interval = this.consecutiveFailures > 3 ? 60_000 : POLL_INTERVAL_MS;
    this.timer = setTimeout(() => void this.poll(), interval);
  }

  private async fetchOnce() {
    try {
      if (!this.contract) {
        const { ethers } = await import('ethers');
        const provider = new ethers.JsonRpcProvider(config.predictfun.rpcUrl);
        const abi = [
          'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
          'function decimals() view returns (uint8)',
        ];
        this.contract = new ethers.Contract(FEED_ADDRESS, abi, provider);
      }

      const [decimals, round] = await Promise.all([
        this.contract.decimals(),
        this.contract.latestRoundData(),
      ]);

      const value = Number(round.answer) / 10 ** Number(decimals);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid Chainlink price: ${round.answer}`);
      }

      this.price = value;
      this.lastUpdatedAtSec = Number(round.updatedAt);
      this.fetchedAt = Date.now();
      this.consecutiveFailures = 0;
    } catch (e: any) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures <= 2 || this.consecutiveFailures % 30 === 0) {
        logger.warn(
          { err: e?.message, failures: this.consecutiveFailures },
          'Chainlink price fetch failed (Binance fallback stays active)'
        );
      }
    }
  }

  /**
   * Fresh on-chain oracle price, or 0 when unavailable/stale.
   * Staleness is judged on the feed's own updatedAt timestamp, so a hung RPC
   * that returns old data is still caught.
   */
  public getPrice(): number {
    if (this.price <= 0) return 0;
    const nowSec = Math.floor(Date.now() / 1000);
    // If the feed itself hasn't updated recently AND we haven't polled
    // recently, treat as stale.
    if (nowSec - this.lastUpdatedAtSec > STALE_AFTER_SEC) return 0;
    if (Date.now() - this.fetchedAt > 5 * POLL_INTERVAL_MS) return 0;
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

export const chainlinkPriceService = new ChainlinkPriceService();
