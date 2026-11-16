import { InlineKeyboard, Keyboard } from 'grammy';
import { config } from '../config/index.js';
import { marketUrl, linkLine } from './links.js';
import type { ActiveRoundState } from '../services/roundWatcher.js';

/** Persistent main menu — ReplyKeyboard (keyword buttons) */
export const BTN = {
  LIVE: '📈 Live',
  QUICK_BET: '⚡ Quick bet',
  WALLET: '💼 Wallet',
  OPEN: '📂 Positions',
  ORDERS: '📋 Orders',
  LOG: '🕘 History',
  PNL: '📊 PnL',
  TREND: '📖 Book',
  PAUSE: '🔕 Mute alerts',
  RESUME: '🔔 Unmute alerts',
  PROFILE: '👤 Profile',

  EXPORT_KEY: '🔐 Export Key',
  WITHDRAW: '💸 Withdraw',
  HELP: '❓ Help',

  UP: '🟢 UP',
  DOWN: '🔴 DOWN',
  A5: '$5',
  A10: '$10',
  A25: '$25',
  A50: '$50',
  CUSTOM: '✏️ Custom',
  CONFIRM: '✅ Confirm',
  CANCEL: '❌ Cancel',
  BACK: '‹ Back',
} as const;

export const MAIN_BTN_SET = new Set<string>([
  BTN.LIVE,
  BTN.QUICK_BET,
  BTN.WALLET,
  BTN.OPEN,
  BTN.ORDERS,
  BTN.LOG,
  BTN.PNL,
  BTN.TREND,
  BTN.PAUSE,
  BTN.RESUME,
  BTN.PROFILE,
]);

/** Buttons used inside the quick-bet / confirm flow (side, amount, confirm, back). */
export const BET_FLOW_BTN_SET = new Set<string>([
  BTN.UP,
  BTN.DOWN,
  BTN.A5,
  BTN.A10,
  BTN.A25,
  BTN.A50,
  BTN.CUSTOM,
  BTN.CONFIRM,
  BTN.CANCEL,
  BTN.BACK,
]);

/** Buttons used inside the Profile screen. */
export const SETTINGS_BTN_SET = new Set<string>([
  BTN.EXPORT_KEY,
  BTN.WITHDRAW,
  BTN.LOG,
  BTN.PAUSE,
  BTN.RESUME,
  BTN.HELP,
  BTN.BACK,
]);

/**
 * Labels from earlier versions. Telegram clients keep showing the old keyboard
 * until a new one is sent, so taps on old labels must still work.
 */
export const LEGACY_BTN: Record<string, string> = {
  'Live': BTN.LIVE,
  'Wallet': BTN.WALLET,
  'Open': BTN.OPEN,
  'Log': BTN.LOG,
  'Trend': BTN.TREND,
  '🩺 System': '/help',
  '🖥️ Live': BTN.LIVE,
  '⚡ Quick Bet': BTN.QUICK_BET,
  'Quick Bet': BTN.QUICK_BET,
  'PnL': BTN.PNL,
  '◾ Pause': BTN.PAUSE,
  '▶️ Resume': BTN.RESUME,
  '✏️ Custom': BTN.CUSTOM,
  '✅ Confirm': BTN.CONFIRM,
  '❌ Cancel': BTN.CANCEL,
  '« Back': BTN.BACK,
  'Settings': BTN.PROFILE,
  '⚙️ Settings': BTN.PROFILE,
};

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
  const lockKnown = round.lockPrice > 0;
  const priceKnown = round.currentPrice > 0;
  const diffStr = !lockKnown
    ? 'syncing'
    : round.priceDiff === 0
    ? '±$0.00'
    : round.priceDiff > 0
    ? `+$${formatPrice(round.priceDiff)}`
    : `-$${formatPrice(Math.abs(round.priceDiff))}`;

  const upPayout = round.upPrice > 0 ? (1 / round.upPrice).toFixed(2) : '—';
  const downPayout = round.downPrice > 0 ? (1 / round.downPrice).toFixed(2) : '—';
  const trend = round.currentTrend === 'UP' ? '🟢' : round.currentTrend === 'DOWN' ? '🔴' : '';

  const lines = [
    `📈 <b>${esc(round.title)}</b>  ·  ⏳ ${formatTimer(round.secondsRemaining)} left`,
    ``,
    `🔒 Lock   ${lockKnown ? `$${esc(formatPrice(round.lockPrice))}` : 'syncing…'}`,
    `💹 Now    ${priceKnown ? `$${esc(formatPrice(round.currentPrice))}  ${esc(diffStr)} ${trend}`.trim() : 'connecting…'}`,
    ``,
    `<b>UP</b> ${(round.upPrice * 100).toFixed(0)}¢ (${esc(upPayout)}x)   <b>DOWN</b> ${(round.downPrice * 100).toFixed(0)}¢ (${esc(downPayout)}x)`,
  ];
  if (balance !== undefined) lines.push(``, `💰 Balance  $${esc(formatPrice(balance))}`);
  if (round.isLocked) lines.push(``, `🔒 <b>Betting locked</b>. Round is closing.`);
  if (config.trading.dryRun) lines.push(``, `<i>🧪 Test mode: no real orders</i>`);
  const link = linkLine(marketUrl(round.roundSlug), 'Market');
  return lines.join('\n') + link;
}

/** Inline controls under the round card: bet shortcuts + refresh. */
export function buildRoundInline(round: ActiveRoundState): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!round.isLocked) {
    kb.text(`UP ${(round.upPrice * 100).toFixed(0)}¢`, 'b:s:UP').text(
      `DOWN ${(round.downPrice * 100).toFixed(0)}¢`,
      'b:s:DOWN'
    );
    kb.row();
  }
  return kb.text('🔄 Refresh', 'r:rf');
}

/** Amount presets for an inline bet (side is UP or DOWN). */
export function buildAmountInline(side: 'UP' | 'DOWN'): InlineKeyboard {
  return new InlineKeyboard()
    .text('$5', `b:a:${side}:5`)
    .text('$10', `b:a:${side}:10`)
    .text('$25', `b:a:${side}:25`)
    .text('$50', `b:a:${side}:50`)
    .row()
    .text('Custom', `b:c:${side}`)
    .text('‹ Back', 'r:rf');
}

/** Main reply keyboard: quick actions and account views. */
export function buildMainKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.LIVE)
    .text(BTN.QUICK_BET)
    .text(BTN.WALLET)
    .row()
    .text(BTN.OPEN)
    .text(BTN.ORDERS)
    .text(BTN.PROFILE)
    .row()
    .text(BTN.PNL)
    .text(BTN.TREND)
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

/** Profile actions live in the reply keyboard, like the Quick bet flow. */
export function buildSettingsKeyboard(paused = false): Keyboard {
  return new Keyboard()
    .text(BTN.EXPORT_KEY)
    .text(BTN.WITHDRAW)
    .row()
    .text(BTN.LOG)
    .text(paused ? BTN.RESUME : BTN.PAUSE)
    .row()
    .text(BTN.HELP)
    .text(BTN.BACK)
    .resized()
    .persistent();
}

/** Settings card: wallet security and account actions. */
export function buildSettingsInline(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔐 Export Private Key', 's:x')
    .row()
    .text('💸 Withdraw', 'w:s')
    .text('❓ Help', 's:h')
    .row()
    .text('✕ Close', 's:c');
}

/** One button per open position — tap to see details / close. */export function buildPositionsInline(
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
    .text('Close / Sell now', `p:c:${key}`)
    .row()
    .text('‹ Back to positions', 'p:l');
}

/** Just a back button — used after the position is closed. */
export function buildPositionBackInline(): InlineKeyboard {
  return new InlineKeyboard().text('‹ Back to positions', 'p:l');
}
