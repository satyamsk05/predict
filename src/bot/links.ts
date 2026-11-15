/**
 * Deep links shown in Telegram messages so every trade/round/wallet message
 * can be opened on Predict.fun / BSCScan with one tap (like Polymarket bots).
 */

/** https://predict.fun/market/btc-updown-5m-1794761100 */
export function marketUrl(slug?: string | null): string | null {
  if (!slug) return null;
  return `https://predict.fun/market/${slug}`;
}

/** https://predict.fun/portfolio/0x... (the web profile view) */
export function portfolioUrl(address?: string | null): string | null {
  if (!address) return null;
  return `https://predict.fun/portfolio/${address}`;
}

/** https://bscscan.com/tx/0x... — only for well-formed 32-byte hashes. */
export function txUrl(txHash?: string | null): string | null {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  return `https://bscscan.com/tx/${txHash}`;
}

/** https://bscscan.com/address/0x... */
export function addressUrl(address?: string | null): string | null {
  if (!address) return null;
  return `https://bscscan.com/address/${address}`;
}

/**
 * Inline HTML link line, or empty string when no URL is available.
 * `label` must be plain text (we build the <a> tag ourselves).
 */
export function linkLine(url: string | null, label: string): string {
  return url ? `\n🔗 <a href="${url}">${label} ↗</a>` : '';
}
