/* ============================================================
   Equinox — app shell: phase routing, state, service-backed actions.
   Wallet connection is handled by wagmi + RainbowKit.
   ============================================================ */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useAccount } from 'wagmi';
import type { AccentName, AssetMap, BorrowerTab, Claim, Mode, Phase, Position, ThemeName, Tweaks } from './types';
import { ASSETS, INITIAL_POSITION, EMPTY_POSITION } from './lib/mock-data';
import { USE_REAL_CHAIN } from './config/contracts';
import { COLLATERAL_ASSETS, ASSET_BY_ID, ASSET_BY_SYM, DEFAULT_ASSET_ID } from './config/assets';
import { derivePosition, isWeekendMode } from './lib/protocol';
import { streamPythPrices } from './lib/pyth';
import { fmtNum, fmtUSD } from './lib/format';
import { getTxHistory, addTxHistory, type TxHistoryEntry } from './lib/tx-history';
import { useTweaks } from './hooks/useTweaks';
import { TweakCtx } from './context/TweakContext';
import { useServices } from './context/ServiceContext';
import type { PositionSnapshot } from './services/types';
import { shortAddress } from './services/mock-wallet';
import { Toast, type ToastInfo } from './components/primitives';
import { ConnectGate, KycFlow } from './components/onboarding';
import { AppShell } from './components/layout';
import { MarketsPanel } from './components/borrower/MarketsPanel';
import { Dashboard } from './components/borrower/Dashboard';
import { BorrowScreen, DepositDrawer, FaucetScreen, LiquidityScreen, RepayScreen } from './components/borrower/actions';
import { LiquidatorConsole } from './components/liquidator';
import { TweaksPanel } from './components/tweaks';

const ACCENT_HUE: Record<AccentName, number> = { Teal: 190, Violet: 282, Cobalt: 255 };

function accentVars(theme: ThemeName, hueName: AccentName): CSSProperties {
  const h = ACCENT_HUE[hueName] ?? 190;
  if (theme === 'obsidian') {
    return {
      '--accent': `oklch(0.745 0.105 ${h})`,
      '--accent-ink': `oklch(0.82 0.10 ${h})`,
      '--accent-soft': `oklch(0.30 0.05 ${h})`,
      '--accent-line': `oklch(0.42 0.07 ${h})`,
    } as CSSProperties;
  }
  return {
    '--accent': `oklch(0.545 0.105 ${h})`,
    '--accent-ink': `oklch(0.42 0.12 ${h})`,
    '--accent-soft': `oklch(0.955 0.026 ${h})`,
    '--accent-line': `oklch(0.85 0.055 ${h})`,
  } as CSSProperties;
}

// Seed the asset map WITHOUT demo prices so the dashboard shows a skeleton (not fake
// numbers dressed as live) until the first Pyth fetch lands — mirrors how `pos` starts
// empty in real mode. Metadata (name/decimals/wrapped/addr) is kept for rendering.
const INITIAL_ASSETS: AssetMap = Object.fromEntries(
  Object.entries(ASSETS).map(([sym, a]) => [sym, { ...a, price: undefined, chg: undefined }]),
);

const TWEAK_DEFAULTS: Tweaks = {
  theme: 'sterling',
  accent: 'Teal',
  privacyMode: 'cipher',
  density: 'regular',
  weekendSim: false,
};

export default function App() {
  const { equinox } = useServices();
  const { address, isConnected } = useAccount();
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [phase, setPhase] = useState<Phase>('gate');
  const [mode, setMode] = useState<Mode>('borrower');
  const [tab, setTab] = useState<BorrowerTab>('dashboard');
  // real mode starts EMPTY (no demo numbers flash before the first on-chain fetch); mock shows the demo basket
  const [pos, setPos] = useState<Position>(() => JSON.parse(JSON.stringify(USE_REAL_CHAIN ? EMPTY_POSITION : INITIAL_POSITION)) as Position);
  // REAL on-chain public factors + authoritative HF (null until fetched/settled)
  const [chainFacts, setChainFacts] = useState<{ A: number; B: number; hfBps: number | null } | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [toast, setToast] = useState<ToastInfo | null>(null);
  const [now, setNow] = useState(Date.now());
  const [depositOpen, setDepositOpen] = useState(false);
  const [liveAssets, setLiveAssets] = useState<AssetMap>(INITIAL_ASSETS);
  const [chainIndex, setChainIndex] = useState<number | undefined>(undefined);
  const [liq, setLiq] = useState({ available: 0, totalSupplied: 0, myShares: 0, supplyApyBps: 0, borrowApyBps: 0, utilizationBps: 0 });
  const [weekendChain, setWeekendChain] = useState(false); // contract's isWeekendMode (weekendOverride-aware)
  const [marketTvl, setMarketTvl] = useState<Record<string, number>>({}); // per-market collateral locked (shares) → $ volume
  const [txHistory, setTxHistory] = useState<TxHistoryEntry[]>([]); // local repay/unwrap/claim history (Repay & Unwrap page)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // wallet connection (RainbowKit/wagmi) drives the gate
  useEffect(() => {
    if (isConnected) setPhase((p) => (p === 'gate' ? 'kyc' : p));
    else setPhase('gate');
  }, [isConnected]);

  // live oracle prices (Pyth Hermes) — refreshed every 60s, in both modes
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const prices = await equinox.fetchPrices();
        if (!alive) return;
        setLiveAssets((prev) => {
          const next: AssetMap = { ...prev };
          for (const [sym, p] of Object.entries(prices)) {
            if (next[sym]) next[sym] = { ...next[sym], price: p.price, chg: p.chg, stale: p.stale, asOf: p.asOf, session: p.session, ref24h: p.ref24h };
          }
          return next;
        });
      } catch (e) {
        console.warn('[Equinox] price fetch failed:', e);
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [equinox]);

  // Real-time price stream (Hermes SSE): live ticks between the 60s REST refresh (which also
  // supplies the 24h change). Patches price/asOf/stale/session only — chg stays from REST.
  // Price streaming is a mode-agnostic Pyth concern (same source in mock and real mode).
  useEffect(() => {
    if (phase !== 'app') return;
    return streamPythPrices((updates) => {
      setLiveAssets((prev) => {
        const next: AssetMap = { ...prev };
        for (const [sym, u] of Object.entries(updates)) {
          if (next[sym]) {
            // recompute the 24h change live from the cached ~24h anchor so the dashboard's
            // 24H column ticks WITH the streamed price (not frozen between 60s REST refreshes).
            const ref = next[sym].ref24h;
            next[sym] = {
              ...next[sym],
              price: u.price,
              asOf: u.asOf,
              stale: u.stale,
              session: u.session,
              chg: ref && ref > 0 ? ((u.price - ref) / ref) * 100 : next[sym].chg,
            };
          }
        }
        return next;
      });
    });
  }, [phase]);

  const pushToast = useCallback((tt: ToastInfo) => {
    setToast(tt);
    setTimeout(() => setToast(null), 3600);
  }, []);

  // local tx history for the Repay & Unwrap page (load per address; append on each action)
  useEffect(() => {
    setTxHistory(address ? getTxHistory(address) : []);
  }, [address]);
  const recordTx = useCallback(
    (e: Omit<TxHistoryEntry, 'ts'>) => {
      if (!address) return;
      setTxHistory(addTxHistory(address, { ...e, ts: Date.now() }));
    },
    [address],
  );

  // read the user's REAL on-chain position (no-op in mock mode)
  const applySnapshot = useCallback((snap: PositionSnapshot) => {
    setPos(snap.position);
    setChainIndex(snap.indexBps / 10_000);
    setWeekendChain(snap.weekendOnChain);
    setChainFacts(
      snap.factorA != null && snap.factorB != null
        ? { A: snap.factorA, B: snap.factorB, hfBps: snap.hfBps ?? null }
        : null,
    );
  }, []);

  const refreshPosition = useCallback(async () => {
    if (!USE_REAL_CHAIN || !address) return;
    try {
      applySnapshot(await equinox.fetchPosition(address));
    } catch (e) {
      console.warn('[Equinox] position refresh failed:', e);
    }
  }, [equinox, address, applySnapshot]);

  // Recovery for a failed sealed read (debt shows unknown): rotate the decryption
  // permit and re-read. Surfaces success/failure to the user via a toast.
  const onRefreshPermit = useCallback(async () => {
    if (!USE_REAL_CHAIN || !address) return;
    try {
      const snap = await equinox.refreshDecryptionPermit(address);
      applySnapshot(snap);
      pushToast(
        snap.position.debtUnknown
          ? { title: 'Permit refreshed — debt still unreadable, retry shortly', icon: 'alert' }
          : { title: 'Permit refreshed — position decrypted', icon: 'check' },
      );
    } catch (e) {
      console.warn('[Equinox] permit refresh failed:', e);
      pushToast({ title: 'Permit refresh failed — check wallet connection', icon: 'alert' });
    }
  }, [equinox, address, applySnapshot]);

  // read the USDC liquidity (LP supply side); works in both mock and real mode
  const refreshLiquidity = useCallback(async () => {
    if (!address) return;
    try {
      setLiq(await equinox.fetchLiquidity(address));
    } catch (e) {
      console.warn('[Equinox] liquidity fetch failed:', e);
    }
  }, [equinox, address]);

  // per-market collateral locked (totalFunded), → $ volume on the dashboard; both modes
  const refreshMarketStats = useCallback(async () => {
    try {
      setMarketTvl(await equinox.fetchMarketStats());
    } catch (e) {
      console.warn('[Equinox] market stats fetch failed:', e);
    }
  }, [equinox]);

  // Fire-and-forget UI sync after a confirmed tx (see the borrower-actions note below):
  // post-tx refreshes (incl. FHE decryptForView reads that can stall on the threshold
  // network) must NEVER gate the TxFlow modal — only the on-chain tx confirmation does.
  const syncState = useCallback(() => {
    void Promise.allSettled([refreshLiquidity(), refreshPosition(), refreshMarketStats()]);
  }, [refreshLiquidity, refreshPosition, refreshMarketStats]);

  // AUDIT #2: finish any borrow payout stranded by a coprocessor outage.
  const recoverPayouts = useCallback(async () => {
    if (!USE_REAL_CHAIN || !address) return;
    try {
      const recovered = await equinox.recoverBorrowPayouts(address);
      if (recovered > 0) {
        pushToast({ title: `Recovered ${fmtUSD(recovered)} stranded borrow payout`, icon: 'check' });
        syncState();
      }
    } catch (e) {
      console.warn('[Equinox] payout recovery deferred:', e);
    }
  }, [equinox, address, pushToast, syncState]);

  // hydrate the position + liquidity from chain on entering the app
  useEffect(() => {
    if (phase === 'app') {
      void refreshPosition();
      void refreshLiquidity();
      void refreshMarketStats();
      void recoverPayouts();
    }
  }, [phase, refreshPosition, refreshLiquidity, refreshMarketStats, recoverPayouts]);

  const realWeekend = useMemo(() => isWeekendMode(new Date(now)), [now]);
  // Real mode: trust the CONTRACT's weekend state (respects the testnet weekendOverride bypass)
  // so borrow isn't blocked by the browser clock; mock mode: client clock. weekendSim still forces it.
  const weekend = (USE_REAL_CHAIN ? weekendChain : realWeekend) || t.weekendSim;
  const [activeAssetId, setActiveAssetId] = useState(DEFAULT_ASSET_ID);
  const activeAsset = ASSET_BY_ID[activeAssetId] ?? COLLATERAL_ASSETS[0];
  const asset = liveAssets[activeAsset.sym] ?? liveAssets.dTSLA;
  const der = useMemo(() => {
    const d = derivePosition(pos, liveAssets, { weekend, index: chainIndex });
    // Real mode: surface the AUTHORITATIVE on-chain values (the public blinded factors the
    // chain actually exposes + the contract's healthFactorBps), not client-side approximations.
    if (USE_REAL_CHAIN && chainFacts) {
      d.A = chainFacts.A;
      d.B = chainFacts.B;
      if (chainFacts.hfBps != null) d.hf = chainFacts.hfBps / 10_000;
    }
    return d;
  }, [pos, weekend, liveAssets, chainIndex, chainFacts]);

  /* ---- borrower actions (service-backed) ----
     The on-chain tx confirmation (bounded in the service) is the SOLE gate for the TxFlow
     modal. Post-tx state refreshes — incl. FHE decryptForView reads that can stall on the
     threshold network — run fire-and-forget so they can NEVER keep the modal open after the
     tx is confirmed. Optimistic setPos above keeps the UI correct until the sync lands. */
  const onDeposit = async (n: number, assetId: number = activeAssetId) => {
    const a = ASSET_BY_ID[assetId] ?? activeAsset;
    const { txHash: hash } = await equinox.deposit(n, assetId);
    // optimistic multi-collateral upsert: bump the matching entry, else append a new one
    setPos((p) => {
      const i = p.collateral.findIndex((c) => c.under === a.sym);
      const collateral =
        i >= 0
          ? p.collateral.map((c, j) => (j === i ? { ...c, shares: c.shares + n } : c))
          : [...p.collateral, { sym: `fb${a.sym.slice(1)}`, under: a.sym, shares: n }];
      return { ...p, collateral, walletShares: { ...p.walletShares, [a.sym]: Math.max(0, (p.walletShares[a.sym] ?? 0) - n) } };
    });
    pushToast({ title: `Deposited ${fmtNum(n)} ${a.sym} as encrypted collateral`, icon: 'lock', hash });
    setTab('portfolio');
    syncState();
  };

  const onMint = async (n: number, assetId: number = activeAssetId) => {
    const a = ASSET_BY_ID[assetId] ?? activeAsset;
    const { txHash: hash } = await equinox.mintDShares(n, assetId);
    setPos((p) => ({ ...p, walletShares: { ...p.walletShares, [a.sym]: (p.walletShares[a.sym] ?? 0) + n } }));
    pushToast({ title: `Minted ${fmtNum(n)} ${a.sym}`, icon: 'plus', hash });
    syncState();
  };

  const onMintUsdc = async (n: number) => {
    const { txHash: hash } = await equinox.mintUsdc(n);
    setPos((p) => ({ ...p, walletUSDC: p.walletUSDC + n }));
    pushToast({ title: `Minted ${fmtUSD(n)} test USDC`, icon: 'plus', hash });
    syncState();
  };

  const onProvideLiquidity = async (n: number) => {
    const { txHash: hash } = await equinox.provideLiquidity(n);
    pushToast({ title: `Supplied ${fmtUSD(n)} USDC liquidity`, icon: 'wallet', hash });
    syncState();
  };

  const onWithdrawLiquidity = async (n: number) => {
    const { txHash: hash } = await equinox.withdrawLiquidity(n);
    pushToast({ title: `Withdrew ${fmtUSD(n)} USDC liquidity`, icon: 'check', hash });
    syncState();
  };

  const onBorrow = async (n: number) => {
    const res = await equinox.borrow(n, der.remaining);
    if (!res.approved || res.disbursed <= 0) {
      pushToast({ title: 'FHE.select drew $0 — limit exceeded, no leak', icon: 'shield' });
      return;
    }
    setPos((p) => ({ ...p, debtUSDC: p.debtUSDC + res.disbursed, walletUSDC: p.walletUSDC + res.disbursed }));
    pushToast({ title: `Borrowed ${fmtUSD(res.disbursed)} USDC confidentially`, icon: 'check', hash: res.txHash });
    setTab('portfolio');
    syncState();
  };

  const onRepay = async (n: number) => {
    const { txHash: hash } = await equinox.repay(n);
    setPos((p) => ({ ...p, debtUSDC: Math.max(0, p.debtUSDC - n), walletUSDC: p.walletUSDC - n }));
    recordTx({ kind: 'repay', amount: n, txHash: hash });
    pushToast({ title: `Repaid ${fmtUSD(n)} USDC`, icon: 'check', hash });
    syncState();
  };

  const onRequestUnwrap = async (n: number, assetId: number) => {
    const sym = (ASSET_BY_ID[assetId] ?? activeAsset).sym;
    const req = await equinox.requestUnwrap(n, assetId);
    setClaims((c) => [...c, { id: req.claimId, under: sym, shares: n, hash: req.hash, requestedAt: Date.now(), readyAt: req.readyAt }]);
    recordTx({ kind: 'unwrap', sym, amount: n, txHash: req.txHash });
    pushToast({ title: `Unwrap requested (${sym}) — claimable in ~3 blocks`, icon: 'clock' });
  };

  const onClaim = async (id: string) => {
    const claim = claims.find((x) => x.id === id);
    if (!claim) return;
    // the freed amount is HF-gated on-chain → use what claimUnwrapped ACTUALLY released (may be 0)
    const { txHash: hash, shares: freed } = await equinox.claimUnwrapped(id, claim.shares);
    // multi-collateral: decrement ONLY the unwrapped asset by the real freed amount, keep others
    setPos((p) => ({
      ...p,
      collateral: p.collateral.map((c) =>
        c.under === claim.under ? { ...c, shares: Math.max(0, c.shares - freed) } : c,
      ),
      walletShares: { ...p.walletShares, [claim.under]: (p.walletShares[claim.under] ?? 0) + freed },
    }));
    setClaims((cs) => cs.filter((x) => x.id !== id));
    if (freed > 0) recordTx({ kind: 'claim', sym: claim.under, amount: freed, txHash: hash });
    pushToast(
      freed > 0
        ? { title: `Claimed ${fmtNum(freed)} ${claim.under}`, icon: 'check', hash }
        : { title: `Health gate: ${claim.under} withdrawal exceeded the safe limit — repay first`, icon: 'alert' },
    );
    syncState();
  };

  // Per-row "Deposit" in MarketsPanel must target the CLICKED dShare, not the default.
  // Select that asset first, THEN open the drawer (the drawer renders `activeAssetId`).
  const openDepositFor = (sym: string) => {
    const id = ASSET_BY_SYM[sym]?.assetId;
    if (id != null) setActiveAssetId(id);
    setDepositOpen(true);
  };

  const rootStyle: CSSProperties = { ...accentVars(t.theme, t.accent), minHeight: '100vh' };
  const rootClass = `theme-${t.theme} density-${t.density}`;
  const display = address ? shortAddress(address) : '0x…';

  return (
    <TweakCtx.Provider value={{ privacyMode: t.privacyMode }}>
      <div className={rootClass} style={rootStyle}>
        {phase === 'gate' && <ConnectGate />}
        {phase === 'kyc' && <KycFlow onDone={() => setPhase('app')} />}
        {phase === 'app' && (
          <AppShell mode={mode} setMode={setMode} tab={tab} setTab={setTab} weekend={weekend} address={display}>
            {mode === 'borrower' ? (
              tab === 'dashboard' ? (
                <MarketsPanel onDeposit={openDepositFor} assets={liveAssets} tvl={marketTvl} />
              ) : tab === 'portfolio' ? (
                <Dashboard
                  pos={pos}
                  der={der}
                  prices={liveAssets}
                  weekend={weekend}
                  weekendSim={t.weekendSim}
                  onToggleWeekend={() => setTweak('weekendSim', false)}
                  go={setTab}
                  asset={asset}
                  onDeposit={() => setDepositOpen(true)}
                />
              ) : tab === 'borrow' ? (
                <BorrowScreen pos={pos} der={der} asset={asset} weekend={weekend} onBack={() => setTab('portfolio')} onBorrow={onBorrow} />
              ) : tab === 'repay' ? (
                <RepayScreen
                  pos={pos}
                  der={der}
                  asset={asset}
                  activeAssetId={activeAssetId}
                  onSelectAsset={setActiveAssetId}
                  claims={claims}
                  history={txHistory}
                  now={now}
                  onBack={() => setTab('portfolio')}
                  onRepay={onRepay}
                  onRequestUnwrap={onRequestUnwrap}
                  onClaim={onClaim}
                  onRefreshPermit={onRefreshPermit}
                />
              ) : tab === 'liquidity' ? (
                <LiquidityScreen liq={liq} onProvide={onProvideLiquidity} onWithdraw={onWithdrawLiquidity} />
              ) : (
                <FaucetScreen pos={pos} asset={asset} activeAssetId={activeAssetId} onSelectAsset={setActiveAssetId} onMint={onMint} onMintUsdc={onMintUsdc} />
              )
            ) : (
              <LiquidatorConsole pushToast={pushToast} assets={liveAssets} />
            )}
          </AppShell>
        )}

        <Toast toast={toast} />
        <DepositDrawer
          open={depositOpen}
          onClose={() => setDepositOpen(false)}
          pos={pos}
          asset={asset}
          activeAssetId={activeAssetId}
          onSelectAsset={setActiveAssetId}
          onDeposit={onDeposit}
        />
        <TweaksPanel tweaks={t} setTweak={setTweak} />
      </div>
    </TweakCtx.Provider>
  );
}
