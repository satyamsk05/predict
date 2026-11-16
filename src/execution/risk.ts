import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { stateStore } from '../utils/store.js';
import { userRegistry } from '../users/registry.js';
import { sideOfOutcome } from '../exchanges/predictfun/types.js';

export interface TradeRecord {
  timestamp: number;
  marketId: string;
  outcome: 'UP' | 'DOWN';
  amountUsdt: number;
  price: number;
  orderId?: string;
  pnlUsd?: number;
  settled: boolean;
  /**
   * A placed limit order may never fill. Exposure/stats only count trades we
   * know are filled (or that were simulated in dry-run). Old records without
   * the flag are treated as filled for backward compatibility.
   */
  filled?: boolean;
  /** Set by the dry-run simulator so live settlements never touch them. */
  dryRun?: boolean;
  /** Telegram user id for per-member PnL attribution (multi-user mode). */
  userId?: number;
}

/** Max trades kept in memory + on disk (matches store.ts MAX_TRADES). */
const TRADE_HISTORY_MAX = 200;

export type DryRunResult = 'WON' | 'LOST' | 'REFUND';

class RiskManager {
  private dailyLossUsd: number = 0;
  private dailyTradesCount: number = 0;
  private consecutiveErrors: number = 0;
  private isTripped: boolean = false;
  private tripReason: string = '';
  /** UTC day index (days since epoch) — survives month/year rollovers. */
  private lastResetDay: number = Math.floor(Date.now() / 86_400_000);
  private tradeHistory: TradeRecord[] = [];
  /** `${marketId}|${outcome}` already counted, so polling can't double-count. */
  private settledKeys: Set<string> = new Set();
  /**
   * Per-member failed-order streaks. One member's failures (empty wallet, API
   * rejects) must pause THAT member — not trip the shared breaker for everyone.
   */
  private userFailures: Map<number, { count: number; cooldownUntil: number }> = new Map();

  constructor() {
    // Restore persisted state so a restart can't silently clear the loss limit.
    const saved = stateStore.get().risk;
    this.dailyLossUsd = saved.dailyLossUsd;
    this.dailyTradesCount = saved.dailyTradesCount;
    this.lastResetDay = saved.lastResetDay;
    this.isTripped = saved.isTripped;
    this.tripReason = saved.tripReason;
    this.tradeHistory = saved.trades;
    this.settledKeys = new Set(saved.settledKeys);

    if (this.isTripped) {
      logger.warn({ reason: this.tripReason }, 'Circuit breaker restored as TRIPPED');
    }

    // Handles the "bot was offline across midnight" case immediately.
    this.checkDayReset();

    // Check day reset periodically
    setInterval(() => this.checkDayReset(), 60000);
  }

  private persist() {
    stateStore.update((s) => {
      s.risk = {
        dailyLossUsd: this.dailyLossUsd,
        dailyTradesCount: this.dailyTradesCount,
        lastResetDay: this.lastResetDay,
        isTripped: this.isTripped,
        tripReason: this.tripReason,
        trades: this.tradeHistory.slice(-TRADE_HISTORY_MAX),
        settledKeys: [...this.settledKeys].slice(-1000),
      };
    });
  }

  private checkDayReset() {
    const currentDay = Math.floor(Date.now() / 86_400_000);
    if (currentDay !== this.lastResetDay) {
      this.dailyLossUsd = 0;
      this.dailyTradesCount = 0;
      this.consecutiveErrors = 0;
      this.isTripped = false;
      this.tripReason = '';
      this.lastResetDay = currentDay;
      logger.info('Daily risk limits reset for new UTC day');
      this.persist();
    }
  }

  public canTrade(amountUsdt: number, userId?: number): { allowed: boolean; reason?: string } {
    if (this.isTripped) {
      return {
        allowed: false,
        reason: `Circuit Breaker is TRIPPED: ${this.tripReason}`,
      };
    }

    // NaN passes every `>` / `<=` comparison below, so it must be rejected first.
    if (!Number.isFinite(amountUsdt)) {
      return { allowed: false, reason: 'Bet amount must be a valid number' };
    }

    if (userId != null) {
      const f = this.userFailures.get(userId);
      if (f && f.cooldownUntil > Date.now()) {
        const mins = Math.ceil((f.cooldownUntil - Date.now()) / 60_000);
        return {
          allowed: false,
          reason: `Several recent orders failed. Paused for ${mins} min. Check balance and gas.`,
        };
      }
    }

    if (amountUsdt > config.trading.maxBetUsdt) {
      return {
        allowed: false,
        reason: `Bet amount $${amountUsdt} exceeds max allowed limit of $${config.trading.maxBetUsdt} USDT`,
      };
    }

    if (amountUsdt <= 0) {
      return {
        allowed: false,
        reason: 'Bet amount must be greater than 0 USDT',
      };
    }

    if (this.dailyLossUsd >= config.trading.dailyLossLimitUsdt) {
      this.trip(`Daily loss limit reached ($${this.dailyLossUsd.toFixed(2)} / $${config.trading.dailyLossLimitUsdt})`);
      return {
        allowed: false,
        reason: `Daily loss limit of $${config.trading.dailyLossLimitUsdt} exceeded! Trading paused.`,
      };
    }

    return { allowed: true };
  }

  public trip(reason: string) {
    this.isTripped = true;
    this.tripReason = reason;
    logger.warn({ reason }, '🚨 CIRCUIT BREAKER TRIPPED');
    this.persist();
  }

  public resetCircuit() {
    this.isTripped = false;
    this.tripReason = '';
    this.consecutiveErrors = 0;
    this.userFailures.clear();
    logger.info('Circuit breaker manually reset');
    this.persist();
  }

  /** True when the daily loss limit is still exceeded (a reset won't re-enable trading). */
  public isDailyLimitExceeded(): boolean {
    return this.dailyLossUsd >= config.trading.dailyLossLimitUsdt;
  }

  public recordTrade(trade: TradeRecord) {
    this.dailyTradesCount++;
    this.consecutiveErrors = 0;
    if (trade.userId != null) this.userFailures.delete(trade.userId);
    // Defaults so callers don't have to remember the flags.
    trade.filled ??= true;
    trade.dryRun ??= config.trading.dryRun;
    this.tradeHistory.push(trade);
    if (this.tradeHistory.length > TRADE_HISTORY_MAX) {
      // Prefer dropping settled history; only drop open trades as a last resort.
      while (this.tradeHistory.length > TRADE_HISTORY_MAX) {
        const idx = this.tradeHistory.findIndex((t) => t.settled);
        if (idx === -1) {
          this.tradeHistory.shift();
          break;
        }
        this.tradeHistory.splice(idx, 1);
      }
    }
    this.persist();
  }

  /**
   * @param userId the member whose operation failed. When given, the failure only
   *   pauses that member (10 min after 5 in a row); the shared breaker is left
   *   alone. Without it (legacy callers) the old global behaviour applies.
   */
  public recordFailure(error: string, userId?: number) {
    if (userId != null) {
      const f = this.userFailures.get(userId) ?? { count: 0, cooldownUntil: 0 };
      f.count++;
      if (f.count >= 5) {
        f.count = 0;
        f.cooldownUntil = Date.now() + 10 * 60_000;
        logger.warn({ userId, error }, 'Member paused for 10 min after 5 consecutive failed orders');
      }
      this.userFailures.set(userId, f);
      return;
    }

    this.consecutiveErrors++;
    if (this.consecutiveErrors >= 5) {
      this.trip(`5 consecutive failed operations: ${error}`);
    }
  }

  /**
   * Settle a trade, win or loss. Wins and losses both matter: previously only
   * redeemed (winning) positions were settled, so `dailyLossUsd` never moved and
   * the loss circuit breaker could never trip.
   *
   * Multiple trades can map to one API position (e.g. two bets on the same
   * side in the same round). The aggregate PnL is now split across ALL matching
   * unsettled trades pro-rata by stake, so no trade is left "Pending" forever.
   *
   * @returns true when at least one matching open trade was settled.
   */
  public recordSettlement(
    marketId: string,
    pnlUsd: number,
    outcome?: string,
    /** Attribute only this member's trades (per-user wallets). */
    userId?: number
  ): boolean {
    if (!Number.isFinite(pnlUsd)) return false;

    // API outcomes are "Up"/"Yes" while trades store "UP"/"DOWN". Normalise
    // before comparing, otherwise every settlement falls through to the
    // less precise market-only fallback below.
    const settledOutcome = sideOfOutcome(outcome) || undefined;

    // Key must be per-user: two members can bet on the same market+outcome.
    const key = `${userId ?? 'x'}|${marketId}|${settledOutcome || ''}`;
    if (this.settledKeys.has(key)) return false;

    const isOpenLive = (t: TradeRecord) =>
      t.marketId === marketId &&
      !t.settled &&
      // Never let the live settler touch simulated trades (or vice versa).
      t.dryRun !== true &&
      (!userId || t.userId === userId);

    let matches = this.tradeHistory.filter(
      (t) => isOpenLive(t) && (!settledOutcome || t.outcome === settledOutcome)
    );
    if (matches.length === 0) {
      matches = this.tradeHistory.filter(isOpenLive);
    }
    if (matches.length === 0) return false;

    this.settledKeys.add(key);

    const totalAmount = matches.reduce((sum, t) => sum + t.amountUsdt, 0);
    for (const trade of matches) {
      trade.settled = true;
      trade.filled = true; // a resolved position must have filled
      const share = totalAmount > 0 ? trade.amountUsdt / totalAmount : 1 / matches.length;
      trade.pnlUsd = pnlUsd * share;
      if (trade.pnlUsd < 0) {
        this.dailyLossUsd += Math.abs(trade.pnlUsd);
      }
      // Attribute to the member who placed the bet (multi-user stats).
      userRegistry.recordPnl(trade.userId, trade.pnlUsd);
    }

    if (this.dailyLossUsd >= config.trading.dailyLossLimitUsdt) {
      this.trip(`Daily loss limit reached ($${this.dailyLossUsd.toFixed(2)} loss today)`);
    }

    this.persist();
    return true;
  }

  /**
   * A live order that was placed but never confirmed filled. Called once an
   * open position for market+outcome appears in the API.
   * @returns how many trades were marked filled.
   */
  public markFilled(marketId: string, outcome: 'UP' | 'DOWN', userId?: number): number {
    let marked = 0;
    for (const t of this.tradeHistory) {
      if (
        t.marketId === marketId &&
        t.outcome === outcome &&
        !t.settled &&
        t.filled === false &&
        t.dryRun !== true &&
        (userId == null || t.userId === userId)
      ) {
        t.filled = true;
        marked++;
      }
    }
    if (marked > 0) this.persist();
    return marked;
  }

  /**
   * Dry-run settlement from the resolved market's start/end price — no API
   * pnl needed. PnL is derived from the trade's own entry price:
   *   WON    → shares × $1 − stake
   *   LOST   → −stake
   *   REFUND → 0 (round ended exactly at the lock price)
   */
  public settleDryRun(trade: TradeRecord, result: DryRunResult): boolean {
    if (trade.settled || !(trade.price > 0)) return false;
    trade.settled = true;
    trade.filled = true;
    trade.pnlUsd =
      result === 'WON'
        ? trade.amountUsdt / trade.price - trade.amountUsdt
        : result === 'LOST'
        ? -trade.amountUsdt
        : 0;

    // Per-member stats must update in DRY RUN too (previously only live
    // settlements reached userRegistry.recordPnl, so member stats stayed 0).
    userRegistry.recordPnl(trade.userId, trade.pnlUsd);

    if (trade.pnlUsd < 0) {
      this.dailyLossUsd += Math.abs(trade.pnlUsd);
      if (this.dailyLossUsd >= config.trading.dailyLossLimitUsdt) {
        this.trip(`Daily loss limit reached ($${this.dailyLossUsd.toFixed(2)} loss today)`);
      }
    }

    this.persist();
    return true;
  }

  /** Unsettled trades placed in dry-run mode (input for the dry-run settler). */
  public getUnsettledDryRunTrades(userId?: number): TradeRecord[] {
    return this.tradeHistory.filter(
      (t) => !t.settled && t.dryRun === true && (userId == null || t.userId === userId)
    );
  }

  /** True when a live order was placed but not yet confirmed filled. */
  public hasUnfilledTrades(userId?: number): boolean {
    return this.tradeHistory.some(
      (t) =>
        !t.settled &&
        t.filled === false &&
        t.dryRun !== true &&
        (userId == null || t.userId === userId)
    );
  }

  public getOpenTrades(userId?: number): TradeRecord[] {
    return this.tradeHistory.filter(
      (t) => !t.settled && (userId == null || t.userId === userId)
    );
  }

  public getStats(userId?: number) {
    const trades =
      userId == null ? this.tradeHistory : this.tradeHistory.filter((t) => t.userId === userId);
    const totalTrades = trades.length;
    const settledTrades = trades.filter((t) => t.settled);
    const winningTrades = settledTrades.filter((t) => (t.pnlUsd || 0) > 0);
    const winRate =
      settledTrades.length > 0 ? (winningTrades.length / settledTrades.length) * 100 : 0;
    const totalPnl = settledTrades.reduce((acc, t) => acc + (t.pnlUsd || 0), 0);
    const member = userId != null ? userRegistry.getStats(userId) : null;

    return {
      isTripped: this.isTripped,
      tripReason: this.tripReason,
      dailyTrades: member ? member.dailyTrades : this.dailyTradesCount,
      dailyLoss: member ? member.dailyLossUsd : this.dailyLossUsd,
      totalTrades,
      winRate: winRate.toFixed(1),
      totalPnl: totalPnl.toFixed(2),
      isDryRun: config.trading.dryRun,
    };
  }

  public getRecentTrades(userId?: number, limit = 10): TradeRecord[] {
    const list =
      userId == null ? this.tradeHistory : this.tradeHistory.filter((t) => t.userId === userId);
    return [...list].reverse().slice(0, limit);
  }

  /** Total USDT currently staked in unresolved FILLED trades (informational).
   *  Unfilled limit orders commit no funds, so they are excluded. */
  public getOpenExposureUsdt(userId?: number): number {
    return this.tradeHistory
      .filter(
        (t) =>
          !t.settled &&
          t.filled !== false &&
          (userId == null || t.userId === userId)
      )
      .reduce((sum, t) => sum + t.amountUsdt, 0);
  }
}

export const riskManager = new RiskManager();
