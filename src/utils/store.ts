import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import type { TradeRecord } from '../execution/risk.js';

/** How many historical keys/trades we keep on disk. */
const MAX_TRADES = 200;
const MAX_KEYS = 1000;

export interface PersistedRiskState {
  dailyLossUsd: number;
  dailyTradesCount: number;
  lastResetDay: number;
  isTripped: boolean;
  tripReason: string;
  trades: TradeRecord[];
  settledKeys: string[];
}

export interface PersistedAutoState {
  redeemedKeys: string[];
  notifyTargets: Array<{ chatId: number; paused: boolean }>;
}

/** Legacy single-wallet baseline (kept so old state.json files still parse). */
export interface PersistedDepositState {
  usdt: number;
  bnb: number;
}

/** Per-user deposit baselines (per-user wallets): telegramId → balances. */
export type PersistedDepositUsers = Record<string, { usdt: number; bnb: number }>;

export interface PersistedState {
  version: number;
  risk: PersistedRiskState;
  auto: PersistedAutoState;
  deposit?: PersistedDepositState;
  depositUsers?: PersistedDepositUsers;
}

function emptyState(): PersistedState {
  return {
    version: 1,
    risk: {
      dailyLossUsd: 0,
      dailyTradesCount: 0,
      lastResetDay: Math.floor(Date.now() / 86_400_000),
      isTripped: false,
      tripReason: '',
      trades: [],
      settledKeys: [],
    },
    auto: {
      redeemedKeys: [],
      notifyTargets: [],
    },
  };
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').slice(-max);
}

function sanitize(raw: any): PersistedState {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;

  const risk = raw.risk ?? {};
  base.risk = {
    dailyLossUsd: toFiniteNumber(risk.dailyLossUsd, 0),
    dailyTradesCount: toFiniteNumber(risk.dailyTradesCount, 0),
    lastResetDay: toFiniteNumber(risk.lastResetDay, base.risk.lastResetDay),
    isTripped: risk.isTripped === true,
    tripReason: typeof risk.tripReason === 'string' ? risk.tripReason : '',
    trades: Array.isArray(risk.trades)
      ? risk.trades
          .filter(
            (t: any) =>
              t &&
              typeof t.marketId === 'string' &&
              (t.outcome === 'UP' || t.outcome === 'DOWN') &&
              Number.isFinite(t.amountUsdt) &&
              Number.isFinite(t.price)
          )
          .map((t: any) => ({
            ...t,
            userId: Number.isFinite(t.userId) ? t.userId : undefined,
          }))
          .slice(-MAX_TRADES)
      : [],
    settledKeys: toStringArray(risk.settledKeys, MAX_KEYS),
  };

  const auto = raw.auto ?? {};
  base.auto = {
    redeemedKeys: toStringArray(auto.redeemedKeys, MAX_KEYS),
    notifyTargets: Array.isArray(auto.notifyTargets)
      ? auto.notifyTargets
          .filter((t: any) => t && Number.isFinite(t.chatId))
          .map((t: any) => ({ chatId: t.chatId, paused: t.paused === true }))
      : [],
  };

  if (raw.deposit && Number.isFinite(raw.deposit.usdt) && Number.isFinite(raw.deposit.bnb)) {
    base.deposit = { usdt: raw.deposit.usdt, bnb: raw.deposit.bnb };
  }

  if (raw.depositUsers && typeof raw.depositUsers === 'object') {
    const out: PersistedDepositUsers = {};
    for (const [id, b] of Object.entries(raw.depositUsers as any)) {
      const bb: any = b;
      if (bb && Number.isFinite(bb.usdt) && Number.isFinite(bb.bnb)) {
        out[id] = { usdt: bb.usdt, bnb: bb.bnb };
      }
    }
    base.depositUsers = out;
  }

  return base;
}

class StateStore {
  private readonly dir: string;
  private readonly file: string;
  private state: PersistedState;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.dir = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.resolve(process.cwd(), 'data');
    this.file = path.join(this.dir, 'state.json');
    this.state = this.load();
  }

  private load(): PersistedState {
    try {
      if (!fs.existsSync(this.file)) return emptyState();
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      logger.info({ file: this.file }, 'Loaded persisted bot state');
      return sanitize(raw);
    } catch (e) {
      logger.warn({ err: e, file: this.file }, 'Could not read state file — starting fresh');
      return emptyState();
    }
  }

  public get(): PersistedState {
    return this.state;
  }

  /** Mutate and schedule a debounced atomic save. */
  public update(mutator: (state: PersistedState) => void): void {
    try {
      mutator(this.state);
      this.scheduleSave();
    } catch (e) {
      logger.warn({ err: e }, 'Failed to update persisted state');
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 500);
  }

  /** Atomic write (tmp + rename) so a crash can't corrupt the file. */
  public saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      try {
        fs.renameSync(tmp, this.file);
      } catch (e) {
        // Windows can refuse to replace an existing file.
        try {
          fs.unlinkSync(this.file);
          fs.renameSync(tmp, this.file);
        } catch {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // ignore
          }
          throw e;
        }
      }
    } catch (e) {
      logger.warn({ err: e, file: this.file }, 'Failed to persist bot state');
    }
  }

  public getFile(): string {
    return this.file;
  }
}

export const stateStore = new StateStore();
