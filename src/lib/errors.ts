/* ============================================================
   Equinox — turn a wallet/tx error into a short human message.
   ============================================================ */

export function txErrorMessage(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  const msg = err?.shortMessage || err?.message || String(e);
  if (/user rejected|rejected the request|user denied|\bdenied\b/i.test(msg)) {
    return 'You rejected the request in your wallet.';
  }
  if (/insufficient funds/i.test(msg)) {
    return 'Insufficient funds for gas on Arbitrum Sepolia.';
  }
  if (/wallet not connected/i.test(msg)) {
    return 'Wallet not connected. Connect again and retry.';
  }
  if (/reverted|execution reverted/i.test(msg)) {
    return msg;
  }
  return msg || 'The transaction failed. Please try again.';
}
