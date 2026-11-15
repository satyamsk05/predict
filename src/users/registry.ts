import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Multi-user registry (max 10 members by default).
 *
 * - Admins come from TELEGRAM_ALLOWED_USERS (+ optional TELEGRAM_ADMIN_ID).
 * - New members are auto-registered on /start (no approval step).
 * - Optional JOIN_CODE makes /start invite-only, so strangers cannot fill all
 *   slots with throwaway Telegram accounts.
 * - /kick marks a member as blocked instead of deleting the record, otherwise
 *   the next message from that user would simply re-register them.
 * - Every member gets per-user stats and a per-user daily loss limit.
 * - Each member has their own wallet (see users/accounts.ts).
 */

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

const MAX_USERS = parsePositiveInt(process.env.MAX_USERS, 10, 10_000);
/** Per-member daily loss cap; falls back to the global limit. */
const USER_DAILY_LOSS_LIMIT_USDT = (() => {
  const n = Number(process.env.USER_DAILY_LOSS_LIMIT_USDT);
  return Number.isFinite(n) && n >= 0 ? n : config.trading.dailyLossLimitUsdt;
})();

/** Empty string = open join; any other value requires `/start <code>`. */
const JOIN_CODE = config.telegram.joinCode;

export type UserStatus = 'active' | 'pending' | 'blocked';

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

export type AccessResult = 'active' | 'full' | 'blocked' | 'denied';

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

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeStats(raw: any): UserStats {
  const base = emptyStats();
  if (!raw || typeof raw !== 'object') return base;
  return {
    trades: Math.max(0, Math.floor(finiteOr(raw.trades, 0))),
    wins: Math.max(0, Math.floor(finiteOr(raw.wins, 0))),
    losses: Math.max(0, Math.floor(finiteOr(raw.losses, 0))),
    pnlUsd: finiteOr(raw.pnlUsd, 0),
    dailyLossUsd: Math.max(0, finiteOr(raw.dailyLossUsd, 0)),
    dailyTrades: Math.max(0, Math.floor(finiteOr(raw.dailyTrades, 0))),
    lastDay: Math.floor(finiteOr(raw.lastDay, base.lastDay)),
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

function writeFileAtomic(file: string, contents: string, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, { mode });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(file);
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      throw e;
    }
  }
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
          this.users = raw.users
            .filter(
              (u) =>
                u &&
                Number.isFinite(u.telegramId) &&
                (u.role === 'admin' || u.role === 'user')
            )
            .map((u) => ({
              ...u,
              status:
                u.status === 'blocked' || u.status === 'pending' || u.status === 'active'
                  ? u.status
                  : 'active',
              stats: sanitizeStats(u.stats),
            }));
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
      const payload: UsersFile = { version: 2, users: this.users };
      writeFileAtomic(userFile(), JSON.stringify(payload, null, 2));
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
    return this.users.some(
      (u) => u.telegramId === id && u.role === 'admin' && u.status === 'active'
    );
  }

  /** Approved (can use trading commands) — admins always count. */
  public hasAccess(id: number): boolean {
    return this.users.some((u) => u.telegramId === id && u.status === 'active');
  }

  public isBlocked(id: number): boolean {
    return this.users.some((u) => u.telegramId === id && u.status === 'blocked');
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
    // Blocked members no longer occupy a slot; pending/active do.
    return this.users.filter((u) => u.role === 'user' && u.status !== 'blocked').length;
  }

  // ─── Access flow (no approval — /start creates the account directly) ───

  /**
   * Auto-create an active member.
   * @param joinCode value typed after `/start` (required only when JOIN_CODE set)
   * @returns 'active' | 'full' | 'blocked' | 'denied'
   */
  public ensureUser(
    telegramId: number,
    username?: string,
    joinCode?: string
  ): AccessResult {
    const existing = this.get(telegramId);
    if (existing) {
      if (existing.status === 'blocked') return 'blocked';
      let changed = false;
      if (existing.status !== 'active') {
        existing.status = 'active';
        changed = true;
      }
      if (username && existing.username !== username) {
        existing.username = username;
        changed = true;
      }
      if (changed) this.save();
      return 'active';
    }

    // New member: invite code (when configured) is checked *before* creating a
    // record, so a wrong/absent code cannot fill a slot.
    if (JOIN_CODE && joinCode !== JOIN_CODE) return 'denied';
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
    logger.info({ telegramId, username }, 'New member auto-registered');
    return 'active';
  }

  /** Block a member (keeps their stats and wallet record for auditing). */
  public kick(telegramId: number): 'admin' | 'ok' | 'notfound' {
    const u = this.get(telegramId);
    if (!u) return 'notfound';
    if (u.role === 'admin') return 'admin';
    if (u.status !== 'blocked') {
      u.status = 'blocked';
      this.save();
      logger.info({ telegramId }, 'User blocked by admin');
    }
    return 'ok';
  }

  /** Restore access for a blocked member. */
  public unban(telegramId: number): 'admin' | 'ok' | 'notfound' | 'notblocked' {
    const u = this.get(telegramId);
    if (!u) return 'notfound';
    if (u.role === 'admin') return 'admin';
    if (u.status !== 'blocked') return 'notblocked';
    if (this.memberCount() >= MAX_USERS) return 'notfound';
    u.status = 'active';
    this.save();
    logger.info({ telegramId }, 'User unbanned by admin');
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
    // 0 (or negative) explicitly disables the personal cap.
    if (USER_DAILY_LOSS_LIMIT_USDT > 0 && u.stats.dailyLossUsd >= USER_DAILY_LOSS_LIMIT_USDT) {
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
    // A $0.00 refund/tie is neither a win nor a loss.
    if (pnlUsd > 0) u.stats.wins++;
    else if (pnlUsd < 0) {
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

  public userDailyLossLimit(): number {
    return USER_DAILY_LOSS_LIMIT_USDT;
  }

  public joinCodeRequired(): boolean {
    return JOIN_CODE.length > 0;
  }
}

export const userRegistry = new UserRegistry();
