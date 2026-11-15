import { InlineKeyboard, Keyboard } from 'grammy';
import { config } from '../config/index.js';
import type { ActiveRoundState } from '../services/roundWatcher.js';

/** Persistent main menu — ReplyKeyboard (keyword buttons) */
export const BTN = {
  LIVE: '🖥️ Live',
  WALLET: '🏦 Wallet',
  OPEN: '📦 Open',
  LOG: '📜 Log',
  TREND: '📈 Trend',
  SYSTEM: '🩺 System',
  QUICK_BET: '⚡ Quick Bet',
  PNL: '📊 PnL',
  PAUSE: '◾ Pause',
  RESUME: '▶️ Resume',

  UP: '🟢 UP',
  DOWN: '🔴 DOWN',
  A5: '$5',
  A10: '$10',
  A25: '$25',
  A50: '$50',
  CUSTOM: '✏️ Custom',
  CONFIRM: '✅ Confirm',
  CANCEL: '❌ Cancel',
  BACK: '« Back',
} as const;

export const MAIN_BTN_SET = new Set<string>([
  BTN.LIVE,
  BTN.WALLET,
  BTN.OPEN,
  BTN.LOG,
  BTN.TREND,
  BTN.SYSTEM,
  BTN.QUICK_BET,
  BTN.PNL,
  BTN.PAUSE,
  BTN.RESUME,
]);

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatPrice(price: number): string {
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Escape HTML special chars for Telegram HTML parse_mode */
export function esc(text: string | number | null | undefined): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildRoundCard(round: ActiveRoundState, balance?: number): string {
  const trendEmoji = round.currentTrend === 'UP' ? '🟢' : round.currentTrend === 'DOWN' ? '🔴' : '⚪';

  const lockKnown = round.lockPrice > 0;
  const diffStr = !lockKnown
    ? '— (syncing lock)'
    : round.priceDiff === 0
    ? '±$0.00'
    : round.priceDiff > 0
    ? `+$${formatPrice(round.priceDiff)}`
    : `-$${formatPrice(Math.abs(round.priceDiff))}`;

  const upPayout = round.upPrice > 0 ? (1 / round.upPrice).toFixed(2) : '—';
  const downPayout = round.downPrice > 0 ? (1 / round.downPrice).toFixed(2) : '—';
  const priceKnown = round.currentPrice > 0;

  const lockWarning = round.isLocked
    ? '\n⛔ <b>BETTING LOCKED</b> — Round closing!'
    : '';
  // Use the parsed config (strict) — raw env comparison casing is inconsistent.
  const dryRun = config.trading.dryRun ? '\n🧪 <b>DRY RUN MODE</b> — No real orders' : '';
  const balanceLine =
    balance !== undefined ? `\n💼 <b>Balance:</b> $${esc(formatPrice(balance))} USDT` : '';

  return (
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ <b>${esc(round.title)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏱ <b>Time Left:</b> ${formatTimer(round.secondsRemaining)}\n` +
    `🔒 <b>Lock Price:</b> ${lockKnown ? `$${esc(formatPrice(round.lockPrice))}` : '⏳ syncing…'}\n` +
    `${trendEmoji} <b>Current BTC:</b> ${priceKnown ? `$${esc(formatPrice(round.currentPrice))}  (${esc(diffStr)})` : '⏳ connecting…'}\n` +
    `\n` +
    `📊 <b>Odds:</b>\n` +
    `🟢 UP   : ${(round.upPrice * 100).toFixed(0)}¢  →  <b>${esc(upPayout)}x payout</b>\n` +
    `🔴 DOWN : ${(round.downPrice * 100).toFixed(0)}¢  →  <b>${esc(downPayout)}x payout</b>` +
    `${balanceLine}${lockWarning}${dryRun}`
  );
}

/** Main 3×3 reply keyboard (matches the screenshot layout) */
export function buildMainKeyboard(paused = false): Keyboard {
  return new Keyboard()
    .text(BTN.LIVE)
    .text(BTN.WALLET)
    .text(BTN.OPEN)
    .row()
    .text(BTN.LOG)
    .text(BTN.TREND)
    .text(BTN.SYSTEM)
    .row()
    .text(BTN.QUICK_BET)
    .text(BTN.PNL)
    .text(paused ? BTN.RESUME : BTN.PAUSE)
    .resized()
    .persistent();
}

export function buildSideKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.UP)
    .text(BTN.DOWN)
    .row()
    .text(BTN.BACK)
    .resized()
    .persistent();
}

export function buildAmountKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.A5)
    .text(BTN.A10)
    .row()
    .text(BTN.A25)
    .text(BTN.A50)
    .row()
    .text(BTN.CUSTOM)
    .text(BTN.BACK)
    .resized()
    .persistent();
}

export function buildConfirmKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.CONFIRM)
    .text(BTN.CANCEL)
    .resized()
    .persistent();
}

/** One button per open position — tap to see details / close. */
export function buildPositionsInline(
  items: Array<{ key: string; label: string }>
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items) {
    kb.text(item.label, `p:v:${item.key}`).row();
  }
  return kb;
}

/** Detail view for a single open position. */
export function buildPositionActionsInline(key: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔴 Close / Sell now', `p:c:${key}`)
    .row()
    .text('« Back to positions', 'p:l');
}

/** Just a back button — used after the position is closed. */
export function buildPositionBackInline(): InlineKeyboard {
  return new InlineKeyboard().text('« Back to positions', 'p:l');
}
