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

console.log(`\n✅ All ${passed} smoke tests passed`);
