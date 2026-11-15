import 'dotenv/config';
import fs from 'node:fs';
import { logger } from './utils/logger.js';
import { config, walletInfo } from './config/index.js';
import { createBot } from './bot/bot.js';
import {
  startAutoServices,
  registerNotifyTarget,
  restoreAutoState,
} from './services/autoServices.js';
import { predictSigner } from './exchanges/predictfun/signer.js';
import { stateStore } from './utils/store.js';
import { startDepositWatcher } from './services/depositWatcher.js';

/** .env holds the bot token + private key: make sure only the owner can read it. */
function checkEnvPermissions() {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync('.env').mode & 0o777;
    if ((mode & 0o077) !== 0) {
      logger.warn(
        { mode: mode.toString(8) },
        '⚠️  .env is readable by other local users. Fix with: chmod 600 .env'
      );
    }
  } catch {
    // .env may live elsewhere (env vars injected by the host) — nothing to check.
  }
}

async function main() {
  logger.info('🚀 Starting Predict.fun BTC 5M Telegram Bot...');
  checkEnvPermissions();
  logger.info(`Mode: ${config.trading.dryRun ? '🧪 DRY RUN' : '🔴 LIVE TRADING'}`);
  logger.info(`Network: ${config.predictfun.isTestnet ? 'BNB Testnet (97)' : 'BNB Mainnet (56)'}`);
  logger.info(`Max bet: $${config.trading.maxBetUsdt} USDT`);
  logger.info(`Daily loss limit: $${config.trading.dailyLossLimitUsdt} USDT`);
  logger.info(
    `Wallet: ${walletInfo.address} (${walletInfo.source === 'env' ? 'from .env' : walletInfo.source === 'file' ? 'from data/wallet.json' : 'auto-generated'})`
  );

  // Validate required env
  if (!config.telegram.token) {
    logger.error('❌ TELEGRAM_BOT_TOKEN is not set. Set it in your .env file.');
    process.exit(1);
  }

  if (!config.predictfun.apiKey) {
    logger.warn('⚠️  PREDICTFUN_API_KEY is not set. Market data may be limited.');
  }

  if (!config.predictfun.privateKey) {
    logger.warn('⚠️  PREDICTFUN_PRIVATE_KEY is not set. Only view-only mode available.');
  } else {
    // Pre-initialize signer
    await predictSigner.init().catch((e) => {
      logger.warn({ err: e }, 'Signer init failed — will retry on first trade');
    });

    // Live mode needs on-chain approvals before the first order can fill.
    if (!config.trading.dryRun) {
      const approvals = await predictSigner.ensureApprovals();
      if (!approvals.success) {
        logger.error(
          { reason: approvals.error },
          'Protocol approvals are NOT ready — live orders will fail until this is fixed'
        );
      }
    }
  }

  // Create Telegram bot
  const bot = createBot();

  // Set bot commands menu
  await bot.api.setMyCommands([
    { command: 'start', description: '⚡ Show live BTC 5M round dashboard' },
    { command: 'up', description: '🟢 Quick BET UP (e.g. /up 10)' },
    { command: 'down', description: '🔴 Quick BET DOWN (e.g. /down 10)' },
    { command: 'balance', description: '💼 Check USDT & BNB balance' },
    { command: 'positions', description: '📋 View open positions' },
    { command: 'stats', description: '📈 Win/loss stats & daily PnL' },
    { command: 'history', description: '📜 Last 10 trades' },
    { command: 'trend', description: '📈 Orderbook / trend' },
    { command: 'reset', description: '🔄 Reset circuit breaker' },
    { command: 'export', description: '🔑 Export wallet private key (owner only)' },
    { command: 'help', description: '❓ Show help' },
  ]);

  // Restore persisted chats / redeemed markers before starting services.
  restoreAutoState();

  // Start auto-services (round change notifier + auto-redeem)
  startAutoServices(bot);

  // Watch wallet balances and announce incoming deposits
  startDepositWatcher(bot);

  // Register allowed users for push notifications
  for (const userId of config.telegram.allowedUsers) {
    registerNotifyTarget(userId);
  }

  // Freshly auto-generated wallet: tell the owner where to send funds.
  if (walletInfo.generated && config.telegram.allowedUsers.length > 0) {
    const msg = [
      `🆕 <b>New trading wallet created & saved!</b>`,
      ``,
      `Address: <code>${walletInfo.address}</code>`,
      ``,
      `1️⃣ Is address par <b>USDT (BEP-20)</b> + thoda <b>BNB</b> (gas) transfer karo.`,
      `2️⃣ Phir ⚡ Quick Bet se trading shuru.`,
      ``,
      `🔑 Key export: <b>/export</b>`,
      `💾 Key file (server par): <code>${walletInfo.file}</code> — private rakho!`,
    ].join('\n');
    for (const userId of config.telegram.allowedUsers) {
      await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' }).catch(() => {});
    }
  }

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`Shutting down (${signal})...`);
    bot.stop();
    stateStore.saveNow(); // flush any debounced state before exit
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // A crash must never lose the last persisted trade / circuit-breaker state.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection (state flushed, bot keeps running)');
    stateStore.saveNow();
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception — flushing state and exiting');
    stateStore.saveNow();
    process.exit(1);
  });

  // Start polling
  logger.info('Bot is now polling for messages...');
  await bot.start({
    onStart: (botInfo) => {
      logger.info(`✅ Bot started as @${botInfo.username}`);
    },
  });
}

main().catch((e) => {
  logger.error({ err: e }, 'Fatal startup error');
  process.exit(1);
});
