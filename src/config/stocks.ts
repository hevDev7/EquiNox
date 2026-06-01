/* ============================================================
   Equinox — tokenized-equity (dShare) basket for Arbitrum Sepolia.

   Pyth feed IDs are the REAL canonical regular-market-hours equity
   feeds (Equity.US.<SYM>/USD), fetched from Pyth Hermes and
   adversarially cross-verified. Feed IDs are chain-agnostic.

   Pyth pull-oracle contract on Arbitrum Sepolia per Pyth docs:
   https://docs.pyth.network/price-feeds/core/contract-addresses/evm
   (re-verify against the live docs before any mainnet deployment).
   ============================================================ */

import type { Address } from 'viem';

/** Pyth pull-oracle (IPyth) on Arbitrum Sepolia. */
export const PYTH_ARBITRUM_SEPOLIA = '0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF' as Address;

export interface StockMeta {
  sym: string; // dShare symbol (collateral)
  wrapped: string; // encrypted wrapper symbol
  name: string;
  decimals: number;
  /** demo price (whole USD) until a live oracle is wired */
  price: number;
  chg: number;
  /** canonical Pyth "Equity.US.<SYM>/USD" pull-feed id (regular market hours) */
  pythFeedId: `0x${string}`;
  pythSymbol: string;
  /** Vite env var holding the deployed mock token address (DeployMocks.s.sol) */
  envKey: string;
}

export const STOCKS: StockMeta[] = [
  { sym: 'dTSLA', wrapped: 'fbTSLA', name: 'Tesla Inc.', decimals: 6, price: 342.18, chg: +1.84,
    pythFeedId: '0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1', pythSymbol: 'Equity.US.TSLA/USD', envKey: 'VITE_DTSLA' },
  { sym: 'dAAPL', wrapped: 'fbAAPL', name: 'Apple Inc.', decimals: 6, price: 214.06, chg: -0.42,
    pythFeedId: '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688', pythSymbol: 'Equity.US.AAPL/USD', envKey: 'VITE_DAAPL' },
  { sym: 'dNVDA', wrapped: 'fbNVDA', name: 'NVIDIA Corp.', decimals: 6, price: 138.45, chg: +2.61,
    pythFeedId: '0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593', pythSymbol: 'Equity.US.NVDA/USD', envKey: 'VITE_DNVDA' },
  { sym: 'dMSFT', wrapped: 'fbMSFT', name: 'Microsoft Corp.', decimals: 6, price: 430.12, chg: +0.33,
    pythFeedId: '0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1', pythSymbol: 'Equity.US.MSFT/USD', envKey: 'VITE_DMSFT' },
  { sym: 'dGOOGL', wrapped: 'fbGOOGL', name: 'Alphabet Inc.', decimals: 6, price: 178.32, chg: -0.74,
    pythFeedId: '0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6', pythSymbol: 'Equity.US.GOOGL/USD', envKey: 'VITE_DGOOGL' },
  { sym: 'dAMZN', wrapped: 'fbAMZN', name: 'Amazon.com Inc.', decimals: 6, price: 205.74, chg: +1.12,
    pythFeedId: '0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a', pythSymbol: 'Equity.US.AMZN/USD', envKey: 'VITE_DAMZN' },
  { sym: 'dMETA', wrapped: 'fbMETA', name: 'Meta Platforms', decimals: 6, price: 581.39, chg: +0.97,
    pythFeedId: '0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe', pythSymbol: 'Equity.US.META/USD', envKey: 'VITE_DMETA' },
  { sym: 'dCOIN', wrapped: 'fbCOIN', name: 'Coinbase Global', decimals: 6, price: 312.55, chg: +3.48,
    pythFeedId: '0xfee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245', pythSymbol: 'Equity.US.COIN/USD', envKey: 'VITE_DCOIN' },
  { sym: 'dAMD', wrapped: 'fbAMD', name: 'Advanced Micro Devices', decimals: 6, price: 121.4, chg: +1.85,
    pythFeedId: '0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e', pythSymbol: 'Equity.US.AMD/USD', envKey: 'VITE_DAMD' },
  { sym: 'dNFLX', wrapped: 'fbNFLX', name: 'Netflix Inc.', decimals: 6, price: 892.1, chg: +0.74,
    pythFeedId: '0x8376cfd7ca8bcdf372ced05307b24dced1f15b1afafdeff715664598f15a3dd2', pythSymbol: 'Equity.US.NFLX/USD', envKey: 'VITE_DNFLX' },
  { sym: 'dPLTR', wrapped: 'fbPLTR', name: 'Palantir Technologies', decimals: 6, price: 78.32, chg: +4.12,
    pythFeedId: '0x11a70634863ddffb71f2b11f2cff29f73f3db8f6d0b78c49f2b5f4ad36e885f0', pythSymbol: 'Equity.US.PLTR/USD', envKey: 'VITE_DPLTR' },
  { sym: 'dINTC', wrapped: 'fbINTC', name: 'Intel Corp.', decimals: 6, price: 21.05, chg: -1.2,
    pythFeedId: '0xc1751e085ee292b8b3b9dd122a135614485a201c35dfc653553f0e28c1baf3ff', pythSymbol: 'Equity.US.INTC/USD', envKey: 'VITE_DINTC' },
  { sym: 'dJPM', wrapped: 'fbJPM', name: 'JPMorgan Chase', decimals: 6, price: 245.6, chg: +0.55,
    pythFeedId: '0x7f4f157e57bfcccd934c566df536f34933e74338fe241a5425ce561acdab164e', pythSymbol: 'Equity.US.JPM/USD', envKey: 'VITE_DJPM' },
  { sym: 'dV', wrapped: 'fbV', name: 'Visa Inc.', decimals: 6, price: 315.2, chg: +0.31,
    pythFeedId: '0xc719eb7bab9b2bc060167f1d1680eb34a29c490919072513b545b9785b73ee90', pythSymbol: 'Equity.US.V/USD', envKey: 'VITE_DV' },
  { sym: 'dDIS', wrapped: 'fbDIS', name: 'Walt Disney Co.', decimals: 6, price: 112.4, chg: -0.62,
    pythFeedId: '0x703e36203020ae6761e6298975764e266fb869210db9b35dd4e4225fa68217d0', pythSymbol: 'Equity.US.DIS/USD', envKey: 'VITE_DDIS' },
  { sym: 'dBA', wrapped: 'fbBA', name: 'Boeing Co.', decimals: 6, price: 178.9, chg: +1.05,
    pythFeedId: '0x8419416ba640c8bbbcf2d464561ed7dd860db1e38e51cec9baf1e34c4be839ae', pythSymbol: 'Equity.US.BA/USD', envKey: 'VITE_DBA' },
  { sym: 'dMSTR', wrapped: 'fbMSTR', name: 'MicroStrategy Inc.', decimals: 6, price: 331.5, chg: +5.2,
    pythFeedId: '0xe1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09', pythSymbol: 'Equity.US.MSTR/USD', envKey: 'VITE_DMSTR' },
  { sym: 'dNKE', wrapped: 'fbNKE', name: 'Nike Inc.', decimals: 6, price: 76.18, chg: -0.88,
    pythFeedId: '0x67649450b4ca4bfff97cbaf96d2fd9e40f6db148cb65999140154415e4378e14', pythSymbol: 'Equity.US.NKE/USD', envKey: 'VITE_DNKE' },
];

export const STOCK_BY_SYM: Record<string, StockMeta> = Object.fromEntries(STOCKS.map((s) => [s.sym, s]));

/* ---- sector taxonomy (for the Markets filter) ---- */
export type SectorKey = 'tech' | 'semis' | 'consumer' | 'finance' | 'crypto' | 'industrial';

/** Ordered sector chips shown in the Markets filter. */
export const SECTORS: { key: SectorKey; label: string }[] = [
  { key: 'tech', label: 'Tech' },
  { key: 'semis', label: 'Semiconductors' },
  { key: 'consumer', label: 'Consumer' },
  { key: 'finance', label: 'Finance' },
  { key: 'crypto', label: 'Crypto' },
  { key: 'industrial', label: 'Industrial' },
];

/** Sector of each dShare (by symbol) — every asset belongs to exactly one. */
export const SECTOR_OF: Record<string, SectorKey> = {
  dAAPL: 'tech', dMSFT: 'tech', dGOOGL: 'tech', dMETA: 'tech', dPLTR: 'tech',
  dNVDA: 'semis', dAMD: 'semis', dINTC: 'semis',
  dTSLA: 'consumer', dAMZN: 'consumer', dNKE: 'consumer', dDIS: 'consumer', dNFLX: 'consumer',
  dJPM: 'finance', dV: 'finance',
  dCOIN: 'crypto', dMSTR: 'crypto',
  dBA: 'industrial',
};
