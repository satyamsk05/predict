import type { Bot, Context } from 'grammy';
import { logger } from '../utils/logger.js';
import { stateStore } from '../utils/store.js';
import { portfolioUrl, addressUrl, linkLine } from '../bot/links.js';
import { userRegistry } from '../users/registry.js';
import { getUserRuntime } from '../users/runtime.js';

/**
 * Deposit watcher: polls each member's wallet (USDT / BNB) and notifies that
 * member when funds arrive from outside (on-chain top-up).
 *
 * Baselines persist in state.json (`depositUsers`), so a deposit made while the
 * bot was offline is still announced on the next successful poll. Trades spend
 * funds (balance decreases) so they never trigger a false "deposit".
 */

const POLL_MS = 30_000;
/** Minimum USDT increase (USD) that counts as a deposit. */
const MIN_USDT_DELTA = 0.01;
/** Minimum BNB increase that counts as a deposit (covers tiny gas top-ups). */
const MIN_BNB_DELTA = 0.0001;
/** RPC calls must not hang the whole poll cycle. */
const BALANCE_TIMEOUT_MS = 20_000;

type Balance = { usdt: number; bnb: number };

let timer: NodeJS.Timeout | null = null;
let started = false;
/** telegramId → last seen balance */
const lastBalances: Map<number, Balance> = new Map();

function loadBaselines() {
  const saved = stateStore.get().depositUsers || {};
  for (const [id, bal] of Object.entries(saved)) {
    const userId = Number(id);
    if (Number.isFinite(userId) && bal && Number.isFinite(bal.usdt) && Number.isFinite(bal.bnb)) {
      lastBalances.set(userId, { usdt: bal.usdt, bnb: bal.bnb });
    }
  }
  if (lastBalances.size > 0) {
    logger.info({ users: lastBalances.size }, 'Restored per-user deposit baselines');
  }
}

function persistBaselines() {
  const users: Record<string, Balance> = {};
  for (const [id, bal] of lastBalances) users[String(id)] = bal;
  stateStore.update((s) => {
    s.depositUsers = users;
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('RPC timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function poll(bot: Bot<Context>) {
  let changed = false;

  for (const userId of userRegistry.activeIds()) {
    const rt = getUserRuntime(userId);
    if (!rt) continue; // no wallet yet

    let bal;
    try {
      bal = await withTimeout(rt.api.getBalance(), BALANCE_TIMEOUT_MS);
    } catch {
      continue; // RPC hiccup — keep the previous baseline
    }
    if (!bal.ok) continue;

    const prev = lastBalances.get(userId);
    lastBalances.set(userId, { usdt: bal.usdt, bnb: bal.bnb });
    changed = true;

    if (!prev) continue; // first poll = baseline only

    const dUsdt = bal.usdt - prev.usdt;
    const dBnb = bal.bnb - prev.bnb;
    if (dUsdt < MIN_USDT_DELTA && dBnb < MIN_BNB_DELTA) continue;

    const address = rt.api.getEffectiveAddress();
    const lines = [
      `💰 <b>Funds Received!</b>`,
      ``,
      dUsdt >= MIN_USDT_DELTA ? `USDT: <b>+$${dUsdt.toFixed(2)}</b>` : '',
      dBnb >= MIN_BNB_DELTA ? `BNB: <b>+${dBnb.toFixed(4)}</b>` : '',
      ``,
      `New balance: <b>$${bal.usdt.toFixed(2)} USDT</b> · ${bal.bnb.toFixed(4)} BNB`,
      address ? `Address: <code>${address}</code>` : '',
      linkLine(portfolioUrl(address), 'Portfolio on Predict.fun'),
      linkLine(addressUrl(address), 'View on BSCScan'),
      ``,
      `ℹ️ Deposit ya Predict.fun payout — dono isi tarah dikhte hain.`,
    ]
      .filter(Boolean)
      .join('\n');

    await bot.api.sendMessage(userId, lines, { parse_mode: 'HTML' }).catch((e) => {
      logger.warn({ err: e, userId }, 'Deposit notify failed');
    });
    logger.info({ dUsdt, dBnb, userId }, 'Deposit notification sent');
  }

  if (changed) persistBaselines();
}

export function startDepositWatcher(bot: Bot<Context>) {
  if (started) return;
  started = true;
  loadBaselines();
  // First poll establishes the baseline, then we keep watching.
  void poll(bot).finally(() => {
    timer = setInterval(() => void poll(bot), POLL_MS);
  });
  logger.info({ pollMs: POLL_MS }, 'Per-user deposit watcher started');
}

export function stopDepositWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
