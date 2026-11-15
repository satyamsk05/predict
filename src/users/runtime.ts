import { PredictFunApi } from '../exchanges/predictfun/api.js';
import { PredictSigner } from '../exchanges/predictfun/signer.js';
import { userAccounts } from './accounts.js';

/**
 * Per-user runtime: each member gets their own PredictFunApi + PredictSigner
 * backed by their own wallet, so balances, positions, orders and approvals
 * are fully isolated per Telegram user.
 */

export interface UserRuntime {
  api: PredictFunApi;
  signer: PredictSigner;
}

const runtimes = new Map<number, UserRuntime>();

/** Existing runtime for a user, or null when they have no wallet yet. */
export function getUserRuntime(telegramId: number): UserRuntime | null {
  const cached = runtimes.get(telegramId);
  if (cached) return cached;

  const pk = userAccounts.getPrivateKey(telegramId);
  if (!pk) return null;

  // Per-user instances are EOA-only: never inherit the owner's Predict Account.
  const api = new PredictFunApi({ privateKey: pk, predictAccount: undefined });
  const signer = new PredictSigner(api);
  const rt: UserRuntime = { api, signer };
  runtimes.set(telegramId, rt);
  return rt;
}

/** Create the wallet if needed, then return its runtime. */
export function ensureUserRuntime(telegramId: number, username?: string): UserRuntime | null {
  const cached = runtimes.get(telegramId);
  if (cached) return cached;
  userAccounts.ensureAccount(telegramId, username);
  return getUserRuntime(telegramId);
}

/** Drop cached decrypted-key state (kick/ban, or after an export). */
export function dropUserRuntime(telegramId: number) {
  runtimes.delete(telegramId);
}
