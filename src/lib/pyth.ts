/* ============================================================
   Equinox — live equity prices from Pyth Hermes (session-aware).

   Pyth publishes a SEPARATE feed per trading session for each US equity —
   Pre-Market (.PRE), Regular, Post-Market (.POST) and Overnight (.ON). For each
   stock we fetch every session feed it has and use the one with the freshest
   publish_time (= the session currently trading), so the dashboard shows a LIVE
   price ~24/5 instead of a frozen regular-hours last close. Only when every
   session is closed (weekend/holiday) does a stock read as a stale "last close".
   Hermes is read-only / chain-agnostic, so this works in mock and real mode.
   ============================================================ */

import { STOCKS, type StockMeta } from '../config/stocks';
import { SESSION_FEEDS } from '../config/pyth-sessions';

/** Which Pyth session a displayed price came from. */
export type MarketSession = 'PRE' | 'REG' | 'POST' | 'OVN';

export interface LivePrice {
  price: number;
  /** REAL 24h change (%): (spot − price ~24h of trading earlier) / that price,
   *  anchored to the chosen feed's publish_time so weekends compare prior closes.
   *  `undefined` when the anchor is unavailable — UI shows "—", not a false 0%. */
  chg?: number;
  /** true when even the freshest session feed is older than STALE_AFTER_SEC —
   *  i.e. all sessions are closed (weekend/holiday): a frozen "last close" price. */
  stale: boolean;
  /** unix seconds of the chosen feed's publish time. */
  asOf: number;
  /** the session the price came from (the currently-trading one when live). */
  session?: MarketSession;
  /** the ~24h-ago anchor price used for `chg`. Cached so streamed live ticks can
   *  recompute the 24h change in real time (the stream itself has no historical anchor). */
  ref24h?: number;
}
/** keyed by dShare symbol (dTSLA, dAAPL, …) */
export type LivePriceMap = Record<string, LivePrice>;

const HERMES = (import.meta.env.VITE_PYTH_HERMES ?? 'https://hermes.pyth.network') as string;

interface PythVal {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}
interface PythParsed {
  id: string;
  price: PythVal;
  ema_price?: PythVal;
}

const normId = (id: string): string => id.toLowerCase().replace(/^0x/, '');
const scale = (mantissa: string, expo: number): number => Number(mantissa) * 10 ** expo;

/** A price is "stale" (all sessions closed / last close) when its publish is older
 *  than this. Session feeds tick within seconds while their session is trading. */
const STALE_AFTER_SEC = 300;
const DAY_SEC = 86_400;
/** Cap ids/request to keep URLs short and dodge public-endpoint hiccups on big batches. */
const CHUNK = 30;

async function fetchParsed(url: string): Promise<PythParsed[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pyth Hermes returned ${res.status}`);
  const json = (await res.json()) as { parsed?: PythParsed[] };
  return json.parsed ?? [];
}

/** Batched fetch keyed by normalised feed id. `ts` omitted = latest, given = historical.
 *  Resilient: a failed chunk is skipped; throws only if EVERY latest chunk failed. */
async function fetchByFeed(ids: string[], ts?: number): Promise<Map<string, PythParsed>> {
  const path = ts != null ? String(ts) : 'latest';
  const byFeed = new Map<string, PythParsed>();
  let anyOk = false;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const qs = ids.slice(i, i + CHUNK).map((id) => `ids[]=${id}`).join('&');
    try {
      const parsed = await fetchParsed(`${HERMES}/v2/updates/price/${path}?${qs}&parsed=true&encoding=hex`);
      for (const p of parsed) byFeed.set(normId(p.id), p);
      anyOk = true;
    } catch {
      /* skip this chunk; other chunks may still yield prices */
    }
  }
  if (!anyOk && ts == null) throw new Error('Pyth Hermes: all latest-price chunks failed');
  return byFeed;
}

const BENCHMARKS = (import.meta.env.VITE_PYTH_BENCHMARKS ?? 'https://benchmarks.pyth.network') as string;

/** Cache of previous-close anchors (per dShare symbol). Daily closes move ~once a day, so we
 *  refetch at most every ANCHOR_TTL_SEC — keeps the 24h change live without hammering Benchmarks. */
let anchorCache: { at: number; map: Map<string, number> } | null = null;
const ANCHOR_TTL_SEC = 600;

/** Previous completed daily close per symbol, from Pyth Benchmarks (TradingView shim). This is
 *  the reliable 24h-change anchor: public Hermes only keeps a few HOURS of session-feed history
 *  (a −24h fetch 404s), whereas Benchmarks serves daily OHLC. Best-effort & per-symbol —
 *  a symbol that misses simply gets no `chg` (UI shows "—", never a false 0%). */
async function fetchBenchmarkAnchors(stocks: StockMeta[], nowSec: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const from = nowSec - 8 * DAY_SEC;
  const startOfTodayUTC = Math.floor(nowSec / DAY_SEC) * DAY_SEC;
  await Promise.all(
    stocks.map(async (s) => {
      try {
        const url = `${BENCHMARKS}/v1/shims/tradingview/history?symbol=${s.pythSymbol}&resolution=D&from=${from}&to=${nowSec}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const j = (await res.json()) as { s?: string; t?: number[]; c?: number[] };
        if (j.s !== 'ok' || !j.t?.length || !j.c?.length) return;
        // previous close = last daily bar strictly before today's UTC day (else the latest close).
        let idx = -1;
        for (let i = j.t.length - 1; i >= 0; i--) {
          if (j.t[i] < startOfTodayUTC) { idx = i; break; }
        }
        const close = j.c[idx >= 0 ? idx : j.c.length - 1];
        if (close > 0) out.set(s.sym, close);
      } catch {
        /* skip — chg stays undefined for this symbol */
      }
    }),
  );
  return out;
}

/** Every session feed a stock has (regular first). */
function candidatesFor(s: StockMeta): { id: string; session: MarketSession }[] {
  const sess = SESSION_FEEDS[s.sym] ?? {};
  const out: { id: string; session: MarketSession }[] = [{ id: s.pythFeedId, session: 'REG' }];
  if (sess.pre) out.push({ id: sess.pre, session: 'PRE' });
  if (sess.post) out.push({ id: sess.post, session: 'POST' });
  if (sess.on) out.push({ id: sess.on, session: 'OVN' });
  return out;
}

/**
 * Live equity prices: for each stock, pick the freshest of its session feeds (the
 * currently-trading session) plus a REAL 24h change. Throws only when the whole
 * latest fetch fails (callers then keep the last good values / skeleton).
 */
export async function fetchPythPrices(stocks: StockMeta[] = STOCKS): Promise<LivePriceMap> {
  if (!stocks.length) return {};

  // 1) latest for EVERY session feed across the basket.
  const candBySym = new Map<string, { id: string; session: MarketSession }[]>();
  const allIds: string[] = [];
  for (const s of stocks) {
    const cands = candidatesFor(s);
    candBySym.set(s.sym, cands);
    for (const c of cands) allIds.push(c.id);
  }
  const latest = await fetchByFeed(allIds);

  // 2) the freshest session feed for a stock IS its currently-trading session.
  const picks = new Map<string, { p: PythParsed; session: MarketSession }>();
  for (const s of stocks) {
    let best: { p: PythParsed; session: MarketSession } | undefined;
    for (const c of candBySym.get(s.sym) ?? []) {
      const p = latest.get(normId(c.id));
      if (p && (!best || p.price.publish_time > best.p.price.publish_time)) best = { p, session: c.session };
    }
    if (best) picks.set(s.sym, best);
  }

  // 3) REAL prior-close anchor for the 24h change. Public Hermes only keeps a few HOURS of
  //    session-feed history (a −24h fetch 404s), so anchor to Pyth Benchmarks' daily bars
  //    (the previous completed daily close), cached ~10 min. Best-effort: a symbol that
  //    misses shows no chg, never a false 0%.
  const nowSec = Math.floor(Date.now() / 1000);
  if (!anchorCache || nowSec - anchorCache.at > ANCHOR_TTL_SEC) {
    const map = await fetchBenchmarkAnchors(stocks, nowSec);
    if (map.size) anchorCache = { at: nowSec, map }; // only a SUCCESSFUL fetch resets the TTL
  }
  const anchorBySym = anchorCache?.map ?? new Map<string, number>();

  const out: LivePriceMap = {};
  for (const s of stocks) {
    const best = picks.get(s.sym);
    if (!best) continue;
    const price = scale(best.p.price.price, best.p.price.expo);
    const asOf = best.p.price.publish_time;
    const prevClose = anchorBySym.get(s.sym);
    const chg = prevClose && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : undefined;
    out[s.sym] = { price, chg, asOf, stale: nowSec - asOf > STALE_AFTER_SEC, session: best.session, ref24h: prevClose };
  }
  return out;
}

/**
 * Real-time price stream over Hermes SSE. Opens EventSource(s) on every session feed and,
 * on a throttled cadence (default 1s), emits the freshest live price per stock
 * (price / asOf / stale / session — NOT chg, which needs the historical anchor and stays
 * from fetchPythPrices). Closed-session feeds are silent, so traffic ≈ the live feeds only.
 * Returns a cleanup function. No-op outside the browser (no EventSource).
 */
export function streamPythPrices(
  onTick: (updates: LivePriceMap) => void,
  opts: { flushMs?: number; stocks?: StockMeta[] } = {},
): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const stocks = opts.stocks ?? STOCKS;
  const flushMs = opts.flushMs ?? 1000;

  const candBySym = new Map<string, { id: string; session: MarketSession }[]>();
  const feedToSym = new Map<string, string>();
  const allIds: string[] = [];
  for (const s of stocks) {
    const cands = candidatesFor(s);
    candBySym.set(s.sym, cands);
    for (const c of cands) {
      allIds.push(c.id);
      feedToSym.set(normId(c.id), s.sym);
    }
  }

  const latestByFeed = new Map<string, PythParsed>();
  const dirty = new Set<string>();
  const sources: EventSource[] = [];
  for (let i = 0; i < allIds.length; i += CHUNK) {
    const qs = allIds.slice(i, i + CHUNK).map((id) => `ids[]=${id}`).join('&');
    const es = new EventSource(`${HERMES}/v2/updates/price/stream?${qs}&parsed=true&encoding=hex`);
    es.onmessage = (ev: MessageEvent) => {
      let d: { parsed?: PythParsed[] };
      try {
        d = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      for (const p of d.parsed ?? []) {
        latestByFeed.set(normId(p.id), p);
        const sym = feedToSym.get(normId(p.id));
        if (sym) dirty.add(sym);
      }
    };
    // EventSource auto-reconnects on error; nothing to do here.
    sources.push(es);
  }

  const timer = setInterval(() => {
    if (!dirty.size) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const updates: LivePriceMap = {};
    for (const sym of dirty) {
      let best: { p: PythParsed; session: MarketSession } | undefined;
      for (const c of candBySym.get(sym) ?? []) {
        const p = latestByFeed.get(normId(c.id));
        if (p && (!best || p.price.publish_time > best.p.price.publish_time)) best = { p, session: c.session };
      }
      if (best) {
        const asOf = best.p.price.publish_time;
        updates[sym] = {
          price: scale(best.p.price.price, best.p.price.expo),
          asOf,
          stale: nowSec - asOf > STALE_AFTER_SEC,
          session: best.session,
        };
      }
    }
    dirty.clear();
    if (Object.keys(updates).length) onTick(updates);
  }, flushMs);

  return () => {
    for (const es of sources) es.close();
    clearInterval(timer);
  };
}
