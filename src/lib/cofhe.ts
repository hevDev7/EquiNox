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
  await permits.getOrCreateSelfPermit();
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
  const [out] = await getClient().encryptInputs([Encryptable.uint64(value)]).execute();
  return toSealed(out);
}

export async function encryptBool(value: boolean): Promise<SealedInput> {
  const [out] = await getClient().encryptInputs([Encryptable.bool(value)]).execute();
  return toSealed(out);
}

/** True for transient threshold-network / fetch errors worth retrying. */
function isTransient(e: unknown): boolean {
  const s = String((e as { code?: string; message?: string })?.code ?? (e as Error)?.message ?? e).toLowerCase();
  return (
    s.includes('503') ||
    s.includes('service unavailable') ||
    s.includes('fetch failed') ||
    s.includes('timeout') ||
    s.includes('decrypt_failed') ||
    s.includes('seal_output_failed') ||
    s.includes('econnreset') ||
    s.includes('other side closed')
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry `fn` on transient errors with bounded exponential backoff. Re-throws
 *  the last error (never swallows) so callers can surface a real failure. */
async function withRetry<T>(fn: () => Promise<T>, tries = 5, baseMs = 1000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === tries - 1 || !isTransient(e)) throw e;
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
  const res = await withRetry(() => getClient().decryptForView(handle, FheTypes.Uint64).withPermit().execute());
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
  const res = await withRetry(() => getClient().decryptForTx(handle).withoutPermit().execute());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any;
  if (r?.decryptedValue == null || r?.signature == null) {
    throw new Error('cofhe decryptForTx returned malformed result (no decryptedValue/signature)');
  }
  return { value: BigInt(r.decryptedValue), proof: r.signature as `0x${string}` };
}
