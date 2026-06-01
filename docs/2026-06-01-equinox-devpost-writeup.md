# Equinox

*Private-by-default lending for tokenized real-world equities — without giving up trustless liquidation.*

## What it does

Equinox is a confidential lending protocol for tokenized equities (RWA dShares like dTSLA, dAAPL), live on **Arbitrum Sepolia**. Your collateral, debt, and leverage stay **encrypted on-chain** as `euint64` ciphertext via **Fhenix CoFHE** — never publicly decrypted — yet liquidation stays permissionless.

Deposit one of **18 dShare assets**, borrow against sealed collateral — every op runs homomorphically. Collateral C and debt D are never revealed; the protocol publishes only **blinded factors** `A = s·C·LT` and `B = s·D`, where `s` is a secret per-user blind. Anyone liquidates from **public values only**: `HF = (A·P)/(B·I)`. Because `s` is in **both** A and B it **cancels**, so HF needs no decryption of C or D (`HF < 1` ⇒ liquidatable). That's the wow: **solvency enforced on fully-encrypted positions.**

## The problem it solves

Tokenized equities are moving on-chain — but every DeFi lending position is **fully public**: anyone reads your collateral, debt, leverage, and exact liquidation price. For real stocks that's a non-starter — it invites strategy leakage, copy-trading, front-running, and liquidation hunting, and blocks institutions that need confidentiality. Prior "private" designs trust a central operator or break composability. Equinox keeps positions **encrypted end-to-end on-chain** while preserving permissionless liquidation — privacy without surrendering DeFi's guarantees.

## Challenges I ran into

- **SDK ↔ testnet version skew.** cofhejs@0.3.1 (tfhe-rs 0.11.1) couldn't deserialize the coprocessor's public key — a 64-bit int overflowed a 32-bit `usize`. Fixed by moving to **@cofhe/sdk@0.5.2** (tfhe-rs 1.5.3).
- **`FHE.decrypt` was removed** in 0.1.x; the obvious `createDecryptTask` reverted empty. The fix: `FHE.allowPublic(handle)`, then read back through the threshold network with an **`FHE.verifyDecryptResult` proof**.
- **Arbitrum L2 gas.** Proof-carrying claims hit OOG — Arbitrum folds L1-calldata cost into the L2 limit while `eth_estimateGas` snapshots a stale base fee. Fixed with an explicit `estimate·2 + 300k`.
- **EIP-170 24KB limit.** A new function pushed the impl past 24,576 bytes; the fix was `optimizer_runs 200→1` — optimize for size, not runtime gas.

## Technologies I used

- **FHE:** Fhenix CoFHE via `@fhenixprotocol/cofhe-contracts` 0.1.3; ops hit the live CoFHE **coprocessor**; client encrypt/decrypt via `@cofhe/sdk` 0.5.2.
- **Contracts:** Solidity 0.8.25, Foundry, **UUPS** proxies, OpenZeppelin AccessControl + Pausable + ReentrancyGuard, ERC-7201 storage, SafeERC20.
- **Oracle:** real **Pyth** pull-feed (staleness + confidence guards, exponent-normalized); Hermes for live prices, Benchmarks for the 24h anchor.
- **Frontend:** Vite + React + TypeScript; **RainbowKit + wagmi + viem**; a "web3 seam" so mock and real-chain services swap.

## How we built it

- **Branchless by design.** Borrow is an `FHE.select` gate — over-limit silently draws **0** (a revert would leak the position); we clamp with `FHE.min/lte/select`, never `if`.
- **Liquidation** is 2-step request→settle; repay is capped homomorphically to the **50% close factor**, seize clamped to collateral; **multi-collateral HF** aggregates across all held dShares.
- **Interest:** scaled-debt model, per-second index, **kink-80%** rate curve, supply index + **15% reserve** for LP yield. A **weekend breaker** (Fri 21:00→Mon 13:30 UTC) haircuts HF 15% when markets close.
- **FHERC20Wrapper:** a non-transferable confidential **ERC-7984** token — sealed `euint64`, ERC-165 marker, transfers revert, keccak `balanceOf` decoy. KYC is attester-ECDSA gated (validity an `ebool`).

Rigor: **46/50 Foundry tests**, an **invariant suite** matching sealed state to a plaintext ghost ledger over 384 fuzzed calls, ~95% pool coverage, and an independent **FHE-authenticity audit at 8.62/10 — GENUINE**.

## What we learned

- **FHE on a real L2 is a moving target** — SDK, coprocessor, and contracts must be co-versioned; most "bugs" were version skew, not logic.
- **Encryption forces branchless design** — no leaking reverts, `select/min/lte` clamps, and a deliberate sealed-vs-public split.
- The hardest question wasn't "how to encrypt" but **"what minimal public projection keeps the protocol solvent"** — the blinding primitive is the answer.

## What's next for Equinox

- **Close the static-blinding leak:** A and B reveal each borrower's collateralization *ratio* (never the amounts). Re-blind `s` via `FHE.randomEuint64` so the ratio stays private.
- **Harden for funds:** governance → TimelockController + multisig; Chainlink L2 sequencer-uptime gate; external tier-1 audit + Immunefi bounty.
- **Scale:** ERC-4626 LP vault; subgraph + monitoring + keeper infra; more collateral types.
- Resolve the **browser-FHE testnet skew** with Fhenix so the full flow runs in-browser, not just the node SDK.
