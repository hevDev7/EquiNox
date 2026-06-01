/* ============================================================
   Equinox — app shell: top nav + borrower sidebar + footer
   ============================================================ */

import { type CSSProperties, type ReactNode } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Icon, ICON } from '../lib/icons';
import type { BorrowerTab, Mode } from '../types';
import { Logo } from './primitives';

export function AppShell({
  mode,
  setMode,
  tab,
  setTab,
  weekend,
  address,
  children,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
  tab: BorrowerTab;
  setTab: (t: BorrowerTab) => void;
  weekend: boolean;
  address: string;
  children: ReactNode;
}) {
  const borrowerNav: [BorrowerTab, string, string | readonly string[]][] = [
    ['dashboard', 'Dashboard', ICON.chart],
    ['portfolio', 'Portfolio', ICON.vault],
    ['borrow', 'Borrow', ICON.arrowDown],
    ['repay', 'Repay & unwrap', ICON.refresh],
    ['liquidity', 'Liquidity', ICON.wallet],
    ['faucet', 'Faucet', ICON.plus],
  ];
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* top bar */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 90,
          background: 'color-mix(in oklch, var(--bg) 86%, transparent)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '0 clamp(16px, 3vw, 28px)', height: 62, display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Logo /> <span className="serif" style={{ fontWeight: 600, fontSize: 17 }}>Equinox</span>
          </div>
          <span className="grow"></span>
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      {/* body */}
      <div
        className="app-body"
        style={{
          maxWidth: 1240,
          width: '100%',
          margin: '0 auto',
          padding: 'clamp(20px, 3vw, 34px) clamp(16px, 3vw, 28px)',
          display: 'grid',
          gridTemplateColumns: '210px 1fr',
          gap: 'clamp(20px, 3vw, 34px)',
          flex: 1,
        }}
      >
        <nav className="side-nav">
          <div style={{ position: 'sticky', top: 86, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {borrowerNav.map(([id, label, ic]) => {
              const active = mode === 'borrower' && tab === id;
              return (
                <button key={id} onClick={() => { setMode('borrower'); setTab(id); }} style={navItemStyle(active)}>
                  <Icon d={ic} size={16} style={{ color: active ? 'var(--accent)' : 'var(--ink-faint)' }} /> {label}
                  {id === 'borrow' && weekend && <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: 9, background: 'var(--warn)' }} />}
                </button>
              );
            })}

            {/* liquidator / searcher role shares the same left rail */}
            <button
              onClick={() => setMode('liquidator')}
              style={navItemStyle(mode === 'liquidator')}
            >
              <Icon d={ICON.scale} size={16} style={{ color: mode === 'liquidator' ? 'var(--accent)' : 'var(--ink-faint)' }} /> Liquidate
            </button>

            <div className="card" style={{ marginTop: 16, padding: 14 }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>HCU budget</div>
              <div className="track">
                <span style={{ width: '34%' }} />
              </div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 8 }}>1.7M / 5.0M per tx</div>
            </div>
          </div>
        </nav>
        <main style={{ minWidth: 0 }}>{children}</main>
      </div>

      <AppFooter />
    </div>
  );
}

function navItemStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '10px 13px',
    borderRadius: 10,
    textAlign: 'left',
    fontSize: 14,
    fontWeight: active ? 600 : 500,
    color: active ? 'var(--ink)' : 'var(--ink-3)',
    background: active ? 'var(--surface-2)' : 'transparent',
    border: `1px solid ${active ? 'var(--line)' : 'transparent'}`,
  };
}

function AppFooter() {
  return (
    <footer style={{ borderTop: '1px solid var(--line)', marginTop: 12 }}>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '22px clamp(16px, 3vw, 28px)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Logo size={22} />
          <span className="serif" style={{ fontWeight: 600, fontSize: 15 }}>Equinox</span>
          <span style={{ fontSize: 13, color: 'var(--ink-3)', marginLeft: 6 }}>Confidential Equities Lending Primitive</span>
        </div>
        <span className="grow"></span>
        <nav style={{ display: 'flex', gap: 20, fontSize: 13, color: 'var(--ink-2)', flexWrap: 'wrap' }}>
          {['Docs', 'Contracts', 'Audit', 'Risk', 'Terms'].map((l) => (
            <a key={l} href="#" style={{ transition: 'color 0.15s' }}>
              {l}
            </a>
          ))}
        </nav>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--ink-3)' }}>
          <Icon d={ICON.lock} size={12} sw={2} style={{ color: 'var(--accent)' }} />
          Encrypted by Fhenix CoFHE
        </span>
      </div>
    </footer>
  );
}
