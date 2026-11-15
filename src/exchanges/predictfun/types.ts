export type TradeSide = 'UP' | 'DOWN';

/**
 * Map an API outcome name ("Up"/"Yes"/"Down"/"No") to our UP/DOWN sides.
 * Single source of truth: handlers, settlement and reconciliation must all
 * classify outcomes the same way or trades settle on the wrong side.
 */
export function sideOfOutcome(name?: string | null): TradeSide | null {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  if (n.includes('up') || n.includes('yes')) return 'UP';
  if (n.includes('down') || n.includes('no')) return 'DOWN';
  return null;
}

export interface PredictBookLevel {
  price: number;
  size: number;
}

export interface PredictMarketOutcome {
  id?: string;
  name: string; // e.g. "Up" or "Down" / "Yes" or "No"
  indexSet?: number;
  /** Mid/last price if present (legacy). Prefer bestAsk for buys. */
  price?: number;
  onChainId?: string;
  tokenId?: string;
  status?: string | null;
  bestBid?: PredictBookLevel | null;
  bestAsk?: PredictBookLevel | null;
}

export interface PredictVariantData {
  type?: string;
  priceFeedProvider?: string;
  startPrice?: number | null;
  endPrice?: number | null;
  priceFeedId?: string;
  priceFeedSymbol?: string;
}

export interface PredictMarket {
  id: string | number;
  title?: string;
  question: string;
  category?: string;
  categorySlug?: string;
  seriesSlug?: string;
  /** URL slug used by the web UI: predict.fun/market/<slug> */
  slug?: string;
  status?: string;
  tradingStatus?: string;
  endsAt?: string;
  startsAt?: string;
  feeRateBps?: string | number;
  isNegRisk?: boolean;
  isYieldBearing?: boolean;
  outcomes: PredictMarketOutcome[];
  conditionId?: string;
  volume?: number;
  variantData?: PredictVariantData;
  decimalPrecision?: number;
}

/**
 * The Predict.fun REST API returns orderbook levels as `[price, size]` tuples.
 * Some older/sandbox responses use `{ price, size }` objects, so both are accepted.
 */
export type PredictBookLevelLike = { price: number; size: number } | [number, number];

export interface PredictOrderbook {
  bids: PredictBookLevelLike[];
  asks: PredictBookLevelLike[];
}

/** Normalized position used by the bot UI / auto-redeem */
export interface PredictPosition {
  marketId: string;
  marketTitle?: string;
  conditionId?: string;
  /** Web UI slug for deep links (predict.fun/market/<slug>) */
  slug?: string;
  outcome: string;
  tokenId: string;
  shares: number;
  avgEntryPrice: string;
  currentPrice?: string;
  isNegRisk?: boolean;
  isYieldBearing?: boolean;
  indexSet?: string;
  /** Raw outcome status from the API: WON / LOST / OPEN / ... */
  outcomeStatus?: string;
  isSettled?: boolean;
  isResolved?: boolean;
  pnlUsd?: string;
  valueUsd?: string;
}

export interface PredictSeriesRound {
  id: number | string;
  slug: string;
  title: string;
  shortTitle?: string;
  seriesSlug?: string;
  startsAt: string;
  endsAt: string;
  status?: string;
  isNegRisk?: boolean;
  isYieldBearing?: boolean;
  marketVariant?: string;
  variantData?: PredictVariantData;
  markets: PredictMarket[];
}

/**
 * Buy price for an outcome: prefer best ask, then explicit price.
 * The best bid is deliberately NOT used as a fallback: a BUY limit priced at
 * the bid sits below the ask and can never fill.
 */
export function outcomeBuyPrice(outcome?: PredictMarketOutcome | null): number | undefined {
  if (!outcome) return undefined;
  if (outcome.bestAsk?.price && outcome.bestAsk.price > 0) return outcome.bestAsk.price;
  if (typeof outcome.price === 'number' && outcome.price > 0) return outcome.price;
  return undefined;
}
