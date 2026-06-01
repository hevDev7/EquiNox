# Equinox — Confidential Equities Lending Primitive (mock dapp)

A Vite + React + TypeScript front end for Equinox, a confidential RWA-equities
lending protocol (FHE on Arbitrum Sepolia via Fhenix CoFHE). This pass is
**fully mocked** — no real wallet or contracts — but every chain interaction is
routed through a service interface so the real CoFHE/wagmi layer can be dropped
in later without touching UI code.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit + vite build
npm run preview    # serve the production build
```

## What's here

The full PRD flow, all with mock data:

- **Connect gate** → **Selective Disclosure KYC** (signature encrypted as `ebool`)
- **Borrower dashboard** — sealed collateral/debt/limit values, the **blinded
  Health-Factor gauge**, and a "what the chain sees" panel showing the
  `Aᵢ = sᵢ·Cᵢ·LT` / `Bᵢ = sᵢ·Dᵢ` blinding primitive
- **Deposit & wrap** (ERC-20 → sealed collateral; fund the plaintext edge, then move a
  *sealed* amount into collateral; random non-ERC20 `balanceOf()` decoy)
- **Confidential borrow** (`FHE.select` gate: over-limit draws 0, no revert; proceeds
  credited to a *sealed* USDC balance, realized via the async withdraw-claim edge)
- **Repay & delayed unwrap** (claim-based threshold-decryption pattern)
- **Liquidator console** — computes HF from public `Aᵢ, Bᵢ` only; `sᵢ` cancels
- **Weekend circuit breaker** — auto-detects Fri 21:00 → Mon 13:30 UTC (toggle a
  simulation from the Tweaks panel, bottom-right) with a 15% haircut
- **Tweaks panel** — theme (Sterling/Obsidian/Vellum), privacy accent, sealed-value
  render mode (cipher/decimal/redacted), density, weekend simulation

## Architecture

```
UI components ─▶ services/EquinoxService  ─▶ MockEquinoxService (now) | CofheEquinoxService (later)
              ─▶ services/WalletService ─▶ MockWalletService (now) | wagmi adapter (later)
```

- `src/lib/` — `protocol.ts` (constants + the blinding/HF math), `mock-data.ts`
  (reference assets, positions, accounts — PRD testnet addresses kept as
  constants), `format.ts`, `icons.tsx`.
- `src/services/` — the **web3 seam**. `types.ts` defines `EquinoxService` and
  `WalletService`; the `mock-*` files implement them in-memory with simulated
  coprocessor latency. Swap these by implementing the same interfaces and
  overriding `ServiceCtx` in `src/context/ServiceContext.tsx`.
- `src/components/` — `primitives`, `health`, `onboarding`, `layout`, `tweaks`,
  and `borrower/` + `liquidator`.

## Smart contracts (`contracts/`)

Foundry + Fhenix CoFHE (`@fhenixprotocol/cofhe-contracts` 0.0.13). `KYCRegistry`
(attester-ECDSA gate), `EquinoxPool` (**confidential settlement**: sealed
collateral/debt + a sealed USDC/share credit ledger, no public decrypt of position
values; blinded public factors A=s·C·LT / B=s·D, `FHE.select` borrow gate that
subtracts outstanding debt, weekend breaker, single-step permissionless liquidation),
`FHERC20Wrapper` (confidential `euint64` balances, non-ERC20 `indicatorOf` decoy, FHERC20/ERC-7984 markers, non-transferable, delayed unwrap),
and mock USDC/dShares. A security audit + remediation lives in
`docs/2026-05-31-equinox-security-audit.md`. Compiles and all tests pass against the
CoFHE mocks (`via_ir`):

```bash
cd contracts && forge test -vv
forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --private-key $PK --broadcast
```

See `contracts/README.md`.

## Wallet connection (RainbowKit — real)

Wallet connection is **real** via **RainbowKit + wagmi** on Arbitrum Sepolia
(`src/config/wagmi.ts`, providers in `src/main.tsx`). The connect gate opens the
RainbowKit modal; once connected, the in-app header shows the account / network
control (with wrong-network handling). Set a WalletConnect projectId in `.env`
(`VITE_WC_PROJECT_ID`, free at https://cloud.reown.com) for WalletConnect/mobile;
injected wallets like MetaMask work without it.

## Real chain layer

Contract calls live behind the same service interface in
`src/services/cofhe-equinox-service.ts` (viem clients sourced from the connected
RainbowKit wallet + `cofhejs` for client-side encryption). ABIs in `src/abi/`,
addresses in `src/config/contracts.ts` (Vite env).

**Go fully real:**
1. `cd contracts && forge script script/Deploy.s.sol:Deploy --rpc-url <ARB_SEPOLIA_RPC> --private-key <PK> --broadcast`
2. Put the logged addresses + `VITE_USE_REAL_CHAIN=true` + `VITE_WC_PROJECT_ID` in `.env` (see `.env.example`).
3. `npm run dev` — connect via RainbowKit, then KYC/deposit/borrow hit the contracts.

> Type-checks and builds today. With `VITE_USE_REAL_CHAIN=false` (default), the
> wallet still connects for real but protocol actions are simulated by the mock so
> the app is fully usable before deploying. Enabling the real layer pulls in
> `cofhejs`' tfhe wasm (~3.4 MB).

See `docs/superpowers/specs/2026-05-30-equinox-dapp-design.md` for the full design.
The original visual prototype lives in `Desain/`.
