# Equinox — Production Hardening Spec

**Date:** 2026-05-31
**Status:** Approved (decisions below); implementation phased
**Scope:** Bring the Equinox confidential-lending contracts from hackathon MVP to
**audit-ready, industry-standard engineering** on Arbitrum Sepolia (→ mainnet path).

## Honest boundary

This spec makes the code *audit-ready and engineered to industry standards*. It does
**not** certify safety for real funds. Before mainnet/real value the protocol still
requires: ≥1 independent third-party audit, a public bug bounty, testnet staging
with real users, and an economic/parameter review. Those are out of my scope.

## Locked decisions

| Area | Decision |
|---|---|
| Upgradeability | **UUPS** (OZ upgradeable) + `__gap` storage reserves |
| Access control | **OZ AccessManager/AccessControl roles** (`GOVERNOR`, `PAUSER`, `ORACLE_MANAGER`, `UPGRADER`) behind **TimelockController** + **multisig (Safe)** |
| Oracle | **Pyth pull-feed** (`IPyth.getPriceNoOlderThan`, `updatePriceFeeds`), staleness 60s |
| Economic scope | Complete **isolated lending core**: real liquidation seize + bonus, per-second interest index, `s`-validation + invariants, reentrancy guard, pausing. Pool stays **pre-funded** (no lender side this round). |

## Target architecture

```
TimelockController (admin) ──controls──▶ roles on all contracts
        ▲ proposer/executor = Safe multisig

EquinoxPoolV1 (UUPS)  ── uses ──▶ PythOracleAdapter (IPyth)
   AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable
KYCRegistryV1 (UUPS)
FHERC20WrapperV1 (UUPS)
MockUSDC / MockDShares (test-only; real USDC/dShares on testnet)
```

## Work, by phase (each phase ends green: `forge build` + `forge test`)

### Phase 1 — Secure foundation (infra)
- Add deps: `openzeppelin-contracts-upgradeable`, `openzeppelin-foundry-upgrades`, `@pythnetwork/pyth-sdk-solidity`.
- Convert `EquinoxPool`, `KYCRegistry`, `FHERC20Wrapper` to **UUPS upgradeable**:
  constructor → `initializer`; `_disableInitializers()` in constructor; `__gap`.
- **AccessControlUpgradeable** with roles; `GOVERNOR` replaces `onlyGovernance`.
- **PausableUpgradeable** (`whenNotPaused` on deposit/borrow/repay/unwrap/liquidate) + `PAUSER`.
- **ReentrancyGuardUpgradeable** (`nonReentrant` on all external state-changing fns with token transfers).
- Custom errors (gas + clarity) replacing string requires; full **NatSpec**; explicit events.
- `Ownable2Step`-style safety is superseded by roles+timelock.

### Phase 2 — Soundness fixes
- **Reject `s = 0`** and enforce `s` within a sane range on `initBlinding` (prevents
  A=B=0 "no-debt" liquidation-evasion). Add explicit invariant + test.
- Re-audit `FHE.allow`/`allowThis`/`allowSender` so users can decrypt their own
  sealed balances and the pool retains compute rights — no missing grants.
- CEI ordering on every external call; SafeERC20 everywhere; pull-not-push where possible.
- Guard `pendingBorrows`/claims against double-claim, wrong-owner, replay.

### Phase 3 — Economic completeness
- **Per-second interest index** `borrowIndex` (ray-scaled, accrues on interaction,
  like Aave). Debt stored as **scaled principal** (`euint64`); current debt =
  scaled × index. HF denominator uses the live public index → matches PRD `I`.
- **Real liquidation**: liquidator submits an (encrypted) repay; contract verifies
  HF<1 from public factors, pulls liquidator USDC, **seizes proportional encrypted
  collateral + bonus** to the liquidator (stays `euint64`), reduces victim debt,
  recomputes A/B. Close-factor cap (e.g. 50%).
- **Weekend haircut** folded into the health math (effective LT) during the window.

### Phase 4 — Real oracle
- `PythOracleAdapter`: store Pyth contract + price-feed id per asset; `price()` reads
  `getPriceNoOlderThan(id, 60)`, normalizes expo → 1e-scale used by the pool.
  Borrow path accepts caller-supplied `updateData` + forwards `updatePriceFeeds{value}`.
- Keep a `MockOracle` implementing the same interface for tests.

### Phase 5 — Test & verification suite (industry bar)
- Unit tests for every path incl. repay, pool-unwrap, claim, pause, role-gating,
  `s=0` rejection, oracle staleness revert, close-factor.
- **Fuzz tests** (amounts, prices, time) and **invariant tests** (e.g. "a position
  with HF≥1 can never be liquidated", "sum of seizes ≤ collateral", "index monotonic").
- **Slither** static analysis clean (or triaged); `forge coverage` target ≥90% lines.
- Upgrade-safety check via `openzeppelin-foundry-upgrades` (`Upgrades.validateUpgrade`).

### Phase 6 — Deploy & ops
- Deploy script: deploy implementations → ERC1967 proxies → TimelockController →
  grant roles to timelock, set Safe as proposer/executor → wire Pyth feed ids.
- `forge verify-contract` (Arbiscan) wiring; `.env.example` for keys/feed ids.
- Threat model + invariants doc + "known limitations / audit scope" in `contracts/README.md`.

## Key invariants (to encode as tests)
1. HF computed from public `A,B,P,I` equals the true `C·LT·P/(D·I)` (blinding cancels).
2. `s ≠ 0` always; A,B never both zero for an account with debt.
3. Healthy (HF ≥ 1e4 bps) ⇒ `liquidate` reverts.
4. Liquidation seizes ≤ collateral and ≤ close-factor of debt; bonus ≤ configured.
5. `borrowIndex` is monotonically non-decreasing.
6. Only `GOVERNOR`/role holders (via timelock) can change params; `PAUSER` can pause.
7. Upgrades only by `UPGRADER` via timelock; storage layout compatible.

## Out of scope (explicit)
Lender/supply side & two-sided interest curve; cross-asset/portfolio margining;
governance token; L2↔L1 bridging (LayerZero OFT); formal verification; the external
audit itself.
