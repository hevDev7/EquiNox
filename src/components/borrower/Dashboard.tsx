/* ============================================================
   Equinox — Borrower dashboard
   ============================================================ */

import { fmtUSD } from '../../lib/format';
import { Icon, ICON } from '../../lib/icons';
import type { Asset, AssetMap, BorrowerTab, DerivedPosition, Position } from '../../types';
import { SealedValue, Stat } from '../primitives';
import { BlindedHF } from '../health';
import { PositionTabs, WeekendBanner } from './common';

export function Dashboard({
  pos,
  der,
  prices,
  weekend,
  weekendSim,
  onToggleWeekend,
  go,
  asset,
  onDeposit,
}: {
  pos: Position;
  der: DerivedPosition;
  prices: AssetMap;
  weekend: boolean;
  weekendSim: boolean;
  onToggleWeekend: () => void;
  go: (tab: BorrowerTab) => void;
  asset: Asset;
  onDeposit: () => void;
}) {
  // multi-collateral: distinct underlyings the borrower actually holds
  const unders = [...new Set(pos.collateral.filter((c) => c.shares > 0).map((c) => c.under))];
  const collatHint =
    unders.length === 0 ? 'no collateral · sealed'
    : unders.length === 1 ? `${unders[0]} · sealed`
    : `${unders.length} assets · sealed`;
  const hfUnder = unders.length === 1 ? unders[0].replace(/^d/, '') : 'basket';
  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <WeekendBanner active={weekend} simulated={weekendSim} onToggle={onToggleWeekend} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="eyebrow">Confidential position</div>
          <h1 className="serif" style={{ fontSize: 'clamp(26px, 3.4vw, 34px)', fontWeight: 500, marginTop: 4 }}>Good afternoon, Ronald</h1>
        </div>
        <div style={{ display: 'flex', gap: 9 }}>
          <button className="btn" onClick={onDeposit}>
            <Icon d={ICON.plus} size={15} /> Deposit
          </button>
          <button className="btn btn-primary" onClick={() => go('borrow')} disabled={weekend}>
            <Icon d={ICON.arrowDown} size={15} /> Borrow
          </button>
        </div>
      </div>

      {/* top grid */}
      <div className="dash-top" style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 20 }}>
        <div className="card" style={{ padding: 'calc(24px * var(--pad))', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'calc(22px * var(--pad)) 16px' }}>
          <Stat label="Collateral value" hint={collatHint}>
            <SealedValue value={fmtUSD(der.collatValue)} len={9} />
          </Stat>
          <Stat label="Outstanding debt" hint="Mock USDC · principal + interest">
            <SealedValue value={fmtUSD(der.debt)} len={8} />
          </Stat>
          <Stat label="Available to borrow" hint={weekend ? 'Paused — weekend mode' : 'within LTV 70%'} accent="var(--accent)">
            <SealedValue value={fmtUSD(der.remaining)} len={8} />
          </Stat>
          <Stat label="Net equity" hint="collateral − debt">
            <SealedValue value={fmtUSD(der.collatValue - der.debt)} len={8} />
          </Stat>
        </div>
        <BlindedHF hf={der.hf} liqPrice={der.liqPrice} under={hfUnder} />
      </div>

      {/* collateral + blinding primitive — merged tabs */}
      <PositionTabs pos={pos} der={der} prices={prices} asset={asset} go={go} />
    </div>
  );
}
