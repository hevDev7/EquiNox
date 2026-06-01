/* ============================================================
   Equinox — Liquidator / Searcher console (persona: Bobby)
   Computes HF from PUBLIC factors only. Real collateral stays sealed.
   ============================================================ */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { bigInt, fmtUSD, randCipher, txHash } from '../lib/format';
import { Icon, ICON } from '../lib/icons';
import { PROTOCOL, liquidatorHF } from '../lib/protocol';
import { ASSETS } from '../lib/mock-data';
import { useServices } from '../context/ServiceContext';
import type { Account, AssetMap } from '../types';
import { type ToastInfo } from './primitives';
import { hfColor } from './health';
import { KV } from './borrower/actions';
import { TxFlow } from './borrower/common';

function initialPrices(assets: AssetMap): Record<string, number> {
  const m: Record<string, number> = {};
  for (const a of Object.values(assets)) if (a.price != null) m[a.sym] = a.price;
  return m;
}

export function LiquidatorConsole({
  pushToast,
  assets = ASSETS,
}: {
  pushToast: (t: ToastInfo) => void;
  assets?: AssetMap;
}) {
  const { equinox } = useServices();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>(() => initialPrices(assets));
  const [sel, setSel] = useState<Account | null>(null);
  const [liq, setLiq] = useState<Account | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void equinox.listAccounts().then(setAccounts);
  }, [equinox]);

  // keep the oracle panel synced to live prices when they refresh
  useEffect(() => {
    setPrices(initialPrices(assets));
  }, [assets]);

  const priceFor = (under: string) => prices[under] ?? 0;

  const rows = useMemo(
    () =>
      accounts
        // V2: prefer the contract's authoritative HF (price is folded into factor A, so the
        // V1 client-side formula would be wrong); fall back to it only for mock/un-settled.
        // hf = null when the price isn't loaded yet → render "—" instead of a false HF 0 / liquidatable
        .map((a) => {
          const p = priceFor(a.under);
          const hf = a.hfBps != null ? a.hfBps / 10_000 : p > 0 ? liquidatorHF(a, p, a.idxBps ?? PROTOCOL.interestIndex) : undefined;
          return { ...a, hf };
        })
        .sort((x, y) => (x.hf ?? Infinity) - (y.hf ?? Infinity)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, prices],
  );

  const liquidatable = rows.filter((r) => (r.hf ?? Infinity) < 1 && !done[r.id]).length;

  // distinct underlyings present in the account set, for the oracle panel
  const feedSyms = Array.from(new Set(accounts.map((a) => a.under)));
  // honest oracle freshness: reflect the live stale flag instead of a hardcoded "< 60s"
  const oracleStale = Object.values(assets).some((a) => a.price != null && a.stale);

  const movePrice = (d: number) =>
    setPrices((ps) => {
      const next: Record<string, number> = {};
      for (const k of Object.keys(ps)) next[k] = Math.max(1, +(ps[k] * (1 + d)).toFixed(2));
      return next;
    });
  const resetPrices = () => setPrices(initialPrices(assets));

  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <div className="eyebrow">Searcher console</div>
          <h1 className="serif" style={{ fontSize: 'clamp(24px, 3.2vw, 32px)', fontWeight: 500, marginTop: 4 }}>Liquidation solver</h1>
          <p style={{ fontSize: 14, color: 'var(--ink-2)', marginTop: 6, maxWidth: 620, lineHeight: 1.55 }}>
            You only ever see the public blinded factors <span className="mono" style={{ color: 'var(--accent)' }}>Aᵢ, Bᵢ</span>. The secret sᵢ cancels inside
            the ratio, so you can prove a position is unhealthy and liquidate it — <strong> without ever learning the victim's real collateral or debt.</strong>
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div
            className="pill"
            style={{
              background: liquidatable ? 'var(--danger-soft)' : 'var(--surface-2)',
              color: liquidatable ? 'var(--danger)' : 'var(--ink-3)',
              borderColor: 'transparent',
            }}
          >
            <span className="dot" style={{ background: liquidatable ? 'var(--danger)' : 'var(--ink-faint)' }} /> {liquidatable} liquidatable now
          </div>
        </div>
      </div>

      {/* oracle + formula bar */}
      <div className="liq-top" style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 16 }}>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div className="eyebrow">Pyth oracle · pull feed</div>
            <span className="mono" style={{ fontSize: 12, color: oracleStale ? 'var(--warn)' : 'var(--ink-3)' }}>{oracleStale ? 'last close · market closed' : 'staleness < 60s'}</span>
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', maxHeight: 132, overflowY: 'auto' }}>
            {feedSyms.map((sym) => (
              <div key={sym}>
                <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{sym.replace(/^d/, '')}/USD</div>
                <div className="serif tabnum" style={{ fontSize: 22, fontWeight: 500 }}>{fmtUSD(prices[sym] ?? 0, 2)}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 16 }}>
            <button className="btn btn-sm" onClick={() => movePrice(-0.03)}>−3% shock</button>
            <button className="btn btn-sm" onClick={() => movePrice(-0.01)}>−1%</button>
            <button className="btn btn-sm" onClick={resetPrices}>
              <Icon d={ICON.refresh} size={13} /> Reset
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>The health formula you can compute</div>
          <div className="mono" style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--ink)' }}>
            HFᵢ ={' '}
            <span style={{ display: 'inline-flex', flexDirection: 'column', textAlign: 'center', verticalAlign: 'middle', margin: '0 4px' }}>
              <span style={{ borderBottom: '1.5px solid var(--ink-3)', padding: '0 8px' }}>Aᵢ · P</span>
              <span style={{ padding: '0 8px' }}>Bᵢ · I</span>
            </span>
            ={' '}
            <span style={{ display: 'inline-flex', flexDirection: 'column', textAlign: 'center', verticalAlign: 'middle', margin: '0 4px', color: 'var(--accent)' }}>
              <span style={{ borderBottom: '1.5px solid var(--accent-line)', padding: '0 8px' }}>(s̶ᵢ·Cᵢ·LT)·P</span>
              <span style={{ padding: '0 8px' }}>(s̶ᵢ·Dᵢ)·I</span>
            </span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 12 }}>
            The blinding factor <span className="mono">sᵢ</span> appears in both Aᵢ and Bᵢ and cancels exactly — leaving a real health ratio with zero
            knowledge of Cᵢ or Dᵢ. I = <span className="mono">{PROTOCOL.interestIndex}</span>.
          </div>
        </div>
      </div>

      {/* table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                <Th>Account</Th>
                <Th>Asset</Th>
                <Th>Aᵢ (public)</Th>
                <Th>Bᵢ (public)</Th>
                <Th>Real collateral</Th>
                <Th right>Health</Th>
                <Th right>Action</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isDone = done[r.id];
                const known = r.hf != null;
                const hf = r.hf ?? Infinity;
                const col = isDone || !known ? 'var(--ink-faint)' : hfColor(hf);
                return (
                  <tr
                    key={r.id}
                    onClick={() => setSel(r)}
                    style={{
                      borderTop: '1px solid var(--line)',
                      cursor: 'pointer',
                      opacity: isDone ? 0.5 : 1,
                      background: sel?.id === r.id ? 'var(--surface-2)' : 'transparent',
                    }}
                  >
                    <Td>
                      <span className="mono" style={{ fontSize: 13 }}>{r.id}</span>
                    </Td>
                    <Td>
                      <span className="pill" style={{ padding: '2px 9px', fontSize: 12 }}>{r.under}</span>
                    </Td>
                    <Td>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>{bigInt(r.A).slice(0, 14)}…</span>
                    </Td>
                    <Td>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>{bigInt(r.B).slice(0, 14)}…</span>
                    </Td>
                    <Td>
                      <span className="cipher" style={{ fontSize: 12 }}>
                        <Icon d={ICON.lock} size={11} sw={2} style={{ verticalAlign: '-1px' }} /> {randCipher(8)}
                      </span>
                    </Td>
                    <Td right>
                      <span className="serif tabnum" style={{ fontSize: 19, fontWeight: 500, color: col }}>{isDone || !known ? '—' : hf.toFixed(3)}</span>
                    </Td>
                    <Td right>
                      {isDone ? (
                        <span className="pill pill-positive" style={{ fontSize: 12 }}>Liquidated</span>
                      ) : !known ? (
                        <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>—</span>
                      ) : hf < 1 ? (
                        <button
                          className="btn btn-sm"
                          style={{ background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setLiq(r);
                          }}
                        >
                          <Icon d={ICON.bolt} size={13} /> Liquidate
                        </button>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>healthy</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* detail drawer */}
      {sel && <SolverDetail acct={sel} price={priceFor(sel.under)} onClose={() => setSel(null)} onLiquidate={() => setLiq(sel)} done={!!done[sel.id]} />}

      {/* liquidate flow */}
      <TxFlow
        open={!!liq}
        title="Execute liquidation"
        cta="Submit liquidation"
        steps={[
          { label: 'Settle public factors (threshold proof)', detail: 'settleFactors(A,B) · verifyDecryptResult' },
          { label: 'Prove HF < 1 from public factors', detail: 'verify (Aᵢ·P) < (Bᵢ·I)' },
          { label: 'Repay victim debt in USDC', detail: 'liquidate(account, eDebtShare)' },
          { label: 'Seize collateral + bonus', detail: `bonus ${(PROTOCOL.liqBonus * 100).toFixed(1)}% · stays euint64` },
        ]}
        summary={
          liq && (
            <div>
              <KV k="Target" v={<span className="mono">{liq.id}</span>} />
              <KV k="Health factor" v={(liq.hf ?? 0).toFixed(3)} accent="var(--danger)" />
              <KV k="Seized collateral" v={<span className="cipher">sealed · euint64</span>} accent="var(--accent)" />
              <KV k="Your bonus" v={`+${(PROTOCOL.liqBonus * 100).toFixed(1)}%`} accent="var(--positive)" />
            </div>
          )
        }
        onClose={() => setLiq(null)}
        action={async () => {
          if (!liq) return;
          const id = liq.id;
          await equinox.settleFactors(id); // publish A,B on-chain so liquidate's HF check passes
          // V2: seize collateral asset 0 (dTSLA). The contract clamps the seize to the
          // victim's sealed balance of that asset, so an unheld asset simply seizes 0.
          const { txHash: hash } = await equinox.liquidate(id, 0);
          setDone((d) => ({ ...d, [id]: true }));
          setSel(null);
          pushToast({ title: 'Liquidation executed', icon: 'bolt', hash });
        }}
      />
    </div>
  );
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th style={{ padding: '13px 16px', fontWeight: 600, textAlign: right ? 'right' : 'left' }}>{children}</th>;
}
function Td({ children, right }: { children: ReactNode; right?: boolean }) {
  return <td style={{ padding: '13px 16px', textAlign: right ? 'right' : 'left' }}>{children}</td>;
}

function SolverDetail({
  acct,
  price,
  onClose,
  onLiquidate,
  done,
}: {
  acct: Account;
  price: number;
  onClose: () => void;
  onLiquidate: () => void;
  done: boolean;
}) {
  const hf = acct.hf ?? Infinity;
  const num = acct.A * price;
  const den = acct.B * PROTOCOL.interestIndex;
  return (
    <div className="card fade-up" style={{ padding: 22, border: '1px solid var(--accent-line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon d={ICON.search} size={18} style={{ color: 'var(--accent)' }} />
          <h3 className="serif" style={{ fontSize: 19, fontWeight: 500 }}>Solver trace · {acct.id}</h3>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={onClose} style={{ padding: 6 }}>
          <Icon d={ICON.x} size={16} />
        </button>
      </div>
      <div className="chain-cols" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Public inputs</div>
          <KV k="Aᵢ = sᵢ·Cᵢ·LT" v={<span className="mono" style={{ fontSize: 12 }}>{bigInt(acct.A)}</span>} />
          <KV k="Bᵢ = sᵢ·Dᵢ" v={<span className="mono" style={{ fontSize: 12 }}>{bigInt(acct.B)}</span>} />
          <KV k="P · oracle" v={<span className="mono">{fmtUSD(price, 2)}</span>} />
          <KV k="I · index" v={<span className="mono">{PROTOCOL.interestIndex}</span>} />
        </div>
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Computation</div>
          <KV k="Aᵢ · P" v={<span className="mono" style={{ fontSize: 12 }}>{bigInt(Math.round(num))}</span>} />
          <KV k="Bᵢ · I" v={<span className="mono" style={{ fontSize: 12 }}>{bigInt(Math.round(den))}</span>} />
          <KV k="HF = (Aᵢ·P)/(Bᵢ·I)" v={<b style={{ color: hfColor(hf) }}>{hf.toFixed(4)}</b>} accent={hfColor(hf)} />
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon d={ICON.eyeOff} size={14} /> Real Cᵢ, Dᵢ, sᵢ remain unknown to you.
          </div>
        </div>
      </div>
      {!done && hf < 1 && (
        <button
          className="btn btn-lg"
          style={{ width: '100%', marginTop: 18, background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }}
          onClick={onLiquidate}
        >
          <Icon d={ICON.bolt} size={16} /> Liquidate — claim {(PROTOCOL.liqBonus * 100).toFixed(1)}% bonus
        </button>
      )}
    </div>
  );
}
