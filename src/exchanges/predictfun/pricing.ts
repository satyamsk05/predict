/**
 * Pure order-pricing helpers (no imports, no side effects → unit-testable).
 *
 * Prices are quantised to a tick of 10^-decimals dollars. The docs say a price
 * never has more decimals than the market's `decimalPrecision`; we use at most
 * 2 (1¢ tick) and fewer only if the market allows fewer. A tiny epsilon absorbs
 * binary-float noise such as `0.29 * 100 === 28.999999999999996`.
 */
const EPS = 1e-9;

/** Decimals the bot may use on `pricePerShare` for a market (1 or 2). */
export function priceDecimals(marketPrecision?: number | null): 1 | 2 {
  return marketPrecision === 1 ? 1 : 2;
}

function clampTicks(ticks: number, scale: number): number {
  return Math.max(1, Math.min(scale - 1, ticks));
}

/** Round a SELL price DOWN to the tick (so it still crosses the bid). */
export function floorPrice(price: number, decimals: 1 | 2 = 2): number {
  const scale = 10 ** decimals;
  return clampTicks(Math.floor(price * scale + EPS), scale) / scale;
}

/**
 * Highest price (in dollars) a BUY order may be submitted at.
 *
 * - `hardCap` given (user typed a limit, or the confirm-time quote + tolerance):
 *   the price is a HARD CAP — rounded DOWN to the tick and never raised, so the
 *   bot can never pay more than the user agreed to.
 * - otherwise (market order): best ask plus the slippage budget, rounded down to
 *   the tick but never below the ask itself (otherwise the order cannot cross).
 */
export function buyMaxPrice(input: {
  ask?: number;
  hardCap?: number;
  slippageBps: number;
  decimals?: 1 | 2;
}): number {
  const scale = 10 ** (input.decimals ?? 2);
  const top = (scale - 1) / scale;
  if (input.hardCap != null) {
    return clampTicks(Math.floor(input.hardCap * scale + EPS), scale) / scale;
  }

  const ask = input.ask ?? 0;
  const slip = Math.max(0, input.slippageBps) / 10_000;
  const raw = Math.min(top, ask * (1 + slip));
  let max = clampTicks(Math.floor(raw * scale + EPS), scale) / scale;
  if (max < ask) {
    max = Math.min(top, Math.ceil(ask * scale - EPS) / scale);
  }
  return max;
}

/**
 * Price cap for a "market" BUY that the user confirmed at `quoted`.
 * Allows the slippage budget but at least one tick (1¢), rounded UP to a tick.
 * If the live ask is above this, the bot must ask the user to re-confirm
 * instead of silently paying the new price.
 */
export function marketOrderCap(quoted: number, slippageBps: number, decimals: 1 | 2 = 2): number {
  const scale = 10 ** decimals;
  const tolerance = Math.max(1 / scale, (quoted * Math.max(0, slippageBps)) / 10_000);
  return Math.min((scale - 1) / scale, Math.ceil((quoted + tolerance) * scale - EPS) / scale);
}

/** Smallest order the SDK accepts for market orders (0.01 share). */
export const MIN_SHARES = 0.01;

/**
 * Share quantity as a 6-decimal string, rounded DOWN.
 * Rounding to nearest could exceed the shares actually held (SELL) or the USDT
 * budget (BUY) by a few micro-shares and get the order rejected.
 */
export function floorShares(shares: number): string {
  return (Math.floor(shares * 1e6 + EPS) / 1e6).toFixed(6);
}
