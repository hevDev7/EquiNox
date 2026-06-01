/* ============================================================
   Equinox — chain + deployed-contract configuration.
   Addresses come from Vite env vars (set after `forge script Deploy`).
   ============================================================ */

import type { Address } from 'viem';

export const CHAIN_ID = 421614; // Arbitrum Sepolia
export const LZ_ENDPOINT_ID = 40231; // LayerZero V2 (Arbitrum Sepolia)

export const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'https://sepolia-rollup.arbitrum.io/rpc';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

export const ADDRESSES = {
  pool: (import.meta.env.VITE_EQUINOX_POOL ?? ZERO) as Address,
  kyc: (import.meta.env.VITE_KYC_REGISTRY ?? ZERO) as Address,
  wrapper: (import.meta.env.VITE_FHERC20_WRAPPER ?? ZERO) as Address,
  // official Circle USDC on Arbitrum Sepolia (verified symbol=USDC, decimals=6)
  usdc: (import.meta.env.VITE_USDC ?? '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d') as Address,
  // dShares reference token (override via env for local deploys)
  dshares: (import.meta.env.VITE_DSHARES ?? '0x1be207f7ae412c6deb0505485a36bfbdbd921d89') as Address,
};

/** Whether to use the real chain layer (else mocks). */
export const USE_REAL_CHAIN = import.meta.env.VITE_USE_REAL_CHAIN === 'true';

export const DSHARE_UNIT = 1_000_000n; // 6 decimals
export const USDC_UNIT = 1_000_000n; // 6 decimals
