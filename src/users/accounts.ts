import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { getProvider } from '../utils/provider.js';

/**
 * Per-user trading accounts.
 *
 * Every Telegram user who /starts the bot gets their OWN fresh BSC wallet —
 * no admin approval needed (up to MAX_USERS members, enforced by the
 * registry). Private keys are encrypted at rest with AES-256-GCM so a leaked
 * data/ folder can't drain anyone's funds.
 *
 * Master key resolution (in order):
 *   1. WALLET_MASTER_KEY env (recommended)
 *   2. data/master.key — generated on first run, mode 0600
 *   3. Legacy: TELEGRAM_BOT_TOKEN (only to decrypt accounts created by older
 *      versions; new keys always use 1 or 2)
 *
 * BACK UP data/master.key (or WALLET_MASTER_KEY). If it is lost, member
 * private keys cannot be decrypted and their funds are unrecoverable.
 */

export interface EncKey {
  /** Encryption format version (2 = per-account AAD). */
  v?: number;
  iv: string;
  tag: string;
  data: string;
}

export interface UserAccount {
  telegramId: number;
  username?: string;
  address: string;
  createdAt: string;
  enc: EncKey;
}

interface AccountsFile {
  version: number;
  accounts: Record<string, UserAccount>;
}

function accountsDir(): string {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(process.cwd(), 'data');
}

function accountsFile(): string {
  return path.join(accountsDir(), 'accounts.json');
}

function masterKeyFile(): string {
  return path.join(accountsDir(), 'master.key');
}

const KDF_SALT = 'predict-bot-wallet-v1';
/** Bump when the encryption format changes. */
const ENC_VERSION = 2;

/** Derive a stable 32-byte AES key from a passphrase. */
function deriveKey(secret: string): Buffer {
  return crypto.scryptSync(secret, KDF_SALT, 32);
}

function writeFileAtomic(file: string, contents: string, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, { mode });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows can refuse to replace an existing file.
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

function readOrCreateFileKey(): { key: string; generated: boolean } | null {
  try {
    if (fs.existsSync(masterKeyFile())) {
      const key = fs.readFileSync(masterKeyFile(), 'utf8').trim();
      if (key.length >= 32) return { key, generated: false };
      logger.error(
        { file: masterKeyFile() },
        '⚠️  data/master.key is too short — refusing to use it'
      );
      return null;
    }
    const key = crypto.randomBytes(32).toString('hex');
    writeFileAtomic(masterKeyFile(), key);
    logger.warn(
      { file: masterKeyFile() },
      '🔐 Generated data/master.key — BACK IT UP. Losing it makes member wallet keys unrecoverable.'
    );
    return { key, generated: true };
  } catch (e) {
    logger.error({ err: e, file: masterKeyFile() }, 'Could not create data/master.key');
    return null;
  }
}

/**
 * Safety net for a freshly generated master key: if accounts.json already holds
 * encrypted wallets, at least one of them must decrypt with the keys we will
 * use. Otherwise master.key was lost/replaced, and silently carrying on would
 * lock every member out of their funds (and encrypt new wallets with a key
 * that cannot read the old ones).
 */
function assertExistingAccountsDecryptable(keys: Buffer[]): void {
  const file = accountsFile();
  if (!fs.existsSync(file)) return;

  let accounts: Record<string, UserAccount> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as AccountsFile;
    accounts = raw?.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
  } catch {
    // Unparseable file is reported by UserAccounts.load() with its own error.
    return;
  }

  const entries = Object.values(accounts);
  if (entries.length === 0) return;

  const ok = entries.some((acc) => {
    try {
      decryptWith(keys, acc.enc, acc.telegramId);
      return true;
    } catch {
      return false;
    }
  });
  if (ok) return;

  // Remove the key we just generated so the NEXT start does not trust it.
  try {
    fs.unlinkSync(masterKeyFile());
  } catch {
    // ignore
  }
  throw new Error(
    `accounts.json contains ${entries.length} encrypted wallet(s) but none can be decrypted: ` +
      'data/master.key is missing. Restore the original data/master.key or set the original ' +
      'WALLET_MASTER_KEY, then start again. (A new key was NOT kept.)'
  );
}

let primaryKey: Buffer | null = null;
let decryptKeys: Buffer[] | null = null;

/**
 * Build the primary key plus any legacy key needed to read old accounts.
 * Cached: scrypt is intentionally slow, so never run it per encrypt/decrypt.
 */
function resolveKeys(): { primary: Buffer; all: Buffer[] } {
  if (!primaryKey || !decryptKeys) {
    const envKey = (process.env.WALLET_MASTER_KEY || '').trim();
    let secret: string;
    let generatedKeyFile = false;
    if (envKey) {
      secret = envKey;
    } else {
      const fileKey = readOrCreateFileKey();
      if (!fileKey) {
        throw new Error(
          'No wallet encryption key available. Set WALLET_MASTER_KEY (recommended) or allow the bot to create data/master.key.'
        );
      }
      secret = fileKey.key;
      generatedKeyFile = fileKey.generated;
      logger.warn(
        'WALLET_MASTER_KEY is not set — using data/master.key. Back it up; without it user keys cannot be decrypted.'
      );
    }

    const primary = deriveKey(secret);
    const all = [primary];

    // Backward compatibility: early builds derived the key from the Telegram
    // bot token. Keep that as a *decrypt-only* fallback for existing accounts.
    if (!envKey) {
      const token = (config.telegram.token || '').trim();
      if (token) all.push(deriveKey(token));
      // Never ship a hard-coded fallback key: it made a leaked accounts.json
      // decryptable by anyone. Removed deliberately.
    }

    // A brand-new master.key next to existing encrypted wallets means the old
    // key was lost — fail loudly instead of locking everyone out.
    if (generatedKeyFile) assertExistingAccountsDecryptable(all);

    primaryKey = primary;
    decryptKeys = all;
  }
  return { primary: primaryKey, all: decryptKeys };
}

function aad(telegramId: number): Buffer {
  return Buffer.from(`predictfun-user-wallet-v1:${telegramId}`, 'utf8');
}

function encrypt(plain: string, telegramId: number): EncKey {
  const { primary } = resolveKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', primary, iv);
  cipher.setAAD(aad(telegramId));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    v: ENC_VERSION,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('hex'),
  };
}

function decrypt(enc: EncKey, telegramId: number): string {
  return decryptWith(resolveKeys().all, enc, telegramId);
}

function decryptWith(all: Buffer[], enc: EncKey, telegramId: number): string {
  const iv = Buffer.from(enc.iv, 'hex');
  const tag = Buffer.from(enc.tag, 'hex');
  const data = Buffer.from(enc.data, 'hex');

  // Version 2 binds the ciphertext to this Telegram id. Legacy blobs (no
  // version field) were written without AAD, so try both.
  const aadModes = enc.v === ENC_VERSION ? [true, false] : [false];
  let lastError: unknown;
  for (const key of all) {
    for (const withAad of aadModes) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        if (withAad) decipher.setAAD(aad(telegramId));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch (e) {
        lastError = e;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not decrypt wallet key');
}

class UserAccounts {
  private accounts: Record<string, UserAccount> = {};
  private loaded = false;

  /**
   * Load accounts.json eagerly at startup so a bad key store stops the bot
   * immediately (instead of failing later, inside a user's command).
   */
  public init() {
    this.load();
    // Resolve (and, for a new install, create) the encryption key now, so a lost
    // master.key is detected at startup rather than on the first /start.
    resolveKeys();
  }

  private load() {
    if (this.loaded) return;
    const file = accountsFile();
    if (!fs.existsSync(file)) {
      this.loaded = true;
      return;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as AccountsFile;
      if (!raw || typeof raw !== 'object' || !raw.accounts || typeof raw.accounts !== 'object') {
        throw new Error('accounts.json has an unexpected shape');
      }
      this.accounts = raw.accounts;
      this.loaded = true;
      logger.info(
        { file, accounts: Object.keys(this.accounts).length },
        'Loaded user accounts'
      );
    } catch (e) {
      // FAIL CLOSED. Starting with an empty map would hand every existing
      // member a brand-new wallet on /start and abandon their funded one.
      // Keep a copy for manual recovery and refuse to run until it is fixed.
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      } catch {
        // best effort — the original file is left untouched either way
      }
      logger.error(
        { err: e, file, backup },
        '⚠️  accounts.json could not be parsed — refusing to start. Restore it from a backup or fix the JSON.'
      );
      throw new Error(`accounts.json is unreadable (${file}). Fix or restore it before starting the bot.`);
    }
  }

  /** @returns false when the file could not be written (callers must handle it). */
  private save(): boolean {
    try {
      const payload: AccountsFile = { version: 2, accounts: this.accounts };
      writeFileAtomic(accountsFile(), JSON.stringify(payload, null, 2));
      return true;
    } catch (e) {
      logger.error({ err: e, file: accountsFile() }, 'Failed to persist user accounts');
      return false;
    }
  }

  /** Get or create the user's trading wallet. @returns [account, created] */
  public ensureAccount(
    telegramId: number,
    username?: string
  ): { account: UserAccount | null; created: boolean } {
    this.load();
    const key = String(telegramId);
    const existing = this.accounts[key];

    if (existing) {
      if (username && existing.username !== username) {
        existing.username = username;
        this.save();
      }
      return { account: existing, created: false };
    }

    try {
      const wallet = ethers.Wallet.createRandom();
      const account: UserAccount = {
        telegramId,
        username,
        address: wallet.address,
        createdAt: new Date().toISOString(),
        enc: encrypt(wallet.privateKey, telegramId),
      };
      this.accounts[key] = account;
      // The user is about to be told "send funds to this address". If the key
      // is not safely on disk, a restart would lose it and those funds with it —
      // so never hand out an address we could not persist.
      if (!this.save()) {
        delete this.accounts[key];
        logger.error({ telegramId }, 'Wallet NOT created: could not persist accounts.json');
        return { account: null, created: false };
      }
      logger.info({ telegramId, address: account.address }, '🆕 New per-user trading wallet created');
      return { account, created: true };
    } catch (e) {
      logger.error({ err: e, telegramId }, 'Could not create user wallet');
      return { account: null, created: false };
    }
  }

  public get(telegramId: number): UserAccount | null {
    this.load();
    return this.accounts[String(telegramId)] || null;
  }

  public all(): UserAccount[] {
    this.load();
    return Object.values(this.accounts);
  }

  public count(): number {
    this.load();
    return Object.keys(this.accounts).length;
  }

  public remove(telegramId: number): boolean {
    this.load();
    const key = String(telegramId);
    if (!this.accounts[key]) return false;
    delete this.accounts[key];
    this.save();
    return true;
  }

  /** Decrypted private key for this user's wallet (only used to sign). */
  public getPrivateKey(telegramId: number): string | null {
    const acc = this.get(telegramId);
    if (!acc) return null;
    try {
      const pk = decrypt(acc.enc, telegramId);
      return /^0x[0-9a-fA-F]{64}$/.test(pk) ? pk : null;
    } catch (e) {
      logger.error({ err: e, telegramId }, 'Could not decrypt user wallet key');
      return null;
    }
  }

  /** @returns the user's public address, or null when they have no account. */
  public getAddress(telegramId: number): string | null {
    return this.get(telegramId)?.address || null;
  }

  /**
   * Send USDT (BEP-20) from the user's wallet to a destination address.
   * @param amountUsdt number, or `'all'` to send the full balance.
   * @returns tx hash.
   */
  public async sendUsdt(
    telegramId: number,
    to: string,
    amountUsdt: number | 'all'
  ): Promise<string> {
    const pk = this.getPrivateKey(telegramId);
    if (!pk) throw new Error('Account wallet not found');

    if (!/^0x[0-9a-fA-F]{40}$/.test(to) || !ethers.isAddress(to)) {
      throw new Error('Invalid destination address');
    }
    // Normalised (checksummed) form; also rejects bad mixed-case checksums above.
    const dest = ethers.getAddress(to);
    const wallet = new ethers.Wallet(pk, getProvider());
    if (dest === wallet.address) {
      throw new Error('Cannot withdraw to the same wallet');
    }
    if (dest === ethers.ZeroAddress) {
      throw new Error('Cannot withdraw to the zero address');
    }

    const usdtAddress = config.predictfun.isTestnet
      ? '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd'
      : '0x55d398326f99059fF775485246999027B3197955';
    const abi = [
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address owner) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ];
    const usdt = new ethers.Contract(usdtAddress, abi, wallet);
    const [balRaw, decimalsRaw] = await Promise.all([
      usdt.balanceOf(wallet.address),
      usdt.decimals().catch(() => 18),
    ]);
    const decimals = Number(decimalsRaw);
    const balance = Number(ethers.formatUnits(balRaw, decimals));

    // Work in raw token units. Going through a JS float (the old behaviour)
    // could produce a value 1 wei ABOVE the balance for "all" and make the
    // transfer revert, or leave dust behind.
    let value: bigint;
    if (amountUsdt === 'all') {
      value = balRaw as bigint;
    } else {
      if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
        throw new Error(`Wallet holds $${balance.toFixed(2)} USDT`);
      }
      value = ethers.parseUnits(amountUsdt.toFixed(Math.min(decimals, 18)), decimals);
      if (value > (balRaw as bigint)) {
        throw new Error(`Only $${balance.toFixed(2)} USDT available`);
      }
    }
    if (value <= 0n) {
      throw new Error(
        amountUsdt === 'all'
          ? `Wallet holds $${balance.toFixed(2)} USDT`
          : 'Amount is too small to withdraw'
      );
    }

    // BEP-20 transfer needs BNB for gas — fail early with a clear message.
    const gasBal = await getProvider().getBalance(wallet.address);
    if (gasBal < ethers.parseEther('0.00012')) {
      throw new Error(
        'Not enough BNB for gas. Send a little BNB to this wallet first.'
      );
    }

    const tx = await usdt.transfer(dest, value);

    // Bounded wait: this runs inside a Telegram handler, so a stuck transaction
    // must not hang the bot indefinitely.
    let receipt;
    try {
      receipt = await tx.wait(1, 90_000);
    } catch (e: any) {
      if (e?.code === 'TIMEOUT') {
        throw new Error(
          `Transaction not confirmed yet. Hash: ${tx.hash}. Check BSCScan and do NOT withdraw again until it confirms or fails.`
        );
      }
      throw e;
    }
    if (receipt && receipt.status === 0) {
      throw new Error('Withdrawal transaction reverted on-chain');
    }

    const hash = receipt?.hash || tx.hash;
    logger.info(
      { telegramId, to: dest, amount: ethers.formatUnits(value, decimals), hash },
      'User USDT withdrawal sent'
    );
    return hash;
  }
}

export const userAccounts = new UserAccounts();
