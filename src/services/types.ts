/* ============================================================
   Equinox — service interfaces (the web3 seam).
   UI talks ONLY to these. Swap the mock impls for real
   wagmi + @cofhe/sdk later by implementing the same shapes.
   ============================================================ */

import type { Account, Position } from '../types';

/** Live oracle prices keyed by dShare symbol (dTSLA …). */
export type PriceMap = Record<string, { price: number; chg?: number; stale?: boolean; asOf?: number; session?: string; ref24h?: number }>;

/** USDC liquidity (LP supply side) + live rate economics (Batch C). */
export interface LiquidityInfo {
  available: number; // free USDC in the pool (whole USDC)
  totalSupplied: number; // total USDC owed to LPs incl. accrued yield (whole USDC)
  myShares: number; // caller's claimable USDC incl. accrued yield (whole USDC)
  supplyApyBps: number; // current LP supply APR in bps (10000 = 100%)
  borrowApyBps: number; // current borrow APR in bps
  utilizationBps: number; // pool utilization in bps (10000 = 100%)
}

/** A user's on-chain position plus the protocol state needed to value it. */
export interface PositionSnapshot {
  position: Position;
  /** live borrow index in bps (10000 = 1.0). */
  indexBps: number;
  priceStale: boolean;
  weekendOnChain: boolean;
  /** REAL on-chain public blinded factors (A = s·Σ(Cᵢ·priceᵢ·LTᵢ/BPS), B = s·scaledDebt).
   *  Undefined in mock mode / before settlement. */
  factorA?: number;
  factorB?: number;
  /** REAL on-chain healthFactorBps (10000 = 1.0); undefined if factors not yet settled. */
  hfBps?: number;
  /** dShare symbols whose SET collateral handle could NOT be decrypted this read (permit not
   *  ready / threshold network) — the UI carries over their last-known amount instead of dropping. */
  unreadableCollateral?: string[];
  /** On-chain oracle price (whole USD, `assets[i].priceUsd`) for each HELD collateral symbol — the
   *  SAME price the borrow gate uses. The UI values borrow capacity at this (not the live Pyth price)
   *  so "Available to borrow" matches what the chain will actually allow (→ 0 after a max borrow). */
  oraclePrices?: Record<string, number>;
}

export interface WalletInfo {
  address: string;
  chainId: number;
  kind: 'metamask' | 'walletconnect';
}

export interface KycAttestation {
  jurisdiction: string;
  consent: boolean;
}

export interface TxResult {
  txHash: string;
}

export interface BorrowResult extends TxResult {
  /** false when the request exceeded the sealed limit (FHE.select → 0, no revert). */
  approved: boolean;
  disbursed: number;
  /** true when the borrow is committed on-chain but the USDC disbursement (threshold-decrypt →
   *  claimWithdraw) didn't finish in time and is completing in the background (recoverBorrowPayouts). */
  pending?: boolean;
}

export interface UnwrapRequest {
  claimId: string;
  hash: string;
  readyAt: number;
  /** the on-chain withdrawCollateral tx hash (for the history / explorer link). */
  txHash: string;
}

export interface ClaimResult extends TxResult {
  shares: number;
}

export interface EquinoxService {
  /** onProgress reports completed step count (0..4) so the UI can follow the real tx. */
  submitKyc(att: KycAttestation, onProgress?: (step: number) => void): Promise<{ ok: boolean }>;
  /** Deposit `shares` of collateral asset `assetId` (fund plaintext → seal into collateral). */
  deposit(shares: number, assetId: number): Promise<TxResult>;
  /** Confidential borrow. `limit` is the caller's sealed max; FHE.select gates the draw. */
  borrow(amount: number, limit: number): Promise<BorrowResult>;
  repay(amount: number): Promise<TxResult>;
  /** Delayed-claim collateral unwrap for asset `assetId` (HF-gated): threshold decryption
   *  resolves after a few blocks, then claimUnwrapped pays out the freed dShares. */
  requestUnwrap(shares: number, assetId: number): Promise<UnwrapRequest>;
  /** Warm the threshold-decrypt for a pending claim in the background so the Claim tx is instant. */
  prepareUnwrap(claimId: string): Promise<void>;
  /** True once a pending claim's decrypt has finished (proof cached) — the UI gates the Claim
   *  button on this so clicking pops the MetaMask confirm instantly, not after a 1-2 min decrypt. */
  isUnwrapClaimReady(claimId: string): boolean;
  claimUnwrapped(claimId: string, shares: number): Promise<ClaimResult>;
  /** Liquidator view — only the public blinded factors A,B per account. */
  listAccounts(): Promise<Account[]>;
  /** Liquidate `accountId`, seizing collateral asset `seizeAssetId`. */
  liquidate(accountId: string, seizeAssetId: number): Promise<TxResult>;
  /** Settle a borrower's public blinded factors (A,B) via threshold-decrypt proofs,
   *  so their liquidation health-factor becomes computable on-chain. */
  settleFactors(user: string): Promise<TxResult>;
  /** Testnet faucet: mint mock dShare (collateral) `assetId` tokens to the connected wallet. */
  mintDShares(amount: number, assetId: number): Promise<TxResult>;
  /** Testnet faucet: mint mock USDC to the connected wallet (for repay / LP supply). */
  mintUsdc(amount: number): Promise<TxResult>;
  /** LP supply side (public, official Circle USDC): provide / withdraw borrowable USDC. */
  provideLiquidity(amount: number): Promise<TxResult>;
  withdrawLiquidity(amount: number): Promise<TxResult>;
  fetchLiquidity(address: string): Promise<LiquidityInfo>;
  /** Live oracle prices (Pyth Hermes), keyed by dShare symbol. */
  fetchPrices(): Promise<PriceMap>;
  /** Public per-market collateral locked (totalFunded whole shares) keyed by dShare symbol;
   *  the dashboard × live price → $ volume per market. */
  fetchMarketStats(): Promise<Record<string, number>>;
  /** Read + locally-decrypt the connected user's on-chain position. */
  fetchPosition(address: string): Promise<PositionSnapshot>;
  /** Force a fresh decryption permit (drops any cached one) then re-read the position.
   *  Recovery for when a sealed read failed (debt/collateral decrypted to unknown). */
  refreshDecryptionPermit(address: string): Promise<PositionSnapshot>;
  /** Finish any borrow payouts stranded by a coprocessor outage; returns USDC recovered. */
  recoverBorrowPayouts(address: string): Promise<number>;
}

export interface WalletService {
  connect(kind: WalletInfo['kind']): Promise<WalletInfo>;
  current(): WalletInfo | null;
}
