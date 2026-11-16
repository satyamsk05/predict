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
import { stateStore } from './utils/store.js';
import { startDepositWatcher } from './services/depositWatcher.js';
import { userRegistry } from './users/registry.js';
import { userAccounts } from './users/accounts.js';

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

  // Wallet key store: fail fast (before polling starts) if accounts.json is
  // corrupt or the master key was lost — never run with a broken key store.
  userAccounts.init();

  // Multi-user registry: seeds env admins, loads data/users.json.
  userRegistry.init();
  logger.info(
    {
      maxUsers: userRegistry.maxUsers(),
      userDailyLossLimitUsdt: userRegistry.userDailyLossLimit(),
      inviteOnly: userRegistry.joinCodeRequired(),
    },
    'Multi-user mode: every member gets their own wallet (per-user keys, PnL and limits)'
  );
  if (userRegistry.all().every((u) => u.role !== 'admin')) {
    logger.warn(
      '⚠️  No admin configured (TELEGRAM_ALLOWED_USERS / TELEGRAM_ADMIN_ID) — /users, /kick, /unban and /reset are locked to nobody.'
    );
  }

  if (walletInfo.address) {
    logger.info(
      `Legacy owner wallet: ${walletInfo.address} (${walletInfo.source}) — member trading uses per-user wallets`
    );
  } else {
    logger.info('No legacy owner wallet configured — using per-user wallets only');
  }

  // Validate required env
  if (!config.telegram.token) {
    logger.error('❌ TELEGRAM_BOT_TOKEN is not set. Set it in your .env file.');
    process.exit(1);
  }

  if (!config.predictfun.apiKey) {
    logger.warn('⚠️  PREDICTFUN_API_KEY is not set. Market data may be limited.');
  }

  // Note: PREDICTFUN_PRIVATE_KEY is now legacy — user accounts create their
  // own wallets, and per-user approvals run lazily on the first order.

  // Create Telegram bot
  const bot = createBot();

  // Command menu: members see the everyday commands; admins also get the
  // admin ones, scoped to their own chat so members never see them.
  const memberCommands = [
    { command: 'start', description: 'Live round' },
    { command: 'up', description: 'Bet UP, e.g. /up 10' },
    { command: 'down', description: 'Bet DOWN, e.g. /down 10' },
    { command: 'balance', description: 'Wallet balance' },
    { command: 'positions', description: 'Open positions' },
    { command: 'orders', description: 'Resting orders, cancel' },
    { command: 'history', description: 'Recent trades' },
    { command: 'stats', description: 'PnL and win rate' },
    { command: 'book', description: 'Order book' },
    { command: 'withdraw', description: 'Withdraw USDT' },
    { command: 'export', description: 'Export your private key' },
    { command: 'help', description: 'Help' },
  ];
  await bot.api.setMyCommands(memberCommands);
  for (const id of userRegistry.activeIds()) {
    if (!userRegistry.isAdmin(id)) continue;
    await bot.api
      .setMyCommands(
        [
          ...memberCommands,
          { command: 'users', description: 'Members (admin)' },
          { command: 'kick', description: 'Block a member (admin)' },
          { command: 'unban', description: 'Restore a member (admin)' },
          { command: 'reset', description: 'Reset circuit breaker (admin)' },
        ],
        { scope: { type: 'chat', chat_id: id } }
      )
      .catch((e) => logger.warn({ err: e, id }, 'Could not set admin commands'));
  }
  // First-open screen and menu button (all best-effort cosmetics).
  await bot.api
    .setMyShortDescription('Trade BTC 5-minute up/down markets on Predict.fun.')
    .catch(() => {});
  await bot.api
    .setMyDescription(
      'Trade BTC 5-minute up/down markets on Predict.fun from Telegram. Your own wallet, one tap to bet, positions and payouts handled for you. Send /start to begin.'
    )
    .catch(() => {});
  await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } }).catch(() => {});

  // Restore persisted chats / redeemed markers before starting services.
  restoreAutoState();

  // Start auto-services (round change notifier + auto-redeem)
  startAutoServices(bot);

  // Watch wallet balances and announce incoming deposits
  startDepositWatcher(bot);

  // Register members for push notifications
  for (const userId of userRegistry.activeIds()) {
    registerNotifyTarget(userId);
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
