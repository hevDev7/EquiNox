/* ============================================================
   Equinox — in-memory mock implementation of EquinoxService.
   Simulates coprocessor latency; encodes the PRD's FHE.select
   borrow gate and the delayed-unwrap claim pattern.
   ============================================================ */

import { INITIAL_POSITION, makeAccounts } from '../lib/mock-data';
import { COLLATERAL_ASSETS } from '../config/assets';
import { fetchPythPrices } from '../lib/pyth';
import { PROTOCOL } from '../lib/protocol';
import { txHash } from '../lib/format';
import type { Account, Position } from '../types';
import type {
  BorrowResult,
  EquinoxService,
  ClaimResult,
  KycAttestation,
  LiquidityInfo,
  PriceMap,
  PositionSnapshot,
  TxResult,
  UnwrapRequest,
} from './types';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** ~3 blocks of threshold decryption before an unwrap is claimable. */
const UNWRAP_LATENCY_MS = 12_000;

let claimSeq = 0;

export class MockEquinoxService implements EquinoxService {
  async submitKyc(_att: KycAttestation, onProgress?: (step: number) => void): Promise<{ ok: boolean }> {
    // simulate the 4 onboarding steps so the mock UI mirrors the real tx-driven flow
    for (let step = 1; step <= 4; step++) {
      await delay(650);
      onProgress?.(step);
    }
    return { ok: true };
  }

  async deposit(_shares: number, _assetId: number): Promise<TxResult> {
    await delay(300);
    return { txHash: txHash() };
  }

  async borrow(amount: number, limit: number): Promise<BorrowResult> {
    await delay(300);
    // FHE.select: if R > eMaxBorrow, disburse 0 instead of reverting (no leak).
    const approved = amount <= limit;
    return { approved, disbursed: approved ? amount : 0, txHash: txHash() };
  }

  async repay(_amount: number): Promise<TxResult> {
    await delay(300);
    return { txHash: txHash() };
  }

  async requestUnwrap(_shares: number, _assetId: number): Promise<UnwrapRequest> {
    await delay(300);
    claimSeq += 1;
    return {
      claimId: `claim-${claimSeq}-${(Math.random() * 1e6) | 0}`,
      hash: txHash(),
      readyAt: Date.now() + UNWRAP_LATENCY_MS,
      txHash: txHash(),
    };
  }

  async prepareUnwrap(_claimId: string): Promise<void> {
    /* mock has no threshold network to warm */
  }

  async claimUnwrapped(_claimId: string, shares: number): Promise<ClaimResult> {
    await delay(300);
    return { shares, txHash: txHash() };
  }

  async listAccounts(): Promise<Account[]> {
    await delay(150);
    return makeAccounts();
  }

  async liquidate(_accountId: string, _seizeAssetId: number): Promise<TxResult> {
    await delay(300);
    return { txHash: txHash() };
  }

  async settleFactors(_user: string): Promise<TxResult> {
    await delay(300);
    return { txHash: txHash() };
  }

  async recoverBorrowPayouts(_address: string): Promise<number> {
    await delay(50);
    return 0; // mock has no stranded payouts
  }

  async mintDShares(_amount: number, _assetId: number): Promise<TxResult> {
    await delay(300);
    return { txHash: txHash() };
  }

  async mintUsdc(_amount: number): Promise<TxResult> {
    await delay(300);
    return { txHash: txHash() };
  }

  async provideLiquidity(_amount: number): Promise<TxResult> {
    await delay(300);
    return { txHash: txHash() };
  }

  async withdrawLiquidity(_amount: number): Promise<TxResult> {
    await delay(300);
    return { txHash: txHash() };
  }

  async fetchLiquidity(_address: string): Promise<LiquidityInfo> {
    await delay(120);
    // demo economics: 72% utilized → ~4.6% borrow / ~2.8% supply (kinked curve)
    return {
      available: 70_000,
      totalSupplied: 250_000,
      myShares: 0,
      supplyApyBps: 281,
      borrowApyBps: 460,
      utilizationBps: 7_200,
    };
  }

  /** Live Pyth prices even in demo mode. No offline demo fallback: on a Hermes failure the
   *  error propagates and the UI keeps its honest "connecting…" skeleton rather than dressing
   *  static demo constants up as live/last-close Pyth quotes. */
  async fetchPrices(): Promise<PriceMap> {
    return fetchPythPrices();
  }

  /** Demo per-market collateral (deterministic per ticker) so the markets table shows varied
   *  $ volume even in mock mode. */
  async fetchMarketStats(): Promise<Record<string, number>> {
    await delay(120);
    const out: Record<string, number> = {};
    for (const a of COLLATERAL_ASSETS) {
      let seed = 0;
      for (const c of a.sym) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
      out[a.sym] = 2_000 + (seed % 9_000); // 2k–11k shares of collateral locked
    }
    return out;
  }

  /** Mock position snapshot (used only on initial load; App keeps optimistic state in mock mode). */
  async fetchPosition(_address: string): Promise<PositionSnapshot> {
    await delay(150);
    return {
      position: JSON.parse(JSON.stringify(INITIAL_POSITION)) as Position,
      indexBps: Math.round(PROTOCOL.interestIndex * 10_000),
      priceStale: false,
      weekendOnChain: false,
    };
  }

  /** Mock mode has no FHE permit — just re-read the (in-memory) position. */
  async refreshDecryptionPermit(address: string): Promise<PositionSnapshot> {
    return this.fetchPosition(address);
  }
}

export const mockEquinoxService = new MockEquinoxService();
