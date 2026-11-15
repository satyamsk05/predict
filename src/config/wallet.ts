import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';

/**
 * Wallet bootstrap: env key > saved wallet.json > auto-generate.
 *
 * Lets the bot be started with ZERO manual setup: if no private key is
 * configured, a fresh BNB-chain trading wallet is generated and saved to
 * data/wallet.json (mode 0600, gitignored). The owner can then fund it from
 * their main wallet and export the key via the Telegram /export command.
 */
export interface WalletBoot {
  privateKey: string;
  address: string;
  source: 'env' | 'file' | 'generated';
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
      'PREDICTFUN_PRIVATE_KEY is not a valid 32-byte hex key — ignoring it and falling back to the auto wallet.'
    );
  }

  // 2) Previously generated wallet from data/wallet.json.
  try {
    if (fs.existsSync(walletFile())) {
      const raw = JSON.parse(fs.readFileSync(walletFile(), 'utf8'));
      const pk = typeof raw.privateKey === 'string' ? raw.privateKey.trim() : '';
      if (pk && /^0x[0-9a-fA-F]{64}$/.test(pk)) {
        const wallet = new ethers.Wallet(pk);
        logger.info({ file: walletFile() }, 'Loaded auto-generated wallet');
        return { privateKey: pk, address: wallet.address, source: 'file' };
      }
    }
  } catch (e) {
    logger.warn({ err: e, file: walletFile() }, 'Could not read wallet.json — generating a new wallet');
  }

  // 3) Auto-generate a fresh trading wallet and persist it.
  const wallet = ethers.Wallet.createRandom();
  const payload = {
    address: wallet.address,
    privateKey: wallet.privateKey,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(walletDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(walletFile(), JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(walletFile(), 0o600);
  } catch {
    // Windows may not enforce POSIX modes — ignore.
  }
  logger.warn(
    { address: wallet.address, file: walletFile() },
    '🆕 New trading wallet generated — fund it, then export the key via /export'
  );
  return { privateKey: wallet.privateKey, address: wallet.address, source: 'generated' };
}
