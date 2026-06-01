/* ============================================================
   Equinox — real on-chain implementation of EquinoxService.
   Uses viem for contract calls + cofhejs for client-side encryption.

   Targets the CONFIDENTIAL-SETTLEMENT pool (post-EQX-02): position values
   are sealed and never publicly decrypted. Real tokens move only at the
   plaintext fund/withdraw edges:
     - deposit  = fundShares(plaintext) → deposit(sealed amount)
     - borrow   = requestBorrow(sealed) credits sealed USDC; realize it as real
                  USDC via requestWithdraw → claimWithdraw (async threshold decrypt)
     - repay    = fundUsdc(plaintext) → repay(sealed amount from credit)
     - liquidate= fundUsdc(plaintext) → liquidate(sealed repay) (single-step)

   NOT runnable against a bare local node: it targets Arbitrum Sepolia with
   the CoFHE coprocessor live and the contracts deployed. Swap in for the mock
   by setting VITE_USE_REAL_CHAIN=true.
   ============================================================ */

import { parseAbiItem, publicActions, type Abi, type Address, type Hash } from 'viem';
import poolAbiJson from '../abi/EquinoxPoolV2.json';
import kycAbiJson from '../abi/KYCRegistry.json';
import erc20AbiJson from '../abi/MockERC20.json';
import { ADDRESSES, DSHARE_UNIT, USDC_UNIT } from '../config/contracts';
import { COLLATERAL_ASSETS, ASSET_BY_ID } from '../config/assets';
import { getPublicClient, getWalletClient, chain } from './viem-clients';
import { encryptUint64, ensureCofhe, unsealUint64, decryptForTxUint64, refreshPermit } from '../lib/cofhe';
import { fetchPythPrices } from '../lib/pyth';
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

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/** Persist the client-only blinding secret s so the cosmetic blinded factors
 *  survive a page reload. (The real C/D/HF derive from decrypted chain state,
 *  not from s, so a missing s never affects displayed truth.) */
const sKey = (addr: string) => `equinox.s.${addr.toLowerCase()}`;
function saveBlinding(addr: string, s: bigint): void {
  try {
    localStorage.setItem(sKey(addr), s.toString());
  } catch {
    /* storage unavailable — blinding is cosmetic, ignore */
  }
}
function loadBlinding(addr: string): number {
  try {
    const v = localStorage.getItem(sKey(addr));
    if (v) return Number(BigInt(v));
  } catch {
    /* ignore */
  }
  return 1;
}

/* ---- AUDIT #2: resumable borrow-payout store ------------------------------
   borrow() burns sealed credit into a Withdrawal, then claims it via the async
   threshold-decrypt. If the coprocessor 503s mid-claim the credit is stranded
   with no client-side record of the withdrawId. We persist pending payouts so
   a later sweep (recoverBorrowPayouts) can finish the claim — withdrawId is
   also fully recoverable on-chain (withdrawals[] / WithdrawRequested). */
interface PendingPayout {
  withdrawId: string;
  amount: number;
  ts: number;
}
const ppKey = (addr: string) => `equinox.pendingPayout.${addr.toLowerCase()}`;
function loadPendingPayouts(addr: string): PendingPayout[] {
  try {
    return JSON.parse(localStorage.getItem(ppKey(addr)) || '[]') as PendingPayout[];
  } catch {
    return [];
  }
}
function savePendingPayouts(addr: string, list: PendingPayout[]): void {
  try {
    localStorage.setItem(ppKey(addr), JSON.stringify(list));
  } catch {
    /* storage unavailable — best-effort */
  }
}
function addPendingPayout(addr: string, p: PendingPayout): void {
  savePendingPayouts(addr, [...loadPendingPayouts(addr), p]);
}
function removePendingPayout(addr: string, withdrawId: string): void {
  savePendingPayouts(addr, loadPendingPayouts(addr).filter((x) => x.withdrawId !== withdrawId));
}

/** Fetch a fresh KYC attestation { expiry, signature } from the attester service.
 *  The registry verifies the attester's ECDSA signature over
 *  keccak256(user, expiry, registry, chainId) — see KYCRegistry.attestationDigest. */
async function fetchAttestation(
  user: Address,
  registry: Address,
  chainId: number,
): Promise<{ expiry: bigint; signature: `0x${string}` }> {
  const url = import.meta.env.VITE_KYC_ATTESTER_URL as string | undefined;
  if (!url) {
    throw new Error(
      'KYC attester not configured: set VITE_KYC_ATTESTER_URL to your attester API ' +
        '(or run the reference signer in scripts/attester.mjs for local testing).',
    );
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, registry, chainId }),
  });
  if (!res.ok) throw new Error(`KYC attester returned ${res.status}`);
  const j = (await res.json()) as { expiry: string | number; signature: string };
  return { expiry: BigInt(j.expiry), signature: j.signature as `0x${string}` };
}

const poolAbi = poolAbiJson as Abi;
const kycAbi = kycAbiJson as Abi;
const erc20Abi = erc20AbiJson as Abi;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Cryptographically-strong 64-bit blinding s in [10_000_000, 2^53) (AUDIT EQX-12f:
 *  replaces the previous Math.random()-derived value). */
function randomBlinding(): bigint {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  // 53-bit magnitude, comfortably below euint64 and the on-chain factor overflow band
  const hi = BigInt(buf[0] & 0x1f_ffff); // 21 bits
  const lo = BigInt(buf[1]); // 32 bits
  const s = (hi << 32n) | lo;
  return s < 10_000_000n ? s + 10_000_000n : s;
}

/* ============================================================
   [INSTR] Temporary borrow-flow timing instrumentation.
   Logs per-boundary latency to the console so we can see which await
   dominates the "Disburse USDC · update limit" wait. Pure logging — no
   behaviour change. Set TIMING=false (or delete this block + the tlog()/
   _now() calls) once the dominant factor is confirmed.
   ============================================================ */
const TIMING = true;
const _now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function tlog(label: string, startMs: number, extra = ''): void {
  if (TIMING) console.log(`[equinox-timing] ${label}: ${(_now() - startMs).toFixed(0)}ms${extra ? '  · ' + extra : ''}`);
}

export class CofheEquinoxService implements EquinoxService {
  /** Lazy so importing this module (e.g. in mock mode) never touches the chain. */
  private get pub() {
    return getPublicClient();
  }

  private async account(): Promise<Address> {
    const wc = await getWalletClient();
    if (!wc.account) throw new Error('Wallet not connected');
    return wc.account.address;
  }

  /** Cache of in-flight/resolved threshold-decryptions for pending unwrap claims, keyed by
   *  withdrawId. Pre-decrypting (prepareUnwrap) RIGHT AFTER the request lets the Claim button
   *  fire claimWithdraw — and thus the MetaMask popup — INSTANTLY, instead of stalling 1-2 min
   *  on the threshold network at click time. */
  private _unwrapProofs = new Map<string, ReturnType<typeof decryptForTxUint64>>();
  private _unwrapReady = new Set<string>(); // claimIds whose pre-warm decrypt has RESOLVED

  /** Decrypt a withdrawal's sealed `take` once, sharing the promise so a concurrent
   *  prepare + claim never double-decrypts. Marks the claim "ready" once it resolves so the
   *  UI only enables Claim when the proof is cached (→ MetaMask pops instantly). A failed
   *  decrypt is evicted so it can retry. */
  private _decryptUnwrap(claimId: string, handle: bigint): ReturnType<typeof decryptForTxUint64> {
    let p = this._unwrapProofs.get(claimId);
    if (!p) {
      p = decryptForTxUint64(handle);
      p.then(() => this._unwrapReady.add(claimId)).catch(() => {
        this._unwrapProofs.delete(claimId);
        this._unwrapReady.delete(claimId);
      });
      this._unwrapProofs.set(claimId, p);
    }
    return p;
  }

  /** True once a claim's threshold-decrypt has finished (proof cached) → claiming is instant. */
  isUnwrapClaimReady(claimId: string): boolean {
    return this._unwrapReady.has(claimId);
  }

  /** Warm the threshold-decrypt for a pending unwrap claim in the BACKGROUND (called right
   *  after requestUnwrap), so claimUnwrapped finds it ready. Best-effort & idempotent. */
  async prepareUnwrap(claimId: string): Promise<void> {
    try {
      await ensureCofhe(this.pub, await getWalletClient()); // bind the SDK so the warm works on a fresh reload too
      const w = await this.read<readonly [Address, bigint, boolean, boolean, bigint]>(
        ADDRESSES.pool,
        poolAbi,
        'withdrawals',
        [BigInt(claimId)],
      );
      if (w[3]) return; // already claimed — nothing to warm
      await this._decryptUnwrap(claimId, BigInt(w[1]));
    } catch {
      /* best-effort warm-up; claimUnwrapped will decrypt on demand if this missed */
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async send(address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<any> {
    const wc = await getWalletClient();
    const account = await this.account();
    // Arbitrum Sepolia's base fee drifts by a hair between estimate and submit;
    // the default fee can land just under it ("max fee per gas less than block
    // base fee" → RPC rejects). Add headroom — gas here is ~0.02 gwei so 3x is
    // still a negligible cost.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fees: any = {};
    let _t = _now();
    try {
      const f = await this.pub.estimateFeesPerGas();
      if (f.maxFeePerGas != null) fees.maxFeePerGas = f.maxFeePerGas * 3n;
      if (f.maxPriorityFeePerGas != null) fees.maxPriorityFeePerGas = f.maxPriorityFeePerGas;
    } catch {
      /* fall back to wallet-managed fees */
    }
    tlog(`send(${functionName}) estimateFeesPerGas`, _t);
    // GAS LIMIT — Arbitrum folds the L1-calldata posting cost INTO the L2 gas limit,
    // and that component is VOLATILE: `eth_estimateGas` snapshots the L1 base fee at
    // estimate time, but by the time the tx executes it can rise, pushing real usage
    // PAST the estimated limit → the tx reverts OUT OF GAS. This bit `claimWithdraw`
    // hardest (it carries a 65-byte threshold-decrypt proof): a real claim needs
    // ~117k gas but the auto-estimate handed back ~96k, so the borrow's "Disburse
    // USDC" step silently reverted and the modal hung on its last step forever.
    // Estimate ourselves, then add generous headroom — gas on Arb Sepolia is ~free.
    _t = _now();
    let _estOk = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const est = await this.pub.estimateContractGas({ address, abi, functionName, args, account } as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fees as any).gas = est * 2n + 300_000n;
    } catch {
      _estOk = false;
      /* estimate failed (RPC hiccup, or a genuinely reverting call) — fall back to
         the wallet's own estimate, preserving the existing revert-surfacing path */
    }
    tlog(`send(${functionName}) estimateContractGas`, _t, _estOk ? 'ok' : 'FAILED → wallet-estimate (call may revert!)');
    // viem's generics are narrowed by const ABIs; we use runtime ABIs, so cast.
    if (TIMING) console.log(`[equinox-timing] send(${functionName}) → calling writeContract NOW (MetaMask popup should appear)`);
    _t = _now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hash: Hash = await wc.writeContract({ address, abi, functionName, args, account, chain, ...fees } as any);
    tlog(`send(${functionName}) writeContract resolved (popup shown + user confirmed)`, _t);
    _t = _now();
    const receipt = await this._waitForReceipt(wc, hash);
    tlog(`send(${functionName}) waitForReceipt`, _t);
    return receipt;
  }

  /**
   * Wait for a tx receipt robustly. BUGFIX: the tx is submitted via the WALLET's RPC
   * (MetaMask), but the app's public client polls a DIFFERENT public endpoint
   * (sepolia-rollup.arbitrum.io) that can lag or drop the receipt — an unbounded
   * `waitForTransactionReceipt` then HANGS, leaving the UI modal stuck on its last step
   * even though the wallet shows the tx confirmed. We poll BOTH the wallet's own transport
   * (the RPC that accepted the tx, so it reliably has the receipt) AND the public client in
   * parallel, take whichever surfaces it first, and cap with a timeout so it never hangs.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _waitForReceipt(wc: any, hash: Hash): Promise<any> {
    const walletPub = wc.extend(publicActions); // public reads over MetaMask's transport
    let receipt;
    try {
      receipt = await Promise.any([
        walletPub.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 2_000 }),
        this.pub.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 4_000 }),
      ]);
    } catch {
      throw new Error(
        'Transaction sent, but its on-chain receipt could not be confirmed in time. ' +
          'It may still have succeeded — check your wallet/explorer before retrying.',
      );
    }
    if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain.');
    return receipt;
  }

  private async read<T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.pub.readContract({ address, abi, functionName, args } as any) as Promise<T>;
  }

  async submitKyc(_att: KycAttestation, onProgress?: (step: number) => void): Promise<{ ok: boolean }> {
    await ensureCofhe(this.pub, await getWalletClient());
    const addr = await this.account();
    onProgress?.(1);

    // Idempotent: skip register if already KYC'd (the single-use registry reverts
    // AlreadyRegistered on a repeat — which MetaMask surfaces as a huge gas estimate).
    const registered = await this.read<boolean>(ADDRESSES.kyc, kycAbi, 'isRegistered', [addr]);
    if (!registered) {
      // Real attester-signed registration (the sole KYC gate — AUDIT EQX-08).
      const { expiry, signature } = await fetchAttestation(addr, ADDRESSES.kyc, chain.id);
      await this.send(ADDRESSES.kyc, kycAbi, 'register', [expiry, signature]);
    }
    onProgress?.(2);

    // Idempotent: skip initBlinding if already initialized (else AlreadyInitialized revert).
    const initialized = await this.read<boolean>(ADDRESSES.pool, poolAbi, 'initialized', [addr]);
    if (!initialized) {
      // initialize the confidential account with a sealed, CSPRNG blinding s_i
      const s = randomBlinding();
      saveBlinding(addr, s);
      const encS = await encryptUint64(s);
      await this.send(ADDRESSES.pool, poolAbi, 'initBlinding', [encS]);
    }
    onProgress?.(4);
    return { ok: true };
  }

  /** Plaintext fund edge + sealed allocation to collateral. */
  async deposit(shares: number, assetId: number): Promise<TxResult> {
    const asset = ASSET_BY_ID[assetId];
    if (!asset) throw new Error(`Unknown collateral asset ${assetId}`);
    await ensureCofhe(this.pub, await getWalletClient());
    await this.send(asset.address, erc20Abi, 'approve', [ADDRESSES.pool, BigInt(shares) * DSHARE_UNIT]);
    await this.send(ADDRESSES.pool, poolAbi, 'fundShares', [BigInt(assetId), BigInt(shares)]);
    const encShares = await encryptUint64(BigInt(shares));
    const receipt = await this.send(ADDRESSES.pool, poolAbi, 'deposit', [BigInt(assetId), encShares]);
    return { txHash: receipt.transactionHash };
  }

  /** Confidential borrow: credits sealed USDC (no public disbursement), then realizes it
   *  as real USDC via the async withdraw-claim edge. AUDIT #2: the withdrawId is persisted
   *  BEFORE claiming, so a transient coprocessor 503 mid-claim leaves a recoverable record
   *  (see recoverBorrowPayouts) instead of stranding the sealed credit. */
  async borrow(amount: number, _limit: number): Promise<BorrowResult> {
    const _tB = _now();
    const me = await this.account();
    let _t = _now();
    await ensureCofhe(this.pub, await getWalletClient());
    tlog('borrow › ensureCofhe', _t);
    _t = _now();
    const encR = await encryptUint64(BigInt(amount));
    tlog('borrow › encrypt R', _t);
    _t = _now();
    const reqReceipt = await this.send(ADDRESSES.pool, poolAbi, 'requestBorrow', [encR]);
    tlog('borrow › requestBorrow TOTAL (tx #1)', _t);

    // realize the sealed proceeds as real USDC (CoFHE 0.1.x proof model):
    // requestWithdraw makes the amount publicly decryptable → threshold-decrypt
    // off-chain for value+proof → claimWithdraw verifies the proof and pays out.
    _t = _now();
    const encW = await encryptUint64(BigInt(amount));
    tlog('borrow › encrypt W', _t);
    _t = _now();
    await this.send(ADDRESSES.pool, poolAbi, 'requestWithdraw', [encW, true, 0n]); // USDC payout — assetId ignored
    tlog('borrow › requestWithdraw TOTAL (tx #2)', _t);
    _t = _now();
    const count = await this.read<bigint>(ADDRESSES.pool, poolAbi, 'withdrawalsCount');
    tlog('borrow › read withdrawalsCount', _t);
    const withdrawId = count - 1n;
    addPendingPayout(me, { withdrawId: withdrawId.toString(), amount, ts: Date.now() });

    _t = _now();
    // BOUND the disburse. _claimPayout's decryptForTx runs on the CoFHE threshold network, which
    // can be slow or — when the testnet coprocessor is degraded — UNRESPONSIVE (no timeout on
    // .execute()), which would hang the modal forever at "Disburse USDC". Race the claim against a
    // timeout: on timeout the borrow is already on-chain (requestBorrow + requestWithdraw committed)
    // and the pending payout persists, so recoverBorrowPayouts (and the still-running claim) realize
    // the USDC in the background — the modal completes as "disbursing", never stalls.
    const TIMED_OUT = -2;
    const claimP = this._claimPayout(me, withdrawId).catch((e) => {
      console.warn('[equinox] borrow disbursement deferred — recovery will finish it:', String((e as Error)?.message ?? e));
      return -1; // claim errored/deferred → pending
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disbursed = await Promise.race<number>([
      claimP,
      new Promise<number>((res) => {
        timer = setTimeout(() => res(TIMED_OUT), 90_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    tlog('borrow › _claimPayout TOTAL (the "Disburse USDC · update limit" step)', _t, disbursed === TIMED_OUT ? 'TIMED OUT → background' : '');
    tlog('borrow ✦ GRAND TOTAL', _tB);
    if (disbursed === TIMED_OUT || disbursed === -1) {
      // disburse still in flight / threshold slow → background claim + recovery finish it
      return { approved: true, disbursed: 0, txHash: reqReceipt.transactionHash, pending: true };
    }
    // disbursed > 0 = realized; disbursed === 0 = FHE.select gated the draw to 0 (over limit)
    return { approved: disbursed > 0, disbursed, txHash: reqReceipt.transactionHash };
  }

  /** Threshold-decrypt + claim a single USDC withdrawal, clearing its pending record on
   *  success. Throws (keeping the pending record) if the coprocessor is unavailable. */
  private async _claimPayout(owner: Address, withdrawId: bigint): Promise<number> {
    // withdrawals(id) → (owner, amount(euint64 handle), isUsdc, claimed, assetId)
    let _t = _now();
    const w = await this.read<readonly [Address, bigint, boolean, boolean, bigint]>(
      ADDRESSES.pool,
      poolAbi,
      'withdrawals',
      [withdrawId],
    );
    tlog('claimPayout › read withdrawals', _t);
    if (w[3]) {
      removePendingPayout(owner, withdrawId.toString()); // already claimed
      return 0;
    }
    _t = _now();
    const { value, proof } = await decryptForTxUint64(BigInt(w[1]));
    tlog('claimPayout › decryptForTx ★ THRESHOLD-DECRYPT (off-chain; NO popup; gates claimWithdraw)', _t);
    _t = _now();
    await this.send(ADDRESSES.pool, poolAbi, 'claimWithdraw', [withdrawId, value, proof]);
    tlog('claimPayout › claimWithdraw TOTAL (tx #3 — the disburse confirm popup)', _t);
    removePendingPayout(owner, withdrawId.toString());
    return Number(value);
  }

  /** AUDIT #2: finish any borrow payouts that were stranded by a coprocessor outage.
   *  Returns the total USDC recovered. Safe to call on every app load. */
  async recoverBorrowPayouts(address: string): Promise<number> {
    const me = address as Address;
    const pending = loadPendingPayouts(me);
    if (!pending.length) return 0;
    await ensureCofhe(this.pub, await getWalletClient());
    let recovered = 0;
    for (const p of pending) {
      try {
        const wid = BigInt(p.withdrawId);
        const w = await this.read<readonly [Address, bigint, boolean, boolean, bigint]>(
          ADDRESSES.pool,
          poolAbi,
          'withdrawals',
          [wid],
        );
        if (w[3] || w[0].toLowerCase() !== me.toLowerCase()) {
          removePendingPayout(me, p.withdrawId); // claimed elsewhere or not ours
          continue;
        }
        recovered += await this._claimPayout(me, wid);
      } catch (e) {
        console.warn('[Equinox] borrow-payout recovery deferred (coprocessor unavailable):', e);
      }
    }
    return recovered;
  }

  /** Plaintext fund edge + sealed repay from credit. */
  async repay(amount: number): Promise<TxResult> {
    await ensureCofhe(this.pub, await getWalletClient());
    await this.send(ADDRESSES.usdc, erc20Abi, 'approve', [ADDRESSES.pool, BigInt(amount) * USDC_UNIT]);
    await this.send(ADDRESSES.pool, poolAbi, 'fundUsdc', [BigInt(amount)]);
    const encAmt = await encryptUint64(BigInt(amount));
    const receipt = await this.send(ADDRESSES.pool, poolAbi, 'repay', [encAmt]);
    return { txHash: receipt.transactionHash };
  }

  /** Multi-collateral unwrap: HF-gated `withdrawCollateral` on the POOL for the chosen asset,
   *  realized through the claim path (threshold-decrypt → claimWithdraw pays out the dShares).
   *  The pool seals WHOLE shares (like deposit), so no DSHARE_UNIT scaling here. */
  async requestUnwrap(shares: number, assetId: number): Promise<UnwrapRequest> {
    await ensureCofhe(this.pub, await getWalletClient());
    const encShares = await encryptUint64(BigInt(shares));
    const receipt = await this.send(ADDRESSES.pool, poolAbi, 'withdrawCollateral', [BigInt(assetId), encShares]);
    const count = await this.read<bigint>(ADDRESSES.pool, poolAbi, 'withdrawalsCount');
    const claimId = (count - 1n).toString();
    // warm the threshold-decrypt in the background so the eventual Claim is instant.
    void this.prepareUnwrap(claimId);
    return { claimId, hash: claimId, readyAt: Date.now() + 36_000, txHash: receipt.transactionHash };
  }

  async claimUnwrapped(claimId: string, _shares: number): Promise<ClaimResult> {
    await ensureCofhe(this.pub, await getWalletClient());
    // withdrawals(id) → (owner, amount(euint64 handle), isUsdc, claimed, assetId)
    const w = await this.read<readonly [Address, bigint, boolean, boolean, bigint]>(
      ADDRESSES.pool,
      poolAbi,
      'withdrawals',
      [BigInt(claimId)],
    );
    if (w[3]) return { shares: 0, txHash: `0x${'0'.repeat(64)}` as Hash }; // already claimed
    // reuse the pre-warmed decrypt (prepareUnwrap) → MetaMask confirm pops instantly.
    const { value, proof } = await this._decryptUnwrap(claimId, BigInt(w[1]));
    const receipt = await this.send(ADDRESSES.pool, poolAbi, 'claimWithdraw', [BigInt(claimId), value, proof]);
    this._unwrapProofs.delete(claimId);
    this._unwrapReady.delete(claimId);
    return { shares: Number(value), txHash: receipt.transactionHash }; // whole dShares freed (0 if HF-gated)
  }

  /** Settle a user's public blinded factors (A,B) so liquidation HF is computable.
   *  Reads the eA/eB handles, threshold-decrypts off-chain, submits with proofs. */
  async settleFactors(user: string): Promise<TxResult> {
    await ensureCofhe(this.pub, await getWalletClient());
    const [eA, eB] = await this.read<readonly [bigint, bigint]>(
      ADDRESSES.pool,
      poolAbi,
      'encryptedFactorsOf',
      [user as Address],
    );
    const a = await decryptForTxUint64(eA);
    const b = await decryptForTxUint64(eB);
    const receipt = await this.send(ADDRESSES.pool, poolAbi, 'settleFactors', [
      user as Address,
      a.value,
      b.value,
      a.proof,
      b.proof,
    ]);
    return { txHash: receipt.transactionHash };
  }

  /** Testnet faucet: mint mock USDC (open mint) to the connected wallet — for repay / LP supply. */
  async mintUsdc(amount: number): Promise<TxResult> {
    const addr = await this.account();
    const receipt = await this.send(ADDRESSES.usdc, erc20Abi, 'mint', [addr, BigInt(Math.floor(amount)) * USDC_UNIT]);
    return { txHash: receipt.transactionHash };
  }

  /** Testnet faucet: mint mock dShares (open mint) of `assetId` to the connected wallet. */
  async mintDShares(amount: number, assetId: number): Promise<TxResult> {
    const asset = ASSET_BY_ID[assetId];
    if (!asset) throw new Error(`Unknown collateral asset ${assetId}`);
    const addr = await this.account();
    const receipt = await this.send(asset.address, erc20Abi, 'mint', [addr, BigInt(Math.floor(amount)) * DSHARE_UNIT]);
    return { txHash: receipt.transactionHash };
  }

  /** LP supply side — provide official Circle USDC for borrowers to draw. */
  async provideLiquidity(amount: number): Promise<TxResult> {
    await this.send(ADDRESSES.usdc, erc20Abi, 'approve', [ADDRESSES.pool, BigInt(amount) * USDC_UNIT]);
    const receipt = await this.send(ADDRESSES.pool, poolAbi, 'provideLiquidity', [BigInt(amount)]);
    return { txHash: receipt.transactionHash };
  }

  async withdrawLiquidity(amount: number): Promise<TxResult> {
    const receipt = await this.send(ADDRESSES.pool, poolAbi, 'withdrawLiquidity', [BigInt(amount)]);
    return { txHash: receipt.transactionHash };
  }

  async fetchLiquidity(address: string): Promise<LiquidityInfo> {
    const [available, totalSupplied, myShares, supplyRate, borrowRate, util] = await Promise.all([
      this.read<bigint>(ADDRESSES.pool, poolAbi, 'availableLiquidity'),
      this.read<bigint>(ADDRESSES.pool, poolAbi, 'totalSuppliedUsdc'),
      this.read<bigint>(ADDRESSES.pool, poolAbi, 'lpBalanceOf', [address as Address]),
      this.read<bigint>(ADDRESSES.pool, poolAbi, 'currentSupplyRateBps'),
      this.read<bigint>(ADDRESSES.pool, poolAbi, 'currentBorrowRateBps'),
      this.read<bigint>(ADDRESSES.pool, poolAbi, 'utilizationBps'),
    ]);
    return {
      available: Number(available),
      totalSupplied: Number(totalSupplied),
      myShares: Number(myShares),
      supplyApyBps: Number(supplyRate),
      borrowApyBps: Number(borrowRate),
      utilizationBps: Number(util),
    };
  }

  /** Public per-asset pool collateral (`totalFunded`, whole shares) keyed by dShare symbol.
   *  The dashboard multiplies this by the live price to show $ volume locked per market.
   *  Aggregate-only — per-user collateral stays sealed. */
  async fetchMarketStats(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    await Promise.all(
      COLLATERAL_ASSETS.map(async (a) => {
        try {
          // assets(id) → (token, priceUsd, priceAt, ltvBps, ltBps, liqBonusBps, supplyCap, totalFunded, enabled, tokenDecimals)
          const cfg = await this.read<readonly unknown[]>(ADDRESSES.pool, poolAbi, 'assets', [BigInt(a.assetId)]);
          out[a.sym] = Number(cfg[7] as bigint); // totalFunded — whole shares funded into the pool
        } catch {
          out[a.sym] = 0;
        }
      }),
    );
    return out;
  }

  /** Live Pyth prices (Hermes HTTP) keyed by dShare symbol. */
  async fetchPrices(): Promise<PriceMap> {
    return fetchPythPrices();
  }

  /** Read the connected user's REAL position from chain: public protocol state +
   *  plaintext ERC-20 wallet balances + client-decrypted sealed collateral/debt. */
  async fetchPosition(address: string): Promise<PositionSnapshot> {
    const addr = address as Address;
    const pool = ADDRESSES.pool;

    const [indexBpsRaw, priceStale, weekendOnChain] = await Promise.all([
      this.read<bigint>(pool, poolAbi, 'currentIndexBps'),
      this.read<boolean>(pool, poolAbi, 'isPriceStale'),
      this.read<boolean>(pool, poolAbi, 'isWeekendMode'),
    ]);

    // plaintext USDC balance + every dShare wallet balance (real ERC-20 reads, 6 decimals)
    const usdcRaw = await this.read<bigint>(ADDRESSES.usdc, erc20Abi, 'balanceOf', [addr]);
    const walletUSDC = Number(usdcRaw) / Number(USDC_UNIT);
    const walletBalRaw = await Promise.all(
      COLLATERAL_ASSETS.map((a) => this.read<bigint>(a.address, erc20Abi, 'balanceOf', [addr])),
    );
    const walletShares: Record<string, number> = {};
    COLLATERAL_ASSETS.forEach((a, i) => {
      const v = Number(walletBalRaw[i]) / Number(DSHARE_UNIT);
      if (v > 0) walletShares[a.sym] = v;
    });

    // sealed scaled debt + per-asset sealed collateral — decrypt client-side (owner-only).
    let scaledDebt = 0;
    let debtUnknown = false;
    const collateral: Position['collateral'] = [];
    const unreadableCollateral: string[] = []; // held assets whose decrypt failed this round
    const initialized = await this.read<boolean>(pool, poolAbi, 'initialized', [addr]);
    if (initialized) {
      await ensureCofhe(this.pub, await getWalletClient()); // ensures an active permit
      const debtH = await this.read<bigint>(pool, poolAbi, 'encryptedScaledDebtOf', [addr]);
      const debtRead = await this.safeUnseal(debtH);
      // null = a SET handle that could not be decrypted → debt UNKNOWN (never silently 0).
      if (debtRead === null) debtUnknown = true;
      else scaledDebt = debtRead;

      // read each asset's collateral handle; only decrypt the ones the user has touched
      // (an unset handle is bytes32(0) → no collateral for that asset).
      const collHandles = await Promise.all(
        COLLATERAL_ASSETS.map((a) => this.read<bigint>(pool, poolAbi, 'encryptedCollateralOf', [addr, BigInt(a.assetId)])),
      );
      for (let i = 0; i < COLLATERAL_ASSETS.length; i++) {
        if (!collHandles[i]) continue; // unset → user never deposited this asset
        const shares = await this.safeUnseal(collHandles[i]);
        if (shares === null) {
          // SET handle but the threshold-decrypt failed (permit not ready / network) → mark
          // unreadable so the UI carries over the last-known amount instead of dropping it.
          unreadableCollateral.push(COLLATERAL_ASSETS[i].sym);
          continue;
        }
        if (shares > 0) {
          const a = COLLATERAL_ASSETS[i];
          collateral.push({ sym: `fb${a.sym.slice(1)}`, under: a.sym, shares });
        }
      }
    }

    const position: Position = {
      collateral,
      walletShares,
      walletUSDC,
      debtUSDC: scaledDebt, // un-indexed principal; derivePosition applies the live index
      blinding: loadBlinding(addr),
      debtUnknown,
    };

    // REAL public blinded factors + authoritative HF (so the portfolio shows what the chain
    // actually sees, not a client-side approximation).
    let factorA: number | undefined;
    let factorB: number | undefined;
    let hfBps: number | undefined;
    try {
      const [a, b] = await this.read<readonly [bigint, bigint, boolean]>(pool, poolAbi, 'getFactors', [addr]);
      factorA = Number(a);
      factorB = Number(b);
    } catch { /* not initialised */ }
    try {
      hfBps = Number(await this.read<bigint>(pool, poolAbi, 'healthFactorBps', [addr]));
    } catch { /* factors not settled yet */ }

    return { position, indexBps: Number(indexBpsRaw), priceStale, weekendOnChain, factorA, factorB, hfBps, unreadableCollateral };
  }

  /** Drop any cached decryption permit, mint a fresh one, and re-read the position.
   *  Recovery path for a failed sealed read (debt/collateral showing unknown): a
   *  stale-but-unexpired permit is reused by ensurePermit(), so we force-rotate here. */
  async refreshDecryptionPermit(address: string): Promise<PositionSnapshot> {
    await ensureCofhe(this.pub, await getWalletClient());
    await refreshPermit();
    return this.fetchPosition(address);
  }

  /** Decrypt a sealed handle. Returns 0 ONLY for a genuinely-unset handle
   *  (bytes32(0)); returns null when a SET handle could not be decrypted (stale
   *  permit / cofhejs↔testnet skew) — callers MUST treat null as "unknown", never 0. */
  private async safeUnseal(handle: bigint): Promise<number | null> {
    if (!handle) return 0;
    try {
      return Number(await unsealUint64(handle));
    } catch (e) {
      console.warn('[Equinox] sealed-handle decryption FAILED (value UNKNOWN, not 0):', e);
      return null;
    }
  }

  /** Enumerate confidential accounts for the liquidator by scanning BlindingSet
   *  events (every account inits exactly once), then reading each one's PUBLIC
   *  blinded factors (A, B). The real collateral/debt stay sealed — a liquidator
   *  only ever sees A, B and computes HF from them. */
  async listAccounts(): Promise<Account[]> {
    const pool = ADDRESSES.pool;
    if (!pool || pool.toLowerCase() === ZERO_ADDR) return [];

    const latest = await this.pub.getBlockNumber();
    const envBlock = import.meta.env.VITE_POOL_DEPLOY_BLOCK as string | undefined;
    const LOOKBACK = 90_000n; // public RPCs cap getLogs ranges; bound the scan
    const fromBlock = envBlock ? BigInt(envBlock) : latest > LOOKBACK ? latest - LOOKBACK : 0n;
    if (!envBlock) {
      console.warn(
        `[Equinox] listAccounts scanned blocks ${fromBlock}..${latest}; ` +
          'set VITE_POOL_DEPLOY_BLOCK to cover the pool\'s full history.',
      );
    }

    const logs = await this.pub.getLogs({
      address: pool,
      event: parseAbiItem('event BlindingSet(address indexed user)'),
      fromBlock,
      toBlock: latest,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const users = Array.from(new Set(logs.map((l) => (l as any).args.user as Address)));
    if (!users.length) return [];

    const idxBps = Number(await this.read<bigint>(pool, poolAbi, 'currentIndexBps'));
    const accounts = await Promise.all(
      users.map(async (u) => {
        const [a, b] = await this.read<[bigint, bigint, boolean]>(pool, poolAbi, 'getFactors', [u]);
        // V2: read the contract's AUTHORITATIVE health factor. The blinded factors fold price
        // into A, so the V1 client-side A·price/(B·I) formula is wrong for V2 — use the chain's
        // healthFactorBps directly. Reverts FactorsNotSettled for un-settled accounts → undefined.
        let hfBps: number | undefined;
        try {
          hfBps = Number(await this.read<bigint>(pool, poolAbi, 'healthFactorBps', [u]));
        } catch {
          /* not settled yet — leave undefined (liquidator treats as not-yet-liquidatable) */
        }
        return {
          id: u,
          under: 'dTSLA',
          C: 0, // hidden truth — never revealed to a liquidator
          D: 0,
          s: 0,
          A: Number(a),
          B: Number(b),
          idxBps,
          hfBps,
        } as Account;
      }),
    );
    // only borrowers (non-zero debt factor) are liquidation candidates
    return accounts.filter((a) => a.B > 0);
  }

  /** Single-step confidential liquidation: fund sealed USDC credit, then liquidate,
   *  seizing collateral asset `seizeAssetId`. */
  async liquidate(accountId: string, seizeAssetId: number, repayUsdc = 50_000): Promise<TxResult> {
    await ensureCofhe(this.pub, await getWalletClient());
    await this.send(ADDRESSES.usdc, erc20Abi, 'approve', [ADDRESSES.pool, BigInt(repayUsdc) * USDC_UNIT]);
    await this.send(ADDRESSES.pool, poolAbi, 'fundUsdc', [BigInt(repayUsdc)]);
    const encRepay = await encryptUint64(BigInt(repayUsdc));
    const receipt = await this.send(ADDRESSES.pool, poolAbi, 'liquidate', [
      accountId as Address,
      BigInt(seizeAssetId),
      encRepay,
    ]);
    return { txHash: receipt.transactionHash };
  }
}

export const cofheEquinoxService = new CofheEquinoxService();
