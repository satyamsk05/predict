import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { stateStore } from '../utils/store.js';

export interface TradeRecord {
  timestamp: number;
  marketId: string;
  outcome: 'UP' | 'DOWN';
  amountUsdt: number;
  price: number;
  orderId?: string;
  pnlUsd?: number;
  settled: boolean;
}

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
        trades: this.tradeHistory.slice(-200),
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

  public canTrade(amountUsdt: number): { allowed: boolean; reason?: string } {
    if (this.isTripped) {
      return {
        allowed: false,
        reason: `Circuit Breaker is TRIPPED: ${this.tripReason}`,
      };
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
    logger.info('Circuit breaker manually reset');
    this.persist();
  }

  public recordTrade(trade: TradeRecord) {
    this.dailyTradesCount++;
    this.consecutiveErrors = 0;
    this.tradeHistory.push(trade);
    if (this.tradeHistory.length > 100) {
      this.tradeHistory.shift();
    }
    this.persist();
  }

  public recordFailure(error: string) {
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
   * @returns true when a matching open trade was found and settled.
   */
  public recordSettlement(marketId: string, pnlUsd: number, outcome?: string): boolean {
    if (!Number.isFinite(pnlUsd)) return false;

    const key = `${marketId}|${outcome || ''}`;
    if (this.settledKeys.has(key)) return false;

    const trade =
      this.tradeHistory.find(
        (t) => t.marketId === marketId && !t.settled && (!outcome || t.outcome === outcome)
      ) || this.tradeHistory.find((t) => t.marketId === marketId && !t.settled);

    if (!trade) return false;

    this.settledKeys.add(key);
    trade.settled = true;
    trade.pnlUsd = pnlUsd;

    if (pnlUsd < 0) {
      this.dailyLossUsd += Math.abs(pnlUsd);
      if (this.dailyLossUsd >= config.trading.dailyLossLimitUsdt) {
        this.trip(`Daily loss limit reached ($${this.dailyLossUsd.toFixed(2)} loss today)`);
      }
    }

    this.persist();
    return true;
  }

  public getOpenTrades(): TradeRecord[] {
    return this.tradeHistory.filter((t) => !t.settled);
  }

  public getStats() {
    const totalTrades = this.tradeHistory.length;
    const settledTrades = this.tradeHistory.filter((t) => t.settled);
    const winningTrades = settledTrades.filter((t) => (t.pnlUsd || 0) > 0);
    const winRate = settledTrades.length > 0 ? (winningTrades.length / settledTrades.length) * 100 : 0;
    const totalPnl = settledTrades.reduce((acc, t) => acc + (t.pnlUsd || 0), 0);

    return {
      isTripped: this.isTripped,
      tripReason: this.tripReason,
      dailyTrades: this.dailyTradesCount,
      dailyLoss: this.dailyLossUsd,
      totalTrades,
      winRate: winRate.toFixed(1),
      totalPnl: totalPnl.toFixed(2),
      isDryRun: config.trading.dryRun,
    };
  }

  public getRecentTrades(): TradeRecord[] {
    return [...this.tradeHistory].reverse().slice(0, 10);
  }

  /** Total USDT currently staked in unresolved trades (informational). */
  public getOpenExposureUsdt(): number {
    return this.tradeHistory
      .filter((t) => !t.settled)
      .reduce((sum, t) => sum + t.amountUsdt, 0);
  }
}

export const riskManager = new RiskManager();
