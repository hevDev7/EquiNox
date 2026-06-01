# Equinox — Arbitrum Sepolia deploy & real-data runbook

This takes the dapp from "mock demo" to **every displayed value sourced from
Arbitrum Sepolia**. You run the deploy steps (they need a funded key); the app
code is already wired for real reads (live Pyth prices, on-chain position
decrypt, real KYC attestation, on-chain liquidator account scan).

> ⚠️ Testnet only. The contracts are audit-ready but **unaudited** — do not put
> real funds in them. See `contracts/README.md`.

## 0. Prerequisites

- Foundry (`forge`), Node ≥ 18, a deployer EOA funded with Arbitrum Sepolia ETH.
- Testnet USDC from <https://faucet.circle.com> (token `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`).
- A WalletConnect projectId (<https://cloud.reown.com>).
- Decide a **KYC attester** EOA (its address is set on-chain; its key signs attestations).
- A **fresh, throwaway deployer** key (testnet ETH only) — never reuse a real key.

Put the deployer key in the **contracts** env (gitignored — NOT the frontend `.env`):

```bash
cd contracts
cp .env.example .env          # then edit .env and paste PRIVATE_KEY=0x...
source .env                   # exports PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC, roles…
```

> 🔐 Safer alternative (no plaintext key on disk): `cast wallet import deployer
> --interactive`, then swap `--private-key $PRIVATE_KEY` for `--account deployer`
> in every command below.

## 1. Deploy the mock collateral basket (testnet)

The richer 18-token basket only feeds the Markets list cosmetically — the demo
pool below wires its own single collateral token, so this step is optional.

```bash
forge script script/DeployMocks.s.sol:DeployMocks \
  --rpc-url $ARBITRUM_SEPOLIA_RPC --private-key $PRIVATE_KEY --broadcast
```

## 2. Deploy the protocol

**Demo** (single EOA holds all roles, manual oracle price). This script deploys
its **own** `MockDShares` collateral token — note the printed address; it becomes
`VITE_DSHARES`. (`DSHARES` env is ignored here.)

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $ARBITRUM_SEPOLIA_RPC --private-key $PRIVATE_KEY --broadcast
```

**Production-shaped** (timelock + multisig + Pyth oracle adapter). Reads
`MULTISIG`, `PYTH`, `TSLA_FEED_ID`, `DSHARES`, `KYC_ATTESTER` from your `.env`:

```bash
forge script script/DeployProduction.s.sol:DeployProduction \
  --rpc-url $ARBITRUM_SEPOLIA_RPC --private-key $PRIVATE_KEY --broadcast
```

Record the deployed **EquinoxPool / KYCRegistry / FHERC20Wrapper** addresses, the
collateral token address, and the **block number** of the pool deploy tx.

## 3. Wire the oracle & seed liquidity

- Production: via the timelock/Safe, call `pool.setOracle(<PythOracleAdapter>)`,
  then push a fresh price (`PythOracleAdapter.updateAndRead(updateData)` with the
  Pyth update fee as `msg.value`, or a keeper running `pool.syncPrice()`).
- Demo: as `ORACLE_MANAGER_ROLE`, call `pool.setPrice(<wholeUSD>)` (bounded:
  ≤20% move/update, 1 ≤ price ≤ 1,000,000). The price must be fresher than 60s
  for `requestBorrow`/`liquidate` to succeed.
- Transfer testnet USDC into the pool so borrows can be withdrawn.

## 4. Run the KYC attester (testnet stand-in)

```bash
ATTESTER_PRIVATE_KEY=0x<attester-key> node scripts/attester.mjs
# → signing as 0x<KYC_ATTESTER> on http://localhost:8787/
```

The signer's address **must equal** the on-chain `KYC_ATTESTER`. In production,
replace this with your KYC provider's attested signing endpoint.

## 5. Point the frontend at the deployment

Copy `.env.example` → `.env` and fill:

```ini
VITE_USE_REAL_CHAIN=true
VITE_WC_PROJECT_ID=<reown-project-id>
VITE_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc

VITE_EQUINOX_POOL=0x...
VITE_KYC_REGISTRY=0x...
VITE_FHERC20_WRAPPER=0x...
VITE_POOL_DEPLOY_BLOCK=<pool deploy block>     # bounds the liquidator log scan
VITE_KYC_ATTESTER_URL=http://localhost:8787/attest

VITE_USDC=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
VITE_DSHARES=0x<collateral token from step 2 — demo: the printed MockDShares>
```

> The deployer private key goes in **`contracts/.env`** only — never in this
> frontend `.env`. Vite bundles env into the browser; a key here would leak.

```bash
npm install && npm run build && npm run preview   # or: npm run dev
```

## 6. Verify real data end-to-end

- **Prices** (Markets / dashboard): live from Pyth Hermes within seconds — works
  even before deploy (`VITE_USE_REAL_CHAIN` independent).
- **KYC (Step 2)**: connect wallet → register tx (attester signature) → initBlinding tx.
- **Position**: deposit/borrow/repay → the dashboard re-reads & **client-decrypts**
  your sealed collateral/debt from chain; wallet balances come from ERC-20 reads.
- **Liquidator**: the console enumerates accounts by scanning `BlindingSet` events
  and reads each one's public blinded factors (A, B) to compute HF.

## What is still NOT real / out of scope

- **External audit + HCU budget measurement** — required before any real funds.
- **`balanceOf()` on the FHERC20 wrapper** is a deliberate decoy (random); the
  real wrapped balance is the sealed `encryptedBalanceOf`.
- **Liquidator log scan** is RPC-range-bounded; for full history set
  `VITE_POOL_DEPLOY_BLOCK`, and for production use a dedicated event indexer.
- **`chg%`** in Markets is the spot-vs-EMA deviation from Pyth (Hermes' "latest"
  endpoint exposes no 24h open).
