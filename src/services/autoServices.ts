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
import { marketUrl, txUrl, linkLine } from '../bot/links.js';
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
/** Redeem keys that failed too many times — stopped from retrying forever. */
const deadRedeems: Set<string> = new Set();
/** Failure counts per redeem key (for the give-up threshold). */
const redeemAttempts: Map<string, number> = new Map();
let redeemInFlight = false;
/** Give up on a redeem key after this many failed attempts in one run. */
const MAX_REDEEM_ATTEMPTS = 5;

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

/** Map a raw outcome name ("Up"/"Yes"/"Down"/"No") to our UP/DOWN sides. */
function sideOf(name: string): 'UP' | 'DOWN' | null {
  const n = (name || '').toLowerCase();
  if (n.includes('up') || n.includes('yes')) return 'UP';
  if (n.includes('down') || n.includes('no')) return 'DOWN';
  return null;
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

      // New round started — notify once per market id. Synthetic placeholder
      // rounds (API outage) are silent: there is nothing to bet on and it
      // would just spam every slot.
      if (!round.synthetic && target.lastNotifiedRoundId !== roundId) {
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
        !round.synthetic &&
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
  if (config.trading.dryRun) {
    // DRY RUN: simulate settlement from the resolved market's start/end price.
    // Without this, dry-run trades stay "Pending" forever and PnL / the loss
    // circuit breaker can never be tested.
    setInterval(async () => {
      if (redeemInFlight) return;
      redeemInFlight = true;
      try {
        const open = riskManager.getUnsettledDryRunTrades();
        if (open.length === 0) return;

        const byMarket = new Map<string, typeof open>();
        for (const t of open) {
          const list = byMarket.get(t.marketId) || [];
          list.push(t);
          byMarket.set(t.marketId, list);
        }

        for (const [marketId, trades] of byMarket) {
          let market;
          try {
            market = await predictFunApi.getMarket(marketId);
          } catch (e) {
            logger.warn({ err: e, marketId }, 'Dry-run settle: market fetch failed');
            continue;
          }
          if (!market) continue;

          const start = market.variantData?.startPrice;
          const end = market.variantData?.endPrice;
          const resolved =
            (market.tradingStatus || market.status) === 'RESOLVED' ||
            (typeof start === 'number' && start > 0 && typeof end === 'number' && end > 0);
          if (!resolved) continue;

          // Winner from start/end price; fall back to a WIN-flagged outcome.
          let winner: 'UP' | 'DOWN' | 'TIE' | null = null;
          if (typeof start === 'number' && start > 0 && typeof end === 'number' && end > 0) {
            winner = end > start ? 'UP' : end < start ? 'DOWN' : 'TIE';
          } else {
            const winOutcome = (market.outcomes || []).find(
              (o) => typeof o.status === 'string' && o.status.toUpperCase().includes('WIN')
            );
            if (winOutcome) winner = sideOf(winOutcome.name);
          }
          if (winner === null) {
            logger.warn({ marketId }, 'Dry-run settle: winner could not be determined');
            continue;
          }

          for (const trade of trades) {
            const result = winner === 'TIE' ? 'REFUND' : winner === trade.outcome ? 'WON' : 'LOST';
            if (riskManager.settleDryRun(trade, result)) {
              const pnl = trade.pnlUsd ?? 0;
              logger.info(
                { marketId, outcome: trade.outcome, result, pnl },
                '[DRY RUN] Trade settled'
              );
              await broadcast(
                bot,
                [
                  `🧪 <b>[DRY RUN] Settled</b>`,
                  `Market: ${esc(market.title || market.question || marketId)}`,
                  linkLine(marketUrl((market as any).slug), 'Open market'),
                  `Bet: ${trade.outcome === 'UP' ? '🟢 UP' : '🔴 DOWN'} $${trade.amountUsdt.toFixed(2)} @ ${(trade.price * 100).toFixed(0)}¢`,
                  `Result: ${result === 'WON' ? '✅ WON' : result === 'LOST' ? '❌ LOST' : '↩️ REFUND'}`,
                  `PnL: <b>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</b>`,
                  `Today's loss: $${riskManager.getStats().dailyLoss} / $${config.trading.dailyLossLimitUsdt}`,
                ]
                  .filter(Boolean)
                  .join('\n')
              );
            }
          }
        }
      } catch (e) {
        logger.warn({ err: e }, 'Dry-run settle cycle failed');
      } finally {
        redeemInFlight = false;
      }
    }, 30000); // Check every 30 seconds
  } else {
    // LIVE: settle outcomes (win OR loss — the circuit breaker needs losses!)
    // every cycle; redeeming winners is optional behind AUTO_REDEEM.
    setInterval(async () => {
      if (redeemInFlight) return;
      redeemInFlight = true;
      try {
        // 0) Orders placed earlier may have filled since — mark them filled so
        //    exposure/stats reflect reality.
        if (riskManager.hasUnfilledTrades()) {
          try {
            const all = await predictFunApi.getPositions();
            for (const pos of all) {
              if (pos.isResolved) continue;
              const side = sideOf(pos.outcome);
              if (side) riskManager.markFilled(pos.marketId, side);
            }
          } catch (e) {
            logger.warn({ err: e }, 'Fill reconciliation pass failed');
          }
        }

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
        if (config.trading.autoRedeem) {
          for (const pos of positions) {
            if (!pos.conditionId || !pos.isSettled) continue;

            const redeemKey = `${pos.conditionId}|${pos.indexSet ?? '1'}`;
            if (redeemedKeys.has(redeemKey) || deadRedeems.has(redeemKey)) continue;

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
                const tries = (redeemAttempts.get(redeemKey) || 0) + 1;
                redeemAttempts.set(redeemKey, tries);
                if (tries >= MAX_REDEEM_ATTEMPTS) {
                  // Stop burning calls/gas-estimates on a permanently failing
                  // redeem (e.g. already redeemed externally, no gas).
                  deadRedeems.add(redeemKey);
                  logger.warn(
                    { conditionId: pos.conditionId, tries },
                    'Auto-redeem gave up after repeated failures'
                  );
                }
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
                  txUrl(result.txHash)
                    ? `TX: <a href="${txUrl(result.txHash)}">${result.txHash!.slice(0, 10)}…${result.txHash!.slice(-6)}</a> ↗`
                    : `TX: <code>${result.txHash || 'N/A'}</code>`,
                ]
                  .filter(Boolean)
                  .join('\n')
              );
            } catch (e: any) {
              // One bad position must not stall the rest of the cycle.
              logger.warn(
                { err: e, conditionId: pos.conditionId },
                'Auto-redeem cycle item failed'
              );
            }
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
