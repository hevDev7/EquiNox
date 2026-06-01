/* ============================================================
   Equinox — tokenized-equities markets list (collateral universe).
   Public oracle data, but every row frames the confidential
   wrap-to-collateral path: deposit a dShare → sealed fbShare.
   Inspired by a generic markets table, rebuilt in Equinox's
   private-banking idiom (serif prices, ciphertext accents, sealed pills).
   ============================================================ */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ASSETS } from '../../lib/mock-data';
import { PROTOCOL } from '../../lib/protocol';
import { fmtUSD, fmtNum } from '../../lib/format';
import { Icon, ICON } from '../../lib/icons';
import type { Asset, AssetMap } from '../../types';
import { AssetMark } from '../primitives';

type Filter = 'all' | 'gainers' | 'losers';

/** Deterministic pseudo-sparkline series from the ticker (stable across renders). */
function spark(sym: string, n = 18): number[] {
  let seed = 0;
  for (const c of sym) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const out: number[] = [];
  let v = 50;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    v = Math.max(10, Math.min(90, v + ((seed % 100) / 100 - 0.5) * 24));
    out.push(v);
  }
  return out;
}

function Sparkline({ sym, up }: { sym: string; up: boolean }) {
  const pts = spark(sym);
  const W = 84;
  const H = 26;
  const d = pts.map((p, i) => `${(i / (pts.length - 1)) * W},${H - (p / 100) * H}`).join(' ');
  const stroke = up ? 'var(--positive)' : 'var(--danger)';
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={d} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
    </svg>
  );
}

function Mover({ a, kind }: { a?: Asset; kind: 'gain' | 'loss' }) {
  const col = kind === 'gain' ? 'var(--positive)' : 'var(--danger)';
  const p = a?.price;
  const c = a?.chg;
  const loading = p == null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--line)', minWidth: 0 }}>
      <AssetMark sym={a?.sym ?? 'dTSLA'} size={30} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{(a?.sym ?? '—').replace(/^d/, '')}</div>
        <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{loading ? <Skeleton w={48} h={12} /> : <FlashPrice price={p ?? 0} size={12} weight={500} base="var(--ink-3)" />}</div>
      </div>
      <div className="tabnum" style={{ fontWeight: 700, fontSize: 13, color: loading || c == null ? 'var(--ink-faint)' : col, flex: 'none' }}>
        {loading ? '··' : c == null ? '—' : `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`}
      </div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th style={{ padding: '12px 16px', fontWeight: 600, textAlign: right ? 'right' : 'left', fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>
      {children}
    </th>
  );
}
function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <td style={{ padding: '13px 16px', textAlign: right ? 'right' : 'left', verticalAlign: 'middle' }}>{children}</td>;
}

/** Placeholder bar shown while the first Pyth fetch is in flight — no fake prices. */
function Skeleton({ w = 60, h = 14 }: { w?: number; h?: number }) {
  return <span style={{ display: 'inline-block', width: w, height: h, borderRadius: 5, background: 'var(--surface-2)', border: '1px solid var(--line)', opacity: 0.7 }} />;
}

/** Live price that briefly flashes green on an up-tick / red on a down-tick, then fades
 *  back — makes the real-time stream visible. Padding is offset by negative margin so the
 *  flash highlight never shifts layout. */
function FlashPrice({ price, size = 14, weight = 600, base = 'var(--accent)' }: { price: number; size?: number; weight?: number; base?: string }) {
  const prevRef = useRef(price);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = price;
    if (price === prev) return;
    setDir(price > prev ? 'up' : 'down');
    const t = setTimeout(() => setDir(null), 700);
    return () => clearTimeout(t);
  }, [price]);
  const flash = dir === 'up' ? 'var(--positive)' : dir === 'down' ? 'var(--danger)' : null;
  return (
    <span
      className="mono tabnum"
      style={{
        display: 'inline-block',
        fontSize: size,
        fontWeight: weight,
        color: flash ?? base,
        background: flash ? `color-mix(in srgb, ${flash} 13%, transparent)` : 'transparent',
        borderRadius: 5,
        padding: '0 4px',
        margin: '0 -4px',
        transition: 'color 0.2s ease, background 0.5s ease',
      }}
    >
      {fmtUSD(price, 2)}
    </span>
  );
}

/** Which Pyth session the live price came from → short badge label + colour. */
function sessionTag(a: Asset): { label: string; color: string } {
  if (a.stale) return { label: 'LAST CLOSE', color: 'var(--warn)' };
  switch (a.session) {
    case 'REG': return { label: 'REG', color: 'var(--positive)' };
    case 'OVN': return { label: 'OVN', color: 'var(--accent)' };
    case 'PRE': return { label: 'PRE', color: 'var(--accent-ink)' };
    case 'POST': return { label: 'POST', color: 'var(--accent-ink)' };
    default: return { label: 'LIVE', color: 'var(--positive)' };
  }
}

/** Compact $ for the volume column ("$1.24M", "$3.4K"). */
function fmtVol(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/** `tvl` = per-market collateral locked (totalFunded whole shares) keyed by dShare symbol;
 *  Volume$ = tvl[sym] × live price. */
export function MarketsPanel({ onDeposit, assets = ASSETS, tvl = {} }: { onDeposit: (sym: string) => void; assets?: AssetMap; tvl?: Record<string, number> }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const all = useMemo(() => Object.values(assets).filter((a) => a.sym !== 'USDC'), [assets]);
  // Top 4 gainers + top 4 losers — both ends of the chg-sorted list (only assets with a live
  // change). `losers` starts past the gainers' slots so the two never overlap when few names
  // have loaded; reversed so the biggest loser leads.
  const { topGainers, topLosers } = useMemo(() => {
    const withChg = all.filter((a) => a.chg != null).sort((x, y) => (y.chg as number) - (x.chg as number));
    const gainers = withChg.slice(0, 4);
    const losers = withChg.slice(Math.max(4, withChg.length - 4)).reverse();
    return { topGainers: gainers, topLosers: losers };
  }, [all]);

  // oracle freshness for the status pill — honest: connecting → live → (partial) last close
  const loaded = all.filter((a) => a.price != null);
  const loadingPrices = all.length > 0 && loaded.length === 0;
  const allStale = loaded.length > 0 && loaded.every((a) => a.stale);
  const someStale = loaded.some((a) => a.stale);
  // dominant currently-trading session across the live names (for the status pill)
  const sessCount: Record<string, number> = {};
  for (const a of loaded) if (!a.stale && a.session) sessCount[a.session] = (sessCount[a.session] ?? 0) + 1;
  const domSession = Object.entries(sessCount).sort((x, y) => y[1] - x[1])[0]?.[0];

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((a) => (filter === 'gainers' ? (a.chg ?? 0) >= 0 : filter === 'losers' ? (a.chg ?? 0) < 0 : true))
      .filter((a) => !needle || a.sym.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle))
      .sort((x, y) => (y.price ?? 0) - (x.price ?? 0));
  }, [all, q, filter]);

  const chips: [Filter, string][] = [
    ['all', 'All'],
    ['gainers', 'Gainers'],
    ['losers', 'Losers'],
  ];

  // pagination — max 10 markets per page
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [q, filter]); // reset to first page when the list changes
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const visible = rows.slice(start, start + PAGE_SIZE);

  return (
    <div className="card fade-up" style={{ padding: 0, overflow: 'hidden' }}>
      {/* header */}
      <div style={{ padding: 'calc(20px * var(--pad)) calc(22px * var(--pad)) calc(16px * var(--pad))', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div className="eyebrow">Tokenized equities · collateral universe</div>
            <h2 className="serif" style={{ fontSize: 'clamp(20px, 2.4vw, 26px)', fontWeight: 500, marginTop: 4 }}>Markets</h2>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span className="pill" style={{ background: 'var(--surface-2)' }}>
              <span className="dot" style={{ background: 'var(--accent)' }} /> {all.length} markets
            </span>
            <span className="pill" style={{ background: 'var(--surface-2)' }}>Max LTV {(PROTOCOL.LTV * 100).toFixed(0)}%</span>
            <span className="pill" style={{ background: 'var(--surface-2)', color: someStale ? 'var(--warn)' : undefined }}>
              <Icon d={ICON.clock} size={11} sw={2} /> {loadingPrices ? 'Pyth · connecting…' : allStale ? 'Pyth · last close' : `Pyth · ${domSession ?? 'live'}${someStale ? ' · some last close' : ''}`}
            </span>
          </div>
        </div>

        {/* top movers — two columns: Top Gainers (4) | Top Losers (4) */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
          <div>
            <span className="eyebrow" style={{ fontSize: 12, color: 'var(--positive)' }}>Top Gainers</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 7 }}>
              {Array.from({ length: 4 }).map((_, i) => (
                <Mover key={`g${i}`} a={topGainers[i]} kind="gain" />
              ))}
            </div>
          </div>
          <div>
            <span className="eyebrow" style={{ fontSize: 12, color: 'var(--danger)' }}>Top Losers</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 7 }}>
              {Array.from({ length: 4 }).map((_, i) => (
                <Mover key={`l${i}`} a={topLosers[i]} kind="loss" />
              ))}
            </div>
          </div>
        </div>

        {/* toolbar */}
        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-faint)', display: 'inline-flex' }}>
              <Icon d={ICON.search} size={15} />
            </span>
            <input
              className="field"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search ticker or name"
              style={{ paddingLeft: 36, height: 42, fontSize: 14 }}
            />
          </div>
          <div style={{ display: 'inline-flex', gap: 3, padding: 3, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
            {chips.map(([id, label]) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className="btn btn-sm"
                style={{
                  background: filter === id ? 'var(--surface)' : 'transparent',
                  border: filter === id ? '1px solid var(--line-2)' : '1px solid transparent',
                  boxShadow: filter === id ? 'var(--shadow-sm)' : 'none',
                  color: filter === id ? 'var(--ink)' : 'var(--ink-3)',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
          <thead>
            <tr>
              <Th>Asset</Th>
              <Th>Oracle</Th>
              <Th right>Volume</Th>
              <Th right>Max LTV</Th>
              <Th right>Liq. threshold</Th>
              <Th right>24h</Th>
              <Th right>Action</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a, i) => {
              const up = (a.chg ?? 0) >= 0;
              const chgCol = up ? 'var(--positive)' : 'var(--danger)';
              return (
                <tr
                  key={a.sym}
                  className="fade-up"
                  style={{ borderTop: '1px solid var(--line)', animationDelay: `${i * 35}ms` }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <Td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <AssetMark sym={a.sym} size={34} />
                      <div>
                        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
                          {a.sym.replace(/^d/, '')}
                          <span className="pill pill-accent" style={{ padding: '1px 7px', fontSize: 12 }}>
                            <Icon d={ICON.lock} size={9} sw={2.2} /> {a.wrapped}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{a.name}</div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {a.price == null ? (
                      <Skeleton w={72} h={16} />
                    ) : (
                      <>
                        <FlashPrice price={a.price} />
                        {(() => {
                          const tag = sessionTag(a);
                          return (
                            <div className="mono" style={{ fontSize: 12, color: 'var(--ink-faint)', display: 'flex', alignItems: 'center', gap: 5 }}>
                              <span style={{ fontWeight: 700, color: tag.color, letterSpacing: '0.03em' }}>{tag.label}</span> · Pyth
                            </div>
                          );
                        })()}
                      </>
                    )}
                  </Td>
                  <Td right>
                    {a.price == null || Object.keys(tvl).length === 0 ? (
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <Skeleton w={64} h={16} />
                      </div>
                    ) : (
                      <div>
                        <div className="tabnum" style={{ fontWeight: 600 }}>{fmtVol((tvl[a.sym] ?? 0) * (a.price ?? 0))}</div>
                        <div className="mono" style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{fmtNum(tvl[a.sym] ?? 0)} sh collateral</div>
                      </div>
                    )}
                  </Td>
                  <Td right>
                    <span className="pill" style={{ background: 'var(--surface-2)' }}>{(PROTOCOL.LTV * 100).toFixed(0)}%</span>
                  </Td>
                  <Td right>
                    <span className="tabnum" style={{ color: 'var(--ink-2)' }}>{(PROTOCOL.LT * 100).toFixed(0)}%</span>
                  </Td>
                  <Td right>
                    {a.price == null ? (
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <Skeleton w={88} h={16} />
                      </div>
                    ) : a.chg == null ? (
                      <span className="tabnum" style={{ fontSize: 13, color: 'var(--ink-faint)', minWidth: 52, display: 'inline-block', textAlign: 'right' }}>—</span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                        <Sparkline sym={a.sym} up={up} />
                        <span className="tabnum" style={{ fontWeight: 700, fontSize: 13, color: chgCol, textAlign: 'right' }}>
                          {up ? '+' : ''}
                          {(a.chg ?? 0).toFixed(2)}%
                        </span>
                      </div>
                    )}
                  </Td>
                  <Td right>
                    <button className="btn btn-sm btn-accent" onClick={() => onDeposit(a.sym)} style={{ gap: 6 }}>
                      <Icon d={ICON.plus} size={13} sw={2.2} /> Deposit
                    </button>
                  </Td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr style={{ borderTop: '1px solid var(--line)' }}>
                <Td>
                  <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>No markets match “{q}”.</span>
                </Td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px calc(22px * var(--pad))',
            borderTop: '1px solid var(--line)',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            Showing {start + 1}–{Math.min(start + PAGE_SIZE, rows.length)} of {rows.length} markets
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              className="btn btn-sm btn-ghost"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              aria-label="Previous page"
            >
              <Icon d={ICON.arrowR} size={14} style={{ transform: 'rotate(180deg)' }} /> Prev
            </button>
            <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)', minWidth: 54, textAlign: 'center' }}>
              {safePage + 1} / {pageCount}
            </span>
            <button
              className="btn btn-sm btn-ghost"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              aria-label="Next page"
            >
              Next <Icon d={ICON.arrowR} size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
