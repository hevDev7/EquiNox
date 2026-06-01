/* ============================================================
   Equinox — self-contained Tweaks panel (theme / privacy / density / demo).
   A standalone port of the design-host panel: no postMessage protocol,
   just a floating toggle + segmented controls bound to App tweak state.
   ============================================================ */

import { useState, type ReactNode } from 'react';
import { Icon, ICON } from '../lib/icons';
import type { AccentName, Tweaks } from '../types';

const ACCENT_HUE: Record<AccentName, number> = { Teal: 190, Violet: 282, Cobalt: 255 };

const PANEL_STYLE = `
  .twk-fab{position:fixed;right:16px;bottom:16px;z-index:2147483645;width:42px;height:42px;
    border-radius:12px;display:grid;place-items:center;background:var(--surface);
    border:1px solid var(--line-2);box-shadow:var(--shadow);color:var(--ink-2)}
  .twk-fab:hover{color:var(--accent);border-color:var(--accent-line)}
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:276px;
    display:flex;flex-direction:column;background:var(--surface);color:var(--ink);
    border:1px solid var(--line-2);border-radius:14px;box-shadow:var(--shadow-lg);
    font:12px/1.4 'Hanken Grotesk',system-ui,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:11px 10px 11px 14px;border-bottom:1px solid var(--line)}
  .twk-hd b{font-size:12.5px;font-weight:600}
  .twk-body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:11px}
  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
    color:var(--ink-3);padding-top:4px}
  .twk-sect:first-child{padding-top:0}
  .twk-lbl{font-weight:500;color:var(--ink-2);margin-bottom:5px}
  .twk-seg{display:flex;gap:3px;padding:3px;border-radius:9px;background:var(--surface-2);
    border:1px solid var(--line)}
  .twk-seg button{flex:1;border:0;background:transparent;color:var(--ink-3);font:inherit;
    font-weight:600;padding:5px 4px;border-radius:6px;text-transform:capitalize}
  .twk-seg button[data-on="1"]{background:var(--surface);color:var(--ink);
    box-shadow:var(--shadow-sm);border:1px solid var(--line-2)}
  .twk-chips{display:flex;gap:7px}
  .twk-chip{flex:1;height:30px;border-radius:8px;border:1px solid var(--line-2);cursor:pointer}
  .twk-chip[data-on="1"]{box-shadow:0 0 0 2px var(--ink);border-color:var(--ink)}
  .twk-row-h{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .twk-toggle{position:relative;width:34px;height:20px;border:0;border-radius:999px;
    background:var(--line-2);transition:background .15s;padding:0}
  .twk-toggle[data-on="1"]{background:var(--positive)}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}
  .twk-hint{font-size:11px;color:var(--ink-3);line-height:1.4;margin-top:-2px}
`;

function Section({ label }: { label: string }) {
  return <div className="twk-sect">{label}</div>;
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div>
      <div className="twk-lbl">{label}</div>
      <div className="twk-seg" role="radiogroup">
        {options.map((o) => (
          <button key={o} type="button" data-on={o === value ? '1' : '0'} onClick={() => onChange(o)}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="twk-row-h">
      <div className="twk-lbl" style={{ marginBottom: 0 }}>{label}</div>
      <button type="button" className="twk-toggle" data-on={value ? '1' : '0'} role="switch" aria-checked={value} onClick={() => onChange(!value)}>
        <i />
      </button>
    </div>
  );
}

export function TweaksPanel({ tweaks, setTweak }: { tweaks: Tweaks; setTweak: <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => void }) {
  const [open, setOpen] = useState(false);

  const panel: ReactNode = (
    <div className="twk-panel">
      <div className="twk-hd">
        <b>Tweaks</b>
        <button className="btn btn-sm btn-ghost" style={{ padding: 5 }} aria-label="Close tweaks" onClick={() => setOpen(false)}>
          <Icon d={ICON.x} size={15} />
        </button>
      </div>
      <div className="twk-body">
        <Section label="Theme" />
        <Seg label="Palette" value={tweaks.theme} options={['sterling', 'obsidian', 'vellum'] as const} onChange={(v) => setTweak('theme', v)} />
        <div>
          <div className="twk-lbl">Privacy accent</div>
          <div className="twk-chips" role="radiogroup">
            {(Object.keys(ACCENT_HUE) as AccentName[]).map((name) => (
              <button
                key={name}
                type="button"
                className="twk-chip"
                title={name}
                aria-label={name}
                data-on={tweaks.accent === name ? '1' : '0'}
                style={{ background: `oklch(0.6 0.13 ${ACCENT_HUE[name]})` }}
                onClick={() => setTweak('accent', name)}
              />
            ))}
          </div>
        </div>

        <Section label="Privacy display" />
        <Seg label="Sealed values" value={tweaks.privacyMode} options={['cipher', 'decimal', 'redacted'] as const} onChange={(v) => setTweak('privacyMode', v)} />
        <div className="twk-hint">How hidden numbers render before you reveal them.</div>

        <Section label="Layout" />
        <Seg label="Density" value={tweaks.density} options={['compact', 'regular', 'comfy'] as const} onChange={(v) => setTweak('density', v)} />

        <Section label="Demo" />
        <Toggle label="Force weekend mode" value={tweaks.weekendSim} onChange={(v) => setTweak('weekendSim', v)} />
      </div>
    </div>
  );

  return (
    <>
      <style>{PANEL_STYLE}</style>
      {open ? (
        panel
      ) : (
        <button className="twk-fab" aria-label="Open tweaks" onClick={() => setOpen(true)}>
          <Icon d={ICON.dots} size={18} />
        </button>
      )}
    </>
  );
}
