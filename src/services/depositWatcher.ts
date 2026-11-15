import type { Bot, Context } from 'grammy';
import { logger } from '../utils/logger.js';
import { predictFunApi } from '../exchanges/predictfun/api.js';
import { stateStore } from '../utils/store.js';
import { walletInfo } from '../config/index.js';
import { portfolioUrl, addressUrl, linkLine } from '../bot/links.js';
import { userRegistry } from '../users/registry.js';

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
let lastUsdt: number | null = null;
let lastBnb: number | null = null;

function loadBaseline() {
  const saved = stateStore.get().deposit;
  if (saved && Number.isFinite(saved.usdt) && Number.isFinite(saved.bnb)) {
    lastUsdt = saved.usdt;
    lastBnb = saved.bnb;
    logger.info({ usdt: saved.usdt, bnb: saved.bnb }, 'Restored deposit-watcher baseline');
  }
}

function persistBaseline() {
  if (lastUsdt == null || lastBnb == null) return;
  stateStore.update((s) => {
    s.deposit = { usdt: lastUsdt as number, bnb: lastBnb as number };
  });
}

async function poll(bot: Bot<Context>) {
  let bal;
  try {
    bal = await predictFunApi.getBalance();
  } catch {
    return; // RPC hiccup — keep the previous baseline
  }
  if (!bal.ok) return;

  const prevUsdt = lastUsdt;
  const prevBnb = lastBnb;
  lastUsdt = bal.usdt;
  lastBnb = bal.bnb;
  persistBaseline();

  if (prevUsdt == null || prevBnb == null) return; // first poll = baseline only

  const dUsdt = bal.usdt - prevUsdt;
  const dBnb = bal.bnb - prevBnb;

  if (dUsdt >= MIN_USDT_DELTA || dBnb >= MIN_BNB_DELTA) {
    const lines = [
      `💰 <b>Deposit Received!</b>`,
      ``,
      dUsdt >= MIN_USDT_DELTA ? `USDT: <b>+$${dUsdt.toFixed(2)}</b>` : '',
      dBnb >= MIN_BNB_DELTA ? `BNB: <b>+${dBnb.toFixed(4)}</b>` : '',
      ``,
      `New balance: <b>$${bal.usdt.toFixed(2)} USDT</b> · ${bal.bnb.toFixed(4)} BNB`,
      `Address: <code>${walletInfo.address}</code>`,
      linkLine(portfolioUrl(walletInfo.address), 'Portfolio on Predict.fun'),
      linkLine(addressUrl(walletInfo.address), 'View on BSCScan'),
    ]
      .filter(Boolean)
      .join('\n');

    // Notify every approved member (multi-user club mode).
    for (const userId of userRegistry.activeIds()) {
      await bot.api.sendMessage(userId, lines, { parse_mode: 'HTML' }).catch((e) => {
        logger.warn({ err: e, userId }, 'Deposit notify failed');
      });
    }
    logger.info({ dUsdt, dBnb }, 'Deposit notification sent');
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
