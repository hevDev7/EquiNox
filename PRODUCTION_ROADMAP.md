# Equinox — Production-Readiness Roadmap (→ Mainnet)

Gap analysis of the current contracts vs industry-standard lending protocols
(Aave v3 / Compound / Morpho), with a prioritized path from hackathon demo to a
mainnet-grade confidential lending/borrow protocol. Generated from a 6-dimension
code audit (interest/LP economics, oracle, liquidation/risk, multi-asset,
security/governance, standards/testing).

> **Honest status:** the architecture is audit-*ready* (UUPS, roles, pausable,
> reentrancy-guarded, FHE-confidential positions, scaled-debt interest). It is
> **not mainnet-safe** until the P0 blockers below are closed **and** ≥1 external
> audit + bug bounty + testnet staging are completed.

---

## P0 — Mainnet blockers (must close before any real funds)

1. **FHE factor-settlement is broken.** `getDecryptResultSafe` on-chain poll is dead on CoFHE 0.1.x → `pokeFactors()` never settles `factorA/factorB`, so **liquidation HF is uncomputable** and `FHERC20Wrapper.claimUnwrapped` hangs. → Migrate to the **proof model** (`FHE.verifyDecryptResult` + SDK `decryptForTx`), same as the borrow `claimWithdraw` already uses.
2. **Zero LP yield.** LPs earn 0% on supplied USDC → no incentive to provide liquidity. → Add a **supply interest index** + **reserve factor** (treasury cut); supplyAPY = borrowAPR × utilization × (1 − reserveFactor).
3. **`liquidate()` lacks an oracle-staleness guard** → liquidations possible on stale prices during outages. → `require(!isPriceStale())` (or `updateAndRead`) before HF.
4. **No Chainlink L2 Sequencer Uptime Feed** (mandatory on Arbitrum) → protocol exploitable while the sequencer is down. → gate borrow/liquidate on the sequencer feed + grace period.
5. **Test suite can't run on 0.1.x** — `CoFheTest` was removed from the new `@cofhe/mock-contracts`. → migrate the Foundry harness; restore ≥90% coverage + invariants.

### Testnet footguns that MUST be removed/locked before mainnet
- `weekendOverride` bool (added for off-hours borrow testing) — delete + hardcode `isWeekendMode`.
- Open `mint` faucet on Mock tokens + `Deploy.s.sol` single-key admin / manual `setPrice` — add a chain-id guard so the testnet/demo script can never run on mainnet; mainnet uses `DeployProduction.s.sol` (timelock + multisig + Pyth-only).

---

## Quick wins (high value, low effort — do first)
- `require(!isPriceStale())` guard in `liquidate()`.
- Sequencer uptime feed check (~3–5 LOC) in borrow/liquidate gates.
- Chain-id guard in `Deploy.s.sol` (revert on Arbitrum One).
- Fix the test harness so `forge test` runs again.
- LP supply-index stub + reserve factor (unblocks real LP economics).

---

## Phase 0 — Unblock (~1 wk)
Close infra/safety blockers so dev can resume and testnet iteration is safe.
- Fix `CoFheTest` import / migrate test harness → `forge test` green.
- Oracle staleness guard in `liquidate()`.
- Chainlink sequencer uptime feed in borrow/liquidate.
- Migrate `pokeFactors` + `claimUnwrapped` to the `verifyDecryptResult` proof model (same pattern as `claimWithdraw`).
- Regression tests for each.

## Phase 1 — Economics & audit-readiness (~2 wk)
- **Supply-side interest**: `supplyIndexBps` + `reserveFactor` (e.g. 15–20% → treasury); LP yield accrues via the supply index. `calculateSupplyAPY()` view.
- **Per-asset risk config stub** (`AssetConfig`: ltv, lt, bonus, reserveFactor, priceFeed) — single asset now, multi later.
- **Governance to timelock + multisig**: all GOVERNOR/ORACLE_MANAGER ops via `TimelockController` (2-day delay); remove EOA-held roles; remove/relock manual `setPrice` (Pyth-only via `syncPrice`).
- Coverage ≥95% on `EquinoxPool` (interest, reserve, supply-APY invariants).

## Phase 2 — Composability & risk engine (~3–4 wk)
- **Multi-collateral**: `AssetConfig` mapping, per-asset LTV/LT/bonus; HF = Σ(Cᵢ·Pᵢ·LTᵢ)/(D·I); liquidator picks seize asset.
- **Utilization-based kinked rate** model (base + slope1 below kink, + slope2 above).
- **ERC-4626 vault** (`eqUSDC`) for LP positions (transferable, composable).
- **Supply caps + borrow caps** per asset; decimal normalization to 18.

## Phase 3 — Maturity & mainnet-ready (~2–3 wk + external audit)
- Engage ≥1 tier-1 auditor (OpenZeppelin / Spearbit / Trail of Bits) + bug bounty (Immunefi).
- Subgraph (The Graph / Goldsky) for positions/liquidations/pool stats.
- Monitoring/alerting (oracle freshness, liquidity, bad debt, sequencer, keeper uptime).
- Keeper infra (Pyth price pushes + liquidations; Gelato/Chainlink Automation).
- Mainnet deployment checklist + emergency runbook (pause/upgrade/oracle recovery); multisig ≥3/5 HSM-backed.

## Post-launch — ops & scaling (rolling)
- Daily monitoring, quarterly attester-key rotation, parameter governance, bug-bounty upkeep, multi-equity expansion on demand.

---

*Total ≈ 8–12 weeks engineering + external audit (~$80k–150k) before mainnet.
FHE settlement items depend on CoFHE API stability (coordinate with Fhenix).*
