# Equinox — Smart Contract Security Audit

**Protocol:** Equinox — Confidential Equities Lending Primitive
**Stack:** Solidity ^0.8.25 · Foundry · Fhenix CoFHE (`@fhenixprotocol/cofhe-contracts` 0.0.13) · UUPS proxies · Pyth oracle · Arbitrum Sepolia (chainId 421614)
**Scope:** `contracts/src/**` (`EquinoxPool`, `FHERC20Wrapper`, `KYCRegistry`, `oracle/PythOracleAdapter`, `access/*`, `mocks/*`) + deploy scripts + frontend FHE boundary
**Date:** 2026-05-31
**Auditor:** Blockchain security review (manual + Foundry PoC)
**Commit baseline:** local working tree (no git); 45/45 existing tests pass at audit time.

---

## 1. Executive Summary

Equinox is a confidential lending market: borrowers post tokenized-equity collateral
(`dShares`), borrow `USDC`, and a per-user secret blinding factor `s` is supposed to
hide their collateral `C` and debt `D` while still exposing a *blinded* public health
factor (`A = s·C·LT`, `B = s·scaledDebt`) so liquidations stay permissionless. The
Fhenix CoFHE primitives (`euint64`, `ebool`, `FHE.select`, threshold `FHE.decrypt`,
ACL `FHE.allow*`) are wired in and the code compiles and passes its own suite.

However the audit found **two issues that defeat the protocol's two core guarantees —
solvency and confidentiality — both proven with executable Foundry PoCs**, plus a
liquidation-DoS, an ACL regression, and several medium/low issues.

| # | Severity | Title | Status |
|---|----------|-------|--------|
| EQX-01 | 🔴 **Critical** | Borrow limit ignores outstanding debt → unlimited borrowing / pool drain | **PoC ✅** |
| EQX-02 | 🟠 **High** | Confidentiality model defeated — `C`, `D` and secret `s` recoverable from public state | **PoC ✅** |
| EQX-03 | 🟠 **High** | Liquidation never checks oracle staleness → liquidate on stale price | Confirmed |
| EQX-04 | 🟠 **High** | Liquidation DoS — borrower perpetually resets `factorsReady` to block liquidation | Confirmed |
| EQX-05 | 🟡 **Medium** | Victim loses FHE decrypt-ACL on own collateral/debt after liquidation | Confirmed |
| EQX-06 | 🟡 **Medium** | Silent `euint64` overflow in scaled-debt / `eMax` math | Confirmed |
| EQX-07 | 🟡 **Medium** | Unbounded, unguarded `setPrice` (no bounds/deviation; all roles on one EOA in `Deploy`) | Confirmed |
| EQX-08 | 🟡 **Medium** | Sealed KYC `ebool` verification bit is never enforced anywhere | Confirmed |
| EQX-09 | 🟢 Low | KYC attestation has no nonce → replayable within validity window; re-registration allowed | Confirmed |
| EQX-10 | 🟢 Low | Operator model defined but never enforced (dead feature) | Confirmed |
| EQX-11 | 🟢 Low | `balanceOf` returns `block.prevrandao`-derived random value (ERC20 non-compliant) | By design / document |
| EQX-12 | 🔵 Info | Liquidation debt-reduction uses stale snapshot index; tiny liquidations seize 0; `liquidated` flag unused; unbounded pending arrays; vendored `TASK_MANAGER_ADDRESS` "TODO CHANGE ME" | Confirmed |

---

## 2. Fhenix / CoFHE Architecture Verification

**Is Fhenix genuinely applied? — Mechanically yes, effectively no (for confidentiality).**

✅ **Correctly used primitives**
- `import "@fhenixprotocol/cofhe-contracts/FHE.sol"` in all three core contracts.
- Sealed state uses real encrypted types: `euint64` for collateral/scaled-debt/blinding/balances, `ebool` for the KYC validity bit.
- Encrypted inputs use `InEuint64` / `InEbool` (client-side ciphertext + proof), encrypted client-side with `cofhejs` (`src/lib/cofhe.ts`, `encryptUint64`/`encryptBool`).
- Branchless gating via `FHE.select` (over-limit borrow draws 0, no revert) — `EquinoxPool.sol:260-261`, `requestUnwrap` `FHERC20Wrapper.sol:126-127`.
- Asynchronous **threshold decryption** modeled correctly with the request→claim pattern: `FHE.decrypt(...)` then later `FHE.getDecryptResultSafe(...)` (`claimBorrow`, `claimUnwrapped`, `settleLiquidation`, `pokeFactors`).
- ACL calls `FHE.allowThis` / `FHE.allowSender` after most ciphertext writes.
- Tests exercise the CoFHE mock coprocessor (`CoFheTest`, `assertHashValue`, async-decrypt warp offset).

❌ **Where the FHE design does not deliver its guarantee**
1. **Plaintext side-channels publish the values FHE is meant to hide.** `deposit(uint256 shares)` (`EquinoxPool.sol:224`) and `repay(uint256 wholeUsdc)` (`:296`) take **plaintext** amounts, and the borrowed amount is later **globally decrypted** (`FHE.decrypt(approved)` → readable by anyone via `getDecryptResult`). So `C` and `D` are public regardless of the `euint64` storage. See **EQX-02**.
2. **Wrong decrypt primitive for private values.** `FHE.decrypt` performs a **global/public** decryption (`Impl.decrypt` → `createDecryptTask`; `getDecryptResult` has no caller restriction). Values that should stay user-private (the public factors `A`,`B` are by-design, but the blinding `s` they expose is not) leak. For per-user confidential reads the design should use **sealed output** (encrypt-to-recipient), not public decrypt.
3. **ACL regression on liquidation** (`EQX-05`): the victim's rewritten `euint64` balances are granted only `allowThis`, never re-`allowSender` to the victim, so the owner can no longer decrypt their own position after being liquidated.
4. **Vendored `FHE.sol` ships a placeholder coprocessor address** — `TASK_MANAGER_ADDRESS = 0xeA30…48D9` carries a literal `TODO : CHANGE ME AFTER DEPLOYING` banner. Confirm it equals the live CoFHE TaskManager on Arbitrum Sepolia before mainnet/testnet reliance (`EQX-12`).

**Conclusion:** the integration is real and idiomatic at the API level, but the surrounding
*plaintext* deposit/repay interface and the *public* decrypt of borrow amounts mean the
blinding scheme adds essentially **no confidentiality** today. Closing EQX-02 is required
for the "confidential" claim to hold.

---

## 3. Critical & High Findings

### EQX-01 🔴 Critical — Borrow limit ignores outstanding debt (pool drain)

**File:** `contracts/src/EquinoxPool.sol:242-278` (`requestBorrow`)

The borrow gate computes the maximum as the **full** LTV capacity of the collateral and
compares only the *new* request against it — it never subtracts the borrower's existing debt:

```solidity
euint64 eMax = FHE.div(
    FHE.mul(FHE.mul(_eCollateral[msg.sender], FHE.asEuint64(uint256(price))), FHE.asEuint64(uint256(LTV_BPS))),
    FHE.asEuint64(uint256(BPS))
);                                   // eMax = C · price · LTV / BPS   (no `- currentDebt`)
ebool ok = FHE.lte(r, eMax);         // checks the NEW request only
euint64 approved = FHE.select(ok, r, FHE.asEuint64(0));
```

Because each call is judged against the *entire* limit, a borrower can call `requestBorrow`
repeatedly and accumulate debt without bound while only ever posting collateral once. The
position passes every individual check yet becomes massively undercollateralized; the
borrower claims the USDC and never repays. Seized collateral on liquidation is capped at
`C`, but the debt (and the USDC walked away with) is unbounded → **protocol insolvency**.

**PoC:** `contracts/test/PoC_UnlimitedBorrow.t.sol::test_PoC_UnlimitedBorrow_DrainsPool`

```
collateral value (USDC): 342000000000   (= 342,000 USDC)
total USDC borrowed     : 957600000000   (= 957,600 USDC)   → 2.8× the collateral, drained in 4 calls
```

**Impact:** Direct theft of pool liquidity / insolvency. Highest severity.

**Remediation:** Gate on **remaining** capacity, computed homomorphically:

```solidity
// currentDebt = scaledDebt · index / BPS
euint64 eDebt   = FHE.div(FHE.mul(_eScaledDebt[msg.sender], FHE.asEuint64(idx)), FHE.asEuint64(uint256(BPS)));
ebool   hasRoom = FHE.lte(eDebt, eMax);
euint64 eRoom   = FHE.select(hasRoom, FHE.sub(eMax, eDebt), FHE.asEuint64(0));
ebool   ok      = FHE.lte(r, eRoom);
```

Add a regression test asserting that the sum of successful borrows never exceeds `C·price·LTV`.

---

### EQX-02 🟠 High — Confidentiality defeated: `C`, `D`, and secret `s` are publicly recoverable

**Files:** `EquinoxPool.sol:224` (`deposit` plaintext), `:296` (`repay` plaintext),
`:272` (`FHE.decrypt(approved)`), `:316-337` (public `factorA`/`factorB`).

The protocol's value proposition is hiding `C` and `D` behind the blinding `s`. It fails on
multiple independent channels:

1. **Collateral is plaintext.** `deposit(uint256 shares)` puts `C` directly in calldata and in the `dShares` `Transfer` event.
2. **Repayments are plaintext.** `repay(uint256 wholeUsdc)` exposes every repayment.
3. **Borrows are globally decrypted.** `requestBorrow` calls `FHE.decrypt(approved)`; the result is readable by *anyone* (`getDecryptResult`), and the USDC disbursement amount is public anyway. So `D` (scaled debt) is fully public.
4. **The blinding then unravels.** `factorB = s·scaledDebt` is published by `pokeFactors`. With `scaledDebt` known from (1)–(3), `s = factorB / scaledDebt`. Then `factorA = s·C·LT` yields `C = factorA /(s·LT)`.

So the "secret" `s` and "sealed" `C` are recoverable with public getters only.

**PoC:** `contracts/test/PoC_UnlimitedBorrow.t.sol::test_PoC_ConfidentialityBroken_RecoverSecretAndCollateral`

```
recovered blinding s   : 73194028   (== the user's secret)
recovered collateral C : 1000       (== the "sealed" collateral)
```

**Impact:** Complete loss of the confidentiality guarantee that justifies the FHE design.
Not a fund-loss bug on its own, but it nullifies the product's reason to exist.

**Remediation (design-level):**
- Accept encrypted deposit/repay amounts (`InEuint64`) instead of plaintext, mirroring `requestBorrow`.
- Do **not** publicly `FHE.decrypt` the approved borrow; disburse via a mechanism that does not reveal the per-user amount, or accept that the disbursed amount is inherently public and re-scope the privacy claim.
- Reconsider publishing `factorB = s·scaledDebt`: any single public debt observation cancels `s`. Consider re-blinding `s` per epoch, or proving health in zero-knowledge rather than via a multiplicative blind that collapses once one factor is known.
- Use sealed-output (encrypt-to-recipient) for values that must remain user-private.

---

### EQX-03 🟠 High — Liquidation path has no oracle-staleness check

**File:** `contracts/src/EquinoxPool.sol:357-386` (`requestLiquidation`) and `healthFactorBps` (`:341-349`).

`requestBorrow` rejects a stale oracle (`block.timestamp - priceUpdatedAt > STALENESS`,
`:251`), but **neither `requestLiquidation` nor `healthFactorBps` checks freshness**. Both
read the cached `price` directly. If the price feed stops updating (Pyth outage, keeper
down), liquidations proceed on an arbitrarily old price. Combined with the weekend haircut
and a stale-high or stale-low price, solvent users can be liquidated, or unhealthy users
shielded, on data that no longer reflects the market.

**Impact:** Unfair/incorrect liquidations or missed liquidations during oracle downtime.

**Remediation:** Apply the same staleness guard to `requestLiquidation` (and ideally make
`healthFactorBps` revert or signal staleness). Prefer pulling a fresh Pyth update in the
same tx (`PythOracleAdapter.updateAndRead`) before liquidating.

---

### EQX-04 🟠 High — Liquidation DoS by perpetually resetting `factorsReady`

**Files:** `EquinoxPool.sol:316-326` (`_recomputeFactors` sets `factorsReady=false`),
`:357-367` (`requestLiquidation` requires `factorsReady[user]`).

Every state-changing user action (`deposit`, `requestBorrow`, `repay`) calls
`_recomputeFactors`, which sets `factorsReady[user] = false` until someone re-`pokeFactors`
*after* the async decrypt resolves (several blocks later). `requestLiquidation` reverts with
`FactorsNotSettled` whenever `factorsReady[user]` is false.

An underwater borrower can therefore **front-run / spam a cheap state change** (e.g.
`deposit(1)` or `repay(1)`) once per block, keeping `factorsReady` permanently false and
making themselves **un-liquidatable** while their position rots into bad debt. The cost to
the attacker (1 unit + gas per block) is negligible relative to the avoided liquidation.

**Impact:** Bad debt accrual; liquidations can be indefinitely blocked → protocol loss.

**Remediation:** Decouple liquidation eligibility from the async factor refresh. Options:
compute health from the live encrypted state at liquidation time rather than gating on the
cached public factors; or keep the *previous* settled factors valid for liquidation until
the new ones settle; or rate-limit/charge for factor invalidation.

---

## 4. Medium Findings

### EQX-05 🟡 Medium — Victim loses FHE decrypt-ACL on their own balances after liquidation

**File:** `contracts/src/EquinoxPool.sol:410-419` (`settleLiquidation`).

When the victim's collateral/debt are rewritten:

```solidity
_eScaledDebt[L.user] = FHE.sub(_eScaledDebt[L.user], paid);
FHE.allowThis(_eScaledDebt[L.user]);          // contract can use it…
// …but NO FHE.allowSender / allow(L.user) — victim can no longer decrypt
_eCollateral[L.user] = FHE.sub(_eCollateral[L.user], take);
FHE.allowThis(_eCollateral[L.user]);          // same omission
```

Each `FHE.sub` yields a **new ciphertext handle**; only `allowThis` is granted. Unlike
`deposit`/`repay`/`borrow` (which `allowSender` because the owner is `msg.sender`), here the
owner is `L.user` (not the caller), so no per-owner allowance is granted. After liquidation
the victim can no longer decrypt `encryptedCollateralOf`/`encryptedScaledDebtOf` for their
own account — the dapp's sealed-balance view for that user breaks.

**Remediation:** After each rewrite of a victim balance, call `FHE.allow(handle, L.user)`.

---

### EQX-06 🟡 Medium — Silent `euint64` overflow in scaled-debt / `eMax` arithmetic

**Files:** `EquinoxPool.sol:256-265` (`eMax`, `scaledAdd`), `:372-375` (`maxRepay`).

FHE integer ops are modular over the type width with no Solidity overflow guard. Intermediate
products can exceed `2^64`:
- `eMax = C · price · LTV / BPS` — `C·price·LTV` overflows `euint64` when `C·price ≳ 1.8e15`.
- `scaledAdd = (approved·BPS + idx-1)/idx` — `approved·BPS` overflows when `approved ≳ 1.8e15`.
- `maxRepay`: `scaledDebt · (idx·CLOSE_FACTOR)` similarly.

On overflow the value wraps silently, producing a wrong (possibly tiny) limit or scaled
debt — e.g. a large borrow could register near-zero debt. While the thresholds are
economically large, nothing in code bounds them, and EQX-01 already shows debt can be
inflated arbitrarily.

**Remediation:** Bound `price`, `shares`, and borrow amounts so all intermediate products
stay `< 2^64`, or perform the scaling in a wider encrypted type (`euint128`) and downcast
after the divide. Add explicit input caps in `deposit`/`requestBorrow`.

---

### EQX-07 🟡 Medium — Unbounded, single-key `setPrice`; deploy grants all roles to one EOA

**Files:** `EquinoxPool.sol:152-156` (`setPrice`), `script/Deploy.s.sol:22,135-139`.

`setPrice(uint64)` accepts any value with no bounds, no deviation cap, and no relation to the
Pyth adapter. A single `ORACLE_MANAGER_ROLE` holder can set `price = 0` (→ everyone
liquidatable / division anomalies) or a huge price (→ unlimited borrow). In `Deploy.s.sol`
the deployer EOA (`msg.sender`) is granted `DEFAULT_ADMIN`, `GOVERNOR`, `ORACLE_MANAGER`,
`PAUSER`, and `UPGRADER` — full custody from one hot key. (`DeployProduction.s.sol` correctly
routes everything through a `TimelockController` + multisig; the gap is the non-production
script and the missing on-chain price sanity checks.)

**Remediation:** Drive price from the Pyth adapter (`syncPrice`) as the norm; if a manual
setter is kept, enforce a max deviation vs. the last oracle price and a sane absolute range.
Never ship the EOA-admin deploy to a public network.

---

### EQX-08 🟡 Medium — Sealed KYC verification bit is never enforced

**Files:** `KYCRegistry.sol:67-78` (`register`), `:85-87` (`isRegistered`), `EquinoxPool.sol:118-121` (`onlyKyc`).

`register` stores a client-supplied `ebool encOk` as `_verified[msg.sender]` and sets the
public `registered = true` **unconditionally**. The only gate the pool ever checks is the
public `registered` flag (`onlyKyc → kyc.isRegistered`). Nothing ever reads `_verified`, and
the user encrypts `encOk` themselves — so the "selective-disclosure" validity bit is purely
decorative and contributes no access-control value. The real gate is the attester's ECDSA
signature; the sealed bit could be `false` and the user would still pass `onlyKyc`.

**Remediation:** Either drop the sealed bit (and document that the attester signature is the
gate), or actually consume `_verified` in a homomorphic gate (e.g. `FHE.select` on the
verified bit when computing borrow approval), so a `false` attestation cannot transact.

---

## 5. Low / Informational

- **EQX-09 (Low) — KYC attestation replay / re-registration.** `attestationDigest` binds
  `user, expiry, registry, chainId` but **no nonce** (`KYCRegistry.sol:58-78`). The same
  signature is reusable until `expiry`, and `register` can be called repeatedly (overwriting
  `_verified`). Impact is limited (msg.sender must equal the attested user), but add a nonce
  and/or a "already registered" guard.
- **EQX-10 (Low) — Operator model is dead code.** `setOperator`/`isOperator`
  (`FHERC20Wrapper.sol:85-92`) are never consulted by `wrap`/`requestUnwrap`, which only act
  on `msg.sender`. The README advertises an "Operator model" that isn't wired. Remove or
  implement (and gate operator actions on `isOperator`).
- **EQX-11 (Low/By-design) — `balanceOf` randomness.** `FHERC20Wrapper.balanceOf`
  (`:114-116`) returns `keccak256(block.prevrandao, account, block.number) % 10000`. This is
  intentional blinding but is **not ERC20-compliant** (non-deterministic, changes per block);
  any integrator/aggregator reading it will misbehave. Document loudly and avoid exposing it
  as the standard ERC20 `balanceOf` selector if the wrapper is ever treated as a real token.
- **EQX-12 (Info) — Assorted:**
  - `settleLiquidation` reduces debt with the **request-time** `indexSnap` (`:406`) while
    interest keeps accruing between request and settle — a small under-reduction of debt.
  - Tiny liquidations round `seize` to 0 (`:414`, integer divide) — liquidator pays and
    seizes nothing; not a protocol loss, but surprising.
  - `liquidated[user]` (`:426`) is written but never read.
  - `pendingBorrows` / `pendingLiquidations` / `claims` arrays grow unbounded; fine with
    index access, but storage grows forever (no pruning of settled entries).
  - Vendored `FHE.sol` hardcodes `TASK_MANAGER_ADDRESS` with a literal `TODO : CHANGE ME
    AFTER DEPLOYING` banner — verify it matches the live CoFHE TaskManager on Arbitrum
    Sepolia before relying on decryption.
  - Frontend `submitKyc` (`src/services/cofhe-equinox-service.ts:58-77`) sends a placeholder
    signature `'0x'` and a `Math.random()` blinding `s`; the real `register` call would revert
    on-chain (`InvalidAttestation`). The real attester-API integration is still a TODO.

---

## 6. Proof-of-Concept Artifacts

Added under `contracts/test/`:

| File | Test | Proves |
|------|------|--------|
| `PoC_UnlimitedBorrow.t.sol` | `test_PoC_UnlimitedBorrow_DrainsPool` | EQX-01: borrows 957,600 USDC against 342,000 collateral |
| `PoC_UnlimitedBorrow.t.sol` | `test_PoC_ConfidentialityBroken_RecoverSecretAndCollateral` | EQX-02: recovers secret `s` and collateral `C` from public getters |

Run:

```bash
cd contracts
forge test --match-contract PoC_UnlimitedBorrow -vv
```

Both tests **pass** (i.e. the exploits succeed) against the current code. The existing
45-test suite also passes — note its `invariant_scaledDebtMatchesGhost` only checks that
accounting stays internally consistent, **not** that borrowing respects the collateral
limit, which is why EQX-01 slips through.

---

## 7. Remediation Priority

1. **EQX-01** — fix the borrow capacity check (subtract current debt). *Blocking — funds at risk.*
2. **EQX-02** — redesign the confidentiality boundary (encrypted deposit/repay, no public
   borrow decrypt, re-blinding). *Blocking for the "confidential" claim.*
3. **EQX-03 / EQX-04** — staleness guard on liquidation; decouple liquidation from async
   factor refresh.
4. **EQX-05 / EQX-06 / EQX-07 / EQX-08** — ACL re-grant, overflow bounds, oracle hardening,
   enforce or remove the KYC bit.
5. **EQX-09…EQX-12** — hygiene.

Re-audit after EQX-01 and EQX-02 are addressed, since the confidentiality redesign touches
the same borrow/debt accounting as the solvency fix.

---

*This report is a point-in-time review of the code as provided and is not a guarantee of the
absence of other vulnerabilities. Re-audit after remediation.*

---

# 8. Independent Verification & Remediation (2026-05-31)

A second reviewer independently re-verified every finding against the source (each claim
reproduced from the code, both Foundry PoCs re-run) and then remediated the codebase. **Net
verdict: the audit is valid and actionable.** All 12 findings are real as *mechanisms*; two
were materially overstated in impact and two contained factual errors (corrected below). The
fixes were implemented and the full suite re-run.

## 8.1 Validity verdict & corrections

| # | Audit sev. | Verified verdict | Correction to the audit |
|---|-----------|------------------|--------------------------|
| EQX-01 | Critical | ✅ Valid (Critical) | None. PoC reproduced: 957,600 USDC drawn vs 342,000 collateral. |
| EQX-02 | High | ✅ Valid (High) | None material. No *local* patch exists — fixed by re-architecture (§8.2). |
| EQX-03 | High | ✅ Valid, **→ Medium** | Attacker can't *induce* staleness; `syncPrice` is permissionless (self-help). Audit **missed** that `settleLiquidation` also used the cached price. |
| EQX-04 | High | ✅ Valid (High) | Clarified: strictly a *self*-DoS; the cheapest perpetual vector is over-limit `requestBorrow` (token-free), not `deposit(1)`/`repay(1)`. |
| EQX-05 | Medium | ✅ Valid, **→ Low** | Self-recoverable (victim's next deposit/repay re-grants ACL); no fund loss. |
| EQX-06 | Medium | ✅ Valid, **→ Low** | Overflow thresholds are economically unreachable (~7.7e12 shares); reachable wrap direction is self-DoS / protocol-favourable. |
| EQX-07 | Medium | ✅ Valid (Med dev / Low prod) | `price=0` is DoS, not theft. A deviation cap stops fat-fingers only; the real control is role custody (DeployProduction already uses timelock+multisig). |
| EQX-08 | Medium | ⚠️ Valid mechanism, **→ Low/Info** | **Framing wrong:** does NOT enable self-asserted KYC — the attester ECDSA signature is and always was the gate. The bit was decorative dead code + misleading NatSpec. |
| EQX-09 | Low | ⚠️ Valid, **→ Info** | Replay is *self-only* (digest bound to `msg.sender`); re-registration was a no-op (`_verified` unused). |
| EQX-10 | Low | ✅ Valid (Low) | None. |
| EQX-11 | Low | ✅ Valid (Low/Info) | "Non-deterministic" is imprecise — deterministic *within* a block. The deeper gap: the type isn't an ERC20 at all (no transfer/approve/totalSupply). |
| EQX-12 | Info | ⚠️ Mostly valid, **2 errors** | (a) direction **inverted** — stale snapshot index ⇒ debt is *over*-reduced (borrower-favourable), not under-reduced. (e) `FHE.sol` is an **upstream npm dependency, not vendored**, and the address is the real CoFHE TaskManager — not an Equinox defect. (b/c/d/f) confirmed. |

## 8.2 Remediation implemented

**EQX-02 (confidentiality) — full confidential-settlement re-architecture.** The root cause is
that plaintext ERC-20 settlement publishes the amounts FHE hides. The pool now keeps an
**internal sealed credit ledger** (`_eShareCredit`, `_eUsdcCredit`) and all position
operations act on sealed `euint64` state with **no public `FHE.decrypt` of any position
value**:
- `deposit(InEuint64)` moves a sealed amount from idle share-credit into collateral.
- `requestBorrow(InEuint64)` is now **synchronous**: proceeds are credited to a sealed
  `_eUsdcCredit` (no global decrypt, no plaintext disbursement, no `BorrowClaimed` amount).
- `repay(InEuint64)` draws from sealed credit.
- `liquidate(user, InEuint64)` is **single-step**: the liquidator's pre-funded sealed credit
  pays a homomorphically close-factor-capped amount; debt/seize computed in the sealed domain.
- Real ERC-20s move only at two explicit, position-decoupled plaintext edges:
  `fundShares`/`fundUsdc` (top up sealed credit) and `requestWithdraw`→`claimWithdraw`
  (async threshold-decrypt then pay out).

With `C` and `D` never leaking, the public pair `(A=s·C·LT, B=s·scaledDebt)` is two equations
in three unknowns — under-determined — so `s`, `C`, `D` are no longer recoverable (the EQX-02
break relied on a public `D` to solve `s=B/D`). **Documented residual:** aggregate pool
balances and the fund/withdraw edge amounts remain observable; per-tx amount-unlinkability
would need a shielded pool (out of scope, noted in NatSpec).

**Per-finding fixes (all in `contracts/`):**
- **EQX-01** — `requestBorrow` gates on *remaining* room `select(lte(r, eMax−currentDebt), r, 0)`. Invariant `invariant_debtNeverExceedsLtvCapacity` + guard `test_EQX01_Guard_BorrowCappedByCollateral`.
- **EQX-03** — staleness guard (`isPriceStale`) added to `liquidate`; `healthFactorBps` stays a non-reverting view (UI reads it). `settleLiquidation` folded into the single-step `liquidate`, which is also guarded. Guard `test_EQX03_Liquidate_RevertsOnStaleOracle`.
- **EQX-04** — liquidation/health gate on `factorsSettledOnce` (the last *settled* factors), not the resettable `factorsReady`; price/interest worsening is reflected via the live `price`/index. Guard `test_EQX04_BorrowerCannotBlockOwnLiquidation`.
- **EQX-05** — `FHE.allow(handle, victim)` re-granted on the victim's rewritten balances. Guard `test_EQX05_Liquidation_VictimRetainsDecryptAcl` (checks `acl.isAllowed`).
- **EQX-06** — all intermediate products widened to `euint128`; manual `price` bounded (EQX-07). Factor handles are `euint128` and decrypt to their true value, neutralising a malicious large `s`. Guard `test_EQX06_LargeCollateral_NoOverflow`.
- **EQX-07** — `setPrice` bounded (absolute band `[MIN_PRICE, MAX_PRICE]` + 20% per-update deviation cap); large legitimate moves go through `syncPrice` (trusted Pyth adapter). `Deploy.s.sol` marked TESTNET/DEMO-ONLY with a runtime warning.
- **EQX-08** — removed the decorative encrypted bit; `register(uint256 expiry, bytes signature)`; honest NatSpec naming the attester signature as the sole gate.
- **EQX-09** — single-use `AlreadyRegistered` guard; bound digest + `msg.sender` make third-party replay impossible. Guard `test_Register_RevertsOnAlreadyRegistered`.
- **EQX-10** — removed the dead operator model from `FHERC20Wrapper`; updated README + deposit UI copy.
- **EQX-11** — `balanceOf` kept (intentional decoy) with a loud NatSpec warning that it is NOT ERC20 and must not be used for accounting.
- **EQX-12** — (a) liquidation reduces debt at the **live** index; (b) tiny-seize and (c) unused `liquidated` retained by design (documented); (d) the async claim arrays remain O(1)-indexed/append-only; (e) no action (upstream dependency — pin the version & assert the TaskManager address at deploy); (f) frontend now uses a CSPRNG blinding (`crypto.getRandomValues`) and documents the attester-signature TODO.

## 8.3 Verification evidence

- **`forge test`: 64/64 pass** (`via_ir`), including 3 invariants (collateral, scaled-debt, and the new LTV-capacity solvency invariant).
- **EQX-01 guard:** max extractable is now **239,400 USDC = the LTV cap ≤ 342,000 collateral value** (pre-fix: 957,600). The pool can no longer be drained.
- **EQX-02 guard:** the recovery formula no longer yields the planted `s`/`C`; borrowing disburses **0** public USDC; a decoy funded amount ≠ the sealed collateral.
- Both original PoCs were **inverted into regression guards** (`contracts/test/PoC_UnlimitedBorrow.t.sol`).

## 8.4 Notes / residual

- Confidentiality now depends on users **decoupling** fund/withdraw amounts & timing from
  their position sizes; full per-tx edge unlinkability needs a shielded pool/batching.
- `via_ir` was enabled (the sealed `euint128` math is local-variable heavy).
- Re-audit recommended after this remediation, per the original report's guidance — the
  confidential-settlement rewrite is substantial and touches the borrow/debt/liquidation core.
