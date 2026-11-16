import { config } from '../config/index.js';

/**
 * Deep links shown in Telegram messages so every trade/round/wallet message
 * can be opened on Predict.fun / BSCScan with one tap (like Polymarket bots).
 */

/** Explorer host for the configured network. */
function scanHost(): string {
  return config.predictfun.isTestnet ? 'https://testnet.bscscan.com' : 'https://bscscan.com';
}

/** Slugs come from the API, so only allow URL-safe characters into the link. */
function safeSegment(value: string): string | null {
  return /^[A-Za-z0-9._~-]+$/.test(value) ? value : null;
}

/** https://predict.fun/market/btc-updown-5m-1794761100 */
export function marketUrl(slug?: string | null): string | null {
  if (!slug) return null;
  const seg = safeSegment(slug);
  return seg ? `https://predict.fun/market/${seg}` : null;
}

/** https://predict.fun/portfolio/0x... (the web profile view) */
export function portfolioUrl(address?: string | null): string | null {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return `https://predict.fun/portfolio/${address}`;
}

/** https://bscscan.com/tx/0x... — only for well-formed 32-byte hashes. */
export function txUrl(txHash?: string | null): string | null {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  return `${scanHost()}/tx/${txHash}`;
}

/** https://bscscan.com/address/0x... */
export function addressUrl(address?: string | null): string | null {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return `${scanHost()}/address/${address}`;
}

/**
 * Inline HTML link line, or empty string when no URL is available.
 * `label` must be plain text (we build the <a> tag ourselves).
 */
export function linkLine(url: string | null, label: string): string {
  return url ? `\n🔗 <a href="${url}">${label} ↗</a>` : '';
}
