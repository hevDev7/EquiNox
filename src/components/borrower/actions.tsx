/* ============================================================
   Equinox — Borrower actions: Deposit & Encrypt · Borrow · Repay & Unwrap
   ============================================================ */

import { useState, type ReactNode } from 'react';
import { fmtNum, fmtUSD } from '../../lib/format';
import { Icon, ICON } from '../../lib/icons';
import { PROTOCOL } from '../../lib/protocol';
import { canRepay } from '../../lib/sealed-read';
import type { Asset, Claim, DerivedPosition, Position } from '../../types';
import type { TxHistoryEntry, TxKind } from '../../lib/tx-history';
import type { LiquidityInfo } from '../../services/types';
import { AssetMark, DecimalIndicator, EncTag, SealedValue, type Step } from '../primitives';
import { hfColor } from '../health';
import { TxFlow } from './common';
import { COLLATERAL_ASSETS } from '../../config/assets';

/** Arbitrum Sepolia explorer base (for tx-history links). */
const EXPLORER = 'https://sepolia.arbiscan.io';

/** Compact relative time ("2m ago", "1h ago") for the tx-history list. */
function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Dropdown for choosing which of the 18 dShare collaterals to act on. */
export function AssetSelect({ assetId, onSelect, label = 'Collateral asset', wrapped = false }: { assetId: number; onSelect: (id: number) => void; label?: string; wrapped?: boolean }) {
  // `wrapped` shows the confidential wrapped ticker (fbTSLA …) — used in the unwrap flow to
  // signal these are the SEALED collateral tokens being unwrapped, not the plain dShares.
  const symOf = (a: { sym: string; wrapped: string }) => (wrapped ? a.wrapped : a.sym);
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <div className="eyebrow" style={{ marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid var(--line-2)', borderRadius: 10, background: 'var(--surface)' }}>
        <AssetMark sym={symOf(COLLATERAL_ASSETS[assetId] ?? COLLATERAL_ASSETS[0])} size={26} />
        <select
          value={assetId}
          onChange={(e) => onSelect(Number(e.target.value))}
          style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--ink)', fontSize: 15, fontWeight: 600, outline: 'none', cursor: 'pointer' }}
        >
          {COLLATERAL_ASSETS.map((a) => (
            <option key={a.assetId} value={a.assetId}>{symOf(a)} — {a.name}</option>
          ))}
        </select>
      </div>
    </label>
  );
}

export function ScreenHeader({ eyebrow, title, sub, onBack }: { eyebrow: string; title: string; sub: ReactNode; onBack: () => void }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <button className="btn btn-sm btn-ghost" onClick={onBack} style={{ marginBottom: 14, paddingLeft: 6 }}>
        <Icon d={ICON.arrowR} size={14} style={{ transform: 'rotate(180deg)' }} /> Back to dashboard
      </button>
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="serif" style={{ fontSize: 'clamp(24px, 3vw, 30px)', fontWeight: 500, margin: '5px 0 6px' }}>{title}</h1>
      <p style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.55 }}>{sub}</p>
    </div>
  );
}

function AmountInput({
  value,
  onChange,
  suffix,
  max,
  onMax,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  max?: ReactNode;
  onMax?: () => void;
  label?: string;
}) {
  return (
    <div>
      {label && <div className="eyebrow" style={{ marginBottom: 8 }}>{label}</div>}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <input
          className="field tabnum"
          inputMode="decimal"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
          style={{ fontSize: 26, fontFamily: 'Spectral, serif', fontWeight: 500, paddingRight: 110, height: 64 }}
        />
        <div style={{ position: 'absolute', right: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          {onMax && (
            <button className="btn btn-sm btn-ghost" style={{ padding: '4px 9px', fontSize: 12 }} onClick={onMax}>
              MAX
            </button>
          )}
          <span style={{ fontWeight: 600, color: 'var(--ink-2)' }}>{suffix}</span>
        </div>
      </div>
      {max != null && <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 8 }}>{max}</div>}
    </div>
  );
}

function InfoCard({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="card" style={{ padding: 'calc(22px * var(--pad))' }}>
      {title && <div className="eyebrow" style={{ marginBottom: 14 }}>{title}</div>}
      {children}
    </div>
  );
}

export function KV({ k, v, accent, mono }: { k: ReactNode; v: ReactNode; accent?: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--line)', fontSize: 14 }}>
      <span style={{ color: 'var(--ink-3)' }}>{k}</span>
      <span className={mono ? 'mono' : 'tabnum'} style={{ fontWeight: 600, color: accent || 'var(--ink)', textAlign: 'right' }}>{v}</span>
    </div>
  );
}

/* ---------------- shared transaction-history card (paginated, 10/page) ---------------- */
const TX_META: Record<TxKind, { label: string; usd: boolean; color: string }> = {
  borrow: { label: 'Borrow', usd: true, color: 'var(--accent)' },
  repay: { label: 'Repay', usd: true, color: 'var(--accent-ink)' },
  deposit: { label: 'Deposit', usd: false, color: 'var(--ink-2)' },
  unwrap: { label: 'Unwrap', usd: false, color: 'var(--ink-2)' },
  claim: { label: 'Claim', usd: false, color: 'var(--positive)' },
  provide: { label: 'Supply', usd: true, color: 'var(--positive)' },
  withdraw: { label: 'Withdraw', usd: true, color: 'var(--ink-2)' },
};

/** Paginated tx-history card (max 10 rows/page). `history` is pre-filtered by the caller to the
 *  kinds relevant to its page (newest-first); each row links to the Arbiscan tx. */
export function TxHistory({ history, now, title = 'Transaction history' }: { history: TxHistoryEntry[]; now: number; title?: string }) {
  const PAGE = 10;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(history.length / PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE;
  const visible = history.slice(start, start + PAGE);
  return (
    <InfoCard title={`${title} · ${history.length}`}>
      {history.length === 0 && <div style={{ fontSize: 13, color: 'var(--ink-3)', padding: '8px 0' }}>No transactions yet.</div>}
      {visible.map((h, i) => {
        const m = TX_META[h.kind];
        const wrapped = h.sym ? `fb${h.sym.slice(1)}` : '';
        // show the wrap direction for collateral moves: deposit = dShare→sealed (dTSLA → fbTSLA),
        // unwrap = sealed→dShare (fbTSLA → dTSLA); claim realizes the unwrapped dShares.
        const amt =
          h.kind === 'deposit'
            ? `${fmtNum(h.amount)} ${h.sym} → ${wrapped}`
            : h.kind === 'unwrap'
              ? `${fmtNum(h.amount)} ${wrapped} → ${h.sym}`
              : m.usd
                ? fmtUSD(h.amount)
                : `${fmtNum(h.amount)} ${h.sym ?? ''}`;
        return (
          <div
            key={`${h.txHash}-${start + i}`}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '11px 0', borderBottom: '1px solid var(--line)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span className="pill" style={{ background: 'var(--surface-2)', color: m.color, flex: 'none' }}>{m.label}</span>
              <div style={{ minWidth: 0 }}>
                <div className="tabnum" style={{ fontWeight: 600, fontSize: 14 }}>{amt}</div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{relTime(h.ts, now)}</div>
              </div>
            </div>
            <a className="btn btn-sm btn-ghost" href={`${EXPLORER}/tx/${h.txHash}`} target="_blank" rel="noreferrer" style={{ flex: 'none', gap: 5 }}>
              View <Icon d={ICON.arrowR} size={13} />
            </a>
          </div>
        );
      })}
      {pageCount > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            {start + 1}–{Math.min(start + PAGE, history.length)} of {history.length}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button className="btn btn-sm btn-ghost" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page">
              <Icon d={ICON.arrowR} size={13} style={{ transform: 'rotate(180deg)' }} />
            </button>
            <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)', minWidth: 46, textAlign: 'center' }}>{safePage + 1} / {pageCount}</span>
            <button className="btn btn-sm btn-ghost" disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} aria-label="Next page">
              <Icon d={ICON.arrowR} size={13} />
            </button>
          </div>
        </div>
      )}
    </InfoCard>
  );
}

/* ---------------- FAUCET (testnet) ---------------- */
export function FaucetScreen({ pos, asset, activeAssetId, onSelectAsset, onMint, onMintUsdc }: { pos: Position; asset: Asset; activeAssetId: number; onSelectAsset: (id: number) => void; onMint: (n: number) => Promise<void>; onMintUsdc: (n: number) => Promise<void> }) {
  const [amt, setAmt] = useState('1000');
  const [open, setOpen] = useState(false);
  const [usdcAmt, setUsdcAmt] = useState('10000');
  const [usdcBusy, setUsdcBusy] = useState(false);
  const n = parseFloat(amt) || 0;
  const usdcN = parseFloat(usdcAmt) || 0;
  const wallet = pos.walletShares[asset.sym] ?? 0;
  const valid = n > 0;
  const mintUsdc = async () => {
    if (usdcN <= 0 || usdcBusy) return;
    setUsdcBusy(true);
    try { await onMintUsdc(usdcN); } finally { setUsdcBusy(false); }
  };
  const steps: Step[] = [{ label: `Mint ${asset.sym} to your wallet`, detail: 'open testnet faucet · mint(you, amount)' }];
  return (
    <div style={{ width: '100%' }}>
      <div className="eyebrow">Testnet</div>
      <h1 className="serif" style={{ fontSize: 'clamp(24px, 3.2vw, 32px)', fontWeight: 500, margin: '4px 0 8px', letterSpacing: '-0.02em' }}>Faucet</h1>
      <p style={{ color: 'var(--ink-2)', fontSize: 15, lineHeight: 1.55 }}>
        Mint any of the <strong style={{ color: 'var(--ink)' }}>18 tokenized-equity dShares</strong> to your wallet for free, then deposit them as encrypted collateral. Testnet only.
      </p>
      <div style={{ display: 'grid', gap: 16, marginTop: 22 }}>
        <InfoCard>
          <AssetSelect assetId={activeAssetId} onSelect={onSelectAsset} label="dShare to mint" />
          <KV k="Your wallet balance" v={`${fmtNum(wallet)} ${asset.sym}`} />
          <div style={{ marginTop: 16 }}>
            <AmountInput
              label="Amount to mint"
              value={amt}
              onChange={setAmt}
              suffix={asset.sym}
              onMax={() => setAmt('10000')}
              max={`Free testnet faucet · ${asset.name}`}
            />
          </div>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 16 }} disabled={!valid} onClick={() => setOpen(true)}>
            <Icon d={ICON.plus} size={16} /> {`Mint ${n ? fmtNum(n) : ''} ${asset.sym}`}
          </button>
        </InfoCard>

        <InfoCard title="Test USDC faucet">
          <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.55, margin: '0 0 14px' }}>
            Borrow / repay / LP-supply use mintable test USDC on Arbitrum Sepolia. Mint some free to fund repayments &amp; liquidity.
          </p>
          <KV k="Your USDC balance" v={`${fmtUSD(pos.walletUSDC)}`} />
          <div style={{ marginTop: 12 }}>
            <AmountInput
              label="Amount to mint"
              value={usdcAmt}
              onChange={setUsdcAmt}
              suffix="USDC"
              onMax={() => setUsdcAmt('100000')}
              max="Free testnet faucet · mintable MockUSDC"
            />
          </div>
          <button className="btn btn-sm" style={{ width: '100%', marginTop: 12 }} disabled={usdcN <= 0 || usdcBusy} onClick={mintUsdc}>
            <Icon d={ICON.plus} size={14} /> {usdcBusy ? 'Minting…' : `Mint ${usdcN ? fmtNum(usdcN) : ''} USDC`}
          </button>
        </InfoCard>
      </div>

      <TxFlow
        open={open}
        title="Mint test tokens"
        steps={steps}
        cta={`Mint ${asset.sym}`}
        onClose={() => setOpen(false)}
        action={() => onMint(n)}
        onDone={() => setOpen(false)}
        summary={<KV k="You receive" v={`${fmtNum(n)} ${asset.sym}`} />}
      />
    </div>
  );
}

/* ---------------- LIQUIDITY (LP supply side) ---------------- */
export function LiquidityScreen({ liq, history, now, onProvide, onWithdraw }: { liq: LiquidityInfo; history: TxHistoryEntry[]; now: number; onProvide: (n: number) => Promise<void>; onWithdraw: (n: number) => Promise<void> }) {
  const [mode, setMode] = useState<'supply' | 'withdraw'>('supply');
  const [amt, setAmt] = useState('');
  const [open, setOpen] = useState(false);
  const n = parseFloat(amt) || 0;
  const isSupply = mode === 'supply';
  const valid = n > 0 && (isSupply ? true : n <= liq.myShares);
  const steps: Step[] = isSupply
    ? [
        { label: 'Approve USDC', detail: 'USDC.approve(pool, amount)' },
        { label: 'Provide liquidity', detail: 'provideLiquidity(amount) · public test USDC' },
      ]
    : [{ label: 'Withdraw liquidity', detail: 'withdrawLiquidity(amount) → USDC to your wallet' }];

  const Seg = ({ id, label }: { id: 'supply' | 'withdraw'; label: string }) => (
    <button
      onClick={() => { setMode(id); setAmt(''); }}
      className="btn btn-sm"
      style={{
        flex: 1,
        background: mode === id ? 'var(--surface)' : 'transparent',
        border: mode === id ? '1px solid var(--line-2)' : '1px solid transparent',
        boxShadow: mode === id ? 'var(--shadow-sm)' : 'none',
        color: mode === id ? 'var(--ink)' : 'var(--ink-3)',
        fontWeight: mode === id ? 600 : 500,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ width: '100%' }}>
      <div className="eyebrow">Earn</div>
      <h1 className="serif" style={{ fontSize: 'clamp(24px, 3.2vw, 32px)', fontWeight: 500, margin: '4px 0 8px', letterSpacing: '-0.02em' }}>Liquidity</h1>
      <p style={{ color: 'var(--ink-2)', fontSize: 15, lineHeight: 1.55 }}>
        Supply test USDC (mint it free in the Faucet) so borrowers can draw against their encrypted equity collateral. You earn{' '}
        <strong style={{ color: 'var(--accent)' }}>{(liq.supplyApyBps / 100).toFixed(2)}% APR</strong> from borrower interest — your balance grows via the supply index. Withdraw anytime up to the pool&rsquo;s free liquidity.
      </p>
      <div className="action-grid" style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 20, alignItems: 'start', marginTop: 22 }}>
        <InfoCard>
          <div style={{ display: 'inline-flex', gap: 3, padding: 3, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--line)', marginBottom: 18, width: '100%' }}>
            <Seg id="supply" label="Supply" />
            <Seg id="withdraw" label="Withdraw" />
          </div>
          <AmountInput
            value={amt}
            onChange={setAmt}
            suffix="USDC"
            label={isSupply ? 'Amount to supply' : 'Amount to withdraw'}
            onMax={isSupply ? undefined : () => setAmt(String(liq.myShares))}
            max={isSupply ? 'Mintable test USDC — get it free in the Faucet' : `Your supplied: ${fmtNum(liq.myShares)} USDC`}
          />
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 16 }} disabled={!valid} onClick={() => setOpen(true)}>
            <Icon d={isSupply ? ICON.plus : ICON.arrowDown} size={16} />{' '}
            {!isSupply && n > liq.myShares ? 'Exceeds your position' : `${isSupply ? 'Supply' : 'Withdraw'} ${n ? fmtNum(n) : ''} USDC`}
          </button>
        </InfoCard>

        <InfoCard title="Pool">
          <KV k="Supply APR" v={`${(liq.supplyApyBps / 100).toFixed(2)}%`} accent="var(--accent)" />
          <KV k="Borrow APR" v={`${(liq.borrowApyBps / 100).toFixed(2)}%`} />
          <KV k="Utilization" v={`${(liq.utilizationBps / 100).toFixed(1)}%`} />
          <div style={{ margin: '8px 0 14px', height: 6, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, liq.utilizationBps / 100)}%`, background: liq.utilizationBps > 8000 ? 'var(--danger, #d9534f)' : 'var(--accent)', transition: 'width .4s' }} />
          </div>
          <KV k="Available USDC" v={fmtNum(liq.available)} />
          <KV k="Total supplied" v={fmtNum(liq.totalSupplied)} />
          <KV k="Your position" v={`${fmtNum(liq.myShares)} USDC`} accent="var(--accent)" />
          <div style={{ marginTop: 14, fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
            Rates follow a kinked curve — interest rises sharply past <strong style={{ color: 'var(--ink-2)' }}>80% utilization</strong> (the kink), keeping liquidity available for withdrawals.
          </div>
        </InfoCard>
      </div>

      <div style={{ marginTop: 20 }}>
        <TxHistory history={history.filter((h) => h.kind === 'provide' || h.kind === 'withdraw')} now={now} title="Liquidity history" />
      </div>

      <TxFlow
        open={open}
        title={isSupply ? 'Supply USDC' : 'Withdraw USDC'}
        steps={steps}
        onClose={() => setOpen(false)}
        action={() => (isSupply ? onProvide(n) : onWithdraw(n))}
        onDone={() => { setOpen(false); setAmt(''); }}
        cta={`${isSupply ? 'Supply' : 'Withdraw'} ${fmtNum(n)} USDC`}
        summary={<KV k={isSupply ? 'Supplying' : 'Withdrawing'} v={`${fmtNum(n)} USDC`} />}
      />
    </div>
  );
}

/* ---------------- DEPOSIT & WRAP ---------------- */
export function DepositScreen({ pos, asset, activeAssetId, onSelectAsset, onBack, onDeposit, embedded = false, hideHeader = false, onComplete }: { pos: Position; asset: Asset; activeAssetId: number; onSelectAsset: (id: number) => void; onBack?: () => void; onDeposit: (n: number) => Promise<void>; embedded?: boolean; hideHeader?: boolean; onComplete?: () => void }) {
  const [amt, setAmt] = useState('');
  const [open, setOpen] = useState(false);
  const n = parseFloat(amt) || 0;
  const wallet = pos.walletShares[asset.sym] ?? 0;
  const valid = n > 0 && n <= wallet;
  const price = asset.price ?? 0;
  const steps: Step[] = [
    { label: 'Approve & fund shares (plaintext edge)', detail: 'fundShares(amount) → sealed idle credit' },
    { label: 'Encrypt deposit amount client-side', detail: '@cofhe/sdk · CofheEncryptInput' },
    { label: 'Allocate sealed amount to collateral', detail: 'deposit(euint64) · _eCollateral += amount' },
    { label: 'Recompute blinded factors Aᵢ', detail: 'static update · saves HCU' },
  ];
  return (
    <div className="fade-up" id={embedded ? 'eq-deposit' : undefined} style={embedded ? { scrollMarginTop: 86 } : undefined}>
      {hideHeader ? null : embedded ? (
        <div style={{ marginBottom: 22 }}>
          <div className="eyebrow">Collateral</div>
          <h2 className="serif" style={{ fontSize: 'clamp(22px, 2.6vw, 28px)', fontWeight: 500, margin: '5px 0 6px' }}>Deposit &amp; encrypt collateral</h2>
          <p style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.55 }}>
            Deposit standard ERC-20 tokenized shares into the pool, where they become confidential collateral. Your position is sealed as an euint64 — the
            protocol never learns how many shares you hold.
          </p>
        </div>
      ) : (
        <ScreenHeader
          eyebrow="Collateral"
          onBack={onBack ?? (() => {})}
          title="Deposit & encrypt collateral"
          sub="Deposit standard ERC-20 tokenized shares into the pool, where they become confidential collateral. Your position is sealed as an euint64 — the protocol never learns how many shares you hold."
        />
      )}
      <div className="action-grid" style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 20, alignItems: 'start' }}>
        <InfoCard>
          <AssetSelect assetId={activeAssetId} onSelect={onSelectAsset} label="Collateral asset to deposit" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
            <AssetMark sym={asset.sym} size={40} />
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{asset.name}</div>
              <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>{asset.sym} → {asset.wrapped} · {asset.decimals} decimals</div>
            </div>
            <span className="pill">
              <span className="dot" style={{ background: 'var(--positive)' }} /> {fmtUSD(price, 2)}
            </span>
          </div>
          <AmountInput
            value={amt}
            onChange={setAmt}
            suffix={asset.sym}
            onMax={() => setAmt(String(wallet))}
            label="Amount to deposit"
            max={`Wallet balance: ${fmtNum(wallet)} ${asset.sym} (plaintext) · ≈ ${fmtUSD(wallet * price)}`}
          />

          <div style={{ marginTop: 18, display: 'flex', gap: 11, padding: 13, borderRadius: 11, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
            <Icon d={ICON.clock} size={17} style={{ color: 'var(--accent)', flex: 'none', marginTop: 1 }} />
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--ink)' }}>Confidential deposit.</strong> The funded amount is the only public value; you then move a
              <em> sealed</em> amount of your choosing into collateral, so your actual position size stays private.
            </div>
          </div>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 16 }} disabled={!valid} onClick={() => setOpen(true)}>
            <Icon d={ICON.lock} size={16} /> {n > wallet ? 'Insufficient balance' : `Deposit ${n ? fmtNum(n) : ''} ${asset.sym}`}
          </button>
        </InfoCard>

        <InfoCard title="You will receive">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <AssetMark sym={asset.wrapped ?? asset.sym} size={40} />
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{asset.wrapped}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Encrypted collateral</div>
            </div>
            <div className="serif tabnum" style={{ fontSize: 22 }}>{n ? fmtNum(n) : '0'}</div>
          </div>
          <KV k="Collateral value" v={<SealedValue value={fmtUSD(n * price)} len={7} />} />
          <KV k="On-chain (sealed)" v={<DecimalIndicator />} />
          <KV k="Stored as" v="euint64 · _eCollateral" mono accent="var(--accent)" />
          <KV k="New borrow capacity" v={<SealedValue value={fmtUSD(n * price * PROTOCOL.LTV)} len={6} />} />
          <div style={{ marginTop: 14 }}>
            <EncTag label="Position sealed on deposit" />
          </div>
        </InfoCard>
      </div>

      <TxFlow
        open={open}
        title="Deposit & encrypt collateral"
        steps={steps}
        onClose={() => setOpen(false)}
        action={() => onDeposit(n)}
        onDone={() => {
          setOpen(false);
          onComplete?.();
        }}
        cta={`Approve & deposit ${fmtNum(n)} ${asset.sym}`}
        summary={
          <div>
            <KV k="Depositing" v={`${fmtNum(n)} ${asset.sym}`} />
            <KV k="Receiving" v={`${fmtNum(n)} ${asset.wrapped}`} accent="var(--accent)" />
            <KV k="Collateral amount" v="sealed (euint64)" mono />
          </div>
        }
      />
    </div>
  );
}

/* ---------------- DEPOSIT DRAWER (right-side slide-in) ---------------- */
export function DepositDrawer({
  open,
  onClose,
  pos,
  asset,
  activeAssetId,
  onSelectAsset,
  onDeposit,
}: {
  open: boolean;
  onClose: () => void;
  pos: Position;
  asset: Asset;
  activeAssetId: number;
  onSelectAsset: (id: number) => void;
  onDeposit: (n: number) => Promise<void>;
}) {
  return (
    <>
      {/* backdrop */}
      <div
        aria-hidden
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 140,
          background: 'oklch(0.2 0.02 265 / 0.42)',
          backdropFilter: 'blur(3px)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.3s ease',
        }}
      />
      {/* right-side panel */}
      <aside
        role="dialog"
        aria-label="Deposit and encrypt collateral"
        aria-hidden={!open}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 145,
          width: 'min(94vw, 480px)',
          background: 'var(--bg)',
          borderLeft: '1px solid var(--line)',
          boxShadow: 'var(--shadow-lg)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.34s cubic-bezier(0.2,0.7,0.2,1)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '15px 20px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Icon d={ICON.lock} size={16} sw={2} style={{ color: 'var(--accent)' }} />
            <span className="serif" style={{ fontWeight: 600, fontSize: 16 }}>Deposit &amp; encrypt</span>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} style={{ padding: 6 }} aria-label="Close">
            <Icon d={ICON.x} size={16} />
          </button>
        </div>
        <div className="eq-drawer" style={{ overflowY: 'auto', padding: 'clamp(16px, 3vw, 22px)', flex: 1 }}>
          {open && <DepositScreen pos={pos} asset={asset} activeAssetId={activeAssetId} onSelectAsset={onSelectAsset} onDeposit={onDeposit} hideHeader onComplete={onClose} />}
        </div>
      </aside>
    </>
  );
}

/* ---------------- CONFIDENTIAL BORROW ---------------- */
export function BorrowScreen({
  pos,
  der,
  asset,
  weekend,
  history,
  now,
  onBack,
  onBorrow,
}: {
  pos: Position;
  der: DerivedPosition;
  asset: Asset;
  weekend: boolean;
  history: TxHistoryEntry[];
  now: number;
  onBack: () => void;
  onBorrow: (n: number) => Promise<void>;
}) {
  const [amt, setAmt] = useState('');
  const [open, setOpen] = useState(false);
  const n = parseFloat(amt) || 0;
  const exceeds = n > der.remaining;
  const valid = n > 0 && !weekend;
  const price = asset.price ?? 0;
  const steps: Step[] = [
    { label: 'Encrypt borrow request R', detail: 'euint64 R = sealInput(amount)' },
    { label: 'CoFHE evaluates eMaxBorrow', detail: 'FHE.div(FHE.mul(Cᵢ, P·LTV), 1e6)' },
    { label: 'FHE.select gates the draw', detail: 'R ≤ eMaxBorrow ? R : 0  (no revert)' },
    { label: 'Disburse USDC · update limit', detail: 'remaining -= R · sealed' },
  ];
  return (
    <div className="fade-up">
      <ScreenHeader
        eyebrow="Confidential borrow"
        onBack={onBack}
        title="Borrow USDC privately"
        sub="Your borrow request is submitted as ciphertext. CoFHE checks it against your encrypted limit homomorphically — if it exceeds the limit, FHE.select draws 0 instead of reverting, so nothing about your collateral leaks through gas or failure."
      />

      {weekend && (
        <div style={{ display: 'flex', gap: 13, padding: '14px 18px', borderRadius: 13, background: 'var(--warn-soft)', border: '1px solid var(--warn)', marginBottom: 20 }}>
          <Icon d={ICON.alert} size={19} style={{ color: 'var(--warn)', flex: 'none' }} />
          <div style={{ fontSize: 14, color: 'var(--ink-2)' }}>
            <strong style={{ color: 'var(--warn)' }}>Borrowing paused.</strong> Weekend circuit breaker is active until Monday 13:30 UTC to prevent
            stale-price arbitrage.
          </div>
        </div>
      )}

      <div className="action-grid" style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 20, alignItems: 'start' }}>
        <InfoCard>
          <AmountInput
            value={amt}
            onChange={setAmt}
            suffix="USDC"
            onMax={() => setAmt(String(Math.floor(der.remaining)))}
            label="Borrow amount"
            max={
              <>
                Available: <SealedValue value={fmtUSD(der.remaining)} len={6} /> · encrypted limit
              </>
            }
          />
          {exceeds && !weekend && (
            <div style={{ marginTop: 14, display: 'flex', gap: 10, padding: 12, borderRadius: 10, background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', fontSize: 13, color: 'var(--accent-ink)' }}>
              <Icon d={ICON.shield} size={16} style={{ flex: 'none' }} />
              Request exceeds your sealed limit. On-chain, FHE.select will silently disburse <strong>0</strong> — your true limit never appears in the
              revert.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 16 }}>
            {[0.25, 0.5, 1].map((f) => (
              <button key={f} className="btn btn-sm" disabled={weekend} onClick={() => setAmt(String(Math.floor(der.remaining * f)))}>
                {f === 1 ? 'Max' : `${f * 100}%`}
              </button>
            ))}
          </div>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 16 }} disabled={!valid} onClick={() => setOpen(true)}>
            <Icon d={ICON.arrowDown} size={16} /> {weekend ? 'Paused — weekend mode' : `Borrow ${n ? fmtUSD(n) : 'USDC'}`}
          </button>
        </InfoCard>

        <InfoCard title="Position preview">
          <KV k="Health factor now" v={asset.price == null ? '—' : der.hf === Infinity ? '∞' : der.hf.toFixed(2)} accent={asset.price == null ? undefined : hfColor(der.hf)} />
          <KV
            k="Health factor after"
            v={(() => {
              if (asset.price == null) return '—';
              const nd = (pos.debtUSDC + n) * PROTOCOL.interestIndex;
              const h = nd > 0 ? (der.collatValue * der.effLT) / nd : Infinity;
              return <span style={{ color: hfColor(h) }}>{h === Infinity ? '∞' : h.toFixed(2)}</span>;
            })()}
          />
          <KV k="Borrow APR" v="4.8%" />
          <KV k="Liquidation threshold" v={`${(PROTOCOL.LT * 100).toFixed(0)}%${weekend ? ' − 15% haircut' : ''}`} />
          <KV k={`Oracle · ${asset.sym.replace(/^d/, '')}/USD`} v={asset.price == null ? '—' : fmtUSD(price, 2)} mono />
          <div style={{ marginTop: 14, fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }} className="mono">
            Pyth pull-feed · staleness guard 60s · {weekend ? 'weekend haircut applied' : asset.stale ? 'last close' : `${asset.session ?? 'live'} session`}
          </div>
        </InfoCard>
      </div>

      <div style={{ marginTop: 20 }}>
        <TxHistory history={history.filter((h) => h.kind === 'borrow')} now={now} title="Borrow history" />
      </div>

      <TxFlow
        open={open}
        title="Confidential borrow"
        steps={steps}
        onClose={() => setOpen(false)}
        action={() => onBorrow(n)}
        onDone={() => { setOpen(false); setAmt(''); }}
        cta={`Encrypt & request ${fmtUSD(n)}`}
        summary={
          <div>
            <KV k="Requesting (encrypted R)" v={<span className="mono">{fmtUSD(n)}</span>} accent="var(--accent)" />
            <KV k="Outcome" v={exceeds ? 'FHE.select → 0' : 'Approved'} />
            <KV k="Disbursed to wallet" v={exceeds ? '$0 USDC' : `${fmtUSD(n)} USDC`} />
          </div>
        }
      />
    </div>
  );
}

/* ---------------- REPAY & DELAYED UNWRAP ---------------- */
export function RepayScreen({
  pos,
  der,
  asset,
  activeAssetId,
  onSelectAsset,
  claims,
  history,
  now,
  decryptReady,
  onBack,
  onRepay,
  onRequestUnwrap,
  onClaim,
  onRefreshPermit,
}: {
  pos: Position;
  der: DerivedPosition;
  asset: Asset;
  activeAssetId: number;
  onSelectAsset: (id: number) => void;
  claims: Claim[];
  history: TxHistoryEntry[];
  now: number;
  /** true once a claim's decrypt is cached → gate the Claim button so the tx pops instantly. */
  decryptReady: (id: string) => boolean;
  onBack: () => void;
  onRepay: (n: number) => Promise<void>;
  onRequestUnwrap: (n: number, assetId: number) => Promise<void>;
  onClaim: (id: string) => Promise<void>;
  onRefreshPermit?: () => Promise<void>;
}) {
  const [tab, setTab] = useState<'repay' | 'unwrap'>('repay');
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [amt, setAmt] = useState('');
  const [open, setOpen] = useState<false | 'repay' | 'unwrap'>(false);
  const [refreshing, setRefreshing] = useState(false);
  const n = parseFloat(amt) || 0;
  // sealed debt couldn't be decrypted → the displayed 0 is NOT the real debt.
  const debtUnknown = !!pos.debtUnknown;

  const repaySteps: Step[] = [
    { label: 'Approve USDC repayment', detail: 'ERC20.approve(pool, amount)' },
    { label: 'Pool burns debt · updates Bᵢ', detail: 'Dᵢ -= amount · static factor update' },
  ];
  const unwrapSteps: Step[] = [
    { label: 'Submit unwrap · health gate', detail: 'withdrawCollateral(assetId, euint64)' },
    { label: 'Record claim hash', detail: 'claims[hash] = pending' },
    { label: 'Threshold decryption queued', detail: 'CoFHE · resolves in a few blocks' },
  ];
  const validRepay = canRepay(n, pos.debtUSDC, debtUnknown);
  // per-asset: only the collateral held in the SELECTED asset is unwrappable here.
  const maxUnwrap = pos.collateral.find((c) => c.under === asset.sym)?.shares ?? 0;
  const validUnwrap = n > 0 && n <= maxUnwrap;

  return (
    <div className="fade-up">
      <ScreenHeader
        eyebrow="Repay & unwrap"
        onBack={onBack}
        title="Repay debt & release collateral"
        sub="Pay down USDC to free your encrypted shares. Because FHE unwrapping needs threshold decryption that takes a few blocks, withdrawals use a claim-based pattern: request now, then claim your plaintext ERC-20 shares once the coprocessor finishes."
      />

      <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 11, background: 'var(--surface-2)', border: '1px solid var(--line)', marginBottom: 20 }}>
        {([['repay', 'Repay debt'], ['unwrap', 'Request unwrap']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setAmt('');
            }}
            className="btn btn-sm"
            style={{
              background: tab === id ? 'var(--surface)' : 'transparent',
              border: tab === id ? '1px solid var(--line-2)' : '1px solid transparent',
              boxShadow: tab === id ? 'var(--shadow-sm)' : 'none',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="action-grid" style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 20, alignItems: 'start' }}>
        <InfoCard>
          {tab === 'repay' ? (
            <>
              {debtUnknown && (
                <div style={{ display: 'flex', gap: 11, padding: 13, marginBottom: 14, borderRadius: 11, background: 'color-mix(in srgb, var(--danger) 9%, var(--surface-2))', border: '1px solid color-mix(in srgb, var(--danger) 35%, var(--line))' }}>
                  <Icon d={ICON.alert} size={17} style={{ color: 'var(--danger)', flex: 'none', marginTop: 1 }} />
                  <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                    <strong style={{ color: 'var(--ink)' }}>Debt could not be decrypted.</strong> Your encrypted debt is on-chain but
                    the client couldn’t read it (likely a stale permit). The amount below is <strong>not 0</strong> — don’t treat it as repaid.
                    Refresh the permit, or just enter an amount: the contract caps the repayment to your real debt.
                    {onRefreshPermit && (
                      <button
                        className="btn btn-sm"
                        style={{ marginTop: 10 }}
                        disabled={refreshing}
                        onClick={async () => { setRefreshing(true); try { await onRefreshPermit(); } finally { setRefreshing(false); } }}
                      >
                        <Icon d={ICON.refresh} size={13} /> {refreshing ? 'Refreshing…' : 'Refresh permit & re-read'}
                      </button>
                    )}
                  </div>
                </div>
              )}
              <AmountInput
                value={amt}
                onChange={setAmt}
                suffix="USDC"
                onMax={() => setAmt(debtUnknown ? '' : String(pos.debtUSDC))}
                label="Repay amount"
                max={
                  <>
                    Outstanding debt:{' '}
                    {debtUnknown ? (
                      <span style={{ color: 'var(--danger)' }}>encrypted · unreadable</span>
                    ) : (
                      <SealedValue value={fmtUSD(pos.debtUSDC)} len={6} />
                    )}{' '}
                    · wallet {fmtUSD(pos.walletUSDC)} USDC
                  </>
                }
              />
              <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 18 }} disabled={!validRepay} onClick={() => setOpen('repay')}>
                <Icon d={ICON.check} size={16} /> Repay {n ? fmtUSD(n) : 'USDC'}
              </button>
            </>
          ) : (
            <>
              <AssetSelect assetId={activeAssetId} onSelect={(id) => { onSelectAsset(id); setAmt(''); }} label="Wrapped collateral to unwrap" wrapped />
              <AmountInput
                value={amt}
                onChange={setAmt}
                suffix={asset.wrapped ?? asset.sym}
                onMax={() => setAmt(String(maxUnwrap))}
                label={`${asset.wrapped ?? asset.sym} to unwrap`}
                max={
                  <>
                    Held as {asset.wrapped ?? asset.sym}: <SealedValue value={`${fmtNum(maxUnwrap)} sh`} len={5} />
                  </>
                }
              />
              <div style={{ marginTop: 14, display: 'flex', gap: 11, padding: 13, borderRadius: 11, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
                <Icon d={ICON.clock} size={17} style={{ color: 'var(--accent)', flex: 'none', marginTop: 1 }} />
                <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                  <strong style={{ color: 'var(--ink)' }}>Health-gated &amp; delayed.</strong> The pool only releases collateral that keeps your position
                  safe — a request beyond that draws 0 (repay first to free more). The coprocessor then decrypts the freed amount over a
                  few blocks; return to claim your plaintext {asset.sym}.
                </div>
              </div>
              <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 16 }} disabled={!validUnwrap} onClick={() => setOpen('unwrap')}>
                <Icon d={ICON.lock} size={16} /> Request unwrap of {n ? fmtNum(n) : ''} {asset.wrapped ?? asset.sym}
              </button>
            </>
          )}
        </InfoCard>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <InfoCard title="Position">
            <KV k="Collateral" v={<SealedValue value={`${fmtNum(der.collatShares)} sh`} len={5} />} />
            <KV
              k="Debt"
              v={debtUnknown ? <span style={{ color: 'var(--danger)' }}>unreadable</span> : <SealedValue value={fmtUSD(der.debt)} len={6} />}
            />
            <KV k="Health factor" v={debtUnknown ? '—' : der.hf === Infinity ? '∞' : der.hf.toFixed(2)} accent={debtUnknown ? undefined : hfColor(der.hf)} />
          </InfoCard>

          <InfoCard title={`Pending unwrap claims · ${claims.length}`}>
            {claims.length === 0 && <div style={{ fontSize: 13, color: 'var(--ink-3)', padding: '8px 0' }}>No pending claims.</div>}
            {claims.map((c) => {
              // ready ONLY when the threshold-decrypt has actually finished (proof cached) so
              // clicking Claim pops MetaMask instantly — not after a 1-2 min on-click decrypt.
              // Safety fallback: reveal the button anyway well past readyAt so a stuck warm never
              // blocks the user (claimUnwrapped then decrypts on demand).
              const ready = (decryptReady(c.id) && now >= c.readyAt) || now >= c.readyAt + 180_000;
              const pct = Math.min(100, ((now - c.requestedAt) / (c.readyAt - c.requestedAt)) * 100);
              return (
                <div key={c.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>
                        {fmtNum(c.shares)} {c.under}
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{c.hash.slice(0, 16)}…</div>
                    </div>
                    {ready ? (
                      <button
                        className="btn btn-sm btn-accent"
                        disabled={claimingId === c.id}
                        onClick={async () => {
                          setClaimingId(c.id);
                          try {
                            await onClaim(c.id);
                          } finally {
                            setClaimingId(null);
                          }
                        }}
                      >
                        {claimingId === c.id ? (
                          <>
                            <span className="spinner" style={{ width: 11, height: 11 }} /> Claiming…
                          </>
                        ) : (
                          'Claim'
                        )}
                      </button>
                    ) : (
                      <span className="pill pill-accent">
                        <span className="spinner" style={{ width: 11, height: 11 }} /> decrypting
                      </span>
                    )}
                  </div>
                  {!ready && (
                    <div className="track">
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </InfoCard>

          <TxHistory history={history.filter((h) => h.kind === 'repay' || h.kind === 'unwrap' || h.kind === 'claim')} now={now} title="Repay & unwrap history" />
        </div>
      </div>

      <TxFlow
        open={open === 'repay'}
        title="Repay debt"
        steps={repaySteps}
        onClose={() => setOpen(false)}
        action={() => onRepay(n)}
        onDone={() => setOpen(false)}
        cta={`Repay ${fmtUSD(n)}`}
        summary={
          <div>
            <KV k="Repaying" v={fmtUSD(n)} />
            <KV k="Debt after" v={<SealedValue value={fmtUSD(Math.max(0, pos.debtUSDC - n) * PROTOCOL.interestIndex)} len={6} />} />
          </div>
        }
      />

      <TxFlow
        open={open === 'unwrap'}
        title="Request unwrap"
        steps={unwrapSteps}
        onClose={() => setOpen(false)}
        action={() => onRequestUnwrap(n, activeAssetId)}
        onDone={() => setOpen(false)}
        cta={`Request unwrap`}
        summary={
          <div>
            <KV k="Unwrapping" v={`${fmtNum(n)} ${asset.wrapped ?? asset.sym}`} />
            <KV k="Receive" v={asset.sym} />
            <KV k="Release" v="health-gated" mono accent="var(--accent)" />
            <KV k="Claimable in" v="~3 blocks" mono accent="var(--accent)" />
          </div>
        }
      />
    </div>
  );
}
