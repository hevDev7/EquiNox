/* ============================================================
   Faucet limits (frontend-enforced, testnet UX)
   ------------------------------------------------------------
   The demo Mock tokens expose an open `mint(addr, amount)`, so these
   caps are a faucet-page convenience, not a security boundary:
     - at most FAUCET_MAX_MINT tokens per mint, per dShare AND for USDC
     - a 24h cooldown per key before that faucet can be used again
   Cooldown state is kept per-browser in localStorage, keyed by the
   dShare symbol (e.g. "dTSLA") or the literal "USDC".
   ============================================================ */

/** Hard cap on a single faucet mint (per stock, and for USDC). */
export const FAUCET_MAX_MINT = 1000;

/** Wait this long after a mint before the same faucet can be used again. */
export const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

/** localStorage key for the per-faucet last-mint timestamps. */
const STORE_KEY = 'equinox.faucet.lastMint.v1';

/** Sentinel key for the USDC faucet (dShares use their own symbol). */
export const USDC_FAUCET_KEY = 'USDC';

type Store = Record<string, number>;

function read(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(s: Store): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage disabled / over quota — cooldown best-effort only */
  }
}

/** Record a successful mint for `key` so its 24h cooldown starts now. */
export function markMinted(key: string, now: number = Date.now()): void {
  const s = read();
  s[key] = now;
  write(s);
}

/** ms remaining on the 24h cooldown for `key` (0 ⇒ ready to mint). */
export function cooldownRemaining(key: string, now: number = Date.now()): number {
  const last = read()[key];
  if (!last || typeof last !== 'number') return 0;
  return Math.max(0, last + FAUCET_COOLDOWN_MS - now);
}

/** Human-readable countdown, e.g. "23h 41m", "12m 03s", or "45s". */
export function fmtCooldown(ms: number): string {
  if (ms <= 0) return '';
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
