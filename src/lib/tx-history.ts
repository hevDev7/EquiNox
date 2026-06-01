/* ============================================================
   Equinox — local transaction history for the Repay & Unwrap page.
   localStorage-backed, keyed by wallet address. Records the borrower's
   confirmed repay / request-unwrap / claim actions (no chain indexer
   needed for a demo); newest-first, capped. Amounts/symbols are public
   metadata the user already knows — sealed balances never touched.
   ============================================================ */

export type TxKind = 'borrow' | 'repay' | 'deposit' | 'unwrap' | 'claim' | 'provide' | 'withdraw';

export interface TxHistoryEntry {
  kind: TxKind;
  /** dShare symbol for deposit/unwrap/claim (e.g. 'dTSLA'); omitted for USDC-denominated txs. */
  sym?: string;
  /** USDC (borrow/repay/provide/withdraw) or whole shares (deposit/unwrap/claim). */
  amount: number;
  /** on-chain tx hash (explorer link). */
  txHash: string;
  ts: number;
}

const MAX = 50;
const key = (addr: string) => `equinox.txHistory.${addr.toLowerCase()}`;

export function getTxHistory(addr: string): TxHistoryEntry[] {
  if (!addr) return [];
  try {
    return JSON.parse(localStorage.getItem(key(addr)) || '[]') as TxHistoryEntry[];
  } catch {
    return [];
  }
}

/** Prepend an entry (newest-first) and persist; returns the updated list. */
export function addTxHistory(addr: string, e: TxHistoryEntry): TxHistoryEntry[] {
  if (!addr) return [];
  const list = [e, ...getTxHistory(addr)].slice(0, MAX);
  try {
    localStorage.setItem(key(addr), JSON.stringify(list));
  } catch {
    /* storage unavailable — best-effort */
  }
  return list;
}
