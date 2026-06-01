/* ============================================================
   Equinox — viem clients sourced from the wagmi (RainbowKit) config,
   so the real service uses the wallet the user connected via RainbowKit.
   ============================================================ */

import { getPublicClient as wagmiGetPublicClient, getWalletClient as wagmiGetWalletClient } from 'wagmi/actions';
import { arbitrumSepolia } from 'wagmi/chains';
import type { PublicClient, WalletClient } from 'viem';
import { wagmiConfig } from '../config/wagmi';

export const chain = arbitrumSepolia;

export function getPublicClient(): PublicClient {
  const client = wagmiGetPublicClient(wagmiConfig, { chainId: arbitrumSepolia.id });
  if (!client) throw new Error('No public client configured for Arbitrum Sepolia');
  return client as unknown as PublicClient;
}

export async function getWalletClient(): Promise<WalletClient> {
  const client = await wagmiGetWalletClient(wagmiConfig, { chainId: arbitrumSepolia.id });
  if (!client) throw new Error('Wallet not connected');
  return client as unknown as WalletClient;
}
