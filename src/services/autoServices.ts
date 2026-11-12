import { ethers } from 'ethers';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { roundWatcher } from '../services/roundWatcher.js';
import { predictFunApi } from '../exchanges/predictfun/api.js';
import { predictSigner } from '../exchanges/predictfun/signer.js';
import { riskManager } from '../execution/risk.js';
import type { Bot, Context } from 'grammy';
import type { ActiveRoundState } from '../services/roundWatcher.js';
import type { PredictPosition } from '../exchanges/predictfun/types.js';
import { esc } from '../bot/keyboards.js';
import { stateStore } from '../utils/store.js';

interface NotifyTarget {
  chatId: number;
  lastNotifiedRoundId: string;
  lastLockWarnedRoundId: string;
  paused: boolean;
}

const notifyTargets: Map<number, NotifyTarget> = new Map();
/** Condition/index keys already redeemed, so the 60s poll cannot re-redeem. */
const redeemedKeys: Set<string> = new Set();
/** Failures already reported, to avoid spamming the chat every minute. */
const reportedFailures: Set<string> = new Set();
let redeemInFlight = false;

function persistAuto() {
  stateStore.update((s) => {
    s.auto = {
      redeemedKeys: [...redeemedKeys].slice(-1000),
      notifyTargets: [...notifyTargets.values()].map((t) => ({
        chatId: t.chatId,
        paused: t.paused,
      })),
    };
  });
}

/** Restore chat subscriptions and redeemed markers from the previous run. */
export function restoreAutoState() {
  const saved = stateStore.get().auto;
  for (const key of saved.redeemedKeys) redeemedKeys.add(key);
  for (const t of saved.notifyTargets) {
    if (notifyTargets.has(t.chatId)) continue;
    notifyTargets.set(t.chatId, {
      chatId: t.chatId,
      lastNotifiedRoundId: '',
      lastLockWarnedRoundId: '',
      paused: t.paused,
    });
  }
  if (saved.redeemedKeys.length || saved.notifyTargets.length) {
    logger.info(
      { redeemedKeys: saved.redeemedKeys.length, chats: saved.notifyTargets.length },
      'Restored auto-redeem / notification state'
    );
  }
}

export function registerNotifyTarget(chatId: number) {
  const existing = notifyTargets.get(chatId);
  if (!existing) {
    notifyTargets.set(chatId, {
      chatId,
      lastNotifiedRoundId: '',
      lastLockWarnedRoundId: '',
      paused: false,
    });
    logger.info({ chatId }, 'Registered chat for round notifications');
    persistAuto();
  }
}

export function unregisterNotifyTarget(chatId: number) {
  if (notifyTargets.delete(chatId)) persistAuto();
}

export function setNotifyPaused(chatId: number, paused: boolean) {
  registerNotifyTarget(chatId);
  const t = notifyTargets.get(chatId);
  if (t && t.paused !== paused) {
    t.paused = paused;
    persistAuto();
  }
}

export function isNotifyPaused(chatId: number): boolean {
  return notifyTargets.get(chatId)?.paused === true;
}

function isBlockedByUser(err: any): boolean {
  return err?.error_code === 403 || err?.status === 403;
}

async function broadcast(bot: Bot<Context>, text: string, parseMode: 'HTML' | undefined = 'HTML') {
  for (const target of notifyTargets.values()) {
    try {
      await bot.api.sendMessage(
        target.chatId,
        text,
        parseMode ? { parse_mode: parseMode } : undefined
      );
    } catch (e: any) {
      if (isBlockedByUser(e)) {
        logger.info({ chatId: target.chatId }, 'Chat blocked the bot — unregistering notifications');
        unregisterNotifyTarget(target.chatId);
      }
    }
  }
}

/** PnL for a resolved position; negative for lost bets. */
function positionPnl(pos: PredictPosition): number | null {
  const apiPnl =
    pos.pnlUsd != null && pos.pnlUsd !== '' ? parseFloat(pos.pnlUsd) : NaN;
  if (Number.isFinite(apiPnl)) return apiPnl;

  const entry = parseFloat(pos.avgEntryPrice) || 0;
  const won = pos.isSettled === true || pos.outcomeStatus === 'WON';
  const lost = pos.outcomeStatus === 'LOST';
  if (!won && !lost) return null;

  return won ? pos.shares * (1 - entry) : -entry * pos.shares;
}

/**
 * Start the auto-redeem watcher & round notification service
 */
export function startAutoServices(bot: Bot<Context>) {
  // ─── Round change notifier ───────────────────────────────────────
  roundWatcher.onRoundUpdate(async (round: ActiveRoundState) => {
    const roundId = round.marketId;

    for (const target of notifyTargets.values()) {
      if (target.paused) continue;

      // New round started — notify once per market id
      if (target.lastNotifiedRoundId !== roundId) {
        target.lastNotifiedRoundId = roundId;
        target.lastLockWarnedRoundId = '';
        try {
          await bot.api.sendMessage(
            target.chatId,
            [
              `🔔 <b>New 5M BTC Round Started!</b>`,
              ``,
              `Round: <b>${esc(round.title)}</b>`,
              round.lockPrice > 0
                ? `Lock Price: <b>$${round.lockPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</b>`
                : `Lock Price: <b>⏳ syncing…</b>`,
              `Ends in: <b>${Math.floor(round.secondsRemaining / 60)}:${String(round.secondsRemaining % 60).padStart(2, '0')}</b>`,
              ``,
              `Tap <b>⚡ Quick Bet</b> or <b>🖥️ Live</b>`,
            ].join('\n'),
            { parse_mode: 'HTML' }
          );
        } catch (e: any) {
          if (isBlockedByUser(e)) unregisterNotifyTarget(target.chatId);
        }
      }

      // Lock warning once when we enter the guard window
      if (
        round.secondsRemaining <= config.trading.lockGuardSeconds &&
        round.secondsRemaining > 0 &&
        target.lastLockWarnedRoundId !== roundId
      ) {
        target.lastLockWarnedRoundId = roundId;
        try {
          await bot.api.sendMessage(
            target.chatId,
            `⚠️ <b>Betting closes in ${round.secondsRemaining}s!</b>\nLast chance to bet on current round.`,
            { parse_mode: 'HTML' }
          );
        } catch (e: any) {
          if (isBlockedByUser(e)) unregisterNotifyTarget(target.chatId);
        }
      }
    }
  });

  // ─── Settle + auto-redeem resolved positions ─────────────────────
  if (config.trading.autoRedeem) {
    setInterval(async () => {
      if (redeemInFlight || config.trading.dryRun) return;
      redeemInFlight = true;
      try {
        const positions = await predictFunApi.getPositions({ isResolved: true });

        // 1) Settle every resolved position (win OR loss) exactly once.
        for (const pos of positions) {
          const pnl = positionPnl(pos);
          if (pnl === null) continue;
          const settled = riskManager.recordSettlement(pos.marketId, pnl, pos.outcome);
          if (settled) {
            logger.info(
              { marketId: pos.marketId, outcome: pos.outcome, pnl },
              'Settled trade outcome'
            );
          }
        }

        // 2) Redeem only winning positions, once each, isolating failures.
        for (const pos of positions) {
          if (!pos.conditionId || !pos.isSettled) continue;

          const redeemKey = `${pos.conditionId}|${pos.indexSet ?? '1'}`;
          if (redeemedKeys.has(redeemKey)) continue;

          const indexSet = pos.indexSet === '2' ? 2 : 1;
          const amountWei = pos.isNegRisk
            ? ethers.parseUnits(pos.shares.toFixed(6), 18)
            : undefined;

          try {
            logger.info(
              { conditionId: pos.conditionId, marketId: pos.marketId, isNegRisk: pos.isNegRisk },
              'Auto-redeeming settled position...'
            );

            const result = await predictSigner.redeemCondition(
              pos.conditionId,
              indexSet as 1 | 2,
              !!pos.isNegRisk,
              pos.isYieldBearing ?? false,
              amountWei
            );

            if (!result.success) {
              const failKey = `redeem|${redeemKey}`;
              if (!reportedFailures.has(failKey)) {
                reportedFailures.add(failKey);
                logger.warn(
                  { conditionId: pos.conditionId, error: result.error },
                  'Auto-redeem failed'
                );
                await broadcast(
                  bot,
                  [
                    `⚠️ <b>Auto-redeem failed</b>`,
                    `Market: ${esc(pos.marketTitle || pos.marketId)}`,
                    `Reason: ${esc(result.error || 'unknown')}`,
                  ].join('\n')
                );
              }
              continue;
            }

            redeemedKeys.add(redeemKey);
            persistAuto();
            await broadcast(
              bot,
              [
                `✅ <b>Position Redeemed!</b>`,
                `Market: ${esc(pos.marketTitle || pos.marketId)}`,
                `Outcome: ${esc(pos.outcome)}`,
                `TX: <code>${result.txHash || 'N/A'}</code>`,
              ].join('\n')
            );
          } catch (e: any) {
            // One bad position must not stall the rest of the cycle.
            logger.warn(
              { err: e, conditionId: pos.conditionId },
              'Auto-redeem cycle item failed'
            );
          }
        }
      } catch (e) {
        logger.warn({ err: e }, 'Auto-redeem cycle failed');
      } finally {
        redeemInFlight = false;
      }
    }, 60000); // Check every 60 seconds
  }

  logger.info('Auto-services started (round notifier + settle/auto-redeem)');
}
