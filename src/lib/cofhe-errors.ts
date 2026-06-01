/* ============================================================
   CoFHE error classification — PURE predicates, intentionally with NO
   @cofhe/sdk import. cofhe.ts pulls `@cofhe/sdk/web` (TFHE wasm + browser
   globals) so it can't be imported in a plain Node unit test; these
   predicates only inspect the error SHAPE, so they live here and are
   tested in isolation (see scripts/cofhe-errors.test.mjs).

   The shape we match is @cofhe/sdk's CofheError:
     { code: 'SEAL_OUTPUT_FAILED' | ..., message: string,
       context?: { status?: number; statusText?: string } }
   plus plain fetch/Error objects.
   ============================================================ */

/** Minimal structural view of the errors @cofhe/sdk throws (CofheError) and plain fetch errors. */
interface CofheLikeError {
  code?: string;
  message?: string;
  context?: { status?: number; statusText?: string };
}

/**
 * A 401/403 on /v2/sealoutput is the threshold network REFUSING the self-permit's
 * authorization — a stale/mismatched EIP-712 issuerSignature or ACL domain on a permit
 * that was reused from localStorage (`cofhesdk-permits`). It is a PERMANENT rejection,
 * NOT a transient network blip:
 *   - it must not be retried with backoff (the SDK tags it code SEAL_OUTPUT_FAILED, which
 *     would otherwise match isTransient() and burn ~15s of pointless retries), and
 *   - it is recoverable ONLY by dropping the cached permit and minting a freshly-signed one
 *     (see unsealUint64 in cofhe.ts), not by waiting.
 * The coprocessor reports it as HTTP 403 (context.status); we also string-match as a fallback.
 */
export function isSealAuthRejection(e: unknown): boolean {
  const err = e as CofheLikeError;
  const status = err?.context?.status;
  if (status === 401 || status === 403) return true;
  const s = String(err?.message ?? e).toLowerCase();
  return /\b(401|403)\b/.test(s) || s.includes('forbidden') || s.includes('unauthorized');
}

/**
 * True for transient threshold-network / fetch errors worth retrying with bounded backoff.
 * An auth rejection (401/403) is explicitly NOT transient — even though the SDK tags it with
 * code SEAL_OUTPUT_FAILED, retrying it just repeats the same permanent failure.
 */
export function isTransient(e: unknown): boolean {
  if (isSealAuthRejection(e)) return false;
  const err = e as CofheLikeError;
  const s = String(err?.code ?? err?.message ?? e).toLowerCase();
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
