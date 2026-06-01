/* ============================================================
   Equinox — shared domain types
   ============================================================ */

export type Phase = 'gate' | 'kyc' | 'app';
export type Mode = 'borrower' | 'liquidator';
export type BorrowerTab = 'dashboard' | 'portfolio' | 'borrow' | 'repay' | 'faucet' | 'liquidity';

export type ThemeName = 'sterling' | 'obsidian' | 'vellum';
export type AccentName = 'Teal' | 'Violet' | 'Cobalt';
export type PrivacyMode = 'cipher' | 'decimal' | 'redacted';
export type Density = 'compact' | 'regular' | 'comfy';

export interface Asset {
  sym: string;
  name: string;
  wrapped?: string;
  price?: number;
  chg?: number;
  decimals: number;
  addr: string;
  /** true when the oracle price is a frozen last-close (all sessions closed). */
  stale?: boolean;
  /** unix seconds of the oracle price's publish time. */
  asOf?: number;
  /** Pyth trading session the live price came from: PRE | REG | POST | OVN. */
  session?: string;
  /** ~24h-ago anchor price; lets the live stream recompute the 24h change per tick. */
  ref24h?: number;
}
export type AssetMap = Record<string, Asset>;

export interface CollateralItem {
  sym: string;
  under: string;
  shares: number;
}

/** The user's TRUE (locally-decryptable) position. */
export interface Position {
  collateral: CollateralItem[];
  walletShares: Record<string, number>;
  walletUSDC: number;
  debtUSDC: number; // D_i principal
  blinding: number; // s_i (secret)
  /** true when the sealed debt handle exists on-chain but client-side decryption
   *  FAILED (stale permit / cofhejs↔testnet skew) → `debtUSDC` (0) is NOT trustworthy;
   *  the real debt is unknown and likely non-zero. Distinct from a genuinely-zero debt. */
  debtUnknown?: boolean;
}

/** Values derived from a Position + oracle prices. */
export interface DerivedPosition {
  collatShares: number;
  collatValue: number;
  debt: number;
  maxBorrow: number;
  remaining: number;
  hf: number;
  effLT: number;
  A: number; // public blinded factor A_i = s_i·C_i·LT
  B: number; // public blinded factor B_i = s_i·D_i
  liqPrice: number;
}

/** A liquidator-visible account — only A, B are public on-chain. */
export interface Account {
  id: string;
  under: string;
  C: number; // hidden truth
  D: number; // hidden truth
  s: number; // hidden truth
  A: number;
  B: number;
  hf?: number; // computed by liquidator from public factors
  /** live borrow index in bps used to scale this account's HF (real chain);
   *  absent → the demo interest-index constant is used. */
  idxBps?: number;
  /** V2: the contract's authoritative healthFactorBps (10000 = 1.0). When present the
   *  liquidator uses this instead of the V1 client-side A·price/(B·I) formula, because V2
   *  folds price into the blinded factor A. Undefined for un-settled accounts / mock mode. */
  hfBps?: number;
}

export interface Claim {
  id: string;
  under: string; // dShare symbol being unwrapped (e.g. 'dTSLA') — multi-collateral aware
  shares: number;
  hash: string;
  requestedAt: number;
  readyAt: number;
}

export interface ToastData {
  title: string;
  icon?: string;
  hash?: string;
}

export interface Tweaks {
  theme: ThemeName;
  accent: AccentName;
  privacyMode: PrivacyMode;
  density: Density;
  weekendSim: boolean;
}
