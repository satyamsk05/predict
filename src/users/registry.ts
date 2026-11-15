import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Small multi-user registry ("club mode", max 10 members).
 *
 * - Admins come from TELEGRAM_ALLOWED_USERS (+ optional TELEGRAM_ADMIN_ID).
 * - Strangers who /start the bot file an access request (pending).
 * - An admin approves with /approve <id> — up to MAX_USERS members.
 * - Every member gets per-user stats and a per-user daily loss limit.
 * - The trading wallet stays shared (10 trusted users), so /export remains
 *   admin-only.
 */

const MAX_USERS = Math.max(1, Number(process.env.MAX_USERS) || 10);
/** Per-member daily loss cap; falls back to the global limit. */
const USER_DAILY_LOSS_LIMIT_USDT =
  Number(process.env.USER_DAILY_LOSS_LIMIT_USDT) || config.trading.dailyLossLimitUsdt;

export type UserStatus = 'active' | 'pending';

export interface UserStats {
  trades: number;
  wins: number;
  losses: number;
  pnlUsd: number;
  dailyLossUsd: number;
  dailyTrades: number;
  lastDay: number;
}

export interface UserRecord {
  telegramId: number;
  username?: string;
  role: 'admin' | 'user';
  status: UserStatus;
  createdAt: string;
  stats: UserStats;
}

interface UsersFile {
  version: number;
  users: UserRecord[];
}

function emptyStats(): UserStats {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    pnlUsd: 0,
    dailyLossUsd: 0,
    dailyTrades: 0,
    lastDay: Math.floor(Date.now() / 86_400_000),
  };
}

function userDir(): string {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(process.cwd(), 'data');
}

function userFile(): string {
  return path.join(userDir(), 'users.json');
}

class UserRegistry {
  private users: UserRecord[] = [];

  /** Called once at startup (before the bot starts polling). */
  public init() {
    this.load();
    this.seedAdmins();
    this.save();
  }

  private load() {
    try {
      if (fs.existsSync(userFile())) {
        const raw: UsersFile = JSON.parse(fs.readFileSync(userFile(), 'utf8'));
        if (Array.isArray(raw.users)) {
          this.users = raw.users.filter(
            (u) => Number.isFinite(u.telegramId) && (u.role === 'admin' || u.role === 'user')
          );
          logger.info({ file: userFile(), users: this.users.length }, 'Loaded user registry');
        }
      }
    } catch (e) {
      logger.warn({ err: e, file: userFile() }, 'Could not read users.json — starting fresh');
      this.users = [];
    }
  }

  private save() {
    try {
      fs.mkdirSync(userDir(), { recursive: true, mode: 0o700 });
      const payload: UsersFile = { version: 1, users: this.users };
      fs.writeFileSync(userFile(), JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch (e) {
      logger.warn({ err: e, file: userFile() }, 'Failed to persist user registry');
    }
  }

  /** Env whitelist users become permanent admins (file entries are kept in sync). */
  private seedAdmins() {
    const adminIds = new Set<number>(config.telegram.allowedUsers);
    const extra = Number(process.env.TELEGRAM_ADMIN_ID);
    if (Number.isFinite(extra) && extra > 0) adminIds.add(extra);

    for (const id of adminIds) {
      let u = this.users.find((x) => x.telegramId === id);
      if (!u) {
        u = {
          telegramId: id,
          role: 'admin',
          status: 'active',
          createdAt: new Date().toISOString(),
          stats: emptyStats(),
        };
        this.users.push(u);
        logger.info({ telegramId: id }, 'Seeded admin from TELEGRAM_ALLOWED_USERS');
      } else {
        u.role = 'admin';
        u.status = 'active';
      }
    }
  }

  // ─── Lookups ────────────────────────────────────────────────

  public isAdmin(id: number): boolean {
    return this.users.some((u) => u.telegramId === id && u.role === 'admin' && u.status === 'active');
  }

  /** Approved (can use trading commands) — admins always count. */
  public hasAccess(id: number): boolean {
    return this.users.some((u) => u.telegramId === id && u.status === 'active');
  }

  public get(id: number): UserRecord | undefined {
    return this.users.find((u) => u.telegramId === id);
  }

  public all(): UserRecord[] {
    return [...this.users];
  }

  /** Active members (for broadcasts like deposit notifications). */
  public activeIds(): number[] {
    return this.users.filter((u) => u.status === 'active').map((u) => u.telegramId);
  }

  private memberCount(): number {
    return this.users.filter((u) => u.role === 'user').length; // pending + active
  }

  // ─── Access flow (NO approval — /start creates the account directly) ───

  /**
   * Auto-create an active member. @returns 'active' | 'full' (slots capped).
   */
  public ensureUser(telegramId: number, username?: string): 'active' | 'full' {
    const existing = this.get(telegramId);
    if (existing) {
      if (existing.status !== 'active') {
        existing.status = 'active';
        this.save();
      }
      if (username && existing.username !== username) {
        existing.username = username;
        this.save();
      }
      return 'active';
    }
    if (this.memberCount() >= MAX_USERS) return 'full';

    this.users.push({
      telegramId,
      username,
      role: 'user',
      status: 'active',
      createdAt: new Date().toISOString(),
      stats: emptyStats(),
    });
    this.save();
    logger.info({ telegramId, username }, 'New member auto-registered (no approval needed)');
    return 'active';
  }

  /** Remove a member (pending or active). Admins cannot be kicked. */
  public kick(telegramId: number): 'admin' | 'ok' | 'notfound' {
    const u = this.get(telegramId);
    if (!u) return 'notfound';
    if (u.role === 'admin') return 'admin';
    this.users = this.users.filter((x) => x.telegramId !== telegramId);
    this.save();
    logger.info({ telegramId }, 'User removed by admin');
    return 'ok';
  }

  // ─── Per-user stats / limits ────────────────────────────────

  private rolloverIfNeeded(u: UserRecord) {
    const day = Math.floor(Date.now() / 86_400_000);
    if (u.stats.lastDay !== day) {
      u.stats.lastDay = day;
      u.stats.dailyLossUsd = 0;
      u.stats.dailyTrades = 0;
    }
  }

  /** Per-member daily loss cap on top of the global risk manager. */
  public canBet(telegramId: number): { allowed: boolean; reason?: string } {
    const u = this.get(telegramId);
    if (!u || u.status !== 'active') return { allowed: false, reason: 'Not an approved member' };
    this.rolloverIfNeeded(u);
    if (u.stats.dailyLossUsd >= USER_DAILY_LOSS_LIMIT_USDT) {
      return {
        allowed: false,
        reason: `Aaj ka personal loss limit hit ho gaya ($${u.stats.dailyLossUsd.toFixed(2)} / $${USER_DAILY_LOSS_LIMIT_USDT}). Kal phir try karna.`,
      };
    }
    return { allowed: true };
  }

  public recordBet(telegramId: number) {
    const u = this.get(telegramId);
    if (!u) return;
    this.rolloverIfNeeded(u);
    u.stats.trades++;
    u.stats.dailyTrades++;
    this.save();
  }

  /** Called from the risk manager when a trade settles with a known PnL. */
  public recordPnl(telegramId: number | undefined, pnlUsd: number) {
    if (!telegramId || !Number.isFinite(pnlUsd)) return;
    const u = this.get(telegramId);
    if (!u) return;
    this.rolloverIfNeeded(u);
    u.stats.pnlUsd += pnlUsd;
    if (pnlUsd >= 0) u.stats.wins++;
    else {
      u.stats.losses++;
      u.stats.dailyLossUsd += Math.abs(pnlUsd);
    }
    this.save();
  }

  public getStats(telegramId: number): UserStats {
    const u = this.get(telegramId);
    if (!u) return emptyStats();
    this.rolloverIfNeeded(u);
    return u.stats;
  }

  public maxUsers(): number {
    return MAX_USERS;
  }
}

export const userRegistry = new UserRegistry();
