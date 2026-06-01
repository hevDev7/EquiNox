/* ============================================================
   Equinox — asset logo resolver.

   Hybrid source order (resilient, per design 2026-05-31):
     1. Parqet CDN  — by ticker, SVG, no token (live-verified for the basket)
     2. vendored local SVG (src/assets/logos/<TICKER>.svg) — offline / CDN-down
     3. caller (AssetMark) falls back to a lettermark
   ============================================================ */

import { STOCKS } from '../config/stocks';

/** Vendored SVGs: ticker (UPPERCASE) -> bundled URL. Drop a new file in to extend. */
const LOCAL: Record<string, string> = {};
for (const [path, url] of Object.entries(
  import.meta.glob('../assets/logos/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<
    string,
    string
  >,
)) {
  const m = path.match(/\/([^/]+)\.svg$/);
  if (m) LOCAL[m[1].toUpperCase()] = url;
}

/** Tickers we recognise as equities (drives the CDN attempt — skips USDC etc). */
const STOCK_TICKERS = new Set(STOCKS.map((s) => s.sym.replace(/^d/, '').toUpperCase()));

/** `dTSLA` / `fbTSLA` -> `TSLA`. */
export function tickerFromSym(sym: string): string {
  return sym.replace(/^fb|^d/, '').toUpperCase();
}

/** Ordered logo URLs to try for a symbol; empty when none (caller renders a lettermark). */
export function logoSources(sym: string): string[] {
  const ticker = tickerFromSym(sym);
  const out: string[] = [];
  if (STOCK_TICKERS.has(ticker)) out.push(`https://assets.parqet.com/logos/symbol/${ticker}`);
  if (LOCAL[ticker]) out.push(LOCAL[ticker]);
  return out;
}
