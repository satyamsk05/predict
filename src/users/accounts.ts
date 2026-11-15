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

function readOrCreateFileKey(): string | null {
  try {
    if (fs.existsSync(masterKeyFile())) {
      const key = fs.readFileSync(masterKeyFile(), 'utf8').trim();
      if (key.length >= 32) return key;
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
    return key;
  } catch (e) {
    logger.error({ err: e, file: masterKeyFile() }, 'Could not create data/master.key');
    return null;
  }
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
    if (envKey) {
      secret = envKey;
    } else {
      const fileKey = readOrCreateFileKey();
      if (!fileKey) {
        throw new Error(
          'No wallet encryption key available. Set WALLET_MASTER_KEY (recommended) or allow the bot to create data/master.key.'
        );
      }
      secret = fileKey;
      logger.warn(
        'WALLET_MASTER_KEY is not set — using data/master.key. Back it up; without it user keys cannot be decrypted.'
      );
    }

    primaryKey = deriveKey(secret);
    const all = [primaryKey];

    // Backward compatibility: early builds derived the key from the Telegram
    // bot token. Keep that as a *decrypt-only* fallback for existing accounts.
    if (!envKey) {
      const token = (config.telegram.token || '').trim();
      if (token) all.push(deriveKey(token));
      // Never ship a hard-coded fallback key: it made a leaked accounts.json
      // decryptable by anyone. Removed deliberately.
    }

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
  const { all } = resolveKeys();
  const iv = Buffer.from(enc.iv, 'hex');
  const tag = Buffer.from(enc.tag, 'hex');
  const data = Buffer.from(enc.data, 'hex');

  let lastError: unknown;
  for (const key of all) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      // Version 2 binds the ciphertext to this Telegram id.
      if (enc.v !== 1) decipher.setAAD(aad(telegramId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not decrypt wallet key');
}

class UserAccounts {
  private accounts: Record<string, UserAccount> = {};
  private loaded = false;

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const file = accountsFile();
    if (!fs.existsSync(file)) return;

    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as AccountsFile;
      if (!raw || typeof raw !== 'object' || !raw.accounts || typeof raw.accounts !== 'object') {
        throw new Error('accounts.json has an unexpected shape');
      }
      this.accounts = raw.accounts;
      logger.info(
        { file, accounts: Object.keys(this.accounts).length },
        'Loaded user accounts'
      );
    } catch (e) {
      // Never overwrite a corrupt key file: keep it for manual recovery and
      // start with an empty in-memory map. Otherwise the next save would
      // permanently destroy every member's private key.
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, backup);
        logger.error(
          { err: e, file, backup },
          '⚠️  accounts.json could not be parsed — moved to backup and starting fresh'
        );
      } catch (renameError) {
        logger.error(
          { err: e, err2: renameError, file },
          '⚠️  accounts.json is corrupt and could not be moved — refusing to touch it'
        );
      }
      this.accounts = {};
    }
  }

  private save() {
    try {
      const payload: AccountsFile = { version: 2, accounts: this.accounts };
      writeFileAtomic(accountsFile(), JSON.stringify(payload, null, 2));
    } catch (e) {
      logger.error({ err: e, file: accountsFile() }, 'Failed to persist user accounts');
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
      this.save();
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

    if (!ethers.isAddress(to)) {
      throw new Error('Invalid destination address');
    }
    const wallet = new ethers.Wallet(pk, getProvider());
    if (to.toLowerCase() === wallet.address.toLowerCase()) {
      throw new Error('Apne hi wallet mein withdraw nahi kar sakte');
    }
    if (to === ethers.ZeroAddress) {
      throw new Error('Zero address par withdraw nahi kar sakte');
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

    const requested = amountUsdt === 'all' ? balance : amountUsdt;
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error(`Wallet mein $${balance.toFixed(2)} USDT hai`);
    }
    if (requested > balance + 1e-9) {
      throw new Error(`Sirf $${balance.toFixed(2)} USDT available hai`);
    }

    // BEP-20 transfer needs BNB for gas — fail early with a clear message.
    const gasBal = await getProvider().getBalance(wallet.address);
    if (gasBal < ethers.parseEther('0.00012')) {
      throw new Error(
        'Withdrawal ke liye gas (BNB) kam hai — pehle thoda BNB is wallet mein bhejo.'
      );
    }

    // Never round *up* past the user's balance.
    const safeAmount = Math.min(requested, balance);
    const value = ethers.parseUnits(safeAmount.toFixed(Math.min(decimals, 18)), decimals);
    if (value <= 0n) throw new Error('Amount is too small to withdraw');

    const tx = await usdt.transfer(to, value);
    const receipt = await tx.wait();
    if (receipt && receipt.status === 0) {
      throw new Error('Withdrawal transaction reverted on-chain');
    }

    const hash = receipt?.hash || tx.hash;
    logger.info({ telegramId, to, amount: safeAmount, hash }, 'User USDT withdrawal sent');
    return hash;
  }
}

export const userAccounts = new UserAccounts();
