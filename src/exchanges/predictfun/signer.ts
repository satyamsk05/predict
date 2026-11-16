import { OrderBuilder, ChainId, Side } from '@predictdotfun/sdk';
import { ethers } from 'ethers';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { predictFunApi, type PredictFunApi } from './api.js';
import { outcomeBuyPrice, sideOfOutcome, type PredictMarket } from './types.js';
import { buyMaxPrice, floorShares, floorPrice, priceDecimals, MIN_SHARES } from './pricing.js';

class PredictSigner {
  private orderBuilder: OrderBuilder | null = null;
  private isInitialized: boolean = false;
  /** Approval state is per market type (standard vs neg-risk), so cache by key. */
  private approvalsReady: Set<string> = new Set();
  /** API instance whose wallet signs orders (global default / per-user in multi-user mode). */
  private api: PredictFunApi;

  constructor(api: PredictFunApi = predictFunApi) {
    this.api = api;
  }

  public async init(): Promise<void> {
    if (this.isInitialized && this.orderBuilder) return;

    const wallet = this.api.getWallet();
    if (!wallet) {
      logger.warn('Signer wallet not available; dry-run or view-only mode.');
      return;
    }

    try {
      const chainId = config.predictfun.isTestnet ? ChainId.BnbTestnet : ChainId.BnbMainnet;
      // Use this instance's Predict Account (per-user runtimes are EOA-only).
      const predictAccount = this.api.getPredictAccount();
      const options = predictAccount ? { predictAccount } : undefined;
      this.orderBuilder = await OrderBuilder.make(chainId, wallet, options as any);
      this.isInitialized = true;
      logger.info(
        'OrderBuilder initialized successfully with wallet ' +
          wallet.address +
          (predictAccount ? ` (predictAccount ${predictAccount})` : '')
      );
    } catch (e) {
      logger.error({ err: e }, 'Failed to initialize OrderBuilder');
      this.isInitialized = false;
      this.orderBuilder = null;
    }
  }

  public getOrderBuilder(): OrderBuilder | null {
    return this.orderBuilder;
  }

  /**
   * Trading requires on-chain approvals (CTF shares + USDT allowance) for the
   * exchange contracts. Only the approvals needed for the operation are set:
   * a BUY needs the USDT allowance, not the ERC-1155 approval or the split
   * allowances. Scope is derived from the market type.
   */
  public async ensureApprovals(
    market?: Pick<PredictMarket, 'isNegRisk' | 'isYieldBearing'>,
    side: Side = Side.BUY
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.orderBuilder) {
      await this.init();
      if (!this.orderBuilder) {
        return { success: false, error: 'OrderBuilder is not initialized' };
      }
    }

    const isNegRisk = !!market?.isNegRisk;
    const isYieldBearing = !!market?.isYieldBearing;
    const cacheKey = `${isNegRisk ? 'neg' : 'std'}:${isYieldBearing ? 'yb' : 'std'}:${
      side === Side.BUY ? 'buy' : 'sell'
    }`;
    if (this.approvalsReady.has(cacheKey)) return { success: true };

    try {
      const steps = this.orderBuilder.getApprovalSteps({
        operation: 'TRADE',
        isNegRisk,
        isYieldBearing,
        side,
      });

      if (steps.length === 0) {
        this.approvalsReady.add(cacheKey);
        return { success: true };
      }

      logger.info(
        {
          steps: steps.map((s) => s.label),
          isNegRisk,
          isYieldBearing,
          side: side === Side.BUY ? 'BUY' : 'SELL',
        },
        'Checking required protocol approvals'
      );

      const report = await this.orderBuilder.runApprovals(steps, {
        skipSatisfied: true,
        stopOnError: true,
      });

      if (!report.success) {
        const failed = report.steps.find((s) => s.status === 'failed');
        const cause = (failed?.transaction as any)?.cause;
        const msg =
          cause?.shortMessage ||
          cause?.message ||
          failed?.step?.label ||
          'Could not set required protocol approvals';
        logger.error({ steps: report.steps }, 'One or more approvals failed');
        return { success: false, error: msg };
      }

      this.approvalsReady.add(cacheKey);
      logger.info(`Protocol approvals are ready (${side === Side.BUY ? 'BUY' : 'SELL'} scope)`);
      return { success: true };
    } catch (e: any) {
      logger.error({ err: e }, 'Failed to set protocol approvals');
      return { success: false, error: e?.message || String(e) };
    }
  }

  /**
   * Create, sign, and post a BUY order for a specified outcome on Predict.fun
   */
  public async placeBet(
    market: PredictMarket,
    outcome: 'UP' | 'DOWN',
    amountUsdt: number,
    limitPrice?: number,
    /** When the order must stop resting (the round's end). */
    expiresAt?: Date
  ): Promise<{ success: boolean; orderId?: string; orderHash?: string; error?: string }> {
    return this.submitOrder(market, outcome, Side.BUY, { amountUsdt, limitPrice, expiresAt });
  }

  /**
   * Sell (close) an open position: SELL `shares` of `outcome` at `limitPrice`.
   * Used by the "Close / Sell" button so profit can be booked before settlement.
   */
  public async placeSell(
    market: PredictMarket,
    outcome: 'UP' | 'DOWN',
    shares: number,
    limitPrice: number
  ): Promise<{ success: boolean; orderId?: string; orderHash?: string; error?: string }> {
    return this.submitOrder(market, outcome, Side.SELL, { shares, limitPrice });
  }

  private async submitOrder(
    market: PredictMarket,
    outcome: 'UP' | 'DOWN',
    side: Side,
    opts: { amountUsdt?: number; shares?: number; limitPrice?: number; expiresAt?: Date }
  ): Promise<{ success: boolean; orderId?: string; orderHash?: string; error?: string }> {
    if (!this.orderBuilder) {
      await this.init();
      if (!this.orderBuilder) {
        return { success: false, error: 'OrderBuilder is not initialized. Check your PRIVATE_KEY.' };
      }
    }

    try {
      const approvals = await this.ensureApprovals(market, side);
      if (!approvals.success) {
        return { success: false, error: `Approvals failed: ${approvals.error}` };
      }

      const targetOutcome =
        market.outcomes.find((o) => sideOfOutcome(o.name) === outcome) ||
        market.outcomes.find((o) => o.indexSet === (outcome === 'UP' ? 1 : 2));

      if (!targetOutcome || (!targetOutcome.onChainId && !targetOutcome.tokenId)) {
        return {
          success: false,
          error: `Outcome ${outcome} not found for market ${market.id}`,
        };
      }

      const tokenId = (targetOutcome.onChainId || targetOutcome.tokenId)!;

      // An explicit `limitPrice` is the caller's price (user-typed limit, or the
      // confirm-time cap): it is a HARD CAP. Without one, a BUY is a market
      // order priced off the live ask plus the slippage budget.
      const hasExplicitLimit = opts.limitPrice != null && opts.limitPrice > 0;
      const price = hasExplicitLimit
        ? (opts.limitPrice as number)
        : outcomeBuyPrice(targetOutcome) || 0;
      if (!(price > 0) || price >= 1) {
        return {
          success: false,
          error: `No valid ${hasExplicitLimit ? 'limit' : 'ask'} price for ${outcome} (got ${price}). Liquidity may be missing.`,
        };
      }

      // pricePerShare may have at most the market's `decimalPrecision` decimals
      // (we use 2 = 1¢ tick unless the market allows fewer).
      // SELL: quantize down from the bid so the order still crosses.
      const decimals = priceDecimals(market.decimalPrecision);
      const maxPrice =
        side === Side.BUY
          ? buyMaxPrice({
              ask: hasExplicitLimit ? undefined : price,
              hardCap: hasExplicitLimit ? price : undefined,
              slippageBps: config.trading.slippageBps,
              decimals,
            })
          : floorPrice(price, decimals);

      let quantityWei: bigint;
      if (side === Side.BUY) {
        const shares = (opts.amountUsdt ?? 0) / maxPrice;
        if (!(shares > 0)) {
          return { success: false, error: 'Computed share quantity is invalid' };
        }
        quantityWei = ethers.parseEther(floorShares(shares));
      } else {
        const shares = opts.shares ?? 0;
        if (!(shares > 0)) {
          return { success: false, error: 'Position has no shares to sell' };
        }
        quantityWei = ethers.parseEther(floorShares(shares));
      }

      if (quantityWei <= 0n || Number(floorShares(Number(ethers.formatEther(quantityWei)))) < MIN_SHARES) {
        return { success: false, error: `Order too small (minimum ${MIN_SHARES} share)` };
      }

      const priceWei = ethers.parseEther(maxPrice.toFixed(decimals));

      const orderAmounts = this.orderBuilder.getLimitOrderAmounts({
        side,
        pricePerShareWei: priceWei,
        quantityWei,
      });

      // BigInt() throws on decimals ("100.5") — round defensively.
      const feeBpsNum = Number(market.feeRateBps ?? 0);
      const feeRateBps = Number.isFinite(feeBpsNum) && feeBpsNum > 0 ? BigInt(Math.round(feeBpsNum)) : 0n;
      const order = this.orderBuilder.buildOrder('LIMIT', {
        side,
        tokenId,
        makerAmount: orderAmounts.makerAmount,
        takerAmount: orderAmounts.takerAmount,
        feeRateBps,
        // LIMIT orders never expire by default (SDK uses a far-future date), so an
        // unfilled bet would rest on the book after its round. Expire at round end.
        ...(opts.expiresAt && opts.expiresAt.getTime() > Date.now() + 5_000
          ? { expiresAt: opts.expiresAt }
          : {}),
      });

      const typedData = this.orderBuilder.buildTypedData(order, {
        isNegRisk: !!market.isNegRisk,
        isYieldBearing: !!market.isYieldBearing,
      });

      const signedOrder = await this.orderBuilder.signTypedDataOrder(typedData);
      const hash = this.orderBuilder.buildTypedDataHash(typedData);

      const payload = {
        data: {
          pricePerShare: orderAmounts.pricePerShare.toString(),
          strategy: 'LIMIT',
          order: {
            ...signedOrder,
            hash,
          },
        },
      };

      const result = await this.api.postOrder(payload);
      return result;
    } catch (error: any) {
      logger.error(
        { err: error, marketId: market.id, outcome, side },
        side === Side.BUY ? 'Error placing bet' : 'Error selling position'
      );
      return { success: false, error: error.message || String(error) };
    }
  }

  /**
   * Redeem winning shares for a settled condition
   */
  public async redeemCondition(
    conditionId: string,
    indexSet: 1 | 2 = 1,
    isNegRisk = false,
    isYieldBearing = false,
    /** Required for NegRisk markets (wei). */
    amountWei?: bigint
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    if (!this.orderBuilder) {
      await this.init();
      if (!this.orderBuilder) {
        return { success: false, error: 'OrderBuilder not initialized' };
      }
    }

    if (isNegRisk && amountWei === undefined) {
      return { success: false, error: 'Redeem amount is required for NegRisk markets' };
    }

    try {
      const tx = await this.orderBuilder.redeemPositions({
        conditionId,
        indexSet,
        isNegRisk,
        isYieldBearing,
        ...(amountWei !== undefined ? { amount: amountWei } : {}),
      } as any);

      if (!tx.success) {
        const cause = (tx as any)?.cause;
        const msg = cause?.message || cause?.shortMessage || 'Redeem transaction failed';
        logger.error({ conditionId, err: cause }, 'Failed to redeem condition');
        return { success: false, error: msg };
      }

      const txHash = tx.receipt ? tx.receipt.hash : undefined;
      logger.info({ conditionId, txHash }, 'Redeemed positions');
      return { success: true, txHash };
    } catch (e: any) {
      logger.error({ err: e, conditionId }, 'Failed to redeem condition');
      return { success: false, error: e.message || String(e) };
    }
  }
}

export { PredictSigner };
export const predictSigner = new PredictSigner();
