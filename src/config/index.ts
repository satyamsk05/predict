import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';
import { resolveWallet } from './wallet.js';

dotenv.config();

export interface AppConfig {
  telegram: {
    token: string;
    allowedUsers: number[];
    /**
     * Optional invite code. When set, a brand-new member must send
     * `/start <code>` before the bot creates their wallet. Existing members
     * are unaffected. This prevents strangers from filling all MAX_USERS
     * slots with throwaway Telegram accounts.
     */
    joinCode: string;
  };
  predictfun: {
    apiKey: string;
    privateKey: string;
    /** Smart wallet / deposit address if using Predict Account (Privy signer) */
    predictAccount: string;
    isTestnet: boolean;
    baseUrl: string;
    rpcUrl: string;
    /** Series slug for BTC 5m up/down rounds */
    seriesSlug: string;
  };
  trading: {
    dryRun: boolean;
    maxBetUsdt: number;
    dailyLossLimitUsdt: number;
    slippageBps: number;
    lockGuardSeconds: number;
    autoRedeem: boolean;
  };
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  // `DRY_RUN=0` / `NO` / `OFF` used to be treated as TRUE, which silently
  // enabled live trading safeguards in the wrong direction (or worse for
  // AUTO_REDEEM). Accept the common falsy spellings explicitly.
  if (['false', '0', 'no', 'off', 'n'].includes(v)) return false;
  if (['true', '1', 'yes', 'on', 'y'].includes(v)) return true;
  logger.warn({ value }, `Unrecognised boolean "${value}" — falling back to ${fallback}`);
  return fallback;
}

/**
 * Strict numeric env parsing. A typo such as `MAX_BET_USDT=5O` used to produce
 * `NaN`, which silently disabled the limit (`amount > NaN === false`).
 */
function parseNumber(
  name: string,
  value: string | undefined,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {}
): number {
  if (value === undefined || value.trim() === '') return fallback;

  const parsed = Number(value.trim());
  const invalid =
    !Number.isFinite(parsed) ||
    (opts.min !== undefined && parsed < opts.min) ||
    (opts.max !== undefined && parsed > opts.max);

  if (invalid) {
    logger.warn(
      { env: name, value, fallback },
      `Invalid ${name} — falling back to ${fallback}`
    );
    return fallback;
  }

  return opts.integer ? Math.round(parsed) : parsed;
}

const allowedUsersRaw = process.env.TELEGRAM_ALLOWED_USERS || '';
const allowedUsers = allowedUsersRaw
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

// Use the same strict parser: `PREDICTFUN_TESTNET=1` must not silently point
// the bot at mainnet.
const isTestnet = parseBool(process.env.PREDICTFUN_TESTNET, false);

// Wallet bootstrap: env key > data/wallet.json > auto-generate a fresh one.
const walletBoot = resolveWallet(process.env.PREDICTFUN_PRIVATE_KEY || '');
const privateKey = walletBoot.privateKey;

export const config: AppConfig = {
  telegram: {
    token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    allowedUsers,
    joinCode: (process.env.JOIN_CODE || '').trim(),
  },
  predictfun: {
    apiKey: (process.env.PREDICTFUN_API_KEY || '').trim(),
    privateKey,
    predictAccount: (process.env.PREDICTFUN_ACCOUNT || '').trim(),
    isTestnet,
    baseUrl: isTestnet
      ? 'https://api-testnet.predict.fun/v1'
      : 'https://api.predict.fun/v1',
    // Default RPC must match the network: a testnet run on the mainnet endpoint
    // queries the testnet USDT address on the wrong chain.
    rpcUrl:
      process.env.BSC_RPC_URL ||
      (isTestnet
        ? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545/'
        : 'https://bsc-dataseed.bnbchain.org/'),
    seriesSlug: process.env.PREDICTFUN_SERIES_SLUG || 'btc-updown-5m',
  },
  trading: {
    dryRun: parseBool(process.env.DRY_RUN, true), // Default to true for safety!
    maxBetUsdt: parseNumber('MAX_BET_USDT', process.env.MAX_BET_USDT, 50, { min: 0 }),
    dailyLossLimitUsdt: parseNumber(
      'DAILY_LOSS_LIMIT_USDT',
      process.env.DAILY_LOSS_LIMIT_USDT,
      150,
      { min: 0 }
    ),
    slippageBps: parseNumber('SLIPPAGE_BPS', process.env.SLIPPAGE_BPS, 100, {
      min: 0,
      max: 5000,
      integer: true,
    }),
    lockGuardSeconds: parseNumber(
      'LOCK_GUARD_SECONDS',
      process.env.LOCK_GUARD_SECONDS,
      30,
      { min: 0, max: 300, integer: true }
    ),
    autoRedeem: parseBool(process.env.AUTO_REDEEM, true),
  },
};

/** Exported so the Telegram bot can announce the legacy owner wallet (if any). */
export const walletInfo = {
  address: walletBoot.address,
  source: walletBoot.source,
  /** File location hint for owner messages (matches utils/store defaults). */
  file: process.env.DATA_DIR
    ? `${process.env.DATA_DIR.replace(/[\\/]+$/, '')}/wallet.json`
    : 'data/wallet.json',
};
