import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { btcPriceService } from './btcPrice.js';
import { predictFunApi } from '../exchanges/predictfun/api.js';
import { outcomeBuyPrice, type PredictMarket } from '../exchanges/predictfun/types.js';

export interface ActiveRoundState {
  marketId: string;
  title: string;
  roundNumber?: number;
  startsAt: number;
  endsAt: number;
  secondsRemaining: number;
  lockPrice: number;
  currentPrice: number;
  priceDiff: number;
  currentTrend: 'UP' | 'DOWN' | 'EQUAL';
  upPrice: number;
  downPrice: number;
  isLocked: boolean;
  rawMarket?: PredictMarket;
  seriesSlug?: string;
  roundSlug?: string;
}

function findOutcome(market: PredictMarket, side: 'UP' | 'DOWN') {
  const want = side === 'UP' ? ['up', 'yes'] : ['down', 'no'];
  const byName = market.outcomes?.find((o) => want.includes((o.name || '').toLowerCase()));
  if (byName) return byName;
  // indexSet 1 = first outcome (Up/Yes), 2 = second (Down/No)
  return market.outcomes?.find((o) => o.indexSet === (side === 'UP' ? 1 : 2));
}

class RoundWatcher {
  private currentRound: ActiveRoundState | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private listeners: Array<(round: ActiveRoundState) => void> = [];
  private refreshing = false;
  private lastOddsSyncAt = 0;
  private lastRefreshAttempt = 0;
  private refreshBackoffMs = 0;
  private consecutiveRefreshFailures = 0;

  constructor() {
    this.refreshRound();
    this.checkInterval = setInterval(() => this.tick(), 1000);
  }

  public onRoundUpdate(callback: (round: ActiveRoundState) => void) {
    this.listeners.push(callback);
  }

  private notify() {
    if (!this.currentRound) return;
    const round = this.currentRound;
    for (const listener of this.listeners) {
      try {
        const result = listener(round) as unknown;
        // Listeners may be async; don't let a rejection escape unhandled.
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((e) =>
            logger.warn({ err: e }, 'Round update listener failed')
          );
        }
      } catch (e) {
        logger.warn({ err: e }, 'Round update listener threw');
      }
    }
  }

  private async tick() {
    const now = Date.now();

    // If no round or current round has ended, refresh from API.
    // Throttled: without an active round the old code fired one request per
    // second forever during an API outage.
    if (!this.currentRound || now >= this.currentRound.endsAt) {
      const waitMs = Math.max(1000, this.refreshBackoffMs);
      if (now - this.lastRefreshAttempt >= waitMs) {
        await this.refreshRound();
      }
      return;
    }

    // Update real-time metrics. Before the Binance socket connects the price is
    // 0 — never overwrite the last known price with 0.
    const livePrice = btcPriceService.getPrice();
    const currentPrice =
      livePrice > 0 ? livePrice : this.currentRound.currentPrice;
    const secondsRemaining = Math.max(0, Math.floor((this.currentRound.endsAt - now) / 1000));
    const isLocked = secondsRemaining <= config.trading.lockGuardSeconds;

    const lockPrice = this.currentRound.lockPrice || currentPrice;
    const diff = lockPrice > 0 && currentPrice > 0 ? currentPrice - lockPrice : 0;
    const trend = diff > 0 ? 'UP' : diff < 0 ? 'DOWN' : 'EQUAL';

    this.currentRound = {
      ...this.currentRound,
      currentPrice,
      priceDiff: diff,
      currentTrend: trend,
      secondsRemaining,
      isLocked,
    };

    // Re-check API every 15s for odds, and faster while the lock price is still
    // unknown (right after a round starts the API has no startPrice yet).
    const lockPending = this.currentRound.lockPrice <= 0;
    if (
      now - this.lastOddsSyncAt >= 15000 ||
      (lockPending && now - this.lastOddsSyncAt >= 3000)
    ) {
      this.lastOddsSyncAt = now;
      void this.syncMarketOdds();
    }

    this.notify();
  }

  public async refreshRound() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.lastRefreshAttempt = Date.now();
    try {
      const active = await predictFunApi.getActiveBtc5mRound();
      const now = Date.now();
      const currentBtcPrice = btcPriceService.getPrice();

      if (active) {
        const { round, market } = active;
        const startsAt = new Date(round.startsAt).getTime();
        const endsAt = new Date(round.endsAt).getTime();
        const secondsRemaining = Math.max(0, Math.floor((endsAt - now) / 1000));

        const upOutcome = findOutcome(market, 'UP');
        const downOutcome = findOutcome(market, 'DOWN');
        const upPrice = outcomeBuyPrice(upOutcome) ?? 0.5;
        const downPrice = outcomeBuyPrice(downOutcome) ?? 0.5;

        const startPrice =
          round.variantData?.startPrice ??
          market.variantData?.startPrice ??
          null;

        // Keep previous lock price if same market and API hasn't published startPrice yet
        const sameMarket =
          this.currentRound?.marketId === String(market.id) &&
          this.currentRound.lockPrice > 0;
        const lockPrice =
          typeof startPrice === 'number' && startPrice > 0
            ? startPrice
            : sameMarket
            ? this.currentRound!.lockPrice
            : currentBtcPrice || this.currentRound?.lockPrice || 0;

        this.currentRound = {
          marketId: String(market.id),
          title: market.question || market.title || round.title || 'BTC Up or Down 5m',
          startsAt,
          endsAt,
          secondsRemaining,
          lockPrice,
          currentPrice: currentBtcPrice || lockPrice,
          priceDiff: (currentBtcPrice || lockPrice) - lockPrice,
          currentTrend:
            currentBtcPrice > lockPrice ? 'UP' : currentBtcPrice < lockPrice ? 'DOWN' : 'EQUAL',
          upPrice,
          downPrice,
          isLocked: secondsRemaining <= config.trading.lockGuardSeconds,
          rawMarket: market,
          seriesSlug: round.seriesSlug || config.predictfun.seriesSlug,
          roundSlug: round.slug,
        };
        this.lastOddsSyncAt = Date.now();
        this.consecutiveRefreshFailures = 0;
        this.refreshBackoffMs = 0;
        // Pull startPrice/odds immediately instead of waiting 15s.
        void this.syncMarketOdds();
        logger.info(
          {
            marketId: this.currentRound.marketId,
            remaining: secondsRemaining,
            lockPrice,
            upPrice,
            downPrice,
            slug: round.slug,
          },
          'Synced active Predict.fun BTC 5M round'
        );
        this.notify();
        return;
      }

      // Synthetic fallback only if API has no active round yet
      const roundDurationMs = 5 * 60 * 1000;
      const currentSlot = Math.floor(now / roundDurationMs);
      const slotStart = currentSlot * roundDurationMs;
      const slotEnd = slotStart + roundDurationMs;
      const secondsRemaining = Math.max(0, Math.floor((slotEnd - now) / 1000));

      this.currentRound = {
        marketId: `btc-5m-${currentSlot}`,
        title: `BTC 5M Up or Down #${currentSlot % 10000} (waiting for API)`,
        roundNumber: currentSlot % 10000,
        startsAt: slotStart,
        endsAt: slotEnd,
        secondsRemaining,
        lockPrice: currentBtcPrice,
        currentPrice: currentBtcPrice,
        priceDiff: 0,
        currentTrend: 'EQUAL',
        upPrice: 0.5,
        downPrice: 0.5,
        isLocked: secondsRemaining <= config.trading.lockGuardSeconds,
      };
      logger.warn('No active series round — using synthetic placeholder (orders disabled)');
      this.consecutiveRefreshFailures = 0;
      this.refreshBackoffMs = 0;
      this.notify();
    } catch (e) {
      this.consecutiveRefreshFailures++;
      // 2s, 4s, 8s, 16s, capped at 30s
      this.refreshBackoffMs = Math.min(
        30_000,
        1000 * 2 ** Math.min(this.consecutiveRefreshFailures, 5)
      );
      logger.error(
        { err: e, retryInMs: this.refreshBackoffMs },
        'Error refreshing 5M BTC round'
      );
    } finally {
      this.refreshing = false;
    }
  }

  private async syncMarketOdds() {
    const round = this.currentRound;
    if (!round?.rawMarket) return;
    try {
      const updated = await predictFunApi.getMarket(round.marketId);
      if (updated?.outcomes?.length) {
        const up = findOutcome(updated, 'UP');
        const down = findOutcome(updated, 'DOWN');
        const upPrice = outcomeBuyPrice(up);
        const downPrice = outcomeBuyPrice(down);
        if (upPrice) round.upPrice = upPrice;
        if (downPrice) round.downPrice = downPrice;
        round.rawMarket = updated;

        const startPrice = updated.variantData?.startPrice;
        if (typeof startPrice === 'number' && startPrice > 0) {
          round.lockPrice = startPrice;
          round.priceDiff = round.currentPrice - round.lockPrice;
          round.currentTrend =
            round.priceDiff > 0 ? 'UP' : round.priceDiff < 0 ? 'DOWN' : 'EQUAL';
        }
      }
    } catch {
      // quiet
    }
  }

  public getCurrentRound(): ActiveRoundState | null {
    return this.currentRound;
  }
}

export const roundWatcher = new RoundWatcher();
