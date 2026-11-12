import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

dotenv.config();

export interface AppConfig {
  telegram: {
    token: string;
    allowedUsers: number[];
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
  return value.trim().toLowerCase() !== 'false';
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
  .filter((n) => !isNaN(n));

const isTestnet = process.env.PREDICTFUN_TESTNET === 'true';

const rawPrivateKey = (process.env.PREDICTFUN_PRIVATE_KEY || '').trim();
let privateKey = rawPrivateKey;
if (privateKey) {
  const hex = privateKey.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    logger.error('PREDICTFUN_PRIVATE_KEY is not a valid 32-byte hex private key — ignoring it.');
    privateKey = '';
  } else if (!privateKey.startsWith('0x')) {
    privateKey = `0x${hex}`;
  }
}

export const config: AppConfig = {
  telegram: {
    token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    allowedUsers,
  },
  predictfun: {
    apiKey: (process.env.PREDICTFUN_API_KEY || '').trim(),
    privateKey,
    predictAccount: (process.env.PREDICTFUN_ACCOUNT || '').trim(),
    isTestnet,
    baseUrl: isTestnet
      ? 'https://api-testnet.predict.fun/v1'
      : 'https://api.predict.fun/v1',
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org/',
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
