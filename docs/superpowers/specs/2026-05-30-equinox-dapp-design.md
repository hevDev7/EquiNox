# Equinox dapp — Design Spec

**Date:** 2026-05-30
**Status:** Approved
**Source:** PRD v1.0.0 (Confidential Equities Lending Primitive) + `Desain/` prototype

## Goal

Convert the existing in-browser (CDN React + Babel) Equinox prototype in `Desain/`
into a real, buildable **Vite + React + TypeScript** dapp. All protocol behavior
stays **mocked** in this pass; the web3 seam (wallet + contracts) is **stubbed
behind interfaces** so real CoFHE/wagmi can be dropped in later by filling
function bodies — no UI changes.

## Decisions (locked)

- Stack: **Vite + React 18 + TypeScript**
- Port fidelity: **idiomatic refactor** — per-module component files, real
  imports replacing the `window.assign` global pattern, shared types extracted.
- Web3 scope: **mock data now + stubbed service/wallet interfaces**.
- Project lives at repo root (`equinox/equinox/`); `Desain/` kept as reference.

## Architecture

```
UI components ─▶ services (EquinoxService interface) ─▶ MockEquinoxService (now) | CofheEquinoxService (later)
              ─▶ WalletService interface           ─▶ MockWalletService (now) | wagmi adapter (later)
```

UI never touches "chain" directly — only the service interfaces, provided via
React context.

## Source layout

```
src/
├── main.tsx, App.tsx, index.css        # index.css = ported styles.css + responsive rules
├── types.ts                            # Position, Asset, Account, Claim, Toast, Tweaks, Phase, Mode, Tab
├── lib/
│   ├── protocol.ts                     # PROTOCOL consts, derivePosition, liquidatorHF, isWeekendMode
│   ├── format.ts                       # fmtUSD, fmtNum, bigInt, randCipher, randDecimal, txHash
│   ├── mock-data.ts                    # ASSETS, INITIAL_POSITION, makeAccounts
│   └── icons.tsx                       # Icon component + ICON path map
├── services/
│   ├── types.ts                        # EquinoxService + WalletService interfaces
│   ├── mock-equinox-service.ts            # async in-memory impl, simulated FHE latency, FHE.select gating
│   └── mock-wallet.ts                  # connect / account / chain
├── hooks/        useTweaks.ts, useScramble.ts
├── context/      TweakContext.tsx, ServiceContext.tsx
└── components/
    ├── primitives.tsx   # SealedValue, DecimalIndicator, EncTag, Stat, FheSteps, AssetMark, Toast, Logo
    ├── health.tsx       # ArcGauge, BlindedHF, hfColor, hfLabel
    ├── tweaks.tsx       # self-contained TweaksPanel + controls
    ├── onboarding.tsx   # ConnectGate, KycFlow
    ├── layout.tsx       # AppShell, AppFooter
    ├── borrower/
    │   ├── Dashboard.tsx
    │   ├── common.tsx   # TxFlow, WeekendBanner, ChainSees, PositionTabs, Row, CollateralInner
    │   └── actions.tsx  # ScreenHeader, AmountInput, InfoCard, KV, DepositScreen, BorrowScreen, RepayScreen
    └── liquidator.tsx   # LiquidatorConsole, SolverDetail
```

## Service interface (the web3 seam)

```ts
interface EquinoxService {
  submitKyc(attestation: KycAttestation): Promise<{ ok: boolean }>;
  deposit(shares: number): Promise<TxResult>;
  borrow(amount: number, limit: number): Promise<{ approved: boolean; disbursed: number } & TxResult>;
  repay(amount: number): Promise<TxResult>;
  requestUnwrap(shares: number): Promise<{ claimId: string; hash: string; readyAt: number }>;
  claimUnwrapped(claimId: string): Promise<{ shares: number } & TxResult>;
  listAccounts(): Promise<Account[]>;       // liquidator: only A,B public
  liquidate(accountId: string): Promise<TxResult>;
}
interface WalletService {
  connect(kind: 'metamask' | 'walletconnect'): Promise<WalletInfo>;
  current(): WalletInfo | null;
}
```

`borrow` mock replicates the PRD's `FHE.select`: if `amount > limit`, returns
`{ approved: false, disbursed: 0 }` without throwing (no leak via revert).
`requestUnwrap`/`claimUnwrapped` model the delayed threshold-decryption claim.

## Data flow

`App` owns top-level state: `phase` (gate|kyc|app), `mode` (borrower|liquidator),
`tab`, `position`, `claims`, `toast`, `tweaks`. Mutations route through
`EquinoxService` (promises simulate coprocessor latency), then App updates state from
results. Derived values (`Aᵢ/Bᵢ` blinded factors, sealed displays, HF, weekend
breaker, HCU meter) computed exactly as the prototype does in `derivePosition`.

## Faithfulness

Identical visuals, three themes (Sterling/Obsidian/Vellum), all animations and
copy preserved. Intentional `Math.random`/`Date.now` usages (cipher scramble,
live clock, weekend check) retained. Custom CSS vars in inline styles handled via
`React.CSSProperties` casts.

## Out of scope (this pass)

Real wallet connection, real contracts, Foundry/Solidity, Pyth/DIA oracle feeds,
LayerZero bridging — all deferred behind the interfaces above. Reference addresses
from the PRD are kept as constants for later wiring.

## Verification

- `npm run build` (runs `tsc` + `vite build`) passes with no type errors.
- `npm run dev` serves the full flow: connect → KYC → dashboard → deposit →
  borrow → repay/unwrap → liquidator console, with weekend-mode simulation.
