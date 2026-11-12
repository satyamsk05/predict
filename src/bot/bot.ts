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
  handleCallbackQuery,
  handleTextMessage,
} from './handlers.js';

export function createBot() {
  if (!config.telegram.token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables!');
  }

  const bot = new Bot(config.telegram.token);

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
  bot.command('orderbook', handleOrderbook);
  bot.command('reset', handleReset);

  // Legacy inline callbacks (show tip to use reply keyboard)
  bot.on('callback_query:data', handleCallbackQuery);

  // Reply keyboard (keyword) buttons + custom amounts
  bot.on('message:text', handleTextMessage);

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update }, 'Unhandled bot error');
  });

  return bot;
}
