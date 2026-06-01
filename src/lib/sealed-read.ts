/* ============================================================
   Equinox — sealed-read interpretation helpers.

   A sealed on-chain value (FHE euint64) is decrypted client-side. We MUST
   distinguish three outcomes so a failed decryption is never silently shown
   as a real 0 (which hides debt and blocks repayment):

     - unset    : the handle was bytes32(0) — the user genuinely has no value.
     - value    : decrypted successfully.
     - failed   : the handle was SET but decryption failed (stale permit /
                  cofhejs↔testnet version skew) — the value is UNKNOWN.
   ============================================================ */

/** Can the user submit a repay of `n` USDC?
 *
 *  When the debt is UNKNOWN (its sealed read failed) we must NOT gate on the
 *  displayed 0 — that would permanently disable repay against a debt that
 *  actually exists. The pool's `repay` clamps the payment to the real debt via
 *  `FHE.min(amt, debt)` and refunds any excess as sealed credit, so allowing
 *  any positive amount is safe. */
export function canRepay(n: number, debtUSDC: number, debtUnknown: boolean): boolean {
  if (n <= 0) return false;
  if (debtUnknown) return true; // debt is unknown → don't gate on the (untrusted) 0; contract clamps
  return n <= debtUSDC;
}
