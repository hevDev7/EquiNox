/* ============================================================
   Equinox — Borrower shared: confidential TxFlow modal, weekend
   banner, "what the chain sees" blinding panel, collateral tabs.
   ============================================================ */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bigInt, fmtNum, fmtUSD, randCipher } from '../../lib/format';
import { Icon, ICON } from '../../lib/icons';
import { txErrorMessage } from '../../lib/errors';
import type { Asset, AssetMap, BorrowerTab, DerivedPosition, Position } from '../../types';
import { DecimalIndicator, EncTag, FheSteps, SealedValue, AssetMark, type Step } from '../primitives';

/* ---------- reusable confidential tx flow modal ---------- */
export function TxFlow({
  open,
  title,
  steps,
  onClose,
  action,
  summary,
  cta = 'Confirm',
  onDone,
}: {
  open: boolean;
  title: string;
  steps: Step[];
  onClose: () => void;
  /** The real work — its promise resolves on confirmation, throws on reject/revert. */
  action: () => Promise<void>;
  summary?: ReactNode;
  cta?: string;
  /** Fired shortly after the tx succeeds (phase 'done') — e.g. to auto-close a drawer. */
  onDone?: () => void;
}) {
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done' | 'error'>('confirm');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (open) {
      setPhase('confirm');
      setActive(0);
      setError(null);
    }
  }, [open]);

  const run = async () => {
    setPhase('running');
    setActive(0);
    setError(null);
    // indeterminate stepping: advance toward — but never reach — the last step
    // until the real transaction actually resolves
    const id = setInterval(() => setActive((a) => Math.min(a + 1, steps.length - 1)), 820);
    try {
      await action();
      clearInterval(id);
      if (!mounted.current) return;
      setActive(steps.length);
      setPhase('done');
      // show the success state briefly, then notify (e.g. auto-close the drawer)
      if (onDone) setTimeout(() => { if (mounted.current) onDone(); }, 1300);
    } catch (e) {
      clearInterval(id);
      if (!mounted.current) return;
      setError(txErrorMessage(e));
      setPhase('error');
    }
  };

  if (!open) return null;
  const dismiss = phase === 'running' ? undefined : onClose;
  return (
    <div
      onClick={dismiss}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'oklch(0.2 0.02 265 / 0.42)',
        backdropFilter: 'blur(3px)',
        zIndex: 150,
        display: 'grid',
        placeItems: 'center',
        padding: 20,
      }}
    >
      <div className="card fade-up" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 460, padding: 28, boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h3 className="serif" style={{ fontSize: 21, fontWeight: 500 }}>{title}</h3>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={phase === 'running'} style={{ padding: 6 }}>
            <Icon d={ICON.x} size={16} />
          </button>
        </div>

        {phase === 'confirm' && (
          <div className="fade-up">
            {summary}
            <div className="pill pill-accent" style={{ marginTop: 18, width: '100%', justifyContent: 'flex-start', padding: '9px 13px' }}>
              <Icon d={ICON.lock} size={13} sw={2} /> Inputs are encrypted in-browser before signing
            </div>
            <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 16 }} onClick={run}>
              {cta}
            </button>
          </div>
        )}

        {phase === 'running' && (
          <div className="fade-up">
            <FheSteps steps={steps} active={active} />
            <div style={{ marginTop: 20 }}>
              <div className="track">
                <span style={{ width: `${Math.min(95, (active / steps.length) * 100)}%` }} />
              </div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 10 }}>
                awaiting wallet confirmation &amp; on-chain settlement · CoFHE coprocessor
              </div>
              {active >= steps.length - 1 && (
                <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 8, lineHeight: 1.5 }}>
                  Threshold-decryption on the testnet coprocessor can take up to a minute — this is normal. Please keep this window open while it settles.
                </div>
              )}
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="fade-up" style={{ textAlign: 'center', padding: '6px 0' }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: 'var(--positive-soft)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 16px',
                animation: 'pulseRing 1.6s ease-out',
              }}
            >
              <Icon d={ICON.check} size={28} sw={2.4} style={{ color: 'var(--positive)' }} />
            </div>
            <h3 className="serif" style={{ fontSize: 22, fontWeight: 500, marginBottom: 6 }}>Confirmed confidentially</h3>
            <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '0 auto 22px', maxWidth: 320 }}>
              Settled on Arbitrum Sepolia — your sealed balances stay private.
            </p>
            <button className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={onClose}>
              Done
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div className="fade-up" style={{ textAlign: 'center', padding: '6px 0' }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: 'var(--danger-soft)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 16px',
              }}
            >
              <Icon d={ICON.alert} size={26} sw={2} style={{ color: 'var(--danger)' }} />
            </div>
            <h3 className="serif" style={{ fontSize: 21, fontWeight: 500, marginBottom: 6 }}>Transaction failed</h3>
            <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.55, margin: '0 auto 20px', maxWidth: 340 }}>{error}</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-lg grow" onClick={onClose}>Close</button>
              <button className="btn btn-primary btn-lg grow" onClick={() => setPhase('confirm')}>
                <Icon d={ICON.refresh} size={15} /> Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- weekend circuit breaker banner ---------- */
export function WeekendBanner({ active, onToggle, simulated }: { active: boolean; onToggle: () => void; simulated: boolean }) {
  if (!active) return null;
  return (
    <div
      className="fade-up"
      style={{
        display: 'flex',
        gap: 14,
        alignItems: 'center',
        padding: '14px 18px',
        borderRadius: 13,
        background: 'var(--warn-soft)',
        border: '1px solid var(--warn)',
        marginBottom: 20,
      }}
    >
      <Icon d={ICON.clock} size={20} sw={1.8} style={{ color: 'var(--warn)', flex: 'none' }} />
      <div className="grow">
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--warn)' }}>Weekend Emergency Mode active</div>
        <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 1 }}>
          TradFi markets closed (Fri 21:00 → Mon 13:30 UTC). New borrows are paused and a <strong> 15% collateral haircut</strong> applies to all
          health calculations.
        </div>
      </div>
      {simulated && (
        <button className="btn btn-sm btn-ghost" onClick={onToggle}>
          Exit demo
        </button>
      )}
    </div>
  );
}

function Row({ k, v, last }: { k: ReactNode; v: ReactNode; last?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 10,
        padding: '7px 0',
        borderBottom: last ? 'none' : '1px solid var(--line)',
        fontSize: 13,
      }}
    >
      <span style={{ color: 'var(--ink-3)' }}>{k}</span>
      <span style={{ textAlign: 'right' }}>{v}</span>
    </div>
  );
}

/* ---------- "what the chain sees" — the blinding primitive, visualized ---------- */
function ChainSeesInner({ pos, der }: { pos: Position; der: DerivedPosition }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.55, marginBottom: 16 }}>
        Your secret factor <span className="mono" style={{ color: 'var(--accent)' }}>sᵢ</span> blinds every public number. Anyone can read{' '}
        <span className="mono">Aᵢ, Bᵢ</span> — but they cancel sᵢ only inside the health ratio, never exposing your real balances.
      </p>

      <div className="chain-cols" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* public */}
        <div style={{ padding: 14, borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
          <div className="pill" style={{ marginBottom: 12, background: 'transparent' }}>
            <Icon d={ICON.eye} size={12} /> Public on-chain
          </div>
          <Row k="Aᵢ = sᵢ·Σ(Cᵢ·Pᵢ·LTᵢ)" v={<span className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>{bigInt(der.A)}</span>} />
          <Row k="Bᵢ = sᵢ·scaledDebt" v={<span className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>{bigInt(der.B)}</span>} />
          <Row k="balanceOf()" v={<DecimalIndicator />} />
          <Row k="KYC status" v={<span className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>registered ✓</span>} last />
        </div>
        {/* private */}
        <div style={{ padding: 14, borderRadius: 12, background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div className="pill pill-accent" style={{ background: 'var(--surface)' }}>
              <Icon d={ICON.lock} size={12} /> Your truth
            </div>
            <button className="btn btn-sm btn-ghost" onClick={() => setShow((s) => !s)} style={{ padding: '4px 8px' }}>
              <Icon d={show ? ICON.eyeOff : ICON.eye} size={13} />
            </button>
          </div>
          <Row
            k="Collateral Cᵢ"
            v={show ? <b className="reveal-in mono" style={{ fontSize: 12 }}>{fmtNum(der.collatShares)} sh</b> : <SealedValue value={`${fmtNum(der.collatShares)} sh`} len={6} />}
          />
          <Row k="Debt Dᵢ" v={show ? <b className="reveal-in mono" style={{ fontSize: 12 }}>{fmtUSD(pos.debtUSDC)}</b> : <SealedValue value={fmtUSD(pos.debtUSDC)} len={7} />} />
          <Row k="Blinding sᵢ" v={show ? <b className="reveal-in mono" style={{ fontSize: 12 }}>{bigInt(pos.blinding)}</b> : <SealedValue value={bigInt(pos.blinding)} len={8} />} />
          <Row
            k="Collateral value"
            v={show ? <b className="reveal-in mono" style={{ fontSize: 12 }}>{fmtUSD(der.collatValue)}</b> : <SealedValue value={fmtUSD(der.collatValue)} len={8} />}
            last
          />
        </div>
      </div>
    </div>
  );
}

/* ---------- collateral list (inner content) ---------- */
function CollateralInner({ pos, prices, go }: { pos: Position; prices: AssetMap; go: (tab: BorrowerTab) => void }) {
  const held = pos.collateral.filter((c) => c.shares > 0);
  return (
    <div>
      {held.length === 0 ? (
        <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          No encrypted collateral yet. Deposit any of the 18 dShares to start borrowing.
        </div>
      ) : (
        held.map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
            <AssetMark sym={c.sym} />
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{c.sym}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Wrapped {c.under} · euint64</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <SealedValue value={`${fmtNum(c.shares)} sh`} len={5} />
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
                {/* price each row by ITS OWN underlying, not the active asset */}
                <SealedValue value={fmtUSD(c.shares * (prices[c.under]?.price ?? 0))} len={7} />
              </div>
            </div>
          </div>
        ))
      )}
      <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
        <button className="btn btn-sm grow" onClick={() => go('repay')}>
          <Icon d={ICON.refresh} size={14} /> Repay / Unwrap
        </button>
      </div>
    </div>
  );
}

/* ---------- merged tabbed card: Collateral · Blinding Primitive ---------- */
export function PositionTabs({ pos, der, prices, asset, go }: { pos: Position; der: DerivedPosition; prices: AssetMap; asset: Asset; go: (tab: BorrowerTab) => void }) {
  const [tab, setTab] = useState<'collateral' | 'blinding'>('collateral');
  const held = pos.collateral.filter((c) => c.shares > 0);
  const single = held.length === 1 ? prices[held[0].under] : undefined;
  const tabs: [typeof tab, string, string | readonly string[]][] = [
    ['collateral', 'Collateral', ICON.vault],
    ['blinding', 'Blinding Primitive', ICON.layers],
  ];
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 calc(22px * var(--pad))', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', gap: 4, flex: 1 }}>
          {tabs.map(([id, label, ic]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '15px 4px',
                marginRight: 14,
                fontSize: 14,
                fontWeight: tab === id ? 600 : 500,
                color: tab === id ? 'var(--ink)' : 'var(--ink-3)',
                borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}`,
                marginBottom: -1,
                transition: 'color 0.15s',
              }}
            >
              <Icon d={ic} size={15} style={{ color: tab === id ? 'var(--accent)' : 'var(--ink-faint)' }} /> {label}
            </button>
          ))}
        </div>
        {tab === 'collateral' ? (
          <span className="pill pill-positive">
            <span className="dot" style={{ background: 'var(--positive)' }} />{' '}
            {held.length === 1 && single ? (
              <>{held[0].under} {fmtUSD(single.price ?? 0, 2)} <span style={{ opacity: 0.7 }}>{single.chg == null ? '—' : `${single.chg >= 0 ? '+' : ''}${single.chg.toFixed(2)}%`}</span></>
            ) : held.length > 1 ? (
              <>{held.length} assets · {fmtUSD(der.collatValue)} sealed</>
            ) : (
              <>no collateral</>
            )}
          </span>
        ) : (
          <EncTag label="zero-knowledge of balances" />
        )}
      </div>
      <div style={{ padding: 'calc(20px * var(--pad)) calc(22px * var(--pad))' }} key={tab} className="fade-up">
        {tab === 'collateral' ? <CollateralInner pos={pos} prices={prices} go={go} /> : <ChainSeesInner pos={pos} der={der} />}
      </div>
    </div>
  );
}

/* re-export for callers that build cipher backgrounds */
export { randCipher };
