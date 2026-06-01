/* ============================================================
   Equinox — multi-collateral asset registry (frontend mirror of the
   on-chain EquinoxPoolV2 registry). assetId == array index == on-chain
   registry order == src/config/stocks.ts order (the deploy script
   registered the assets in this exact sequence).
   ============================================================ */

import type { Address } from 'viem';
import { STOCKS } from './stocks';

export interface CollateralAsset {
  assetId: number;
  sym: string; // dShare symbol (dTSLA …)
  wrapped: string; // confidential wrapped symbol (fbTSLA …) — the sealed-collateral form
  name: string;
  decimals: number;
  address: Address; // deployed dShare ERC-20 (open-mint MockStock on testnet)
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** The 18 registered dShare collaterals, addresses resolved from Vite env (VITE_D*). */
export const COLLATERAL_ASSETS: CollateralAsset[] = STOCKS.map((s, i) => ({
  assetId: i,
  sym: s.sym,
  wrapped: s.wrapped,
  name: s.name,
  decimals: s.decimals,
  address: ((import.meta.env[s.envKey as keyof ImportMetaEnv] as string | undefined) ?? ZERO) as Address,
}));

export const ASSET_BY_ID: Record<number, CollateralAsset> = Object.fromEntries(
  COLLATERAL_ASSETS.map((a) => [a.assetId, a]),
);
export const ASSET_BY_SYM: Record<string, CollateralAsset> = Object.fromEntries(
  COLLATERAL_ASSETS.map((a) => [a.sym, a]),
);

/** Default active collateral asset (dTSLA = assetId 0). */
export const DEFAULT_ASSET_ID = 0;
