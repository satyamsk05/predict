import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';

/**
 * Legacy owner wallet bootstrap: env key > saved wallet.json.
 *
 * Multi-user mode creates a fresh wallet per Telegram member (see
 * users/accounts.ts), so the bot does **not** need an owner wallet anymore.
 * We deliberately stopped auto-generating one: an unused key in
 * data/wallet.json is a plaintext liability, and the old "fund this address"
 * hint could lure the owner into sending funds to a wallet the bot never
 * trades with.
 *
 * An owner wallet is only loaded when explicitly configured (env key or a
 * wallet.json left over from an older version); it backs the legacy
 * Predict Account / smart-wallet flow.
 */
export interface WalletBoot {
  privateKey: string;
  address: string;
  source: 'env' | 'file' | 'none';
}

function walletDir(): string {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(process.cwd(), 'data');
}

function walletFile(): string {
  return path.join(walletDir(), 'wallet.json');
}

export function resolveWallet(rawEnvKey: string): WalletBoot {
  // 1) .env private key wins (existing behaviour).
  const envKey = rawEnvKey.trim();
  if (envKey) {
    const hex = envKey.replace(/^0x/i, '');
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      const normalized = envKey.startsWith('0x') ? envKey : `0x${hex}`;
      return {
        privateKey: normalized,
        address: new ethers.Wallet(normalized).address,
        source: 'env',
      };
    }
    logger.error(
      'PREDICTFUN_PRIVATE_KEY is not a valid 32-byte hex key — ignoring it (members use their own wallets).'
    );
  }

  // 2) Previously generated wallet from data/wallet.json (older installs).
  try {
    if (fs.existsSync(walletFile())) {
      const raw = JSON.parse(fs.readFileSync(walletFile(), 'utf8'));
      const pk = typeof raw.privateKey === 'string' ? raw.privateKey.trim() : '';
      if (pk && /^0x[0-9a-fA-F]{64}$/.test(pk)) {
        const wallet = new ethers.Wallet(pk);
        logger.warn(
          { file: walletFile() },
          'Loaded legacy owner wallet from data/wallet.json (not used for member trading)'
        );
        return { privateKey: pk, address: wallet.address, source: 'file' };
      }
    }
  } catch (e) {
    logger.warn({ err: e, file: walletFile() }, 'Could not read legacy wallet.json — ignoring it');
  }

  // 3) No owner wallet: completely normal in per-user mode.
  return { privateKey: '', address: '', source: 'none' };
}
