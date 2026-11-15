import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { roundWatcher } from '../services/roundWatcher.js';
import { btcPriceService } from '../services/btcPrice.js';
import { predictFunApi } from '../exchanges/predictfun/api.js';
import { riskManager } from '../execution/risk.js';
import {
  BTN,
  MAIN_BTN_SET,
  esc,
  buildRoundCard,
  buildMainKeyboard,
  buildSideKeyboard,
  buildAmountKeyboard,
  buildConfirmKeyboard,
  buildPositionsInline,
  buildPositionActionsInline,
  buildPositionBackInline,
} from './keyboards.js';
import {
  sideOfOutcome,
  type PredictMarket,
  type PredictPosition,
} from '../exchanges/predictfun/types.js';
import {
  registerNotifyTarget,
  unregisterNotifyTarget,
  setNotifyPaused,
  isNotifyPaused,
} from '../services/autoServices.js';
import { parseBetText } from './betText.js';
import { marketUrl, portfolioUrl, addressUrl, txUrl, linkLine } from './links.js';
import { userRegistry } from '../users/registry.js';
import { userAccounts } from '../users/accounts.js';
import { getUserRuntime, ensureUserRuntime, dropUserRuntime } from '../users/runtime.js';

type BetDraft = {
  outcome?: 'UP' | 'DOWN';
  amountUsdt?: number;
  /** Custom limit price in dollars (e.g. 0.50 for 50¢). */
  limitPrice?: number;
  /** Pinned market id: a confirmed bet must never roll into the next round. */
  marketId?: string;
  awaitingCustom?: boolean;
};

const betDraft: Map<number, BetDraft> = new Map();

/**
 * Per-member order guards: a double-tapped Confirm must never submit two live
 * orders, and rapid-fire betting is throttled to protect the shared API quota.
 */
const ORDERS_IN_FLIGHT: Set<number> = new Set();
const LAST_ORDER_AT: Map<number, number> = new Map();
const ORDER_THROTTLE_MS = 3_000;

/**
 * Withdrawal flow state: 🏦 Wallet → 💸 Withdraw → paste address → amount
 * (or `all`) → inline Confirm → USDT sent + BSCScan link.
 */
type WithdrawDraft = { address?: string; amount?: 'all' | number };
const withdrawDrafts: Map<number, WithdrawDraft> = new Map();
/** Prevents a double-tapped Confirm from broadcasting two transfers. */
const WITHDRAW_IN_FLIGHT: Set<number> = new Set();

/**
 * Open positions shown in `/positions`, keyed by a short id so the inline
 * button callback stays well under Telegram's 64-byte limit.
 */
type CachedPosition = { chatId: number; position: PredictPosition };
const positionCache: Map<string, CachedPosition> = new Map();
/** Position ids with a sell order in flight (prevents double-sell). */
const CLOSING_POSITIONS: Set<string> = new Set();

function cachePositions(chatId: number, positions: PredictPosition[]) {
  for (const [key, value] of positionCache) {
    if (value.chatId === chatId) positionCache.delete(key);
  }
  const now = Date.now().toString(36);
  return positions.map((position, i) => {
    const key = `${now}_${i}`;
    positionCache.set(key, { chatId, position });
    return { key, position };
  });
}

function outcomeToSide(name: string): 'UP' | 'DOWN' | null {
  return sideOfOutcome(name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PositionPnl = {
  value: number;
  cost: number;
  pnl: number;
  pct: number;
  known: boolean;
};

function positionPnl(position: PredictPosition, bid: number): PositionPnl {
  const entry = parseFloat(position.avgEntryPrice) || 0;
  const value = bid * position.shares;
  const apiPnl = parseFloat(position.pnlUsd ?? '');

  if (entry > 0) {
    const cost = entry * position.shares;
    const pnl = value - cost;
    return { value, cost, pnl, pct: cost > 0 ? (pnl / cost) * 100 : 0, known: true };
  }

  // API sometimes returns averageBuyPriceUsd = 0 right after a fill. Fall back
  // to the API's own PnL instead of pretending the whole value is profit.
  if (Number.isFinite(apiPnl)) {
    const cost = Math.max(0, value - apiPnl);
    return {
      value,
      cost,
      pnl: apiPnl,
      pct: cost > 0 ? (apiPnl / cost) * 100 : 0,
      known: true,
    };
  }

  return { value, cost: 0, pnl: 0, pct: 0, known: false };
}

function fmtPnl(p: PositionPnl): string {
  return p.known ? `${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)}` : '—';
}

function fmtPct(p: PositionPnl): string {
  return p.known ? `${p.pct >= 0 ? '+' : ''}${p.pct.toFixed(1)}%` : '—';
}

/** `/start abc123` / `/start@MyBot abc123` → "abc123". */
function joinCodeFrom(ctx: Context): string | undefined {
  const text = (ctx.message?.text || '').trim();
  const m = text.match(/^\/start(?:@\w+)?\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}

function accessStatus(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return 'none' as const;
  return userRegistry.ensureUser(
    userId,
    ctx.from?.username,
    joinCodeFrom(ctx)
  );
}

function isAllowed(ctx: Context): boolean {
  return accessStatus(ctx) === 'active';
}

async function notAllowed(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const result = accessStatus(ctx);
  if (result === 'active') return; // approved in the meantime
  if (result === 'blocked') {
    return ctx.reply(
      '⛔ <b>Access removed hai.</b>\nAdmin se contact karo agar access wapas chahiye.',
      { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
    );
  }
  if (result === 'denied') {
    return ctx.reply(
      [
        '🔒 <b>Invite-only bot</b>',
        ``,
        `Owner se invite code lo, phir ye bhejo:`,
        `<code>/start YOUR_CODE</code>`,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
    );
  }
  return ctx.reply(
    [
      '⛔ <b>Bot full hai</b>',
      ``,
      `Is bot par max <b>${userRegistry.maxUsers()} members</b> allowed hain aur sab slots bhar chuke hain.`,
      `Owner se contact karo agar koi slot khulwana hai.`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
  );
}

// ───────────────────────────────────────────────
// Admin commands — /users, /kick, /unban
// No approval flow: /start auto-creates every member's account.
// ───────────────────────────────────────────────
function adminGate(ctx: Context): boolean {
  const userId = ctx.from?.id;
  // Deliberately strict: with no TELEGRAM_ALLOWED_USERS there is no "owner",
  // and treating every stranger as admin used to expose /reset and /export.
  return userId != null && userRegistry.isAdmin(userId);
}

async function adminDenied(ctx: Context) {
  return ctx.reply(
    '⛔ <b>Admin only.</b>\nApna Telegram id <code>TELEGRAM_ALLOWED_USERS</code> mein set karo.',
    { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
  );
}

export async function handleUsers(ctx: Context) {
  if (!adminGate(ctx)) return adminDenied(ctx);

  const users = userRegistry.all();
  const members = users.filter((u) => u.role === 'user');
  const admins = users.filter((u) => u.role === 'admin');
  const usedSlots = members.filter((u) => u.status !== 'blocked').length;

  const lines = [
    `👥 <b>Members</b> — ${usedSlots}/${userRegistry.maxUsers()} slots used`,
    '',
  ];
  for (const u of admins) {
    lines.push(`👑 ${u.username ? '@' + u.username : 'admin'} — <code>${u.telegramId}</code>`);
  }
  for (const u of members) {
    const s = userRegistry.getStats(u.telegramId);
    const tag = u.status === 'blocked' ? '🚫 blocked' : u.status === 'pending' ? '⏳ pending' : '✅';
    lines.push(
      `${tag} ${u.username ? '@' + u.username : 'anon'} (<code>${u.telegramId}</code>) — ` +
        `${s.trades} trades · PnL ${s.pnlUsd >= 0 ? '+' : ''}$${s.pnlUsd.toFixed(2)}`
    );
  }
  if (userRegistry.joinCodeRequired()) {
    lines.push('', '🔒 Invite code required for new members.');
  }
  lines.push('', `/kick &lt;id&gt; — block member · /unban &lt;id&gt; — restore access`);
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: mainKb(ctx) });
}

export async function handleKick(ctx: Context) {
  if (!adminGate(ctx)) return adminDenied(ctx);

  const id = Number((ctx.message?.text || '').split(/\s+/)[1]);
  if (!Number.isFinite(id) || id <= 0) {
    return ctx.reply('Usage: <code>/kick &lt;userId&gt;</code>', {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }

  const result = userRegistry.kick(id);
  if (result === 'admin') {
    return ctx.reply('👑 Admin ko kick nahi kar sakte.', { reply_markup: mainKb(ctx) });
  }
  if (result === 'notfound') {
    return ctx.reply(`❌ <code>${id}</code> registry mein nahi mila.`, {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }
  // Drop the cached signer (it holds a decrypted key) and mute alerts.
  dropUserRuntime(id);
  unregisterNotifyTarget(id);

  await ctx.reply(`🚫 <code>${id}</code> ko block kar diya (wallet/funds untouched).`, {
    reply_markup: mainKb(ctx),
  });
  await ctx.api
    .sendMessage(id, 'ℹ️ Tumhara is bot ka access admin ne remove kar diya hai.')
    .catch(() => {});
}

export async function handleUnban(ctx: Context) {
  if (!adminGate(ctx)) return adminDenied(ctx);

  const id = Number((ctx.message?.text || '').split(/\s+/)[1]);
  if (!Number.isFinite(id) || id <= 0) {
    return ctx.reply('Usage: <code>/unban &lt;userId&gt;</code>', {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }

  const result = userRegistry.unban(id);
  if (result === 'admin') {
    return ctx.reply('👑 Admin hamesha active hota hai.');
  }
  if (result === 'notfound') {
    return ctx.reply(`❌ <code>${id}</code> registry mein nahi mila (ya slots full hain).`, {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }
  if (result === 'notblocked') {
    return ctx.reply(`ℹ️ <code>${id}</code> blocked nahi hai.`, { reply_markup: mainKb(ctx) });
  }

  await ctx.reply(`✅ <code>${id}</code> ka access restore kar diya.`, {
    reply_markup: mainKb(ctx),
  });
  await ctx.api
    .sendMessage(id, '✅ Tumhara access restore kar diya gaya. /start dabao.')
    .catch(() => {});
}

function mainKb(ctx: Context) {
  const chatId = ctx.chat?.id;
  return buildMainKeyboard(chatId ? isNotifyPaused(chatId) : false);
}

function clearDraft(userId: number) {
  betDraft.delete(userId);
}

// ───────────────────────────────────────────────
// /start + Live dashboard
// ───────────────────────────────────────────────
export async function handleStart(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Registration + invite code + cap check all live in one place.
  const access = accessStatus(ctx);
  if (access !== 'active') return notAllowed(ctx);

  if (ctx.chat?.id) registerNotifyTarget(ctx.chat.id);
  clearDraft(userId);

  // Every member gets their own fresh trading wallet, auto-created.
  const { account, created } = userAccounts.ensureAccount(userId, ctx.from?.username);
  if (!account) {
    return ctx.reply(
      '❌ Wallet create nahi ho paya. Admin se server logs check karwao (WALLET_MASTER_KEY / data folder permissions).',
      { reply_markup: mainKb(ctx) }
    );
  }

  if (created) {
    const welcome = [
      `🎉 <b>Welcome! Aapka trading account ban gaya.</b>`,
      ``,
      `💳 <b>Aapka wallet (sirf aapka):</b>`,
      `<code>${account.address}</code>`,
      linkLine(addressUrl(account.address), 'View on BSCScan'),
      ``,
      `1️⃣ Is address par <b>USDT (BEP-20)</b> + thoda <b>BNB</b> (gas) bhejo.`,
      `2️⃣ 🏦 Wallet button se balance check karo.`,
      `3️⃣ ⚡ Quick Bet se BTC 5M up/down trading shuru!`,
      ``,
      `🔒 Private key encrypted hai — chahiye to <code>/export</code>`,
      `💸 Withdraw karne ke liye: 🏦 Wallet → 💸 Withdraw`,
    ].join('\n');
    return ctx.reply(welcome, {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }

  const round = roundWatcher.getCurrentRound();
  let balance: number | undefined;
  try {
    const rt = getUserRuntime(userId);
    if (rt) {
      const bal = await rt.api.getBalance();
      balance = bal.ok ? bal.usdt : undefined;
    }
  } catch {
    balance = undefined;
  }

  const card = round
    ? buildRoundCard(round, balance)
    : '⏳ Loading current BTC 5M round... Try again in a moment.';

  await ctx.reply(card, {
    parse_mode: 'HTML',
    reply_markup: mainKb(ctx),
  });
}

// ───────────────────────────────────────────────
// /help + System
// ───────────────────────────────────────────────
export async function handleHelp(ctx: Context) {
  if (!isAllowed(ctx)) return notAllowed(ctx);

  const stats = riskManager.getStats();
  const help = [
    '🩺 <b>System</b>',
    '',
    '<b>Keyboard:</b>',
    '🖥️ Live — current round',
    '🏦 Wallet — USDT / BNB',
    '📦 Open — open positions',
    '📜 Log — recent trades',
    '📈 Trend — orderbook',
    '⚡ Quick Bet — place a bet',
    '📊 PnL — stats',
    '◾ Pause — mute round alerts',
    '',
    `<b>DRY RUN:</b> ${config.trading.dryRun ? '✅ Active' : '❌ Off (live)'}`,
    `<b>Max Bet:</b> $${config.trading.maxBetUsdt}`,
    `<b>Daily Loss Limit:</b> $${config.trading.dailyLossLimitUsdt}`,
    `<b>Circuit:</b> ${stats.isTripped ? '🚨 TRIPPED' : '✅ Armed'}`,
    '',
    'Commands still work: /up 10 · /down 10 · /export · /withdraw',
    ...(adminGate(ctx) ? ['Admin: /users · /kick <id> · /unban <id> · /reset'] : []),
    '',
    '<b>⚡ Fast typing:</b>',
    '<code>up 5 45</code> → $5 UP @ 45¢ (limit)',
    '<code>down 2 60</code> → $2 DOWN @ 60¢',
    '<code>up 5</code> → $5 UP at market price',
    '📦 Open → tap a position → <b>Close / Sell</b> to book profit',
  ].join('\n');

  await ctx.reply(help, { parse_mode: 'HTML', reply_markup: mainKb(ctx) });
}

// ───────────────────────────────────────────────
// /up and /down quick commands
// ───────────────────────────────────────────────
// parseBetText lives in betText.ts (pure, unit-tested) — imported at the top.

async function quickBet(
  ctx: Context,
  outcome: 'UP' | 'DOWN',
  amountStr?: string,
  priceStr?: string
) {
  if (!isAllowed(ctx)) return notAllowed(ctx);

  const amount = amountStr ? parseFloat(amountStr) : NaN;
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply(
      `Usage: /${outcome.toLowerCase()} &lt;amount&gt; [price¢]\n` +
        `Example: /${outcome.toLowerCase()} 10   or   /${outcome.toLowerCase()} 10 55`,
      { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
    );
  }

  let limitPrice: number | undefined;
  if (priceStr != null) {
    const raw = parseFloat(priceStr);
    limitPrice = raw < 1 ? raw : raw / 100;
    if (!(limitPrice >= 0.01 && limitPrice <= 0.99)) {
      return ctx.reply('❌ Price 1¢ se 99¢ ke beech hona chahiye (e.g. 55 = 55¢).', {
        reply_markup: mainKb(ctx),
      });
    }
  }

  return showConfirm(ctx, outcome, amount, limitPrice);
}

export function handleUp(ctx: Context) {
  const args = (ctx.message?.text || '').split(/\s+/);
  return quickBet(ctx, 'UP', args[1], args[2]);
}

export function handleDown(ctx: Context) {
  const args = (ctx.message?.text || '').split(/\s+/);
  return quickBet(ctx, 'DOWN', args[1], args[2]);
}

// ───────────────────────────────────────────────
// Confirm card (reply keyboard)
// ───────────────────────────────────────────────
async function showConfirm(
  ctx: Context,
  outcome: 'UP' | 'DOWN',
  amountUsdt: number,
  limitPrice?: number
) {
  const round = roundWatcher.getCurrentRound();
  const userId = ctx.from?.id;

  if (!userId) return;

  // A typed bet ("up 5") can reach this card before /start created the wallet.
  const { account } = userAccounts.ensureAccount(userId, ctx.from?.username);
  if (!account) {
    return ctx.reply('❌ Account wallet create nahi ho paya. Thodi der baad /start try karo.', {
      reply_markup: mainKb(ctx),
    });
  }

  const userCheck = userRegistry.canBet(userId);
  if (!userCheck.allowed) {
    return ctx.reply(`🚫 <b>Trade Blocked</b>\n${esc(userCheck.reason)}`, {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }

  if (!round) {
    return ctx.reply('❌ No active round found. Please try again in a moment.', {
      reply_markup: mainKb(ctx),
    });
  }

  if (round.isLocked) {
    return ctx.reply(
      `⛔ Round is locked! Less than ${config.trading.lockGuardSeconds}s remaining.\nWait for the next round.`,
      { reply_markup: mainKb(ctx) }
    );
  }

  const { allowed, reason } = riskManager.canTrade(amountUsdt);
  if (!allowed) {
    return ctx.reply(`🚫 <b>Trade Blocked</b>\n${esc(reason)}`, {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }

  // Order placement needs a synced market in every mode (dry-run included),
  // otherwise the confirm card promises something we cannot execute.
  if (!round.rawMarket) {
    return ctx.reply('❌ Live market data not synced yet. Wait a few seconds and tap 🖥️ Live.', {
      reply_markup: mainKb(ctx),
    });
  }

  const marketPrice = outcome === 'UP' ? round.upPrice : round.downPrice;
  const price = limitPrice ?? marketPrice;
  if (!(price > 0) || price >= 1) {
    return ctx.reply(
      `❌ No valid ask liquidity for ${outcome} right now (price=${price}). Try the other side or wait.`,
      { reply_markup: mainKb(ctx) }
    );
  }

  const shares = amountUsdt / price;
  const payout = shares;
  const profit = payout - amountUsdt;
  const feeBps = Number(round.rawMarket.feeRateBps ?? 0);
  const feePct = Number.isFinite(feeBps) && feeBps > 0 ? feeBps / 100 : 0;
  const isLimit = limitPrice != null;
  const belowMarket = isLimit && marketPrice > 0 && limitPrice < marketPrice;

  betDraft.set(userId, {
    outcome,
    amountUsdt,
    limitPrice,
    marketId: round.marketId,
  });

  const confirmText = [
    `🎯 <b>Confirm Your Bet</b>`,
    ``,
    `Market: ${esc(round.title)}`,
    `Outcome: ${outcome === 'UP' ? '🟢 UP' : '🔴 DOWN'}`,
    `Price: ${(price * 100).toFixed(0)}¢ per share${isLimit ? ' (limit)' : ''}`,
    `Amount: <b>$${amountUsdt.toFixed(2)} USDT</b>`,
    `Shares: ${shares.toFixed(2)}`,
    `Est. Payout: <b>$${payout.toFixed(2)} USDT</b> (before fees)`,
    `Est. Profit: <b>+$${profit.toFixed(2)} USDT</b> (${((profit / amountUsdt) * 100).toFixed(1)}%)`,
    feePct > 0 ? `ℹ️ Market fee: ${feePct.toFixed(2)}%` : '',
    linkLine(marketUrl(round.roundSlug), 'Open market'),
    isLimit
      ? belowMarket
        ? `⏳ Below market (${(marketPrice * 100).toFixed(0)}¢) — order book mein lagega, fill hone par position banegi.`
        : `✅ Limit price market ke barabar/upar — turant fill hone chahiye.`
      : `ℹ️ Marketable order — price move hone par slippage cap (${(config.trading.slippageBps / 100).toFixed(1)}%) tak pay ho sakta hai.`,
    config.trading.dryRun ? `\n🧪 <b>DRY RUN — No real order</b>` : '',
  ]
    .join('\n')
    .trim();

  await ctx.reply(confirmText, {
    parse_mode: 'HTML',
    reply_markup: buildConfirmKeyboard(),
  });
}

/** @deprecated kept for any external imports — now reply-keyboard flow */
export async function executeBet(ctx: Context, outcome: 'UP' | 'DOWN', amountUsdt: number) {
  return showConfirm(ctx, outcome, amountUsdt);
}

// ───────────────────────────────────────────────
// Callback Query — position close / sell flow
// ───────────────────────────────────────────────
export async function handleCallbackQuery(ctx: Context) {
  const data = ctx.callbackQuery?.data || '';
  const chatId = ctx.chat?.id;

  if (!isAllowed(ctx)) {
    await ctx.answerCallbackQuery({ text: '⛔ Not authorized' });
    return;
  }

  try {
    // Export card buttons (x:y:<userId> / x:n:<userId>)
    if (await handleExportCallback(ctx, data)) return;
    // Withdraw flow buttons (w:s / w:go / w:no)
    if (await handleWithdrawCallback(ctx, data)) return;

    if (data === 'p:l') {
      await ctx.answerCallbackQuery();
      try {
        await ctx.deleteMessage();
      } catch {
        // message may be too old to delete — ignore
      }
      return handlePositions(ctx);
    }

    if (data.startsWith('p:v:')) {
      await ctx.answerCallbackQuery();
      return showPositionDetail(ctx, data.slice(4));
    }

    if (data.startsWith('p:c:')) {
      if (!chatId) return;
      await ctx.answerCallbackQuery({ text: 'Selling…' });
      return closePosition(ctx, data.slice(4));
    }

    await ctx.answerCallbackQuery({
      text: 'Use the bottom keyboard buttons',
      show_alert: false,
    });
  } catch (e: any) {
    logger.error({ err: e, data }, 'Callback handler failed');
    try {
      await ctx.answerCallbackQuery({ text: '❌ ' + (e?.message || 'Error'), show_alert: true });
    } catch {
      // ignore
    }
  }
}

/** Best bid + market data for a cached position. */
async function getPositionQuote(
  position: PredictPosition
): Promise<{ market: PredictMarket | null; bid: number | null }> {
  const market = await predictFunApi.getMarket(position.marketId);
  if (!market) return { market: null, bid: null };

  const side = outcomeToSide(position.outcome);
  const outcome =
    market.outcomes.find(
      (o) => String(o.onChainId || o.tokenId || '') === position.tokenId
    ) || market.outcomes.find((o) => outcomeToSide(o.name) === side);

  const bid = outcome?.bestBid?.price;
  return {
    market,
    bid: typeof bid === 'number' && bid > 0 && bid < 1 ? bid : null,
  };
}

async function showPositionDetail(ctx: Context, key: string) {
  const cached = positionCache.get(key);
  const chatId = ctx.chat?.id;

  if (!cached || cached.chatId !== chatId) {
    return ctx.reply('⌛ Position list expired — tap 📦 Open again.', {
      reply_markup: mainKb(ctx),
    });
  }

  const pos = cached.position;
  const { bid } = await getPositionQuote(pos);
  const entry = parseFloat(pos.avgEntryPrice) || 0;

  const text = [
    `📦 <b>Position</b>`,
    ``,
    `Market: ${esc(pos.marketTitle || pos.marketId)}`,
    linkLine(marketUrl(pos.slug), 'Open market'),
    `Outcome: ${outcomeToSide(pos.outcome) === 'UP' ? '🟢 UP' : '🔴 DOWN'}`,
    `Shares: <b>${pos.shares.toFixed(4)}</b>`,
    entry > 0 ? `Entry: ${(entry * 100).toFixed(1)}¢` : '',
    bid != null ? `Sell now (best bid): <b>${(bid * 100).toFixed(1)}¢</b>` : '⏳ No buyer right now',
    ...(bid != null
      ? (() => {
          const q = positionPnl(pos, bid);
          return [
            `Value: <b>$${q.value.toFixed(2)}</b>`,
            `PnL: <b>${fmtPnl(q)}</b> (${fmtPct(q)})`,
          ];
        })()
      : []),
    ``,
    bid != null
      ? '🔴 <b>Close / Sell</b> dabao → profit book ho jayega (before fees).'
      : 'Bid aane ka wait karo, phir close kar sakte ho.',
  ]
    .filter(Boolean)
    .join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: buildPositionActionsInline(key),
  });
}

async function closePosition(ctx: Context, key: string) {
  const cached = positionCache.get(key);
  const chatId = ctx.chat?.id;

  if (!cached || cached.chatId !== chatId) {
    return ctx.reply('⌛ Position list expired — tap 📦 Open again.', {
      reply_markup: mainKb(ctx),
    });
  }

  const pos = cached.position;
  if (pos.isResolved || pos.isSettled) {
    return ctx.editMessageText(
      '✅ Ye position already resolve ho chuki hai — auto-redeem handle karega.',
      { reply_markup: buildPositionActionsInline(key) }
    );
  }

  const side = outcomeToSide(pos.outcome);
  if (!side) {
    return ctx.editMessageText('❌ Position ka outcome samajh nahi aaya.', {
      reply_markup: buildPositionActionsInline(key),
    });
  }

  const { market, bid } = await getPositionQuote(pos);
  if (!market || bid == null) {
    return ctx.editMessageText(
      '⚠️ Abhi koi buyer (bid) nahi hai — thodi der baad try karo.',
      { reply_markup: buildPositionActionsInline(key) }
    );
  }

  const owner = ctx.from?.id;
  const rt = owner ? getUserRuntime(owner) : null;
  if (!rt) {
    return ctx.editMessageText('❌ Account wallet load nahi hua — thodi der baad try karo.', {
      reply_markup: buildPositionActionsInline(key),
    });
  }

  const q = positionPnl(pos, bid);

  // A double-tapped Close must not submit two sell orders.
  if (CLOSING_POSITIONS.has(key)) {
    return ctx.editMessageText('⏳ Sell already in progress…', {
      reply_markup: buildPositionActionsInline(key),
    });
  }
  CLOSING_POSITIONS.add(key);

  await ctx.editMessageText(
    `⏳ Selling ${pos.shares.toFixed(4)} ${side} @ ${(bid * 100).toFixed(0)}¢…`,
    { reply_markup: buildPositionActionsInline(key) }
  );

  try {
    await rt.signer.init();
    const result = await rt.signer.placeSell(market, side, pos.shares, bid);

    if (!result.success) {
      riskManager.recordFailure(result.error || 'Sell failed');
      return ctx.editMessageText(
        `❌ <b>Close failed</b>\n\n${esc(result.error)}\n\nPosition abhi bhi open hai.`,
        { parse_mode: 'HTML', reply_markup: buildPositionActionsInline(key) }
      );
    }

    // Position is closed — let the risk manager account for the realised PnL.
    if (q.known) riskManager.recordSettlement(pos.marketId, q.pnl, side, owner);
    positionCache.delete(key);

    logger.info(
      { marketId: pos.marketId, side, shares: pos.shares, bid, pnl: q.pnl, orderId: result.orderId },
      'Closed position via SELL order'
    );

    await ctx.editMessageText(
      [
        `✅ <b>Position Closed</b>`,
        ``,
        `Sold: ${pos.shares.toFixed(4)} ${side} @ ${(bid * 100).toFixed(0)}¢`,
        `Proceeds: ~$${q.value.toFixed(2)} USDT`,
        `Profit: <b>${fmtPnl(q)}</b> (${fmtPct(q)}) <i>(before fees)</i>`,
        `Order: <code>${result.orderId || result.orderHash || 'N/A'}</code>`,
        linkLine(marketUrl(pos.slug), 'Open market'),
        ``,
        config.trading.dryRun ? '' : 'ℹ️ Fill hone ke baad 📦 Open se confirm kar lena.',
      ]
        .filter(Boolean)
        .join('\n'),
      { parse_mode: 'HTML', reply_markup: buildPositionBackInline() }
    );
  } catch (e: any) {
    logger.error({ err: e, key }, 'Failed to close position');
    riskManager.recordFailure(e?.message || 'Sell error');
    await ctx.editMessageText(`❌ <b>Close error</b>\n\n${esc(e?.message || String(e))}`, {
      parse_mode: 'HTML',
      reply_markup: buildPositionActionsInline(key),
    });
  } finally {
    CLOSING_POSITIONS.delete(key);
  }
}

// ───────────────────────────────────────────────
// Place actual / dry-run order
// ───────────────────────────────────────────────
async function placeOrder(
  ctx: Context,
  outcome: 'UP' | 'DOWN',
  amountUsdt: number,
  limitPrice?: number,
  expectedMarketId?: string
) {
  const userId = ctx.from?.id;
  const round = roundWatcher.getCurrentRound();
  if (!userId) return;

  // Guard against a double-tapped Confirm creating two live orders.
  if (ORDERS_IN_FLIGHT.has(userId)) {
    return ctx.reply('⏳ Pichla order abhi process ho raha hai — 2 second ruko.', {
      reply_markup: mainKb(ctx),
    });
  }
  const waitMs = ORDER_THROTTLE_MS - (Date.now() - (LAST_ORDER_AT.get(userId) ?? 0));
  if (waitMs > 0) {
    return ctx.reply(`⏳ Thoda ruko — ${Math.ceil(waitMs / 1000)}s baad dobara try karo.`, {
      reply_markup: mainKb(ctx),
    });
  }
  LAST_ORDER_AT.set(userId, Date.now());

  if (!round) {
    return ctx.reply('❌ Round expired. Please start a new bet.', { reply_markup: mainKb(ctx) });
  }
  // Guard against the round rolling over between the confirm card and this
  // call: never execute a bet pinned to round X on round X+1.
  if (expectedMarketId && round.marketId !== expectedMarketId) {
    return ctx.reply('⛔ Round changed since you confirmed — bet cancelled for safety.', {
      reply_markup: mainKb(ctx),
    });
  }
  if (round.isLocked) {
    return ctx.reply('⛔ Round locked! Too late to bet.', { reply_markup: mainKb(ctx) });
  }
  if (!round.rawMarket) {
    return ctx.reply('❌ No live Predict.fun market synced yet. Tap 🖥️ Live.', {
      reply_markup: mainKb(ctx),
    });
  }

  const { allowed, reason } = riskManager.canTrade(amountUsdt);
  if (!allowed) {
    return ctx.reply(`🚫 ${reason}`, { reply_markup: mainKb(ctx) });
  }

  // Per-member daily loss cap (multi-user club mode).
  if (userId) {
    const userCheck = userRegistry.canBet(userId);
    if (!userCheck.allowed) {
      return ctx.reply(`🚫 <b>Trade Blocked</b>\n${esc(userCheck.reason)}`, {
        parse_mode: 'HTML',
        reply_markup: mainKb(ctx),
      });
    }
  }

  const marketPrice = outcome === 'UP' ? round.upPrice : round.downPrice;
  const price = limitPrice ?? marketPrice;
  if (!(price > 0) || price >= 1) {
    return ctx.reply(`❌ No valid ask liquidity for ${outcome} (price=${price}).`, {
      reply_markup: mainKb(ctx),
    });
  }

  if (config.trading.dryRun) {
    riskManager.recordTrade({
      timestamp: Date.now(),
      marketId: round.marketId,
      outcome,
      amountUsdt,
      price,
      userId,
      settled: false,
    });
    if (userId) userRegistry.recordBet(userId);

    logger.info({ marketId: round.marketId, outcome, amountUsdt, price }, '[DRY RUN] Trade recorded');

    return ctx.reply(
      [
        `✅ <b>[DRY RUN] Order Simulated</b>`,
        ``,
        `Market: ${esc(round.title)}`,
        `Outcome: ${outcome === 'UP' ? '🟢 UP' : '🔴 DOWN'}`,
        `Amount: $${amountUsdt.toFixed(2)} USDT`,
        `Price: ${(price * 100).toFixed(0)}¢`,
        `Shares: ${(amountUsdt / price).toFixed(2)}`,
        ``,
        `ℹ️ Set <code>DRY_RUN=false</code> to place real orders.`,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
    );
  }

  // Per-user runtime: balance & signing are isolated to this member's wallet.
  const rt = userId ? getUserRuntime(userId) : null;
  if (!rt) {
    return ctx.reply('❌ Pehle /start dabao — tumhara trading account ban jayega.', {
      reply_markup: mainKb(ctx),
    });
  }

  // Pre-flight: never send a live order the wallet cannot fund, and keep gas
  // for approvals/settlement.
  try {
    const bal = await rt.api.getBalance();
    // A failed balance fetch is not the same as an empty wallet — skip the
    // pre-flight rather than blocking/allowing on bogus data.
    if (bal.ok) {
      // A limit order spends exactly `amountUsdt`; a marketable order may pay
      // up to the slippage cap.
      const needed = limitPrice != null
        ? amountUsdt
        : amountUsdt * (1 + config.trading.slippageBps / 10000);
      if (bal.usdt + 1e-9 < needed) {
        return ctx.reply(
          `🚫 <b>Insufficient USDT balance</b>\nNeed ~$${needed.toFixed(2)}, have $${bal.usdt.toFixed(2)}.`,
          { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
        );
      }
      if (bal.bnb < 0.0005) {
        return ctx.reply(
          `⚠️ <b>Low BNB for gas</b>\nBalance: ${bal.bnb.toFixed(6)} BNB. Top up before trading.`,
          { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
        );
      }
    } else {
      logger.warn('Balance unavailable (RPC error) — skipping pre-flight check');
    }
  } catch (e: any) {
    logger.warn({ err: e }, 'Could not verify balance before order — continuing');
  }

  const placing = await ctx.reply('⏳ Signing &amp; submitting order...', {
    parse_mode: 'HTML',
    reply_markup: mainKb(ctx),
  });

  ORDERS_IN_FLIGHT.add(userId);
  try {
    await rt.signer.init();
    const result = await rt.signer.placeBet(round.rawMarket, outcome, amountUsdt, price);

    if (result.success) {
      // A placed limit order is NOT a filled position — record it unfilled and
      // reconcile once the position appears on-chain (see confirmFill...).
      riskManager.recordTrade({
        timestamp: Date.now(),
        marketId: round.marketId,
        outcome,
        amountUsdt,
        price,
        userId,
        orderId: result.orderId || result.orderHash,
        settled: false,
        filled: false,
      });
      if (userId) userRegistry.recordBet(userId);

      logger.info({ marketId: round.marketId, outcome, amountUsdt, orderId: result.orderId }, 'Order placed!');

      await ctx.api.editMessageText(
        ctx.chat!.id,
        placing.message_id,
        [
          `✅ <b>Order Placed!</b>`,
          ``,
          `Market: ${esc(round.title)}`,
          `Outcome: ${outcome === 'UP' ? '🟢 UP' : '🔴 DOWN'}`,
          `Amount: $${amountUsdt.toFixed(2)} USDT`,
          `Order ID: <code>${result.orderId || result.orderHash || 'N/A'}</code>`,
          linkLine(marketUrl(round.roundSlug), 'Open market'),
          ``,
          `⏳ Fill confirm ho raha hai…`,
        ].join('\n'),
        { parse_mode: 'HTML' }
      );

      // Fire-and-forget fill confirmation (5s × 3 attempts).
      void confirmFillAndNotify(ctx, ctx.chat!.id, round.marketId, outcome, userId);
    } else {
      riskManager.recordFailure(result.error || 'Unknown error');
      await ctx.api.editMessageText(
        ctx.chat!.id,
        placing.message_id,
        `❌ <b>Order Failed</b>\n\n${esc(result.error)}`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (e: any) {
    riskManager.recordFailure(e.message);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      placing.message_id,
      `❌ <b>Error:</b> ${esc(e.message)}`,
      { parse_mode: 'HTML' }
    );
  } finally {
    ORDERS_IN_FLIGHT.delete(userId);
  }
}

/**
 * After a live BUY order is placed, poll the position list a few times to
 * confirm the order actually filled. Notifies the chat either way, and marks
 * the trade filled in the risk manager so exposure stays honest.
 */
async function confirmFillAndNotify(
  ctx: Context,
  chatId: number,
  marketId: string,
  outcome: 'UP' | 'DOWN',
  userId?: number
) {
  const rt = userId ? getUserRuntime(userId) : null;
  if (!rt) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(5000);
    try {
      const positions = await rt.api.getPositions();
      const filled = positions.some(
        (p) =>
          p.marketId === marketId &&
          !p.isResolved &&
          outcomeToSide(p.outcome) === outcome
      );
      if (filled) {
        if (riskManager.markFilled(marketId, outcome, userId) > 0) {
          await ctx.api
            .sendMessage(
              chatId,
              `✅ <b>Order filled</b> — ${outcome === 'UP' ? '🟢 UP' : '🔴 DOWN'} position live. 📦 Open mein dikhega.`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        }
        return;
      }
    } catch {
      // positions fetch failed — retry on the next attempt
    }
  }
  await ctx.api
    .sendMessage(
      chatId,
      `ℹ️ <b>Order abhi tak fill nahi hua</b> — limit order book mein lag sakta hai.\n📦 Open mein aadhe minute baad check karo. Unfilled order se koi funds lock nahi hote jab tak fill na ho.`,
      { parse_mode: 'HTML' }
    )
    .catch(() => {});
}

// ───────────────────────────────────────────────
// /balance
// ───────────────────────────────────────────────
export async function handleBalance(ctx: Context) {
  if (!isAllowed(ctx)) return notAllowed(ctx);

  const userId = ctx.from?.id;
  if (!userId) return;
  const rt = ensureUserRuntime(userId, ctx.from?.username);
  if (!rt) {
    return ctx.reply('❌ Account wallet load nahi hua. Thodi der baad try karo.', {
      reply_markup: mainKb(ctx),
    });
  }

  try {
    const { usdt, bnb, ok } = await rt.api.getBalance();
    if (!ok) {
      return ctx.reply('❌ Balance fetch nahi ho paya (RPC error). Thodi der baad try karo.', {
        reply_markup: mainKb(ctx),
      });
    }
    const address = rt.api.getEffectiveAddress();
    // Withdraw is private-chat only; don't render the button in a group.
    const kb =
      ctx.chat?.type === 'private' ? new InlineKeyboard().text('💸 Withdraw', 'w:s') : undefined;
    await ctx.reply(
      [
        `🏦 <b>Aapka Wallet</b>`,
        ``,
        `USDT: <b>$${usdt.toFixed(2)}</b>`,
        `BNB:  <b>${bnb.toFixed(4)} BNB</b> (gas)`,
        address ? `\nAddress: <code>${address}</code>` : '',
        linkLine(portfolioUrl(address), 'Portfolio on Predict.fun'),
        linkLine(addressUrl(address), 'View on BSCScan'),
        ``,
        ctx.chat?.type === 'private'
          ? `💸 Withdraw karne ke liye button dabao (ya <code>/withdraw</code>).`
          : `💸 Withdraw ke liye bot ko DM mein <code>/withdraw</code> bhejo.`,
      ]
        .filter(Boolean)
        .join('\n')
        .trim(),
      { parse_mode: 'HTML', reply_markup: kb }
    );
  } catch (e: any) {
    await ctx.reply(`❌ Could not fetch balance: ${esc(e.message)}`, {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }
}

// ───────────────────────────────────────────────
// /positions  (tap a position → close / sell)
// ───────────────────────────────────────────────
export async function handlePositions(ctx: Context) {
  if (!isAllowed(ctx)) return notAllowed(ctx);

  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const userId = ctx.from?.id;
  if (!userId) return;

  const rt = ensureUserRuntime(userId, ctx.from?.username);
  if (!rt) {
    return ctx.reply('❌ Account wallet load nahi hua. Thodi der baad try karo.', {
      reply_markup: mainKb(ctx),
    });
  }

  try {
    const positions = await rt.api.getPositions();
    const open = positions.filter((p) => !p.isResolved);
    if (open.length === 0) {
      return ctx.reply('📦 No open positions found.', { reply_markup: mainKb(ctx) });
    }

    const cached = cachePositions(chatId, open.slice(0, 10));
    const lines = ['📦 <b>Open Positions</b>', '<i>Tap a position to view / close it.</i>', ''];

    for (const { position: pos } of cached) {
      const title = pos.marketTitle || pos.marketId;
      const entryPrice = parseFloat(pos.avgEntryPrice);
      const bid = parseFloat(pos.currentPrice || '0');
      const quote = bid > 0 && bid < 1 ? positionPnl(pos, bid) : null;

      lines.push(`<b>${esc(title)}</b>`);
      lines.push(
        `  ${esc(pos.outcome)}: ${pos.shares.toFixed(2)} shares` +
          (entryPrice > 0 ? ` @ ${(entryPrice * 100).toFixed(0)}¢` : '') +
          (quote
            ? `  →  ${(bid * 100).toFixed(0)}¢  (${fmtPnl(quote)}, ${fmtPct(quote)})`
            : '')
      );
      lines.push('');
    }

    const buttons = cached.map(({ key, position }) => {
      const emoji = outcomeToSide(position.outcome) === 'UP' ? '🟢' : '🔴';
      const bid = parseFloat(position.currentPrice || '0');
      const pnl =
        bid > 0 && bid < 1 ? ` · ${fmtPnl(positionPnl(position, bid))}` : '';
      return {
        key,
        label: `${emoji} ${position.outcome} ${position.shares.toFixed(2)}sh${pnl}`,
      };
    });

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: buildPositionsInline(buttons),
    });
  } catch (e: any) {
    await ctx.reply(`❌ Could not fetch positions: ${esc(e.message)}`, {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }
}

// ───────────────────────────────────────────────
// /stats → PnL
// ───────────────────────────────────────────────
export async function handleStats(ctx: Context) {
  if (!isAllowed(ctx)) return notAllowed(ctx);

  const userId = ctx.from?.id ?? undefined;
  // Per-member stats: showing the whole club's PnL leaked other members' results.
  const stats = riskManager.getStats(userId);
  const btcState = btcPriceService.getState();
  const mine = userId ? userRegistry.getStats(userId) : null;

  const text = [
    `📊 <b>PnL / Statistics</b>`,
    ``,
    `BTC Price: <b>$${btcState.currentPrice.toLocaleString()}</b>`,
    ``,
    mine
      ? `👤 <b>Aapke:</b> ${mine.trades} trades · PnL ${mine.pnlUsd >= 0 ? '+' : ''}$${mine.pnlUsd.toFixed(2)} · Aaj ka loss $${mine.dailyLossUsd.toFixed(2)}`
      : '',
    `Today's Trades: ${stats.dailyTrades}`,
    `Today's Loss: $${stats.dailyLoss.toFixed(2)} / $${config.trading.dailyLossLimitUsdt}`,
    `Open Exposure: $${riskManager.getOpenExposureUsdt(userId).toFixed(2)}`,
    `Win Rate: ${stats.winRate}%`,
    `Total PnL: ${parseFloat(stats.totalPnl) >= 0 ? '+' : ''}$${stats.totalPnl}`,
    ``,
    `Circuit Breaker: ${stats.isTripped ? '🚨 TRIPPED — ' + stats.tripReason : '✅ Armed'}`,
    `Mode: ${stats.isDryRun ? '🧪 DRY RUN' : '🔴 LIVE'}`,
    `Max Bet: $${config.trading.maxBetUsdt} USDT`,
    `Personal daily cap: $${userRegistry.userDailyLossLimit()} USDT`,
  ].join('\n');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainKb(ctx) });
}

// ───────────────────────────────────────────────
// /history → Log
// ───────────────────────────────────────────────
export async function handleHistory(ctx: Context) {
  if (!isAllowed(ctx)) return notAllowed(ctx);

  const userId = ctx.from?.id;
  // Admins see the club log; members see ONLY their own trades (never a
  // fallback to everyone's, which used to leak other members' bets).
  const isAdmin = userId != null && adminGate(ctx);
  const trades = riskManager.getRecentTrades(isAdmin ? undefined : userId, 20);

  if (trades.length === 0) {
    return ctx.reply(
      isAdmin ? '📜 No trade history yet.' : '📜 Abhi tak aapki koi trade nahi.',
      { reply_markup: mainKb(ctx) }
    );
  }

  const lines = ['📜 <b>Recent Trades</b>', ''];
  for (const t of [...trades].reverse()) {
    const date = new Date(t.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const pnlStr =
      t.pnlUsd !== undefined
        ? t.pnlUsd >= 0
          ? `+$${t.pnlUsd.toFixed(2)} ✅`
          : `-$${Math.abs(t.pnlUsd).toFixed(2)} ❌`
        : 'Pending ⏳';

    lines.push(
      `${t.outcome === 'UP' ? '🟢' : '🔴'} <b>${t.outcome}</b> $${t.amountUsdt.toFixed(2)} @ ${(t.price * 100).toFixed(0)}¢  |  ${date}  |  ${pnlStr}`
    );
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: mainKb(ctx) });
}

// ───────────────────────────────────────────────
// /export — private key via Telegram
// (inline Yes/Cancel confirm, key message auto-deletes after 90s)
// ───────────────────────────────────────────────
/** Per-user pending export confirmation codes (5 min expiry) — legacy text flow. */
const pendingExports: Map<number, { code: string; expires: number }> = new Map();

/** How long the private-key message lives in the chat before auto-delete. */
const EXPORT_KEY_DELETE_MS = 90_000;

/** Delete the key message after 90s (best-effort: old messages may refuse). */
function scheduleKeyAutoDelete(api: Context['api'], chatId: number, messageId: number) {
  setTimeout(() => {
    void api
      .deleteMessage(chatId, messageId)
      .then(() => logger.info({ chatId }, 'Exported key message auto-deleted'))
      .catch(() => {
        // Too old / already deleted — nothing we can do; the warning told the user.
      });
  }, EXPORT_KEY_DELETE_MS);
}

function buildExportCard(address: string) {
  return [
    '🔐 <b>Export Private Key</b>',
    ``,
    `Wallet: <code>${esc(address)}</code>`,
    ``,
    `⚠️ <b>WARNING:</b> Your private key gives FULL access to this wallet and its funds.`,
    `Kabhi bhi kisi se share / screenshot mat karo.`,
    ``,
    `Export karna hai?`,
  ].join('\n');
}

/** Send the key message and schedule its 90s auto-delete. */
async function sendKeyMessage(
  ctx: Context,
  chatId: number,
  address: string,
  key: string
) {
  const msg = await ctx.api.sendMessage(
    chatId,
    [
      '🔑 <b>PRIVATE KEY — HANDLE WITH CARE</b>',
      ``,
      `Address: <code>${esc(address)}</code>`,
      `Key: <code>${esc(key)}</code>`,
      ``,
      `⏳ <b>Ye message 90 second mein auto-delete ho jayega.</b>`,
      `⚠️ Key wallet ko drain kar sakti hai — kisi se share mat karo.`,
      `ℹ️ Import: MetaMask / Rabby / Trust Wallet → "Import account".`,
    ].join('\n'),
    { parse_mode: 'HTML' }
  );
  scheduleKeyAutoDelete(ctx.api, chatId, msg.message_id);
  logger.warn(
    { userId: ctx.from?.id },
    'User private key exported via Telegram (auto-deletes in 90s)'
  );
}

export async function handleExport(ctx: Context) {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Keys must NEVER appear in a group chat. Even the confirm card is private.
  if (ctx.chat?.type !== 'private') {
    return ctx.reply(
      '🔒 Private key sirf <b>private chat</b> mein export ho sakti hai.\nBot ko DM mein <code>/export</code> bhejo.',
      { parse_mode: 'HTML' }
    );
  }

  if (!userRegistry.hasAccess(userId)) {
    return ctx.reply('⛔ Pehle /start dabao — account active hone ke baad hi export milega.');
  }

  // Every member exports their OWN wallet key (encrypted at rest).
  const { account } = userAccounts.ensureAccount(userId, ctx.from?.username);
  if (!account) {
    return ctx.reply('❌ Wallet create nahi ho paya. Thodi der baad /start try karo.', {
      reply_markup: mainKb(ctx),
    });
  }
  const key = userAccounts.getPrivateKey(userId);
  if (!key) {
    return ctx.reply(
      '❌ Key decrypt nahi hui — admin se WALLET_MASTER_KEY check karwao (agar server migration hui hai to).',
      { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
    );
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const address = userAccounts.getAddress(userId)!;

  // Legacy text confirm still works: /export confirm <code>
  const parts = (ctx.message?.text || '').split(/\s+/);
  if (parts[1] === 'confirm') {
    const pending = pendingExports.get(userId);
    const code = (parts[2] || '').trim();
    if (pending && pending.code === code && Date.now() < pending.expires) {
      pendingExports.delete(userId);
      await sendKeyMessage(ctx, chatId, address, key);
      return ctx.reply('✅ Key bhej diya. ⏳ 90 second mein delete ho jayega.', {
        parse_mode: 'HTML',
        reply_markup: mainKb(ctx),
      });
    }
    return ctx.reply('❌ Invalid ya expired code. Naya code ke liye <code>/export</code> chalao.', {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }

  // Fresh request → issue a code (kept for the text fallback) and show the
  // Polymarket-style inline confirmation card.
  const code = String(crypto.randomInt(100_000, 1_000_000));
  pendingExports.set(userId, { code, expires: Date.now() + 5 * 60_000 });

  const kb = new InlineKeyboard()
    .text('✅ Yes, Export', `x:y:${userId}`)
    .text('❌ Cancel', `x:n:${userId}`);
  return ctx.reply(buildExportCard(address), { parse_mode: 'HTML', reply_markup: kb });
}

/** Handle x:y:<userId> / x:n:<userId> callback presses on the export card. */
async function handleExportCallback(ctx: Context, data: string): Promise<boolean> {
  if (!data.startsWith('x:y:') && !data.startsWith('x:n:')) return false;

  // Never send a key into a group, even if an old card is still clickable.
  if (ctx.chat?.type !== 'private') {
    await ctx.answerCallbackQuery({
      text: '🔒 Export sirf private chat mein — bot ko DM karo.',
      show_alert: true,
    });
    return true;
  }

  const requester = Number(data.split(':')[2]);
  if (ctx.from?.id !== requester) {
    await ctx.answerCallbackQuery({ text: '⛔ Ye card tumhara nahi hai', show_alert: true });
    return true;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return true;

  if (data.startsWith('x:n:')) {
    pendingExports.delete(requester);
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('❌ <b>Export cancelled</b> — key bheji nahi gayi.', {
        parse_mode: 'HTML',
      });
    } catch {
      // card too old to edit — ignore
    }
    return true;
  }

  const acc = userAccounts.get(requester);
  const key = acc ? userAccounts.getPrivateKey(requester) : null;
  if (!acc || !key) {
    await ctx.answerCallbackQuery({ text: '❌ Wallet not found', show_alert: true });
    return true;
  }

  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(
      [
        `✅ <b>Key exported</b>`,
        ``,
        `Key wala message upar bhej diya gaya hai.`,
        `⏳ Wo <b>90 second</b> mein auto-delete ho jayega.`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  } catch {
    // ignore edit failures
  }
  await sendKeyMessage(ctx, chatId, acc.address, key);
  return true;
}

// ───────────────────────────────────────────────
// 💸 Withdraw flow (inline buttons + confirm)
// ───────────────────────────────────────────────
function isValidBscAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

async function startWithdrawFlow(ctx: Context, userId: number, chatId: number) {
  withdrawDrafts.set(userId, {});
  const rt = getUserRuntime(userId);
  let usdt: number | undefined;
  try {
    if (rt) {
      const bal = await rt.api.getBalance();
      if (bal.ok) usdt = bal.usdt;
    }
  } catch {
    // balance optional here
  }
  await ctx.api.sendMessage(
    chatId,
    [
      `💸 <b>Withdraw USDT</b>`,
      ``,
      usdt !== undefined ? `Balance: <b>$${usdt.toFixed(2)} USDT</b>` : '',
      ``,
      `1️⃣ Apna destination address <b>paste karo</b> (BEP-20 USDT wallet — Binance/OKX deposit address ya apna MetaMask address).`,
      `2️⃣ Phir amount mangege — ya <code>all</code> likh dena (sab balance).`,
      `3️⃣ ✅ Confirm karo → USDT bhej diya jayega.`,
      ``,
      `❌ Cancel karne ke liye <code>cancel</code> likho.`,
    ]
      .filter(Boolean)
      .join('\n'),
    { parse_mode: 'HTML' }
  );
}

/** `/withdraw` — same flow as 🏦 Wallet → 💸 Withdraw. */
export async function handleWithdraw(ctx: Context) {
  if (!isAllowed(ctx)) return notAllowed(ctx);
  if (ctx.chat?.type !== 'private') {
    return ctx.reply('🔒 Withdraw sirf <b>private chat</b> mein hota hai. Bot ko DM karo.', {
      parse_mode: 'HTML',
    });
  }
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return;
  const rt = ensureUserRuntime(userId, ctx.from?.username);
  if (!rt) {
    return ctx.reply('❌ Account wallet load nahi hua. Thodi der baad /start try karo.', {
      reply_markup: mainKb(ctx),
    });
  }
  return startWithdrawFlow(ctx, userId, chatId);
}

async function handleWithdrawCallback(ctx: Context, data: string): Promise<boolean> {
  if (data !== 'w:s' && data !== 'w:go' && data !== 'w:no') return false;

  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return true;

  // Funds must only move in a private chat (a group member could otherwise
  // press the buttons / see the destination address).
  if (ctx.chat?.type !== 'private') {
    await ctx.answerCallbackQuery({
      text: '🔒 Withdraw sirf private chat mein — bot ko DM karo.',
      show_alert: true,
    });
    return true;
  }

  const draft = withdrawDrafts.get(userId);

  if (data === 'w:s') {
    await ctx.answerCallbackQuery();
    await startWithdrawFlow(ctx, userId, chatId);
    return true;
  }

  if (data === 'w:no') {
    withdrawDrafts.delete(userId);
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('❌ <b>Withdrawal cancelled</b> — kuch bheja nahi gaya.', {
        parse_mode: 'HTML',
      });
    } catch {
      // old message — ignore
    }
    return true;
  }

  // w:go — confirmed send
  if (!draft?.address || draft.amount === undefined) {
    await ctx.answerCallbackQuery({ text: '⚠️ Flow expired — 🏦 Wallet → 💸 Withdraw se dobara', show_alert: true });
    return true;
  }

  // Double-tapping "Confirm" must never send twice.
  if (WITHDRAW_IN_FLIGHT.has(userId)) {
    await ctx.answerCallbackQuery({ text: '⏳ Withdrawal already in progress', show_alert: true });
    return true;
  }
  WITHDRAW_IN_FLIGHT.add(userId);

  await ctx.answerCallbackQuery({ text: 'Sending…' });
  try {
    await ctx.editMessageText('⏳ <b>Sending USDT…</b>', { parse_mode: 'HTML' }).catch(() => {});
  } catch {
    // ignore
  }

  try {
    const hash = await userAccounts.sendUsdt(userId, draft.address, draft.amount);
    withdrawDrafts.delete(userId);
    await ctx.api.sendMessage(
      chatId,
      [
        `✅ <b>Sent Done!</b>`,
        ``,
        `Amount: <b>${draft.amount === 'all' ? 'Full balance' : `$${draft.amount.toFixed(2)} USDT`}</b>`,
        `To: <code>${draft.address}</code>`,
        txUrl(hash)
          ? `TX: <a href="${txUrl(hash)}">${hash.slice(0, 10)}…${hash.slice(-6)}</a> ↗`
          : `TX: <code>${hash}</code>`,
        ``,
        `ℹ️ 1-2 minute me destination par pahuch jayega.`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  } catch (e: any) {
    logger.warn({ err: e, userId }, 'Withdrawal failed');
    withdrawDrafts.delete(userId);
    await ctx.api.sendMessage(
      chatId,
      [
        `❌ <b>Withdrawal failed</b>`,
        ``,
        esc(e?.message || String(e)),
        ``,
        `Dobara try karo: 🏦 Wallet → 💸 Withdraw`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  } finally {
    WITHDRAW_IN_FLIGHT.delete(userId);
  }
  return true;
}

/** Text messages typed during the withdraw flow (address / amount / cancel). */
async function handleWithdrawText(ctx: Context, userId: number, raw: string): Promise<boolean> {
  const draft = withdrawDrafts.get(userId);
  if (!draft) return false;

  // A flow started in DM can never be continued from a group.
  if (ctx.chat?.type !== 'private') {
    withdrawDrafts.delete(userId);
    await ctx.reply('🔒 Withdraw sirf <b>private chat</b> mein — bot ko DM karo.', {
      parse_mode: 'HTML',
    });
    return true;
  }

  const text = raw.trim();

  if (text.toLowerCase() === 'cancel') {
    withdrawDrafts.delete(userId);
    await ctx.reply('❌ <b>Withdrawal cancelled</b> — kuch bheja nahi gaya.', {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
    return true;
  }

  // Step 1: destination address
  if (!draft.address) {
    const addr = text.replace(/\s+/g, '');
    if (!isValidBscAddress(addr)) {
      await ctx.reply(
        '❌ Ye valid BEP-20 address nahi lag raha (0x + 40 hex chars).\nDobara paste karo ya <code>cancel</code> likho.',
        { parse_mode: 'HTML' }
      );
      return true;
    }
    draft.address = addr;
    await ctx.reply(
      [
        `✅ Address set: <code>${addr}</code>`,
        ``,
        `2️⃣ Ab <b>amount likho</b> (USDT me, e.g. <code>10</code>)`,
        `ya <code>all</code> likho — pura balance withdraw hoga.`,
        ``,
        `<code>cancel</code> se cancel karo.`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return true;
  }

  // Step 2: amount
  const rt = getUserRuntime(userId);
  if (!rt) {
    withdrawDrafts.delete(userId);
    await ctx.reply('❌ Account wallet load nahi hua. Dobara try karo.', {
      reply_markup: mainKb(ctx),
    });
    return true;
  }
  let balance = 0;
  try {
    const bal = await rt.api.getBalance();
    if (!bal.ok) throw new Error('Balance fetch nahi hua — thodi der baad try karo');
    balance = bal.usdt;
  } catch (e: any) {
    withdrawDrafts.delete(userId);
    await ctx.reply(`❌ ${esc(e?.message || 'Balance error')}`, { parse_mode: 'HTML' });
    return true;
  }

  let amount: 'all' | number;
  if (/^all$/i.test(text)) {
    amount = 'all';
  } else {
    const n = parseFloat(text);
    if (!(n > 0)) {
      await ctx.reply('❌ Invalid amount. Number likho (e.g. <code>10</code>) ya <code>all</code>.', {
        parse_mode: 'HTML',
      });
      return true;
    }
    if (n > balance + 1e-9) {
      await ctx.reply(
        `❌ Wallet me sirf <b>$${balance.toFixed(2)} USDT</b> hai. Kam likho ya <code>all</code>.`,
        { parse_mode: 'HTML' }
      );
      return true;
    }
    amount = n;
  }

  draft.amount = amount;
  const amountStr = amount === 'all' ? `Full balance ($${balance.toFixed(2)})` : `$${amount.toFixed(2)}`;
  const kb = new InlineKeyboard()
    .text('✅ Confirm & Send', 'w:go')
    .text('❌ Cancel', 'w:no');
  await ctx.reply(
    [
      `💸 <b>Confirm Withdrawal</b>`,
      ``,
      `Amount: <b>${amountStr} USDT</b>`,
      `To: <code>${draft.address}</code>`,
      ``,
      `⚠️ Sirf BEP-20 addresses pe bhej rahe hain — galat network par funds lag sakte hain.`,
      `✅ Confirm dabao → USDT send ho jayega.`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: kb }
  );
  return true;
}

// ───────────────────────────────────────────────
// /reset circuit breaker
// ───────────────────────────────────────────────
export async function handleReset(ctx: Context) {
  // Resetting the shared circuit breaker affects every member's trading, so it
  // must not be available to ordinary members.
  if (!adminGate(ctx)) return adminDenied(ctx);
  riskManager.resetCircuit();
  await ctx.reply('✅ Circuit breaker reset. Trading re-enabled.', {
    reply_markup: mainKb(ctx),
  });
}

// ───────────────────────────────────────────────
// Trend / Orderbook
// ───────────────────────────────────────────────
export async function handleOrderbook(ctx: Context) {
  if (!isAllowed(ctx)) return notAllowed(ctx);
  const round = roundWatcher.getCurrentRound();
  if (!round) {
    return ctx.reply('No active round found.', { reply_markup: mainKb(ctx) });
  }

  const trendEmoji = round.currentTrend === 'UP' ? '🟢' : round.currentTrend === 'DOWN' ? '🔴' : '⚪';
  const lockKnown = round.lockPrice > 0;
  const header = [
    `📈 <b>Trend</b>`,
    lockKnown
      ? `${trendEmoji} BTC vs lock: ${round.priceDiff >= 0 ? '+' : ''}$${round.priceDiff.toFixed(2)}`
      : `⏳ Lock price still syncing…`,
    lockKnown
      ? `Lock $${round.lockPrice.toFixed(2)} → Now $${round.currentPrice.toFixed(2)}`
      : `Now $${round.currentPrice.toFixed(2)}`,
    '',
  ].join('\n');

  try {
    const ob = await predictFunApi.getOrderbook(round.marketId);
    if (!ob) {
      return ctx.reply(header + 'Orderbook not available for current market.', {
        parse_mode: 'HTML',
        reply_markup: mainKb(ctx),
      });
    }

    // Predict.fun returns levels as `[price, size]` tuples; accept objects too.
    const formatLevel = (lvl: { price: number; size: number } | [number, number]) => {
      const price = Array.isArray(lvl) ? Number(lvl[0]) : Number(lvl.price);
      const size = Array.isArray(lvl) ? Number(lvl[1]) : Number(lvl.size);
      return `  ${(price * 100).toFixed(1)}¢  |  ${size.toFixed(2)} shares`;
    };

    const lines = [
      header,
      `📊 <b>Orderbook — ${esc(round.title)}</b>`,
      ``,
      `<b>ASKS:</b>`,
      ...(ob.asks || []).slice(0, 5).reverse().map(formatLevel),
      `———`,
      `<b>BIDS:</b>`,
      ...(ob.bids || []).slice(0, 5).map(formatLevel),
    ];

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: mainKb(ctx) });
  } catch (e: any) {
    await ctx.reply(`❌ Error: ${esc(e.message)}`, {
      parse_mode: 'HTML',
      reply_markup: mainKb(ctx),
    });
  }
}

async function handlePauseToggle(ctx: Context) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  registerNotifyTarget(chatId);
  const next = !isNotifyPaused(chatId);
  setNotifyPaused(chatId, next);
  await ctx.reply(
    next
      ? '◾ <b>Paused</b> — round alerts muted. Tap ▶️ Resume anytime.'
      : '▶️ <b>Resumed</b> — round alerts enabled again.',
    { parse_mode: 'HTML', reply_markup: buildMainKeyboard(next) }
  );
}

async function startQuickBet(ctx: Context) {
  const round = roundWatcher.getCurrentRound();
  if (!round) {
    return ctx.reply('⏳ No active round yet. Tap 🖥️ Live in a moment.', {
      reply_markup: mainKb(ctx),
    });
  }
  if (round.isLocked) {
    return ctx.reply('⛔ Round locked — wait for the next round.', {
      reply_markup: mainKb(ctx),
    });
  }
  if (ctx.from?.id) {
    betDraft.set(ctx.from.id, {});
  }
  await ctx.reply('⚡ <b>Quick Bet</b> — pick a side:', {
    parse_mode: 'HTML',
    reply_markup: buildSideKeyboard(),
  });
}

const AMOUNT_MAP: Record<string, number> = {
  [BTN.A5]: 5,
  [BTN.A10]: 10,
  [BTN.A25]: 25,
  [BTN.A50]: 50,
};

// ───────────────────────────────────────────────
// Reply-keyboard text router
// ───────────────────────────────────────────────
export async function handleTextMessage(ctx: Context) {
  if (!isAllowed(ctx)) return notAllowed(ctx);

  const userId = ctx.from?.id;
  if (!userId) return;

  const text = ctx.message?.text?.trim() || '';
  if (!text || text.startsWith('/')) return;

  // Withdrawal flow input (address / amount / cancel) takes priority over
  // bet parsing — an amount like "10" would otherwise become a bet.
  if (await handleWithdrawText(ctx, userId, text)) return;

  const draft = betDraft.get(userId);

  // Fast limit-bet syntax: "up 1 50" = $1 on UP at 50¢, "down 2 60", "up 5".
  const typedBet = parseBetText(text);
  if (typedBet) {
    return showConfirm(ctx, typedBet.outcome, typedBet.amountUsdt, typedBet.limitPrice);
  }

  // While waiting for a custom amount, still honour every known button
  // (`$10` used to be parsed as a number and rejected as invalid).
  const isKnownButton =
    MAIN_BTN_SET.has(text) ||
    AMOUNT_MAP[text] != null ||
    text === BTN.UP ||
    text === BTN.DOWN ||
    text === BTN.CUSTOM ||
    text === BTN.BACK ||
    text === BTN.CONFIRM ||
    text === BTN.CANCEL;

  // Custom amount numeric entry
  if (draft?.awaitingCustom && !isKnownButton) {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply(
        '❌ Invalid amount. Enter a number like <code>10</code> or <code>25.5</code>',
        { parse_mode: 'HTML', reply_markup: buildAmountKeyboard() }
      );
    }
    if (!draft.outcome) {
      clearDraft(userId);
      return startQuickBet(ctx);
    }
    draft.awaitingCustom = false;
    return showConfirm(ctx, draft.outcome, amount);
  }

  // Confirm / Cancel while draft has amount
  if (text === BTN.CONFIRM && draft?.outcome && draft.amountUsdt) {
    const { outcome, amountUsdt, limitPrice, marketId } = draft;
    clearDraft(userId);

    // The round may have rolled over between the confirm card and the tap.
    const current = roundWatcher.getCurrentRound();
    if (!marketId || !current || current.marketId !== marketId) {
      return ctx.reply('⛔ Round has changed — please start a new bet.', {
        reply_markup: mainKb(ctx),
      });
    }
    return placeOrder(ctx, outcome, amountUsdt, limitPrice, marketId);
  }
  if (text === BTN.CANCEL && draft) {
    clearDraft(userId);
    return ctx.reply('Cancelled.', { reply_markup: mainKb(ctx) });
  }

  // Side selection
  if (text === BTN.UP || text === BTN.DOWN) {
    const outcome = text === BTN.UP ? 'UP' : 'DOWN';
    betDraft.set(userId, { outcome });
    return ctx.reply(`${text} — select amount:`, {
      reply_markup: buildAmountKeyboard(),
    });
  }

  // Amount presets
  if (AMOUNT_MAP[text] != null) {
    const outcome = draft?.outcome;
    if (!outcome) {
      return startQuickBet(ctx);
    }
    return showConfirm(ctx, outcome, AMOUNT_MAP[text]);
  }

  if (text === BTN.CUSTOM) {
    const outcome = draft?.outcome;
    if (!outcome) return startQuickBet(ctx);
    betDraft.set(userId, { outcome, awaitingCustom: true });
    return ctx.reply(
      '✏️ Type your custom amount in USDT (e.g. <code>25.5</code>)',
      { parse_mode: 'HTML', reply_markup: buildAmountKeyboard() }
    );
  }

  if (text === BTN.BACK) {
    clearDraft(userId);
    return handleStart(ctx);
  }

  // Main menu keyword buttons
  switch (text) {
    case BTN.LIVE:
      return handleStart(ctx);
    case BTN.WALLET:
      return handleBalance(ctx);
    case BTN.OPEN:
      return handlePositions(ctx);
    case BTN.LOG:
      return handleHistory(ctx);
    case BTN.TREND:
      return handleOrderbook(ctx);
    case BTN.SYSTEM:
      return handleHelp(ctx);
    case BTN.QUICK_BET:
      return startQuickBet(ctx);
    case BTN.PNL:
      return handleStats(ctx);
    case BTN.PAUSE:
    case BTN.RESUME:
      return handlePauseToggle(ctx);
    default:
      // Unknown text — ignore (don't spam)
      return;
  }
}
