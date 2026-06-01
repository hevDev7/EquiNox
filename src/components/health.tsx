/* ============================================================
   Equinox — blinded health-factor gauge + colour helpers
   ============================================================ */

import { useState } from 'react';
import { fmtUSD } from '../lib/format';
import { Icon, ICON } from '../lib/icons';
import { useScramble } from '../hooks/useScramble';
import { SealedValue } from './primitives';

export function hfColor(hf: number): string {
  if (hf >= 1.6) return 'var(--positive)';
  if (hf >= 1.15) return 'var(--warn)';
  return 'var(--danger)';
}
export function hfLabel(hf: number): string {
  if (hf >= 1.6) return 'Healthy';
  if (hf >= 1.15) return 'Caution';
  if (hf >= 1.0) return 'At risk';
  return 'Liquidatable';
}

export function ArcGauge({ hf, sealed }: { hf: number; sealed: boolean }) {
  // semicircle, 0 .. 2.5 mapped to 180deg
  const R = 78,
    CX = 90,
    CY = 90,
    sw = 13;
  const max = 2.5;
  const frac = Math.min(1, Math.max(0, (sealed ? 0.5 : hf) / max));
  const a1 = Math.PI - frac * Math.PI;
  const pt = (a: number): [number, number] => [CX + R * Math.cos(a), CY - R * Math.sin(a)];
  const [sx, sy] = pt(Math.PI);
  const [ex, ey] = pt(a1);
  const large = frac > 0.5 ? 1 : 0;
  const trackPath = `M ${CX - R} ${CY} A ${R} ${R} 0 1 1 ${CX + R} ${CY}`;
  const arcPath = `M ${sx} ${sy} A ${R} ${R} 0 ${large} 1 ${ex} ${ey}`;
  const col = sealed ? 'var(--ink-faint)' : hfColor(hf);
  const a = Math.PI - (1 / max) * Math.PI;
  const [x1, y1] = [CX + (R - sw / 2 - 2) * Math.cos(a), CY - (R - sw / 2 - 2) * Math.sin(a)];
  const [x2, y2] = [CX + (R + sw / 2 + 2) * Math.cos(a), CY - (R + sw / 2 + 2) * Math.sin(a)];
  return (
    <svg viewBox="0 0 180 108" width="100%" style={{ maxWidth: 240, display: 'block', margin: '0 auto' }}>
      <path d={trackPath} fill="none" stroke="var(--line)" strokeWidth={sw} strokeLinecap="round" />
      <path
        d={arcPath}
        fill="none"
        stroke={col}
        strokeWidth={sw}
        strokeLinecap="round"
        style={{ transition: 'all 0.6s cubic-bezier(0.2,0.7,0.2,1)', opacity: sealed ? 0.5 : 1 }}
      />
      {/* tick at HF=1.0 */}
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--danger)" strokeWidth="1.5" strokeDasharray="2 2" />
    </svg>
  );
}

export function BlindedHF({ hf, liqPrice, under }: { hf: number; liqPrice: number; under: string }) {
  const [revealed, setRevealed] = useState(false);
  const fuzz = useScramble(5, !revealed, 120);
  return (
    <div className="card" style={{ padding: 'calc(22px * var(--pad))', position: 'relative', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div>
          <div className="eyebrow">Health Factor</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3 }}>
            {revealed ? 'Decrypted — visible only on your device' : 'Public view is blinded by sᵢ'}
          </div>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={() => setRevealed((r) => !r)}>
          <Icon d={revealed ? ICON.eyeOff : ICON.eye} size={14} /> {revealed ? 'Seal' : 'Reveal'}
        </button>
      </div>

      <div style={{ position: 'relative', marginTop: 6 }}>
        <ArcGauge hf={hf} sealed={!revealed} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 2, textAlign: 'center' }}>
          {revealed ? (
            <div className="reveal-in">
              <div className="serif tabnum" style={{ fontSize: 42, lineHeight: 1, color: hfColor(hf), fontWeight: 500 }}>
                {hf === Infinity ? '∞' : hf.toFixed(2)}
              </div>
              <div className="pill" style={{ marginTop: 8, background: 'transparent', borderColor: hfColor(hf), color: hfColor(hf) }}>
                <span className="dot" style={{ background: hfColor(hf) }}></span> {hfLabel(hf)}
              </div>
            </div>
          ) : (
            <div>
              <div className="cipher" style={{ fontSize: 30, fontWeight: 600 }}>~{fuzz}</div>
              <div className="pill pill-accent" style={{ marginTop: 8 }}>
                <Icon d={ICON.shield} size={12} sw={2} /> Blinded indicator
              </div>
            </div>
          )}
        </div>
      </div>

      <hr className="divider" style={{ margin: '18px 0 14px' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span style={{ color: 'var(--ink-3)' }}>Liquidation price · {under}</span>
        {revealed ? (
          <span className="mono reveal-in" style={{ fontWeight: 600 }}>{fmtUSD(liqPrice, 2)}</span>
        ) : (
          <SealedValue value={fmtUSD(liqPrice, 2)} len={7} />
        )}
      </div>
    </div>
  );
}
