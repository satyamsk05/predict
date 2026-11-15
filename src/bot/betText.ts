/**
 * Pure bet-text parsing — no imports, no side effects, fully unit-testable.
 * Parse "up 1 50" (= $1 UP at 50¢) style text.
 * Third value: `< 1` is treated as dollars, otherwise cents.
 */
export function parseBetText(
  text: string
): { outcome: 'UP' | 'DOWN'; amountUsdt: number; limitPrice?: number } | null {
  const m = text
    .trim()
    .match(/^(up|down)\s+\$?(\d+(?:\.\d+)?)(?:\s*@?\s*(\d+(?:\.\d+)?))?$/i);
  if (!m) return null;

  const outcome = m[1].toUpperCase() as 'UP' | 'DOWN';
  const amountUsdt = parseFloat(m[2]);
  if (!(amountUsdt > 0)) return null;

  let limitPrice: number | undefined;
  if (m[3] != null) {
    const raw = parseFloat(m[3]);
    limitPrice = raw < 1 ? raw : raw / 100;
    if (!(limitPrice >= 0.01 && limitPrice <= 0.99)) return null;
  }

  return { outcome, amountUsdt, limitPrice };
}
