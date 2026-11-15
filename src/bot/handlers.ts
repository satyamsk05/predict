import type { Context } from 'grammy';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { roundWatcher } from '../services/roundWatcher.js';
import { btcPriceService } from '../services/btcPrice.js';
import { predictFunApi } from '../exchanges/predictfun/api.js';
import { predictSigner } from '../exchanges/predictfun/signer.js';
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
import type { PredictMarket, PredictPosition } from '../exchanges/predictfun/types.js';
import {
  registerNotifyTarget,
  setNotifyPaused,
  isNotifyPaused,
} from '../services/autoServices.js';
import { parseBetText } from './betText.js';

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
 * Open positions shown in `/positions`, keyed by a short id so the inline
 * button callback stays well under Telegram's 64-byte limit.
 */
type CachedPosition = { chatId: number; position: PredictPosition };
const positionCache: Map<string, CachedPosition> = new Map();

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
  const n = name.toLowerCase();
  if (n.includes('up') || n.includes('yes')) return 'UP';
  if (n.includes('down') || n.includes('no')) return 'DOWN';
  return null;
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

function isAllowed(ctx: Context): boolean {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (config.telegram.allowedUsers.length === 0) return true;
  return config.telegram.allowedUsers.includes(userId);
}

function notAllowed(ctx: Context) {
  return ctx.reply('⛔ You are not authorized to use this bot.');
}

const HTML = { parse_mode: 'HTML' } as const;

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
  if (!isAllowed(ctx)) return notAllowed(ctx);

  if (ctx.chat?.id) {
    registerNotifyTarget(ctx.chat.id);
  }
  if (ctx.from?.id) clearDraft(ctx.from.id);

  const round = roundWatcher.getCurrentRound();
  let balance: number | undefined;

  try {
    const bal = await predictFunApi.getBalance();
    balance = bal.ok ? bal.usdt : undefined;
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
    'Commands still work: /up 10 · /down 10 · /reset',
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

  if (userId) {
    betDraft.set(userId, {
      outcome,
      amountUsdt,
      limitPrice,
      marketId: round.marketId,
    });
  }

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

  const q = positionPnl(pos, bid);

  await ctx.editMessageText(
    `⏳ Selling ${pos.shares.toFixed(4)} ${side} @ ${(bid * 100).toFixed(0)}¢…`,
    { reply_markup: buildPositionActionsInline(key) }
  );

  try {
    await predictSigner.init();
    const result = await predictSigner.placeSell(market, side, pos.shares, bid);

    if (!result.success) {
      riskManager.recordFailure(result.error || 'Sell failed');
      return ctx.editMessageText(
        `❌ <b>Close failed</b>\n\n${esc(result.error)}\n\nPosition abhi bhi open hai.`,
        { parse_mode: 'HTML', reply_markup: buildPositionActionsInline(key) }
      );
    }

    // Position is closed — let the risk manager account for the realised PnL.
    if (q.known) riskManager.recordSettlement(pos.marketId, q.pnl, side);
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
  const round = roundWatcher.getCurrentRound();
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
  if (!allowed) return ctx.reply(`🚫 ${reason}`, { reply_markup: mainKb(ctx) });

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
      settled: false,
    });

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

  // Pre-flight: never send a live order the wallet cannot fund, and keep gas
  // for approvals/settlement.
  try {
    const bal = await predictFunApi.getBalance();
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

  try {
    await predictSigner.init();
    const result = await predictSigner.placeBet(round.rawMarket, outcome, amountUsdt, price);

    if (result.success) {
      // A placed limit order is NOT a filled position — record it unfilled and
      // reconcile once the position appears on-chain (see confirmFill...).
      riskManager.recordTrade({
        timestamp: Date.now(),
        marketId: round.marketId,
        outcome,
        amountUsdt,
        price,
        orderId: result.orderId || result.orderHash,
        settled: false,
        filled: false,
      });

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
          ``,
          `⏳ Fill confirm ho raha hai…`,
        ].join('\n'),
        { parse_mode: 'HTML' }
      );

      // Fire-and-forget fill confirmation (5s × 3 attempts).
      void confirmFillAndNotify(ctx, ctx.chat!.id, round.marketId, outcome);
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
  outcome: 'UP' | 'DOWN'
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(5000);
    try {
      const positions = await predictFunApi.getPositions();
      const filled = positions.some(
        (p) =>
          p.marketId === marketId &&
          !p.isResolved &&
          outcomeToSide(p.outcome) === outcome
      );
      if (filled) {
        if (riskManager.markFilled(marketId, outcome) > 0) {
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

  try {
    const { usdt, bnb, ok } = await predictFunApi.getBalance();
    if (!ok) {
      return ctx.reply('❌ Balance fetch nahi ho paya (RPC error). Thodi der baad try karo.', {
        reply_markup: mainKb(ctx),
      });
    }
    const address = predictFunApi.getEffectiveAddress();
    await ctx.reply(
      [
        `🏦 <b>Wallet Balance</b>`,
        ``,
        `USDT: <b>$${usdt.toFixed(2)}</b>`,
        `BNB:  <b>${bnb.toFixed(4)} BNB</b> (gas)`,
        address ? `\nAddress: <code>${address}</code>` : '',
      ]
        .join('\n')
        .trim(),
      { parse_mode: 'HTML', reply_markup: mainKb(ctx) }
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

  try {
    const positions = await predictFunApi.getPositions();
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

  const stats = riskManager.getStats();
  const btcState = btcPriceService.getState();

  const text = [
    `📊 <b>PnL / Statistics</b>`,
    ``,
    `BTC Price: <b>$${btcState.currentPrice.toLocaleString()}</b>`,
    ``,
    `Today's Trades: ${stats.dailyTrades}`,
    `Today's Loss: $${stats.dailyLoss.toFixed(2)} / $${config.trading.dailyLossLimitUsdt}`,
    `Open Exposure: $${riskManager.getOpenExposureUsdt().toFixed(2)}`,
    `Win Rate: ${stats.winRate}%`,
    `Total PnL: ${parseFloat(stats.totalPnl) >= 0 ? '+' : ''}$${stats.totalPnl}`,
    ``,
    `Circuit Breaker: ${stats.isTripped ? '🚨 TRIPPED — ' + stats.tripReason : '✅ Armed'}`,
    `Mode: ${stats.isDryRun ? '🧪 DRY RUN' : '🔴 LIVE'}`,
    `Max Bet: $${config.trading.maxBetUsdt} USDT`,
  ].join('\n');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainKb(ctx) });
}

// ───────────────────────────────────────────────
// /history → Log
// ───────────────────────────────────────────────
export async function handleHistory(ctx: Context) {
  if (!isAllowed(ctx)) return notAllowed(ctx);

  const trades = riskManager.getRecentTrades();
  if (trades.length === 0) {
    return ctx.reply('📜 No trade history yet.', { reply_markup: mainKb(ctx) });
  }

  const lines = ['📜 <b>Recent Trades</b>', ''];
  for (const t of trades) {
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
// /reset circuit breaker
// ───────────────────────────────────────────────
export async function handleReset(ctx: Context) {
  if (!isAllowed(ctx)) return notAllowed(ctx);
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
  if (!isAllowed(ctx)) return;

  const userId = ctx.from?.id;
  if (!userId) return;

  const text = ctx.message?.text?.trim() || '';
  if (!text || text.startsWith('/')) return;

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
