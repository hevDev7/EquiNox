# Equinox — Fhenix CoFHE / FHE Implementation Authenticity Audit

## 1. Executive Summary

**Bottom-line verdict: GENUINE (with one PARTIAL dimension).** The Fhenix CoFHE technology in Equinox is genuinely implemented, not decorative, mocked-only, or faked. All confidential state — per-user collateral, scaled debt, idle credit, and the blinding secret — lives in real `euint64`/`euint128` ciphertext handles, and every position-mutating operation (deposit, borrow, repay, withdraw, liquidate, wrap, unwrap) executes homomorphically (`FHE.add`/`sub`/`mul`/`div`/`min`/`lte`/`select`) against the authentic `@fhenixprotocol/cofhe-contracts@0.1.3` library, whose ops dispatch to the live CoFHE TaskManager coprocessor at `0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9`. No position value is ever publicly `FHE.decrypt`'d; reveals are confined to a sound threshold-decrypt + `verifyDecryptResult` proof model at the token edges, and to deliberately-blinded health factors. **Overall score: 8.62 / 10** (mean of the eight verifier-adjusted scores: 10, 9, 8, 8, 9, 7, 9, 9). **Does it use FHERC20 and real CoFHE primitives?** Yes — `FHERC20Wrapper.sol` is a genuine non-transferable confidential FHERC20 (sealed `euint64` balance + ERC-165 marker), and the contracts and front-end use real CoFHE primitives (encrypted types, homomorphic arithmetic, branchless `select`/`min` guards, the `allowThis`/`allowSender`/`allow`/`allowPublic` ACL model, threshold decryption with proof verification, and `@cofhe/sdk@0.5.2` client-side encrypt/unseal). The single non-GENUINE dimension is **end-to-end privacy soundness (PARTIAL)**: the design deliberately publishes per-account blinded factors `A`/`B`, exposing the exact collateralisation ratio of every borrower — a documented, by-design confidentiality boundary, not a faked implementation.

## 2. Scope & Methodology

**Artifacts audited:**

Smart contracts (`contracts/src`):
- `EquinoxPoolV2.sol` — main confidential lending pool (current/deployed, UUPS upgradeable)
- `EquinoxPool.sol` — V1 pool (legacy)
- `FHERC20Wrapper.sol` — confidential FHERC20 / ERC-7984-style wrapper
- `KYCRegistry.sol` — attester-gated KYC
- `oracle/IOracle.sol`, `oracle/PythOracleAdapter.sol` — Pyth price feed path
- Tests: `test/PoolV2Fhe.t.sol`, `test/FHERC20Wrapper.t.sol`, `test/LpEconomics.t.sol`

Front-end (`src`):
- `lib/cofhe.ts` — `@cofhe/sdk` client init, encrypt, unseal, permit lifecycle
- `services/cofhe-equinox-service.ts` — real-chain service wiring
- `context/ServiceContext.tsx` — real-vs-mock service selection
- `components/primitives.tsx` — `SealedValue` cosmetic scramble

**Genuine dependencies verified on disk:**
- `@fhenixprotocol/cofhe-contracts` pinned at `0.1.3` (`contracts/package.json:7`), installed package authored by `FhenixProtocol` (`node_modules/@fhenixprotocol/cofhe-contracts/package.json:1-7`)
- `@cofhe/sdk` pinned `^0.5.2` (`package.json:14`), installed at `0.5.2`
- Official test harness `@cofhe/foundry-plugin` / `@cofhe/mock-contracts@0.5.2` (`CofheTest`)

**Method — multi-agent finder → adversarial verifier.** Each of 8 dimensions was first examined by a *finder* agent (producing a verdict, score, cited evidence, concerns), then independently re-examined by an *adversarial verifier* who re-read every load-bearing `file:line`, actively hunted for the classic fakes (plaintext leaks, missing/over-broad ACL grants, non-resolving FHE calls, mock-only illusions, no-op `verifyDecryptResult` stubs), and adjusted the verdict/score where warranted. **Where finder and verifier disagree, this report follows the verifier's adjusted verdict and score**, while reporting both honestly. All scores below are verifier-adjusted.

## 3. Verdict-at-a-Glance

| Component / Dimension | Verdict | Score | One-line basis |
|---|---|---|---|
| Dependency & FHE API authenticity | **GENUINE** | 10/10 | Authentic FhenixProtocol `cofhe-contracts@0.1.3`; real `bytes32` encrypted types; every op routes to live TaskManager; clean build resolves all calls. |
| FHERC20 / ERC-7984 wrapper | **GENUINE** | 9/10 | Sealed `euint64` balance only; non-transferable; threshold-decrypt unwrap gated by real `verifyDecryptResult`; 8/8 tests pass. |
| EquinoxPoolV2 confidential accounting | **GENUINE** | 8/10 | All position state sealed; branchless `min`/`select` clamps before every `sub`; only blinded `A`/`B` revealed; documented static-blinding weakness. |
| EquinoxPool V1 + oracle/Pyth | **GENUINE** | 8/10 | Same sealed model; public Pyth price lifted into `euint128` and used homomorphically; exact-ratio leak (medium); V1 FHE path untested. |
| ACL grants & threshold-decrypt flow | **GENUINE** | 9/10 | Every handle gets `allowThis`+owner-decrypt; `allowPublic` scoped to 4 deliberate handles; proof bound to handle+result+chainid; no cross-user grant. |
| End-to-end privacy soundness | **PARTIAL** | 7/10 | Amounts genuinely sealed, but public `factorA`/`factorB` expose every account's exact collateralisation ratio (by-design); absolute recovery conditional. |
| Mock-vs-real-chain reality | **GENUINE** | 9/10 | Tests run on official mock etched at the canonical TaskManager address; deployed to Arbitrum Sepolia (39 txs, all `0x1`); browser skew is upstream. |
| Front-end `@cofhe/sdk` integration | **GENUINE** | 9/10 | Live `arbSepolia` TESTNET; real `encryptInputs`→`InEuint64`; permit-gated `decryptForView`; every confidential arg is `struct InEuint64`. |

## 4. Detailed Findings per Dimension

### 4.1 Dependency & FHE API authenticity — **GENUINE (10/10)**

The dependency is the authentic FhenixProtocol library, not a look-alike or local fake.

- Pin: `"@fhenixprotocol/cofhe-contracts": "0.1.3"` (`contracts/package.json:7`); installed package metadata names `FhenixProtocol` / `github.com/FhenixProtocol/cofhe-contracts` (`node_modules/@fhenixprotocol/cofhe-contracts/package.json:1-7`).
- Encrypted types are real user-defined value types over ciphertext handles, **not** uint aliases: `type ebool is bytes32; ... type euint64 is bytes32; type euint128 is bytes32; type eaddress is bytes32;` (`FHE.sol:9-15`).
- Ops dispatch to the live coprocessor: `address constant TASK_MANAGER_ADDRESS = 0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9;` (`FHE.sol:23`); `Impl.mathOp` forwards to `ITaskManager(TASK_MANAGER_ADDRESS).createTask(...)` (`FHE.sol:130-131`); `Impl.verifyDecryptResult` calls the real `ITaskManager.verifyDecryptResult` view — **not a `return true` stub** (`FHE.sol:158-159`).
- All three contracts import the genuine path `import "@fhenixprotocol/cofhe-contracts/FHE.sol";` (`EquinoxPoolV2.sol:4`, `FHERC20Wrapper.sol:4`); `foundry.toml:20` remaps to `node_modules` with **no vendored shim**, and `grep` in `src/` finds no local `library FHE` / `type euint` / shadow `TASK_MANAGER` redefinition.

**Adversarial verifier:** Agreed — **GENUINE / 10**, no refuted claims. The verifier hunted three downgrade vectors and refuted all: (1) a no-op stubbed `verifyDecryptResult` — refuted, it calls the TaskManager view; (2) a shadow local FHE library masking unresolved calls — refuted, `grep` returns nothing; (3) the duplicate `allow*/min/lte` definitions at lines 4168+ being a conflicting shadow — refuted, they are the per-type `Bindings*` `using-for` sugar libraries dispatching to the same `Impl`. A clean `forge build` prints *"Compiler run successful!"* (EXIT 0) and produces artifacts, proving every `FHE.*` call resolves. `FHE.decrypt` and `FHE.randomEuint64` appear **only in comments/docstrings** (`EquinoxPoolV2.sol:52`; `FHERC20Wrapper.sol:173`) — `decrypt` was deliberately replaced by the threshold-decrypt flow; build success confirms no unresolved-symbol risk. Two info notes only (a minor mis-citation of line 948, and reliance on structural inspection rather than a published-hash checksum).

### 4.2 FHERC20 / ERC-7984 wrapper authenticity — **GENUINE (9/10)**

`FHERC20Wrapper.sol` is a genuine confidential FHERC20, not a decorative shell.

- Real holding lives only in `mapping(address => euint64) private _encBalance;` (`FHERC20Wrapper.sol:46`); the only exposure is the sealed handle via `confidentialBalanceOf(...) returns (euint64)` (`125-127`). No plaintext `balanceOf` exists.
- `wrap` credits via `FHE.asEuint64` + `FHE.add` and grants minimal ACL `allowThis` + `allowSender` (`105-112`).
- Delayed unwrap is a sound threshold pattern: `ebool ok = FHE.lte(amt, _encBalance[...]); euint64 take = FHE.select(ok, amt, FHE.asEuint64(0)); ... FHE.sub(...)` branchlessly clamps overspend (`163-167`), then `FHE.allowPublic(take)` schedules off-chain threshold decryption of *only the amount* (`172-174`).
- `claimUnwrapped` gates the underlying transfer on a real signature check: `if (!FHE.verifyDecryptResult(c.amount, amount, proof)) revert DecryptionPending();` (`186-188`) — not a backdoor; the amount cannot be forged.
- Non-transferable surface (`transfer`/`transferFrom`/`approve` revert `NonTransferable`, `148-158`), `isFherc20()` + ERC-165 `IConfidentialERC20Marker` (`138-145`), and `indicatorOf` keccak decoy (`119-121`) are correctly implemented.

**Adversarial verifier:** Agreed — **GENUINE / 9**, no refuted claims. The verifier re-ran `forge test --match-contract FHERC20WrapperTest` (8 passed, 0 failed), confirmed `_credit` grants `allowThis`+`allowSender` only (not `allowPublic`), that on unwrap only `take` (the public-by-necessity amount) is made global while `newBal` stays owner/contract-gated, and that all `FHE.*` calls dispatch to the real `ITaskManager`. Score held at **9 (not 10)** because wrap/unwrap edges are inherent confidentiality boundaries: deposit amounts are public (cleartext `safeTransferFrom`), the first-wrap balance is a `trivialEncrypt` of an already-public amount (`106`), and the unwrap amount becomes globally decryptable by design — all correctly handled but not zero-leak.

### 4.3 EquinoxPoolV2 confidential accounting authenticity — **GENUINE (8/10)**

A genuine, non-decorative use of CoFHE.

- Per-user state is all real ciphertext handles: `mapping(...) euint64 _eCollateral; ... _eScaledDebt; _eBlinding; _eUsdcCredit; ... euint128 _eA; _eB;` (`146-160`). The verifier `grep`'d for a plaintext shadow store and found **none**.
- Borrow clamps over-limit to ciphertext-0: `approved128 = FHE.select(FHE.lte(r, eRoom), r, FHE.asEuint128(0))` (`815-832`).
- Every position-decreasing `FHE.sub` is preceded by an `FHE.min`/`FHE.select` clamp so the silent-wrap subtraction cannot underflow — repay (`849-865`), withdraw (`760-774`), liquidate (`1053-1071`), free-room (`932-933`).
- Blinded factors play a real cryptographic role: `eA = FHE.mul(_eBlinding, ltSum); eB = FHE.mul(_eBlinding, _eScaledDebt)` (`942-944`); only these are made public via `FHE.allowPublic(eA); FHE.allowPublic(eB);` (`949-950`). Position-mutating events emit **no amount** (`227-234`).

**Adversarial verifier:** Agreed — **GENUINE / 8**, no refuted claims. The verifier independently re-read every citation, confirmed `allowPublic` is called on **exactly 4 handles** total (`eA`, `eB`, and two deliberate withdrawal `take` amounts at `678`/`780`) and that no raw position handle is ever world-decryptable, verified every `FHE.*` overload resolves in `v0.1.3`, and **re-ran `PoolV2Fhe.t.sol` (7/7 pass)** confirming `expectPlaintext` reads the mock TaskManager's genuinely-decrypted plaintext (e.g. over-cap borrow yields ciphertext-of-0, multi-asset aggregation yields 3000). The score of 8 reflects genuine, openly-documented weakenings: the client-supplied static blinding `s` (`FHE.randomEuint64` hardening exists only in a comment), the world-readable **exact** health factor, and an unproven `euint128` overflow bound on `s·Σ`.

### 4.4 EquinoxPool V1 + oracle/Pyth FHE surface — **GENUINE (finder 9 → verifier 8)**

V1 uses the same genuine encrypted-accounting pattern.

- Positions sealed as `euint64` (`EquinoxPool.sol:97-101`).
- Borrow compares sealed collateral against the **public** Pyth price without decrypting: the price is lifted into `euint128` and `FHE.mul`'d against sealed collateral, with `FHE.lte`/`FHE.select` deciding approval (`588-600`). This is correct — the oracle price is public market data by interface design (`IOracle.priceUSD() returns (uint64)`, `IOracle.sol:5-8`), never used to force a position decryption.
- Pyth adapter enforces `getPriceNoOlderThan(maxAge)`, positive-price, and a confidence-interval cap (`PythOracleAdapter.sol:31-36`).
- Only blinded `eA`/`eB` are `allowPublic`'d (`662-671`); settlement verifies coprocessor signatures via `FHE.verifyDecryptResult` (`684-686`).

**Adversarial verifier — downgraded 9 → 8.** The verifier confirmed the core GENUINE verdict (all FHE calls resolve; identical pattern proven correct in the V2 harness) but **refuted two finder framings as understated**: (1) the summary claim that "`C` and `D` are never revealed" is overstated — `factorA`/`factorB` are *public* state vars (`105-106`), so the ratio `factorA/factorB = C·LT_BPS/scaledDebt` is directly world-computable (s cancels), exposing every borrower's **exact effective LTV** — a real, always-on leak the finder rated info/low; the verifier raised it to **medium**. (2) The verifier added a **low** concern: V1's FHE position path has **zero test coverage** (only `LpEconomics.t.sol` exercises the public LP/interest math), so the finder's "high confidence" for V1 specifically is partly inferential on V1 sharing V2's primitives. Net: still GENUINE (FHE is real and functional), score trimmed to **8**.

### 4.5 ACL grants & threshold-decryption flow correctness — **GENUINE (9/10)**

The CoFHE ACL model is applied correctly and consistently across all three contracts.

- Every persisted handle gets `allowThis` (contract reuse) **and** `allowSender`/`allow(user)` (owner decrypt) — e.g. borrow (`EquinoxPoolV2.sol:824-832`), lazy-init slots (`599-609`), V1 init (`EquinoxPool.sol:457-465`), wrapper credit (`FHERC20Wrapper.sol:169-170`). No orphaned handles.
- `allowPublic` is scoped strictly to deliberate reveals: payout `take` (`678`, `780`; `FHERC20Wrapper.sol:174`; `EquinoxPool.sol:525`) and blinded factors `eA`/`eB` (`949-950`; `EquinoxPool.sol:670-671`).
- Decrypt proof is bound to the specific handle: `FHE.verifyDecryptResult(w.amount, amount, proof)` (`691`); the underlying mock binds `computeDecryptResultHash(ctHash, result, chainid)` + ECDSA recover against the trusted signer (`MockTaskManager.sol:539-547`).
- No cross-user grant: `MockACL.allow` reverts `SenderNotAllowed` unless the requester already owns the handle (`MockACL.sol:86-92`). Liquidation issues minimal ACL — victim retains decrypt on rewritten handles (`1061-1073`), liquidator gets only its own seized collateral + remaining credit (`1075-1083`).
- Front-end uses self-permits only: `decryptForView(handle, FheTypes.Uint64).withPermit().execute()` (`src/lib/cofhe.ts:170-172`).

**Adversarial verifier:** Agreed — **GENUINE / 9**, no refuted claims; all twelve confirmed verbatim. Two non-downgrading nuances surfaced: (1) `FHE.allowPublic` **is** `ITaskManager.allowGlobal` in the real library (`FHE.sol:3030-3039`) — the finder's "`allowPublic` *or* `allowGlobal`" phrasing implies two distinct primitives; harmless. (2) **Important test-assurance caveat:** the mock TaskManager/ACL contain debug bypasses — `_verifyDecryptResult` returns `true` when `decryptResultSigner==address(0)` (`MockTaskManager.sol:535-537`) and `verifyInput` skips the signer check when `verifierSigner==address(0)` — so the replay/substitution-proof binding is enforced only on the **live deployment**, not in the Foundry test harness. Contract code is correct; test-time assurance of the binding is weaker than the framing implies. The `-1` reflects the documented privacy residual plus this mock-only nature of the strongest test-time assurance.

### 4.6 End-to-end privacy soundness — **PARTIAL (finder 6.5 → verifier 7)**

The core sealing is genuine, but published health factors and plaintext token edges narrow positions below "fully confidential."

- **Genuine sealing (confirmed):** every position amount (per-asset `C_i`, scaled debt, idle credit) lives in `euint64`/`euint128`; all ops are branchless homomorphic clamps; **no position value is ever `FHE.decrypt`'d or emitted in plaintext** — position-mutating events carry only indexed addresses + ids (`227-234`). The secret `s` is correctly never made public — `initBlinding` grants only `allowThis`+`allowSender` (`580-585`). `KYCRegistry` is clean (boolean-only registration, off-chain identity, attester ECDSA — `KYCRegistry.sol:31-84`); `indicatorOf` is a genuine uncorrelated decoy.
- **Genuine leak (the reason for PARTIAL):** `mapping(address => uint256) public factorA / factorB` (`154-155`) are world-readable, and `healthFactorBps` recombines them so `s` cancels (`1004-1008`) — **the exact collateralisation ratio of every account is publicly computable**, not merely a liquidation bit. The held-asset *set* is also observable (the aggregation loop skips unset handles, `888-889`), and plaintext amounts appear at the `fundShares`/`fundUsdc`/`claimWithdraw` token edges (`618-646`, `232`, `693-700`).

**Adversarial verifier — adjusted 6.5 → 7.** The verifier confirmed the PARTIAL verdict and the exact-ratio leak as the genuine, unconditional reason it is not GENUINE, but **refuted the finder's HIGH-severity "absolute position recovery" claim as overstated**: `fundShares` credits an *idle* `_eShareCredit` handle (not collateral), the move into `C` is a *sealed* `deposit(InEuint64)`, and borrow proceeds are credited to *sealed* `_eUsdcCredit` — so the public funded amount is only an **upper bound** on `C`, never `C` itself. The finder quoted only the older pessimistic NatSpec (`42-50`) and omitted the **governing** note (`60-74`) stating the EQX-02 break was *closed* by sealed disbursement, making `(A, B)` an under-determined 2-equations-in-3-unknowns system. So absolute `C`/`D` recovery is **conditional/operational (medium)**, not an unconditional on-chain break. Net: PARTIAL confirmed; score nudged to **7** because the most severe claimed break is conditional, while the exact-ratio disclosure keeps it firmly out of GENUINE.

### 4.7 Mock-vs-real-chain reality — **GENUINE (9/10)**

The FHE is genuinely real, not mock-decorative.

- Tests use the **official** Fhenix `CofheTest` harness (`PoolV2Fhe.t.sol:4-17`), which etches the mock at the **same canonical address** the production library calls: `deployCodeTo('MockTaskManager.sol:MockTaskManager', TASK_MANAGER_ADDRESS)` (`CofheTest.sol:42-43`). Passing tests therefore exercise the identical on-chain call path.
- 15 FHE tests pass with realistic precompile-task gas (8–20M); the mock performs **genuine** masked homomorphic arithmetic (`MockCoFHE.sol` `add`/`div`/`select`), so `expectPlaintext(pool.encryptedUsdcCreditOf(user), 3000)` (`104-110`) is a real semantic assertion, not a no-op echo.
- The V2 pool (125 `FHE.*` calls) was deployed to Arbitrum Sepolia chain 421614 behind a UUPS proxy — `DeployV2.s.sol/421614/run-latest.json` has 39 txs all status `0x1` (blocks 272406053–272406344).

**Adversarial verifier:** Agreed — **GENUINE / 9**, no refuted claims. The verifier ran the strongest adversarial test — whether the mock computes real homomorphic results or echoes inputs — and confirmed `MockCoFHE.sol:260-445` performs genuine masked arithmetic. Two honest residuals justify holding at 9 (not raising): (1) **no committed live state-changing round-trip** — every broadcast artifact contains only CREATE/CALL deploy+config txs; the only evidence a live FHE tx works is the memory note's manual `initBlinding` success, so a full borrow round-trip on the real coprocessor is asserted-correct but not evidenced by a reproducible artifact; (2) the blinded `eA`/`eB` are intentionally `allowPublic`, a documented by-design confidentiality boundary at the factor layer (the same leak as 4.6). The **browser-decrypt failure is attributed to an external upstream `tfhe-rs`/`cofhejs` version skew**, resolved by migrating to `@cofhe/sdk@0.5.2` — the project code is correct.

### 4.8 Front-end `@cofhe/sdk` integration authenticity — **GENUINE (9/10)**

A real Fhenix CoFHE dApp client.

- SDK initialised for web against the **live** `arbSepolia` TESTNET via real `createCofheClient`/`createCofheConfig` (`src/lib/cofhe.ts:41-48`); the verifier read the compiled bundle to confirm `arbSepolia` is `environment:'TESTNET'` bound to live Fhenix coprocessor URLs (`testnet-cofhe.fhenix.zone` etc.) — **not a MOCK chain**, ruling out the mock-illusion downgrade.
- Inputs are genuinely encrypted client-side: `encryptInputs([Encryptable.uint64(value)]).execute()` → `InEuint64`-shaped struct (`117-120`); `SealedInput {ctHash, securityZone, utype, signature}` maps 1:1 to the on-chain `struct InEuint64` ABI components in correct order (`26-31`). Every confidential write arg (`requestBorrow`/`deposit`/`initBlinding`/`withdrawCollateral`/`repay`/`liquidate`) is a `struct InEuint64`, never plaintext.
- Owner-only sealed reads via permit-gated `decryptForView(handle, FheTypes.Uint64).withPermit().execute()` (`170-177`); real self-permit lifecycle via `getActivePermit`/`removeActivePermit`/`getOrCreateSelfPermit` (`73-101`). Threshold decrypt for the claim edge via `decryptForTx(handle).withoutPermit().execute()` returning value + proof (`189-196`).
- Production wiring selects the **real** `CofheEquinoxService` (`ServiceContext.tsx:16-18`, `VITE_USE_REAL_CHAIN=true` with live addresses); `SealedValue` is a cosmetic scramble of already-decrypted values, not a stand-in.

**Adversarial verifier:** Agreed — **GENUINE / 9**, no refuted claims. Beyond trusting citations, the verifier confirmed every SDK symbol/method exists at `@cofhe/sdk@0.5.2`, return types match the code's reads, and the uncommitted git diffs are benign UI/unknown-handling logic with no plaintext fabrication or mock fallback. One added **low** concern narrows the finder's framing: deposit/repay/liquidate move tokens in **plaintext** at the fund edge (`fundShares(assetId, shares)` etc.) *before* the value is sealed, so those input amounts are public — an inherent fund-then-seal protocol boundary, not SDK misuse. The `-1` reflects this fund-edge exposure that "every confidential input encrypted" glosses over.

## 5. Genuine FHE Technology Checklist

| Capability | Present? | Evidence (`file:line`) |
|---|---|---|
| Real `@fhenixprotocol/cofhe-contracts` dependency | ✅ | `contracts/package.json:7` (`0.1.3`); `node_modules/.../package.json:1-7` (author `FhenixProtocol`) |
| Encrypted types `euint64` / `euint128` / `ebool` (real `bytes32` handles) | ✅ | `FHE.sol:9-15`; `EquinoxPoolV2.sol:146-160`; `FHERC20Wrapper.sol:46` |
| Homomorphic arithmetic `add`/`sub`/`mul`/`div` | ✅ | `EquinoxPoolV2.sol:815-832` (borrow), `849-865` (repay), `942-944` (blinded factors); `FHE.sol:281-2211` |
| Homomorphic `min` | ✅ | `EquinoxPoolV2.sol:849`, `1053-1071`; `FHERC20Wrapper.sol` unwrap clamp |
| Branchless guards `FHE.select` / `FHE.min` (no decrypt-and-branch) | ✅ | `EquinoxPoolV2.sol:815` (`select`/`lte`), `760-774` (withdraw), `932-933` (free-room); `FHERC20Wrapper.sol:163-167` |
| Encrypted comparisons `lt`/`lte` → `ebool` | ✅ | `EquinoxPoolV2.sol:815`, `932`; `FHERC20Wrapper.sol:164`; `EquinoxPool.sol:588-600` |
| ACL model `allowThis` / `allowSender` / `allow` / `allowPublic` | ✅ | `EquinoxPoolV2.sol:824-832`, `599-609`, `949-950`; `FHERC20Wrapper.sol:169-174`; `EquinoxPool.sol:457-465` |
| Threshold decryption (`allowPublic` + `verifyDecryptResult` + proof) | ✅ | `EquinoxPoolV2.sol:691`, `976-977`; `FHERC20Wrapper.sol:186`; binding at `MockTaskManager.sol:539-547` |
| FHERC20 confidential balance + ERC-165 marker | ✅ | `FHERC20Wrapper.sol:46`, `125-127` (sealed balance), `138-145` (`isFherc20`/ERC-165) |
| Plaintext oracle price lifted into encrypted domain | ✅ | `EquinoxPool.sol:588-600`; `EquinoxPoolV2.sol:767-770` (`FHE.asEuint128(uint256(price))` then `FHE.mul`) |
| Encrypted blinding `FHE.randomEuint64` | ⚠️ **Not implemented** | Referenced **only in a docstring** (`EquinoxPoolV2.sol:52`); blinding `s` is client-supplied (`initBlinding(InEuint64 encS)`, `574-585`) — the documented on-chain re-randomisation hardening is **not yet applied** |
| Front-end `@cofhe/sdk` encrypt + unseal | ✅ | `src/lib/cofhe.ts:117-120` (`encryptInputs`), `170-177` (`decryptForView` + permit), `189-196` (`decryptForTx`) |

All listed CoFHE capabilities are genuinely present **except** on-chain `FHE.randomEuint64` blinding, which is documented-as-planned but not wired; blinding is currently a client-supplied static `euint64`.

## 6. Concerns & Findings (deduplicated, severity-sorted)

> **There are NO CRITICAL findings and NO BROKEN dimensions.** The FHE is real, resolves, computes correctly, and seals amounts. The highest-severity items are *confidentiality/soundness* tradeoffs that the contract documents itself, plus general-security and test-assurance hygiene items.

### Confidentiality / Soundness concerns

| Severity | Concern | `file:line` |
|---|---|---|
| **High** | **Exact collateralisation-ratio leak.** `factorA`/`factorB` are public `uint256` mappings and `eA`/`eB` are `allowPublic`; `healthFactorBps` cancels `s`, so the **exact** health/leverage ratio (and liquidation eligibility) of *every* account is world-computable — richer than the minimal liquidation bit a strict confidential primitive would expose. | `EquinoxPoolV2.sol:154-155, 949-950, 1004-1008`; `EquinoxPool.sol:105-106, 670-671, 707-714` |
| **High (finder) → Medium (verifier)** | **Conditional absolute-position recovery.** Plaintext fund/withdraw edges combined with public `A`/`B` *could* recover `s` and absolute `C`/`D` — **but only** if a user funds-then-deposits (or borrows-then-withdraws) the same amount in one un-decoupled tranche. Because disbursement and the move-to-collateral are sealed, `(A,B)` is unconditionally an under-determined 2-eq/3-unknown system; the EQX-02 break is documented-closed at `EquinoxPoolV2.sol:60-74`. Verifier downgraded to **medium/conditional**. | `EquinoxPoolV2.sol:42-50 (old note), 60-74 (governing), 618-646` |
| **Medium** | **Static client-supplied blinding `s` + cross-settlement differencing.** `s` is client-generated, persisted to localStorage, and constant across pokes (never re-randomised); the `FHE.randomEuint64` hardening exists only in a comment. Combined with public prices and the leaked held-asset set, repeated settlements yield linear equations in `s·C_i`. Single point of failure for the whole guarantee. | `EquinoxPoolV2.sol:42-55, 574-580, 942-961` |
| **Medium** | **Held-asset-set metadata leak.** The aggregation loop skips unset per-asset handles (`if euint64.unwrap(c)==bytes32(0) continue`), so the precise set of dShares a user holds collateral in is observable; only the amounts are sealed. | `EquinoxPoolV2.sol:36-40, 888-889` |
| **Medium** | **Per-tx amount-unlinkability absent at token edges.** Every `fundShares`/`fundUsdc`/`claimWithdraw` (and wrapper `wrap`/`unwrap`) exposes a plaintext amount tied to `msg.sender`; privacy degrades to the user's operational discipline. Inherent to a non-shielded primitive, not a defect. | `EquinoxPoolV2.sol:232, 618-646, 693-700`; `FHERC20Wrapper.sol:97-103, 181-189` |
| **Low** | **`euint128` overflow bound unproven.** `s·Σ` products feeding `_eA`/`_eB` are `euint128` with no proven overflow bound (the header itself flags this); a sufficiently large product could silently wrap and corrupt a published HF. | `EquinoxPoolV2.sol:818, 943-944, 1054` |

### General security / engineering concerns

| Severity | Concern | `file:line` |
|---|---|---|
| **Low** | **V1 FHE path is entirely untested.** Only `LpEconomics.t.sol` exercises V1's *public* LP/interest math; no `createInEuint64`/`expectPlaintext` touches V1's sealed `initBlinding`/`deposit`/`borrow`/`liquidate`. Confidence in V1's homomorphic math is inferential on it sharing V2's primitives. | `LpEconomics.t.sol:9, 160-179` |
| **Low** | **Mock harness debug bypasses weaken test-time proof assurance.** `MockTaskManager._verifyDecryptResult` returns `true` when `decryptResultSigner==address(0)`, and `verifyInput` skips the signer check when `verifierSigner==address(0)`. The replay/substitution-proof binding is enforced only on the live deployment, **not** in Foundry tests. (Production targets the real on-chain TaskManager, so contract code is correct.) | `MockTaskManager.sol:535-537, 562-573` |
| **Low** | **No committed live coprocessor round-trip artifact.** All broadcast files contain only CREATE/config txs (all status `0x1`); the only evidence a live state-changing FHE tx works is the memory note's manual `initBlinding`. Tampered-proof rejection in `claimUnwrapped` is also not unit-testable under the mock. | `broadcast/DeployV2.s.sol/421614/run-latest.json`; `FHERC20Wrapper.t.sol:82-84` |
| **Low** | **Unbounded junk claims on overspend.** `requestUnwrap` pushes a claim even when the encrypted guard zeroes `take` (no-op, decrypts to 0, leaks nothing), growing the unbounded `claims` array on griefing attempts. Storage-hygiene item, not a confidentiality bug. | `FHERC20Wrapper.sol:176-177` |
| **Info** | **Cosmetic layers are not the security boundary.** `SealedValue` scramble (`primitives.tsx:25-28`) and the localStorage `s` are explicitly cosmetic; the real secrecy comes from on-chain `euint` handles + permit-gated decrypt. | `cofhe-equinox-service.ts:43-62`; `src/components/primitives.tsx:25-28` |
| **Info** | **`KYCRegistry` and `indicatorOf` confirmed clean** (boolean-only registration, off-chain identity, attester ECDSA gate; uncorrelated keccak decoy). Included to confirm these surfaces do **not** leak. | `KYCRegistry.sol:31-84`; `FHERC20Wrapper.sol:119-121` |

## 7. Honest Limitations

- **Mock vs live chain.** The Foundry test suite (15 FHE tests passing) runs against the **official** Fhenix `CofheTest` mock etched at the canonical TaskManager address (`CofheTest.sol:42-43`), and the mock performs genuine masked homomorphic arithmetic — so passing assertions exercise the real `FHE.sol → ITaskManager` call path that runs *unchanged* on the live coprocessor. However, the mock contains debug signer-bypasses (`MockTaskManager.sol:535-537`), so the decrypt-proof binding and input-proof verification are only enforced on the live deployment, not in tests. No committed broadcast artifact captures a live *state-changing* coprocessor round-trip (deploys are all `0x1`, but `initBlinding`/`deposit` round-trips are evidenced only by an operator memory note, not a reproducible transaction).
- **External `cofhejs`/`tfhe-rs` version skew.** A prior browser-FHE failure was caused by a `cofhejs@0.3.1` vs live-testnet `tfhe-rs` version skew — **external to this project's code**. The codebase migrated to `@cofhe/sdk@0.5.2` (bundling a matching `tfhe` runtime); the front-end's encrypt path, permit lifecycle, and `decryptForView`/`decryptForTx` calls all resolve against the shipped SDK, and failures surface as `debtUnknown`/`unreadableCollateral` rather than fabricated zeros (the prior silent-zero bug is fixed via the `null`/`debtUnknown` path, `cofhe-equinox-service.ts:603-611`). Any residual non-working browser decrypt is attributable to upstream testnet infra compatibility, **not** to incorrect project code.

## 8. Conclusion & Recommendations

**Direct answer to the user's question: the Fhenix CoFHE technology is GENUINELY implemented — it is real, not decorative, mocked-only, or faked.** Equinox uses the authentic `@fhenixprotocol/cofhe-contracts@0.1.3` and `@cofhe/sdk@0.5.2`; encrypted types are real `bytes32` ciphertext handles; all confidential accounting is performed homomorphically with branchless `select`/`min` guards; the ACL model and threshold-decrypt + `verifyDecryptResult` proof flow are applied correctly; and `FHERC20Wrapper` is a genuine non-transferable confidential FHERC20. A clean compile and 15 passing FHE tests on the official Fhenix harness prove every `FHE.*` call resolves and computes the correct homomorphic result, and the V2 pool is deployed live on Arbitrum Sepolia. **Overall: GENUINE, 8.62 / 10.** The one dimension below GENUINE — end-to-end privacy soundness (PARTIAL) — reflects a *deliberate, self-documented* design tradeoff (public blinded health factors), not a faked or broken implementation. Amounts are genuinely sealed; the position's *risk ratio* is intentionally public so any keeper can settle liquidation eligibility off-chain.

**Prioritized recommendations:**

1. **(High) Reduce the public-factor disclosure from the exact ratio to the liquidation bit.** Today `factorA`/`factorB` expose every account's exact effective LTV. Decrypt only a single `ebool` "liquidatable" per account (e.g. `FHE.lte(eMax_weighted, eDebt_weighted)`), or apply per-account multiplicative noise that survives the binary test but breaks the ratio, so observers learn *whether*, not *how leveraged*, an account is.
2. **(High) Implement the documented on-chain blinding hardening.** Replace the client-supplied static `s` with a fresh `FHE.randomEuint64()` nonce re-randomised on every factor recompute (`EquinoxPoolV2.sol:52`). This removes the localStorage trust assumption and defeats cross-settlement differencing of `s·C_i` over public price moves.
3. **(Medium) Add a proven `euint128` overflow bound** for the `s·Σ(C·price·LT)` products feeding `_eA`/`_eB`, or clamp `s` and the LT-weighted sum so the product provably stays `< 2^128`, eliminating the silent-wrap HF-corruption risk (`818, 943-944`).
4. **(Medium) Add FHE test coverage for the V1 pool's sealed path** (`initBlinding`/`deposit`/`requestBorrow`/`liquidate`) using `CofheTest`/`expectPlaintext`, so V1's homomorphic correctness is directly evidenced rather than inferred from V2.
5. **(Medium) Mitigate token-edge amount-linkability** with fixed-denomination tranches, batching, or a shielded settlement pool, and pre-initialise a fixed per-asset collateral vector to remove the held-asset-set metadata leak (`888-889`).
6. **(Low) Strengthen test-time proof assurance and operational evidence.** Run a subset of tests with non-zero mock signers to exercise the real `verifyDecryptResult`/`verifyInput` binding, and commit a reproducible live Arbitrum-Sepolia transaction (`initBlinding` → `deposit` → `requestBorrow`) artifact to evidence a full coprocessor round-trip beyond the operator memory note.
7. **(Low) Bound the `claims` array** by skipping the zero-`take` no-op push in `requestUnwrap` (`FHERC20Wrapper.sol:176-177`) to prevent storage bloat under griefing.
