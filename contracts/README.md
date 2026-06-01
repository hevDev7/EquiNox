# Equinox contracts (Foundry + Fhenix CoFHE)

Confidential equities-lending contracts. FHE via `@fhenixprotocol/cofhe-contracts`
0.0.13; tested against `cofhe-mock-contracts`. **UUPS upgradeable**, role-gated,
pausable, reentrancy-guarded. Real **Pyth** pull-feed oracle.

> **Not production-safe yet.** This is engineered to industry standards and is
> *audit-ready*, but real funds require ≥1 third-party audit, a bug bounty, and
> testnet staging first. See "Audit scope / known limitations" below.

## Contracts

| Contract | PRD | Purpose |
|---|---|---|
| `KYCRegistry` | §3.1 | Selective-disclosure KYC — validity stored as `ebool`; only "registered" is public. UUPS. |
| `FHERC20Wrapper` | §3.2 / §3.5 | Wrap ERC-20 → confidential FHERC20. Sealed `euint64` `confidentialBalanceOf`, non-ERC20 `indicatorOf` decoy, delayed-claim unwrap. FHERC20/ERC-7984 conformance markers (`isFherc20`/`supportsInterface`); non-transferable (transfer/approve revert); NO operator/allowance model. UUPS, pausable, nonReentrant. |
| `EquinoxPool` | §3.3 / §3.4 / §4 | Sealed collateral `C` + debt `D` + secret blinding `s`. Public blinded factors `A=s·C·LT`, `B=s·D`. `FHE.select` borrow gate. Per-second interest index. Weekend haircut in HF. Real liquidation seize + bonus. UUPS, roles, pausable, nonReentrant. |
| `oracle/PythOracleAdapter` | §5.2 | Reads `getPriceNoOlderThan`, normalizes exponent → whole-USD. |
| `oracle/IOracle`, `MockUSDC/MockDShares` | §7 | Oracle abstraction + faucet test tokens. |

The blinding primitive: liquidators read only public `A, B, P, I` and compute
`HF_bps = (A·P·1e4·[weekendHaircut])/(B·I)`. The secret `s` appears in both `A`
and `B` and cancels, so `C` and `D` never leak. `< 10000` (1.0) ⇒ liquidatable.

## Security architecture

- **Upgradeability:** UUPS (`_authorizeUpgrade` gated by `UPGRADER_ROLE`), `__gap` storage reserves, `_disableInitializers()` in constructors.
- **Access control:** OZ `AccessControl` roles — `DEFAULT_ADMIN`, `GOVERNOR`, `ORACLE_MANAGER`, `PAUSER`, `UPGRADER`. In production all are held by a **`TimelockController`** whose proposer/executor is a **multisig** (Safe). See `script/DeployProduction.s.sol`.
- **Pausable** + **ReentrancyGuard** (ERC-7201 namespaced) on all token-moving paths.
- Custom errors, SafeERC20, CEI ordering, NatSpec.

## Invariants (encoded as tests)
1. HF from public `A,B,P,I` equals true `C·LT·P/(D·I)` — `s` cancels.
2. `s ≠ 0` always (clamped homomorphically) ⇒ A,B never both zero with debt — `test_ZeroBlinding_Clamped_StillLiquidatable`.
3. Healthy (HF ≥ 1.0) ⇒ `liquidate` reverts — `test_HealthyCannotBeLiquidated`.
4. Seize ≤ victim collateral for any repay — `testFuzz_SeizeBoundedByCollateral`.
5. `borrowIndex` monotonically non-decreasing; debt grows over time — `test_InterestAccrual_GrowsDebt_LowersHealth`.
6. Only role holders (via timelock) change params; `PAUSER` can pause; upgrades only via `UPGRADER`.

## Develop

```bash
npm install
forge test -vv      # 14 tests
forge build
```

## Deploy

- Demo/testnet (single admin): `script/Deploy.s.sol` (`GOVERNANCE` env).
- Production (timelock + multisig): `script/DeployProduction.s.sol`
  (`MULTISIG`, `TIMELOCK_DELAY`, `PYTH`, `TSLA_FEED_ID`, `DSHARES`, `USDC`).

## Done (hardening)
- **Liquidation:** 2-step request→settle. Repay is **capped homomorphically to the
  close-factor (50%)** of the sealed debt; the decrypted capped amount is pulled at
  settle, so there is **no overpayment / no refund needed**. Seize is clamped to
  collateral; seized collateral stays sealed in the liquidator's `euint64` balance.
- **Interest:** **scaled-debt model** — debt stored scaled by a public per-second
  borrow index; borrow rounds up, repay scales down, so repaying reduces the
  *current* (interest-inclusive) debt. Verified by `test_InterestAccrual_*`.
- **Oracle:** Pyth adapter now **rejects prices with too-wide confidence intervals**
  (`maxConfBps`) in addition to staleness + exponent normalization.
- **Soundness:** `s` clamped to ≥1; healthy positions cannot be liquidated (tested).
- **KYC:** registration requires a **fresh attester-signed attestation** (ECDSA-verified
  on-chain over user+expiry+registry+chainId) — no self-asserted KYC. Attester is
  rotatable by admin. Tested (`KYCRegistry.t.sol`): valid/expired/wrong-signer/wrong-user.

## Static analysis (Slither 0.11.5, triaged)
- `reentrancy-no-eth` on deposit/borrow/repay/settleLiquidation: **mitigated** — all
  are `nonReentrant`; Slither does not pattern-match the vendored guard. Token
  transfers precede FHE state ops; FHE calls target trusted coprocessor precompiles.
- `weak-prng` (random `balanceOf` indicator) and strict-equality (`==0`, day-of-week):
  **by design / benign.**
- `forge coverage` (54 tests): EquinoxPool 95% lines / 96% statements / 83% branches;
  FHERC20Wrapper, KYCRegistry, PythOracleAdapter **100% branches**. The ~5 uncovered
  EquinoxPool branches are defensive guards that are unreachable in normal flow
  (e.g. a liquidation `payUsdc == 0`, which requires zero debt yet HF < 1).
- **Invariant suite** (`PoolInvariant.t.sol`): an encrypted-input handler turns fuzzed
  plaintext into `InEuint64` borrow inputs and keeps a plaintext ghost ledger; the
  invariants assert the **sealed on-chain collateral/scaled-debt always equal the
  ghost** — held across 384 fuzzed calls per invariant.

## Still open (must close before mainnet)
- HCU budget (≤5M/tx per PRD) not yet measured; index-drift between liquidation
  request and settle is bounded but unaudited.
- **External audit + bug bounty + testnet staging** — required before real funds.
