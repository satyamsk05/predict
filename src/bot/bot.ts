import { Bot } from 'grammy';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  handleStart,
  handleHelp,
  handleUp,
  handleDown,
  handleBalance,
  handlePositions,
  handleStats,
  handleHistory,
  handleReset,
  handleOrderbook,
  handleOrders,
  handleCallbackQuery,
  handleTextMessage,
  handleExport,
  handleUsers,
  handleKick,
  handleUnban,
  handleWithdraw,
  handleSettings,
} from './handlers.js';

export function createBot() {
  if (!config.telegram.token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables!');
  }

  const bot = new Bot(config.telegram.token);

  // Private chats only. This bot shows balances, positions and wallet keys, and
  // keeps per-user state: in a group every member's message would auto-register
  // them (burning member slots), buttons would be shared between members, and
  // /export or balances could be exposed to the whole group.
  bot.use(async (ctx, next) => {
    const type = ctx.chat?.type;
    if (type && type !== 'private') {
      const isCommand = ctx.message?.entities?.some((e) => e.type === 'bot_command' && e.offset === 0);
      if (isCommand) {
        await ctx.reply('This bot works in private chat only. Please message me directly.').catch(() => {});
      }
      return;
    }
    await next();
  });

  // Commands
  bot.command('start', handleStart);
  bot.command('help', handleHelp);
  bot.command('up', handleUp);
  bot.command('down', handleDown);
  bot.command('balance', handleBalance);
  bot.command('positions', handlePositions);
  bot.command('pos', handlePositions);
  bot.command('stats', handleStats);
  bot.command('history', handleHistory);
  bot.command('trend', handleOrderbook);
  bot.command('book', handleOrderbook);
  bot.command('orders', handleOrders);
  bot.command('orderbook', handleOrderbook);
  bot.command('reset', handleReset);
  bot.command('export', handleExport);
  bot.command('settings', handleSettings);
  bot.command('withdraw', handleWithdraw);
  // Multi-user management — admin-only (no approval: /start auto-creates)
  bot.command('users', handleUsers);
  bot.command('kick', handleKick);
  bot.command('unban', handleUnban);

  // Legacy inline callbacks (show tip to use reply keyboard)
  bot.on('callback_query:data', handleCallbackQuery);

  // Reply keyboard (keyword) buttons + custom amounts
  bot.on('message:text', handleTextMessage);

  bot.catch((err) => {
    // Don't log the whole update: it contains the user's raw message text.
    logger.error(
      { err: err.error, updateId: err.ctx?.update?.update_id, userId: err.ctx?.from?.id },
      'Unhandled bot error'
    );
  });

  return bot;
}
