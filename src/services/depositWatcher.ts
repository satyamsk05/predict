import type { Bot, Context } from 'grammy';
import { logger } from '../utils/logger.js';
import { stateStore } from '../utils/store.js';
import { portfolioUrl, addressUrl, linkLine } from '../bot/links.js';
import { userAccounts } from '../users/accounts.js';
import { getUserRuntime } from '../users/runtime.js';

/**
 * Deposit watcher: polls the wallet's USDT / BNB balances and notifies
 * whitelisted chats when funds arrive from outside (on-chain top-up).
 *
 * Baselines persist in state.json, so a deposit made while the bot was
 * offline is still announced on the next successful poll. Trades spend
 * funds (balance decreases) so they never trigger a false "deposit".
 */

const POLL_MS = 30_000;
/** Minimum USDT increase (USD) that counts as a deposit. */
const MIN_USDT_DELTA = 0.01;
/** Minimum BNB increase that counts as a deposit (covers tiny gas top-ups). */
const MIN_BNB_DELTA = 0.0001;

let timer: NodeJS.Timeout | null = null;
let started = false;
/** Per-user baselines: telegramId → { usdt, bnb }. */
const baselines = new Map<number, { usdt: number; bnb: number }>();

function loadBaseline() {
  const saved = stateStore.get().depositUsers;
  if (!saved) return;
  for (const [id, b] of Object.entries(saved)) {
    if (Number.isFinite(b.usdt) && Number.isFinite(b.bnb)) {
      baselines.set(Number(id), { usdt: b.usdt, bnb: b.bnb });
    }
  }
  if (baselines.size) {
    logger.info({ users: baselines.size }, 'Restored deposit-watcher baselines');
  }
}

function persistBaseline() {
  const out: Record<string, { usdt: number; bnb: number }> = {};
  for (const [id, b] of baselines) out[String(id)] = b;
  stateStore.update((s) => {
    s.depositUsers = out;
  });
}

async function poll(bot: Bot<Context>) {
  // Watch every member's own wallet (per-user accounts).
  for (const acc of userAccounts.all()) {
    const userId = acc.telegramId;
    const rt = getUserRuntime(userId);
    if (!rt) continue;

    let bal;
    try {
      bal = await rt.api.getBalance();
    } catch {
      continue; // RPC hiccup — keep the previous baseline
    }
    if (!bal.ok) continue;

    const prev = baselines.get(userId);
    baselines.set(userId, { usdt: bal.usdt, bnb: bal.bnb });
    persistBaseline();

    if (!prev) continue; // first poll = baseline only

    const dUsdt = bal.usdt - prev.usdt;
    const dBnb = bal.bnb - prev.bnb;

    if (dUsdt >= MIN_USDT_DELTA || dBnb >= MIN_BNB_DELTA) {
      const lines = [
        `💰 <b>Deposit Received!</b>`,
        ``,
        dUsdt >= MIN_USDT_DELTA ? `USDT: <b>+$${dUsdt.toFixed(2)}</b>` : '',
        dBnb >= MIN_BNB_DELTA ? `BNB: <b>+${dBnb.toFixed(4)}</b>` : '',
        ``,
        `New balance: <b>$${bal.usdt.toFixed(2)} USDT</b> · ${bal.bnb.toFixed(4)} BNB`,
        `Address: <code>${acc.address}</code>`,
        linkLine(portfolioUrl(acc.address), 'Portfolio on Predict.fun'),
        linkLine(addressUrl(acc.address), 'View on BSCScan'),
      ]
        .filter(Boolean)
        .join('\n');

      await bot.api.sendMessage(userId, lines, { parse_mode: 'HTML' }).catch((e) => {
        logger.warn({ err: e, userId }, 'Deposit notify failed');
      });
      logger.info({ userId, dUsdt, dBnb }, 'Deposit notification sent');
    }
  }
}

export function startDepositWatcher(bot: Bot<Context>) {
  if (started) return;
  started = true;
  loadBaseline();
  // First poll establishes the baseline, then we keep watching.
  void poll(bot).finally(() => {
    timer = setInterval(() => void poll(bot), POLL_MS);
  });
  logger.info({ pollMs: POLL_MS }, 'Deposit watcher started');
}

export function stopDepositWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
