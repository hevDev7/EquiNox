/* ============================================================
   CELP — protocol constants + FHE-flavoured math (the blinding primitive)
   ============================================================ */

import type { Account, AssetMap, DerivedPosition, Position } from '../types';

/** Protocol constants (from PRD). */
export const PROTOCOL = {
  LT: 0.8, // liquidation threshold
  LTV: 0.7, // max loan-to-value
  haircut: 0.15, // weekend collateral haircut
  liqBonus: 0.075, // liquidation bonus
  interestIndex: 1.0241, // I — accumulated borrow index
  hcuBudget: 5_000_000,
  chainId: 421614, // Arbitrum Sepolia
  endpointId: 40231, // LayerZero V2
} as const;

/** Compute derived position values + public blinded factors A_i, B_i. */
export function derivePosition(
  pos: Position,
  prices: AssetMap,
  opts: { weekend?: boolean; index?: number; oraclePrices?: Record<string, number> } = {},
): DerivedPosition {
  const weekend = !!opts.weekend;
  // live borrow index from chain (currentIndexBps/BPS) in real mode; the PRD
  // demo constant otherwise. `pos.debtUSDC` carries the un-indexed principal.
  const I = opts.index ?? PROTOCOL.interestIndex;
  let collatShares = 0;
  let collatValue = 0; // market value at LIVE price (for display)
  let collatGateValue = 0; // value at the ON-CHAIN oracle price (what the borrow gate actually uses)
  pos.collateral.forEach((c) => {
    const live = prices[c.under]?.price ?? 0;
    // The on-chain gate values collateral at assets[i].priceUsd, NOT the live Pyth price. Use it for
    // borrow capacity so "Available to borrow" matches the chain (→ 0 after a max borrow); fall back
    // to the live price in mock mode / before the snapshot loads.
    const gate = opts.oraclePrices?.[c.under] ?? live;
    collatShares += c.shares;
    collatValue += c.shares * live;
    collatGateValue += c.shares * gate;
  });
  const effLT = PROTOCOL.LT * (weekend ? 1 - PROTOCOL.haircut : 1);
  const debt = pos.debtUSDC * I;
  const maxBorrow = collatGateValue * PROTOCOL.LTV * (weekend ? 1 - PROTOCOL.haircut : 1);
  // subtract the INDEXED current debt (matches on-chain eRoom = eMax − scaledDebt·idx/BPS), not the
  // raw un-indexed principal — otherwise interest accrual would leave a phantom borrowable slice.
  const remaining = Math.max(0, maxBorrow - debt);
  const hf = debt > 0 ? (collatValue * effLT) / debt : Infinity;

  // public blinded factors
  const C = collatShares; // shares
  const A = Math.round(pos.blinding * C * PROTOCOL.LT);
  const B = Math.round(pos.blinding * pos.debtUSDC);

  return {
    collatShares,
    collatValue,
    debt,
    maxBorrow,
    remaining,
    hf,
    effLT,
    A,
    B,
    liqPrice: pos.debtUSDC > 0 ? (pos.debtUSDC * I) / (collatShares * effLT) : 0,
  };
}

/**
 * HF computed by a liquidator from PUBLIC factors only — the secret s_i cancels:
 *   A = s·C·LT, B = s·D  ->  A/B = C·LT/D  ->  HF = (A·P)/(B·I)
 */
export function liquidatorHF(acct: Account, price: number, I: number = PROTOCOL.interestIndex): number {
  return (acct.A * price) / (acct.B * I);
}

/** Weekend circuit-breaker check — Fri 21:00 UTC → Mon 13:30 UTC. */
export function isWeekendMode(date: Date): boolean {
  const d = date.getUTCDay(); // 0 Sun .. 6 Sat
  const mins = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (d === 6) return true; // Sat
  if (d === 0) return true; // Sun
  if (d === 5 && mins >= 21 * 60) return true; // Fri after 21:00
  if (d === 1 && mins < 13 * 60 + 30) return true; // Mon before 13:30
  return false;
}
