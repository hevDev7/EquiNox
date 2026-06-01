/* ============================================================
   Equinox — UI primitives: SealedValue, DecimalIndicator, EncTag,
   Stat, FheSteps, AssetMark, Toast, Logo
   ============================================================ */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { randDecimal } from '../lib/format';
import { Icon, ICON } from '../lib/icons';
import { useScramble } from '../hooks/useScramble';
import { useTweakCtx } from '../context/TweakContext';
import { logoSources, tickerFromSym } from '../lib/logos';

const css = (s: CSSProperties & Record<string, string | number>) => s as CSSProperties;

/* ---- core encrypted-value display ----
   value:   true plaintext (revealed locally only)
   privacy mode comes from tweak context: cipher | decimal | redacted */
export interface SealedValueProps {
  value: string;
  len?: number;
  className?: string;
  startRevealed?: boolean;
  onReveal?: () => void;
}
export function SealedValue({ value, len = 8, className = '', startRevealed = false, onReveal }: SealedValueProps) {
  const { privacyMode } = useTweakCtx();
  const [revealed, setRevealed] = useState(startRevealed);
  const cipher = useScramble(len);

  const reveal = () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    onReveal?.();
    setRevealed(true);
  };

  let body: ReactNode;
  if (revealed) {
    body = <span className="reveal-in tabnum">{value}</span>;
  } else if (privacyMode === 'redacted') {
    body = (
      <span className="redacted" style={{ width: `${len * 0.62}em`, height: '0.95em', transform: 'translateY(2px)' }}>x</span>
    );
  } else if (privacyMode === 'decimal') {
    body = <DecimalIndicator />;
  } else {
    body = <span className="cipher">{cipher}</span>;
  }

  return (
    <span className={`sealed ${className}`}>
      {body}
      <button
        onClick={reveal}
        title={revealed ? 'Re-seal' : 'Decrypt locally (only you can see this)'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          color: revealed ? 'var(--ink-3)' : 'var(--accent)',
          opacity: 0.8,
          padding: 2,
          marginLeft: 2,
          transform: 'translateY(1px)',
        }}
      >
        <Icon d={revealed ? ICON.eyeOff : ICON.eye} size={14} sw={1.7} />
      </button>
    </span>
  );
}

/* the PRD's balanceOf() random decimal indicator $0.0000–$0.9999 */
export function DecimalIndicator() {
  // A single sampled value — on-chain balanceOf() returns a random decimal, never
  // the real holding. (No longer re-sampled on a timer; the value is cosmetic.)
  const [v] = useState(randDecimal());
  return (
    <span
      className="cipher"
      title="On-chain balanceOf() returns a random decimal — never the real holding"
      style={{ opacity: 0.92 }}
    >
      {v}
    </span>
  );
}

/* small inline lock chip */
export function EncTag({ label = 'Encrypted on-chain' }: { label?: string }) {
  return (
    <span className="pill pill-accent" style={{ padding: '2px 8px', fontSize: 12 }}>
      <Icon d={ICON.lock} size={11} sw={2} /> {label}
    </span>
  );
}

/* ---- generic stat block ---- */
export function Stat({
  label,
  children,
  hint,
  accent,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  accent?: string;
}) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 6 }}>{label}</div>
      <div className="serif tabnum" style={{ fontSize: 26, fontWeight: 500, color: accent || 'var(--ink)', lineHeight: 1.05 }}>
        {children}
      </div>
      {hint && <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

/* ---- step / latency indicator for FHE async ops ---- */
export interface Step {
  label: string;
  detail?: string;
}
export function FheSteps({ steps, active }: { steps: Step[]; active: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {steps.map((s, i) => {
        const state = i < active ? 'done' : i === active ? 'active' : 'todo';
        return (
          <div
            key={i}
            style={{ display: 'flex', gap: 12, alignItems: 'center', opacity: state === 'todo' ? 0.45 : 1, transition: 'opacity 0.3s' }}
          >
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: '50%',
                flex: 'none',
                display: 'grid',
                placeItems: 'center',
                background: state === 'done' ? 'var(--accent)' : 'var(--surface-2)',
                border: `1px solid ${state === 'todo' ? 'var(--line-2)' : 'var(--accent)'}`,
                color: state === 'done' ? 'white' : 'var(--accent)',
              }}
            >
              {state === 'done' ? (
                <Icon d={ICON.check} size={14} sw={2.4} />
              ) : state === 'active' ? (
                <span className="spinner" style={{ width: 13, height: 13 }} />
              ) : (
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-faint)' }}>{i + 1}</span>
              )}
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: state === 'active' ? 600 : 500 }}>{s.label}</div>
              {s.detail && <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 1 }}>{s.detail}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---- asset glyph: real logo (CDN -> vendored local) with lettermark fallback ---- */
export function AssetMark({ sym, size = 34 }: { sym: string; size?: number }) {
  const ticker = tickerFromSym(sym);
  const sources = logoSources(sym);
  const [st, setSt] = useState<{ ticker: string; idx: number }>({ ticker, idx: 0 });
  const idx = st.ticker === ticker ? st.idx : 0; // reset cleanly when the symbol changes (no flash)
  const src = sources[idx];

  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: 9,
    flex: 'none',
    boxSizing: 'border-box',
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    border: '1px solid var(--line-2)',
  };

  if (src) {
    // logos are full-bleed branded tiles — fill the chip edge-to-edge (no gap/padding),
    // letting the chip's radius + overflow:hidden round the corners. neutral bg shows
    // only while the image loads.
    return (
      <div style={{ ...base, background: 'var(--surface-2)' }}>
        <img
          src={src}
          alt={ticker}
          width={size}
          height={size}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={() => setSt({ ticker, idx: idx + 1 })}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        ...base,
        background: 'var(--surface-2)',
        fontWeight: 700,
        fontSize: size * 0.4,
        fontFamily: 'Spectral, serif',
        color: 'var(--ink-2)',
      }}
    >
      {ticker.slice(0, 1)}
    </div>
  );
}

/* ---- toast ---- */
export interface ToastInfo {
  title: string;
  icon?: string;
  hash?: string;
}
export function Toast({ toast }: { toast: ToastInfo | null }) {
  if (!toast) return null;
  const iconKey = (toast.icon ?? 'check') as keyof typeof ICON;
  return (
    <div
      className="fade-up"
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '12px 18px',
        borderRadius: 12,
        background: 'var(--surface-ink)',
        color: 'var(--bg)',
        boxShadow: 'var(--shadow-lg)',
        maxWidth: 'min(92vw, 460px)',
      }}
    >
      <Icon d={ICON[iconKey]} size={17} sw={2} style={{ color: 'var(--accent)', flex: 'none' }} />
      <div style={{ fontSize: 14 }}>
        <div style={{ fontWeight: 600 }}>{toast.title}</div>
        {toast.hash && <div className="mono" style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{toast.hash.slice(0, 22)}…</div>}
      </div>
    </div>
  );
}

/* ---- brand mark ---- */
export function Logo({ light = false, size = 26 }: { light?: boolean; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 7,
        background: light ? 'var(--accent)' : 'var(--ink)',
        display: 'grid',
        placeItems: 'center',
        flex: 'none',
      }}
    >
      <Icon d={ICON.shieldCheck} size={size * 0.62} sw={2} style={{ color: light ? 'var(--surface-ink)' : 'var(--bg)' }} />
    </div>
  );
}

export { css };
