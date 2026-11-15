import { ethers } from 'ethers';
import { config } from '../config/index.js';

/**
 * One JSON-RPC provider per process, shared by every wallet.
 *
 * The bot now creates one wallet per member. Creating a provider per wallet
 * (the old behaviour) opens a polling loop per member and gets public BSC RPC
 * endpoints rate-limited almost immediately.
 */
let provider: ethers.JsonRpcProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (provider) return provider;

  const instance = new ethers.JsonRpcProvider(config.predictfun.rpcUrl);
  // Public RPCs rate-limit hard; keep polling reasonable (override with
  // RPC_POLLING_MS, e.g. 300 for a private endpoint).
  const pollingMs = Number(process.env.RPC_POLLING_MS || 1000);
  (instance as any).pollingInterval =
    Number.isFinite(pollingMs) && pollingMs >= 100 ? Math.round(pollingMs) : 1000;

  provider = instance;
  return provider;
}
