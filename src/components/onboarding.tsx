/* ============================================================
   Equinox — Connect gate + Selective Disclosure KYC onboarding
   ============================================================ */

import { useState } from 'react';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { randCipher } from '../lib/format';
import { Icon, ICON } from '../lib/icons';
import { useScramble } from '../hooks/useScramble';
import { useServices } from '../context/ServiceContext';
import { txErrorMessage } from '../lib/errors';
import { FheSteps, Logo, type Step } from './primitives';

export function ConnectGate() {
  const { openConnectModal } = useConnectModal();
  const glyphs = useScramble(46, true, 110);

  return (
    <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', placeItems: 'center', padding: 24 }}>
      <div
        className="gate-grid"
        style={{
          width: '100%',
          maxWidth: 1080,
          display: 'grid',
          gridTemplateColumns: '1.05fr 0.95fr',
          gap: 0,
          borderRadius: 22,
          overflow: 'hidden',
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid var(--line)',
        }}
      >
        {/* left: brand */}
        <div
          style={{
            background: 'var(--surface-ink)',
            color: 'var(--bg)',
            padding: 'clamp(32px, 5vw, 56px)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            position: 'relative',
            overflow: 'hidden',
            minHeight: 540,
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              opacity: 0.06,
              fontFamily: 'IBM Plex Mono, monospace',
              fontSize: 12,
              lineHeight: 1.5,
              wordBreak: 'break-all',
              padding: 24,
              color: 'var(--accent)',
              userSelect: 'none',
            }}
          >
            {Array.from({ length: 40 }).map((_, i) => (
              <span key={i}>{randCipher(60)} </span>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <Logo light />
              <div style={{ fontFamily: 'Spectral, serif', fontSize: 21, fontWeight: 500, letterSpacing: '-0.01em' }}>Equinox</div>
            </div>
          </div>
          <div style={{ position: 'relative' }}>
            <div style={{ fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.6, marginBottom: 16 }}>
              Confidential Equities Lending Primitive
            </div>
            <h1 className="serif" style={{ fontSize: 'clamp(30px, 4.2vw, 46px)', fontWeight: 400, lineHeight: 1.08, letterSpacing: '-0.02em' }}>
              Borrow against your<br />tokenized equities —<br />
              <span style={{ fontStyle: 'italic', color: 'var(--accent)' }}>without revealing</span> them.
            </h1>
            <p style={{ marginTop: 18, fontSize: 15, lineHeight: 1.6, opacity: 0.72, maxWidth: 420 }}>
              Collateral balances, debt, and credit limits are computed under fully homomorphic encryption on Arbitrum.
              Liquidations stay permissionless — your portfolio stays private.
            </p>
          </div>
          <div style={{ position: 'relative', display: 'flex', gap: 22, fontSize: 12, opacity: 0.6 }}>
            <span>FHE · Fhenix CoFHE</span>
            <span>Arbitrum Sepolia</span>
            <span>MEV-resistant</span>
          </div>
        </div>

        {/* right: connect */}
        <div style={{ background: 'var(--surface)', padding: 'clamp(32px, 5vw, 56px)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div className="eyebrow">Step 1 of 2 · Connect</div>
          <h2 className="serif" style={{ fontSize: 27, fontWeight: 500, margin: '12px 0 8px' }}>Connect your wallet</h2>
          <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.55, marginBottom: 26 }}>
            Equinox never custodies funds. Your client encrypts every sensitive value locally before it touches the chain.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button className="btn btn-primary btn-lg" onClick={() => openConnectModal?.()}>
              <Icon d={ICON.wallet} size={17} /> Connect wallet
            </button>
            <button className="btn btn-lg" onClick={() => openConnectModal?.()}>
              <Icon d={ICON.link} size={17} /> WalletConnect &amp; more
            </button>
          </div>
          <div
            className="mono"
            style={{
              marginTop: 26,
              padding: 14,
              borderRadius: 11,
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              fontSize: 12,
              color: 'var(--ink-3)',
              wordBreak: 'break-all',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--ink-2)', marginBottom: 6 }}>
              <span>network</span>
              <span style={{ color: 'var(--accent)' }}>● Arbitrum Sepolia · 421614</span>
            </div>
            session_pubkey 0x{glyphs.slice(0, 40)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Selective Disclosure KYC ---------- */
export function KycFlow({ onDone }: { onDone: () => void }) {
  const { equinox } = useServices();
  const [stage, setStage] = useState(0); // 0 intro, 1 attest, 2 signing, 3 done, 4 error
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sigGlyph = useScramble(64, stage === 2, 70);

  const steps: Step[] = [
    { label: 'Hash identity attestation', detail: 'keccak256(passport ‖ jurisdiction ‖ nonce)' },
    { label: 'Encrypt signature client-side', detail: '@cofhe/sdk · ebool sealInput()' },
    { label: 'Submit to KYCRegistry', detail: 'verifyEncryptedSig(ebool) → store' },
    { label: 'On-chain attestation confirmed', detail: 'status kept private as ebool' },
  ];

  const runSign = async () => {
    setError(null);
    setStage(2);
    setActive(0);
    try {
      // progress is driven by the real flow: encrypt → register tx → initBlinding tx
      await equinox.submitKyc({ jurisdiction: 'US · accredited', consent: true }, (step) => setActive(step));
      setActive(steps.length);
      setStage(3);
    } catch (e) {
      setError(txErrorMessage(e));
      setStage(4);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card fade-up" style={{ width: '100%', maxWidth: 560, padding: 'clamp(28px, 4vw, 44px)', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
          <Logo /> <span style={{ fontWeight: 600 }}>Equinox</span>
          <span className="grow"></span>
          <span className="eyebrow">Step 2 of 2 · Verify</span>
        </div>

        {stage < 2 && (
          <div className="fade-up">
            <div style={{ width: 56, height: 56, borderRadius: 14, background: 'var(--accent-soft)', display: 'grid', placeItems: 'center', marginBottom: 18 }}>
              <Icon d={ICON.fingerprint} size={28} sw={1.5} style={{ color: 'var(--accent)' }} />
            </div>
            <h2 className="serif" style={{ fontSize: 26, fontWeight: 500, marginBottom: 8 }}>Selective Disclosure KYC</h2>
            <p style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              Tokenized securities require identity verification. Equinox proves your eligibility
              <strong style={{ color: 'var(--ink)' }}> without publishing it</strong> — your signature is encrypted in-browser and stored as an{' '}
              <span className="mono" style={{ color: 'var(--accent)' }}>ebool</span>. The chain confirms you passed; no one can read who you are.
            </p>
            <div style={{ margin: '22px 0', display: 'grid', gap: 1, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)' }}>
              {[
                ['Verified jurisdiction', 'United States · accredited'],
                ['Disclosed to public', 'Nothing — status is a sealed boolean'],
                ['Disclosed to Equinox', 'Signature validity only'],
              ].map(([k, v], i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '12px 15px', background: 'var(--surface-2)', fontSize: 13 }}>
                  <span style={{ color: 'var(--ink-3)' }}>{k}</span>
                  <span style={{ fontWeight: 500, textAlign: 'right' }}>{v}</span>
                </div>
              ))}
            </div>
            <label style={{ display: 'flex', gap: 11, alignItems: 'flex-start', fontSize: 13, color: 'var(--ink-2)', cursor: 'pointer', marginBottom: 22 }}>
              <input
                type="checkbox"
                checked={stage === 1}
                onChange={(e) => setStage(e.target.checked ? 1 : 0)}
                style={{ marginTop: 2, width: 16, height: 16, accentColor: 'var(--accent)' }}
              />
              I consent to client-side encryption of my identity attestation under the protocol terms.
            </label>
            <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={stage !== 1} onClick={runSign}>
              <Icon d={ICON.key} size={16} /> Sign & encrypt attestation
            </button>
          </div>
        )}

        {stage === 2 && (
          <div className="fade-up">
            <h2 className="serif" style={{ fontSize: 24, fontWeight: 500, marginBottom: 4 }}>Encrypting your attestation…</h2>
            <p style={{ fontSize: 14, color: 'var(--ink-3)', marginBottom: 24 }}>Confirm the request(s) in your wallet — sensitive values are encrypted locally before they touch the chain.</p>
            <FheSteps steps={steps} active={active} />
            <div
              className="mono"
              style={{
                marginTop: 22,
                padding: 13,
                borderRadius: 10,
                background: 'var(--surface-2)',
                border: '1px solid var(--line)',
                fontSize: 12,
                color: 'var(--accent)',
                wordBreak: 'break-all',
                maxHeight: 64,
                overflow: 'hidden',
              }}
            >
              ebool.sig = 0x{sigGlyph}
            </div>
          </div>
        )}

        {stage === 3 && (
          <div className="fade-up" style={{ textAlign: 'center', padding: '12px 0' }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: 'var(--positive-soft)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 18px',
                animation: 'pulseRing 1.6s ease-out',
              }}
            >
              <Icon d={ICON.shieldCheck} size={32} sw={1.8} style={{ color: 'var(--positive)' }} />
            </div>
            <h2 className="serif" style={{ fontSize: 27, fontWeight: 500, marginBottom: 8 }}>You're verified — privately</h2>
            <p style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.6, maxWidth: 380, margin: '0 auto 26px' }}>
              Your KYC status is now a sealed <span className="mono" style={{ color: 'var(--accent)' }}>ebool</span> on-chain. You can deposit
              collateral and borrow confidentially.
            </p>
            <button className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={onDone}>
              Enter Equinox <Icon d={ICON.arrowR} size={16} />
            </button>
          </div>
        )}

        {stage === 4 && (
          <div className="fade-up" style={{ textAlign: 'center', padding: '12px 0' }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: 'var(--danger-soft)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 18px',
              }}
            >
              <Icon d={ICON.alert} size={30} sw={1.8} style={{ color: 'var(--danger)' }} />
            </div>
            <h2 className="serif" style={{ fontSize: 24, fontWeight: 500, marginBottom: 8 }}>Verification failed</h2>
            <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.6, maxWidth: 400, margin: '0 auto 24px' }}>{error}</p>
            <button
              className="btn btn-primary btn-lg"
              style={{ width: '100%' }}
              onClick={() => {
                setError(null);
                setActive(0);
                setStage(1);
              }}
            >
              <Icon d={ICON.refresh} size={16} /> Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
