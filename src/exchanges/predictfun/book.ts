/**
 * Pure order-book helpers (no imports → unit-testable).
 *
 * Predict.fun books are priced in the FIRST outcome (Yes / Up, indexSet 1).
 * The second outcome (No / Down) is its mirror: No bids = 1 − Yes asks and
 * No asks = 1 − Yes bids, with the same share sizes. If one side of the Yes
 * book is empty the opposite No side is empty too.
 */
export interface BookLevel {
  price: number;
  size: number;
}

type LevelLike = { price: number | string; size: number | string } | [number | string, number | string];

/** Accept `[price, size]` tuples or `{price,size}` objects; drop malformed rows. */
export function normalizeLevels(levels: LevelLike[] | undefined | null): BookLevel[] {
  const out: BookLevel[] = [];
  for (const lvl of levels || []) {
    const price = Number(Array.isArray(lvl) ? lvl[0] : lvl?.price);
    const size = Number(Array.isArray(lvl) ? lvl[1] : lvl?.size);
    if (Number.isFinite(price) && Number.isFinite(size) && price > 0 && price < 1 && size > 0) {
      out.push({ price, size });
    }
  }
  return out;
}

/** Complement a price at `decimals` places (0.492 → 0.508) without float drift. */
export function complement(price: number, decimals = 3): number {
  const scale = 10 ** decimals;
  return (scale - Math.round(price * scale)) / scale;
}

export interface TwoSidedBook {
  /** Best (lowest) first. */
  asks: BookLevel[];
  /** Best (highest) first. */
  bids: BookLevel[];
}

/** UP book as returned by the API (sorted best-first) and the derived DOWN book. */
export function splitBooks(
  yesAsks: LevelLike[] | undefined | null,
  yesBids: LevelLike[] | undefined | null,
  decimals = 3
): { up: TwoSidedBook; down: TwoSidedBook } {
  const asks = normalizeLevels(yesAsks).sort((a, b) => a.price - b.price);
  const bids = normalizeLevels(yesBids).sort((a, b) => b.price - a.price);
  return {
    up: { asks, bids },
    down: {
      asks: bids.map((l) => ({ price: complement(l.price, decimals), size: l.size })),
      bids: asks.map((l) => ({ price: complement(l.price, decimals), size: l.size })),
    },
  };
}
