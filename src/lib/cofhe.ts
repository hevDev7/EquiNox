/* ============================================================
   Equinox — CoFHE client-side encryption boundary (@cofhe/sdk).

   Fhenix renamed `cofhejs` → `@cofhe/sdk`. This SDK bundles the
   tfhe-rs that matches the live Arbitrum Sepolia testnet network key.
   Requires a CoFHE-enabled chain + a connected wallet; the TFHE wasm
   auto-initialises on first encrypt.

   AUDIT (Fhenix tech review):
   - #3 the connection + self-permit are re-validated on every call: a
     MetaMask account/chain switch rebinds the SDK, and an expired permit
     is re-minted, so a returning user never silently reads an empty
     position from a stale permit.
   - decryptForTx (threshold network) is retried with bounded backoff on
     transient 5xx/fetch errors, and NEVER swallowed to 0 on the tx path
     (a silent 0 would be a $0 payout against burned sealed credit).
   ============================================================ */

import { createCofheClient, createCofheConfig } from '@cofhe/sdk/web';
import { arbSepolia } from '@cofhe/sdk/chains';
import { Encryptable, FheTypes } from '@cofhe/sdk';
import type { Address, PublicClient, WalletClient } from 'viem';
import { isTransient, isSealAuthRejection } from './cofhe-errors';

/** Shape of an encrypted input as the contracts' `InEuint64`/`InEbool` expect.
 *  (Matches @cofhe/sdk's EncryptedItemInput 1:1.) */
export interface SealedInput {
  ctHash: bigint;
  securityZone: number;
  utype: number;
  signature: `0x${string}`;
}

let _client: ReturnType<typeof createCofheClient> | null = null;
/** `${account}:${chainId}` of the last successful connect — null = never connected. */
let _connectedKey: string | null = null;
let _account: Address | undefined;
let _chainId: number | undefined;
// single-flight guard: when a self-permit is being minted, concurrent callers share the SAME
// promise instead of each opening their own MetaMask signature request ("1 of N" spam).
let _permitMint: Promise<void> | null = null;

function getClient(): ReturnType<typeof createCofheClient> {
  if (!_client) {
    _client = createCofheClient(
      // `environment` here is the PLATFORM ('web'); the NETWORK (TESTNET) +
      // coprocessor URLs come from the arbSepolia chain object.
      // useWorkers:false → run the ZK proof on the main thread; avoids a second
      // (worker-context) tfhe wasm load that's fragile under Vite dev.
      createCofheConfig({ environment: 'web', supportedChains: [arbSepolia], useWorkers: false }),
    );
  }
  return _client;
}

/** AUDIT #3: rebind the SDK whenever the wallet's account or chain changes.
 *  We track the connect key ourselves (the client's account/chainId are
 *  internal) and reconnect on any mismatch; `connect()` is idempotent. */
export async function ensureCofhe(pub: PublicClient, wallet: WalletClient): Promise<void> {
  const account = wallet.account?.address as Address | undefined;
  const chainId = wallet.chain?.id;
  const key = `${account ?? ''}:${chainId ?? ''}`;
  if (_connectedKey === key && account) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await getClient().connect(pub as any, wallet as any);
  _connectedKey = key;
  _account = account;
  _chainId = chainId;
}

/**
 * Ensure a VALID self-permit for the connected account (AUDIT #3). Reuses the
 * active permit when it is a non-expired self-permit (zero signatures on the
 * happy path); otherwise drops the stale one and mints a fresh one. Note
 * `getOrCreateSelfPermit()` alone is insufficient — it can return an expired permit.
 */
export async function ensurePermit(): Promise<void> {
  const permits = getClient().permits;
  try {
    const active = permits.getActivePermit(_chainId, _account);
    const now = Math.floor(Date.now() / 1000);
    // reuse only a non-expired self-permit (expiration is unix seconds)
    if (active && active.type === 'self' && Number(active.expiration) > now) return;
    if (active) permits.removeActivePermit(_chainId, _account);
  } catch {
    /* fall through to mint a fresh permit */
  }
  // SINGLE-FLIGHT: many decrypts/position-reads run concurrently and all need the permit;
  // mint ONCE and let everyone await the same promise → a single signature prompt, not one
  // per caller. (`getActivePermit` above still short-circuits once the minted permit is cached.)
  if (!_permitMint) {
    _permitMint = permits
      .getOrCreateSelfPermit()
      .then(() => undefined)
      .finally(() => {
        _permitMint = null;
      });
  }
  await _permitMint;
}

/**
 * Force a BRAND-NEW self-permit, discarding any cached one. `ensurePermit()` reuses
 * a permit that is merely unexpired — but a permit can be stale/mismatched (or hit
 * the cofhejs↔testnet version skew) and still decrypt to a wrong-looking empty/0
 * position. Recovery path: drop it and re-mint, then re-read the position.
 */
export async function refreshPermit(): Promise<void> {
  const permits = getClient().permits;
  try {
    const active = permits.getActivePermit(_chainId, _account);
    if (active) permits.removeActivePermit(_chainId, _account);
  } catch {
    /* nothing active to drop */
  }
  await permits.getOrCreateSelfPermit();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSealed(out: any): SealedInput {
  if (!out || out.ctHash == null || out.signature == null) {
    throw new Error('cofhe encrypt failed: malformed encrypted input');
  }
  return {
    ctHash: BigInt(out.ctHash),
    securityZone: Number(out.securityZone ?? 0),
    utype: Number(out.utype ?? 0),
    signature: out.signature as `0x${string}`,
  };
}

export async function encryptUint64(value: bigint): Promise<SealedInput> {
  const _t = _now();
  const [out] = await getClient().encryptInputs([Encryptable.uint64(value)]).execute();
  if (TIMING) console.log(`[equinox-timing] encryptUint64 in ${(_now() - _t).toFixed(0)}ms`);
  return toSealed(out);
}

export async function encryptBool(value: boolean): Promise<SealedInput> {
  const [out] = await getClient().encryptInputs([Encryptable.bool(value)]).execute();
  return toSealed(out);
}

/* [INSTR] temporary timing — mirrors the block in cofhe-equinox-service.ts. */
const TIMING = true;
const _now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* `isTransient` / `isSealAuthRejection` live in ./cofhe-errors (SDK-free so they're unit-tested
 *  in isolation). A 401/403 is an auth rejection (NOT transient) → see unsealUint64's recovery. */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry `fn` on transient errors with bounded exponential backoff. Re-throws
 *  the last error (never swallows) so callers can surface a real failure. */
async function withRetry<T>(fn: () => Promise<T>, tries = 5, baseMs = 1000, label = 'cofhe-op'): Promise<T> {
  const _t0 = _now();
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    const _ta = _now();
    try {
      const r = await fn();
      if (TIMING) console.log(`[equinox-timing] ${label} attempt ${i + 1} OK in ${(_now() - _ta).toFixed(0)}ms (total ${(_now() - _t0).toFixed(0)}ms)`);
      return r;
    } catch (e) {
      last = e;
      const transient = isTransient(e);
      if (TIMING) console.warn(`[equinox-timing] ${label} attempt ${i + 1} FAILED in ${(_now() - _ta).toFixed(0)}ms · transient=${transient} ·`, String((e as Error)?.message ?? e));
      if (i === tries - 1 || !transient) throw e;
      await sleep(baseMs * 2 ** i); // 1s, 2s, 4s, 8s
    }
  }
  throw last;
}

/**
 * Decrypt an euint64 handle from a contract view using the connected user's
 * self-permit. Returns the plaintext bigint. The contract must have granted the
 * caller decrypt rights (FHE.allow / allowSender).
 *
 * AUDIT #9: throws on a non-bigint SDK result instead of masking it as 0, so a
 * soft SDK/permit failure surfaces (the caller's catch logs it) rather than
 * silently rendering an empty position. A genuinely-unset handle is filtered
 * upstream (handle === 0n) before this is called.
 */
export async function unsealUint64(handle: bigint): Promise<bigint> {
  await ensurePermit();
  const seal = () =>
    withRetry(() => getClient().decryptForView(handle, FheTypes.Uint64).withPermit().execute(), 5, 1000, 'decryptForView');
  let res: bigint | unknown;
  try {
    res = await seal();
  } catch (e) {
    // A 403/401 on /v2/sealoutput is the threshold network REJECTING the self-permit's
    // authorization (a stale/mismatched EIP-712 signature on a permit reused from
    // localStorage), not a transient error. ensurePermit() reuses any non-expired self-permit
    // WITHOUT re-validating its signature/domain, so the only recovery is to drop it, mint a
    // freshly-signed permit, and retry ONCE. If it still 403s the permit is fine and the
    // rejection is server-side (SDK↔testnet ACL-domain skew) — re-throw so safeUnseal() surfaces
    // it as "unknown" (never a silent 0). See refreshPermit() / docs: cofhe-sealoutput-403.
    if (!isSealAuthRejection(e)) throw e;
    console.warn(
      '[equinox] /v2/sealoutput rejected the self-permit (auth 403) — re-minting and retrying once.',
      String((e as Error)?.message ?? e),
    );
    await refreshPermit();
    res = await seal();
  }
  if (typeof res !== 'bigint') {
    throw new Error(`cofhe decryptForView returned non-bigint for Uint64: ${typeof res}`);
  }
  return res;
}

/**
 * Threshold-decrypt a PUBLICLY-decryptable handle (FHE.allowPublic) off-chain and
 * return the plaintext + a coprocessor signature/proof. The contract verifies it
 * with FHE.verifyDecryptResult(handle, value, proof). Used to realize borrow
 * proceeds / unwrap payouts on CoFHE 0.1.x.
 *
 * AUDIT #2: retried on transient 503/fetch errors; on permanent failure it THROWS
 * (never returns 0) so the caller keeps the sealed credit + persisted withdrawId
 * and can resume — a silent 0 here would burn credit for a $0 payout.
 */
export async function decryptForTxUint64(handle: bigint): Promise<{ value: bigint; proof: `0x${string}` }> {
  const res = await withRetry(() => getClient().decryptForTx(handle).withoutPermit().execute(), 5, 1000, 'decryptForTx');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any;
  if (r?.decryptedValue == null || r?.signature == null) {
    throw new Error('cofhe decryptForTx returned malformed result (no decryptedValue/signature)');
  }
  return { value: BigInt(r.decryptedValue), proof: r.signature as `0x${string}` };
}
