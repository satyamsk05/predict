/**
 * Minimal smoke tests for pure logic (no network, no filesystem).
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { parseBetText } from '../bot/betText.js';
import {
  outcomeBuyPrice,
  sideOfOutcome,
  type PredictMarketOutcome,
} from '../exchanges/predictfun/types.js';
import {
  buyMaxPrice,
  marketOrderCap,
  floorShares,
  floorPrice,
  priceDecimals,
} from '../exchanges/predictfun/pricing.js';
import { splitBooks, complement, normalizeLevels } from '../exchanges/predictfun/book.js';
import {
  buildRoundCard,
  buildMainKeyboard,
  buildSettingsKeyboard,
  MAIN_BTN_SET,
  SETTINGS_BTN_SET,
  BTN,
  LEGACY_BTN,
} from '../bot/keyboards.js';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('parseBetText');
check('market bet: "up 10"', () => {
  const r = parseBetText('up 10');
  assert.deepEqual(r, { outcome: 'UP', amountUsdt: 10, limitPrice: undefined });
});
check('limit bet in cents: "down 2 60"', () => {
  const r = parseBetText('down 2 60');
  assert.deepEqual(r, { outcome: 'DOWN', amountUsdt: 2, limitPrice: 0.6 });
});
check('limit bet in dollars: "up 5 0.45"', () => {
  const r = parseBetText('up 5 0.45');
  assert.deepEqual(r, { outcome: 'UP', amountUsdt: 5, limitPrice: 0.45 });
});
check('dollar sign + @ forms', () => {
  assert.deepEqual(parseBetText('up $3 @55'), { outcome: 'UP', amountUsdt: 3, limitPrice: 0.55 });
});
check('case-insensitive: "UP 10"', () => {
  assert.equal(parseBetText('UP 10')?.outcome, 'UP');
});
check('rejects negative/zero amounts', () => {
  assert.equal(parseBetText('up 0'), null);
  assert.equal(parseBetText('up -5'), null);
});
check('rejects out-of-range prices', () => {
  assert.equal(parseBetText('up 5 100'), null); // 100¢ → $1.00, out of range
  assert.equal(parseBetText('up 5 0'), null);
  assert.equal(parseBetText('up 5 150'), null); // 150¢ → $1.50, out of range
  // "< 1" is dollars, otherwise cents: "1.5" → 1.5¢ = 0.015 (by design)
  assert.equal(parseBetText('up 5 1.5')?.limitPrice, 0.015);
});
check('rejects non-bet text', () => {
  assert.equal(parseBetText('hello'), null);
  assert.equal(parseBetText(''), null);
  assert.equal(parseBetText('up'), null);
});

console.log('outcomeBuyPrice');
check('prefers best ask', () => {
  const o: PredictMarketOutcome = {
    name: 'Up',
    bestAsk: { price: 0.55, size: 100 },
    bestBid: { price: 0.45, size: 100 },
  };
  assert.equal(outcomeBuyPrice(o), 0.55);
});
check('falls back to explicit price', () => {
  assert.equal(outcomeBuyPrice({ name: 'Up', price: 0.6 }), 0.6);
});
check('does NOT fall back to best bid (unfillable buy)', () => {
  const o: PredictMarketOutcome = { name: 'Up', bestBid: { price: 0.45, size: 100 } };
  assert.equal(outcomeBuyPrice(o), undefined);
});
check('undefined outcome → undefined', () => {
  assert.equal(outcomeBuyPrice(undefined), undefined);
});

console.log('sideOfOutcome');
check('maps Up/Down', () => {
  assert.equal(sideOfOutcome('Up'), 'UP');
  assert.equal(sideOfOutcome('DOWN'), 'DOWN');
});
check('maps Yes/No (binary markets)', () => {
  assert.equal(sideOfOutcome('yes'), 'UP');
  assert.equal(sideOfOutcome('No'), 'DOWN');
});
check('trims and handles null/empty', () => {
  assert.equal(sideOfOutcome('  Up  '), 'UP');
  assert.equal(sideOfOutcome(null), null);
  assert.equal(sideOfOutcome(''), null);
  assert.equal(sideOfOutcome(undefined), null);
});
check('unknown outcome → null (never guessed)', () => {
  assert.equal(sideOfOutcome('tie'), null);
  assert.equal(sideOfOutcome('void'), null);
});
check('whole-word match: "unknown"/"north" are NOT read as DOWN', () => {
  assert.equal(sideOfOutcome('unknown'), null);
  assert.equal(sideOfOutcome('north'), null);
  assert.equal(sideOfOutcome('Up ↑'), 'UP');
});

console.log('pricing');
check('buyMaxPrice: user limit is a HARD cap (never raised by slippage)', () => {
  assert.equal(buyMaxPrice({ hardCap: 0.5, slippageBps: 5000 }), 0.5);
  assert.equal(buyMaxPrice({ hardCap: 0.505, slippageBps: 100 }), 0.5); // rounded DOWN
});
check('buyMaxPrice: market order = ask + slippage, never below the ask', () => {
  assert.equal(buyMaxPrice({ ask: 0.5, slippageBps: 0 }), 0.5);
  assert.equal(buyMaxPrice({ ask: 0.5, slippageBps: 1000 }), 0.55);
  assert.equal(buyMaxPrice({ ask: 0.505, slippageBps: 0 }), 0.51); // off-tick ask rounds up
});
check('buyMaxPrice: clamped to 1¢..99¢', () => {
  assert.equal(buyMaxPrice({ ask: 0.98, slippageBps: 10_000 }), 0.99);
  assert.equal(buyMaxPrice({ hardCap: 0.001, slippageBps: 0 }), 0.01);
});
check('buyMaxPrice: float noise (0.29*100) does not drop a cent', () => {
  assert.equal(buyMaxPrice({ hardCap: 0.29, slippageBps: 0 }), 0.29);
  assert.equal(buyMaxPrice({ hardCap: 0.57, slippageBps: 0 }), 0.57);
});
check('marketOrderCap: at least +1¢, rounded up, capped at 99¢', () => {
  assert.equal(marketOrderCap(0.5, 100), 0.51);
  assert.equal(marketOrderCap(0.5, 2000), 0.6);
  assert.equal(marketOrderCap(0.985, 100), 0.99);
});
check('floorShares rounds DOWN (never exceeds shares held)', () => {
  assert.equal(floorShares(12.3456789), '12.345678');
  assert.equal(floorShares(12.345678), '12.345678');
  assert.equal(floorShares(0.0000009), '0.000000');
});

console.log('price decimals');
check('priceDecimals: 2 unless the market allows only 1', () => {
  assert.equal(priceDecimals(undefined), 2);
  assert.equal(priceDecimals(3), 2);
  assert.equal(priceDecimals(2), 2);
  assert.equal(priceDecimals(1), 1);
});
check('1-decimal markets: caps and floors land on a 10¢ tick', () => {
  assert.equal(buyMaxPrice({ hardCap: 0.57, slippageBps: 0, decimals: 1 }), 0.5);
  assert.equal(buyMaxPrice({ ask: 0.5, slippageBps: 0, decimals: 1 }), 0.5);
  assert.equal(marketOrderCap(0.5, 100, 1), 0.6);
  assert.equal(floorPrice(0.57, 1), 0.5);
  assert.equal(floorPrice(0.57), 0.57);
  assert.equal(floorPrice(0.001), 0.01);
});

console.log('order book');
check('normalizeLevels: tuples/objects, drops junk', () => {
  const l = normalizeLevels([[0.5, 10], { price: '0.4', size: '2' }, [0, 5], [0.3, 0], [1, 1], ['x', 1] as any]);
  assert.deepEqual(l, [
    { price: 0.5, size: 10 },
    { price: 0.4, size: 2 },
  ]);
});
check('complement has no float drift', () => {
  assert.equal(complement(0.492), 0.508);
  assert.equal(complement(0.29, 2), 0.71);
});
check('DOWN book mirrors the UP (Yes) book', () => {
  const { up, down } = splitBooks(
    [[0.493, 20], [0.492, 30]],
    [[0.49, 5], [0.491, 300]]
  );
  assert.deepEqual(up.asks.map((l) => l.price), [0.492, 0.493]);
  assert.deepEqual(up.bids.map((l) => l.price), [0.491, 0.49]);
  // No asks = 1 − Yes bids (best first = lowest), No bids = 1 − Yes asks (highest first)
  assert.deepEqual(down.asks.map((l) => l.price), [0.509, 0.51]);
  assert.deepEqual(down.bids.map((l) => l.price), [0.508, 0.507]);
  assert.deepEqual(down.asks.map((l) => l.size), [300, 5]);
});
check('empty side on UP means the opposite DOWN side is empty', () => {
  const { up, down } = splitBooks([], [[0.4, 10]]);
  assert.equal(up.asks.length, 0);
  assert.equal(down.bids.length, 0);
  assert.equal(down.asks.length, 1);
});

console.log('menu');
check('main keyboard buttons are all routable', () => {
  const rows = buildMainKeyboard().keyboard.flat().map((b: any) => (typeof b === 'string' ? b : b.text));
  assert.equal(rows.length, 8);
  for (const t of rows) assert.ok(MAIN_BTN_SET.has(t), t);
  assert.ok(rows.includes(BTN.PROFILE));
  assert.ok(!rows.includes(BTN.LOG) && !rows.includes(BTN.PAUSE));
});
check('labels from the previous keyboard still map to a current label', () => {
  for (const [old, now] of Object.entries(LEGACY_BTN)) {
    assert.ok(now === '/help' || Object.values(BTN).includes(now as any), old);
  }
});
check('profile keyboard buttons are all routable', () => {
  const rows = buildSettingsKeyboard().keyboard.flat().map((b: any) => (typeof b === 'string' ? b : b.text));
  for (const t of rows) assert.ok(SETTINGS_BTN_SET.has(t), t);
  assert.ok(rows.includes(BTN.EXPORT_KEY) && rows.includes(BTN.BACK));
  assert.ok(rows.includes(BTN.LOG) && rows.includes(BTN.PAUSE));
  const muted = buildSettingsKeyboard(true).keyboard.flat().map((b: any) => (typeof b === 'string' ? b : b.text));
  assert.ok(muted.includes(BTN.RESUME) && !muted.includes(BTN.PAUSE));
});
check('round card: compact, no raw HTML specials, lock/test notices', () => {
  const card = buildRoundCard(
    {
      title: 'BTC <5M>', secondsRemaining: 161, lockPrice: 98420.1, currentPrice: 98455.62,
      priceDiff: 35.52, currentTrend: 'UP', upPrice: 0.54, downPrice: 0.46, isLocked: false,
      endsAt: Date.now() + 161000, marketId: '1', roundSlug: 'btc-updown-5m-1',
    } as any,
    12.5
  );
  assert.ok(card.includes('02:41 left'));
  assert.ok(card.includes('BTC &lt;5M&gt;'));
  assert.ok(card.includes('1.85x') && card.includes('2.17x'));
  assert.ok(card.includes('Balance  $12.50'));
  assert.ok(!card.includes('━'));
  assert.ok((card.match(/\p{Extended_Pictographic}/gu) || []).length <= 10);
});

console.log(`\n✅ All ${passed} smoke tests passed`);
