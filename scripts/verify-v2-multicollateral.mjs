/* ============================================================
   Equinox — D3 on-chain FHE verification for EquinoxPoolV2 (multi-collateral).

   Proves the confidential AGGREGATION on live Arbitrum Sepolia + CoFHE:
   deposits sealed collateral in TWO assets (dTSLA + dAAPL), borrows against
   the COMBINED capacity, settles the blinded factors, and reads the health
   factor — which must reflect BOTH assets (not just one).

   Run with the deployer key (it is also the KYC attester):
     PRIVATE_KEY=0x<deployer-key> node scripts/verify-v2-multicollateral.mjs
   ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createPublicClient, createWalletClient, http, encodePacked, keccak256, getContract,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node';
import { arbSepolia } from '@cofhe/sdk/chains';
import { Encryptable, FheTypes } from '@cofhe/sdk';

const __dir = dirname(fileURLToPath(import.meta.url));
const abi = (f) => JSON.parse(readFileSync(join(__dir, '..', 'src', 'abi', f), 'utf8'));
const poolAbi = abi('EquinoxPoolV2.json');
const erc20Abi = abi('MockERC20.json');
const kycAbi = abi('KYCRegistry.json');

const RPC = process.env.ARBITRUM_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const PK = process.env.PRIVATE_KEY;
if (!PK) throw new Error('Set PRIVATE_KEY (deployer = KYC attester).');
const pk = PK.startsWith('0x') ? PK : `0x${PK}`;

const POOL = '0xA1a36C6582128253C88f316CCF9d8384155D3d92';
const KYC = '0xA54aa7716208Ca193cdBf988592c81a22143644b';
const USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const ASSETS = [
  { id: 0, sym: 'dTSLA', addr: '0x45Abf327b54DCa069E8f36A16b1483Cf96Da8874', price: 342, ltv: 0.7, lt: 0.8 },
  { id: 1, sym: 'dAAPL', addr: '0xF36A224700Eb0814a30e384E7A88A57F938B0A3e', price: 214, ltv: 0.7, lt: 0.8 },
];
const DEPOSIT = 10n; // shares per asset
const BORROW = 1000n; // USDC
const UNIT = 1_000_000n;
const CHAIN_ID = 421614;

const account = privateKeyToAccount(pk);
const ME = account.address;
const FEES = { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 0n }; // 0.1 gwei (Arb Sepolia)

const pub = createPublicClient({ chain: arbSepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: arbSepolia, transport: http(RPC) });

const read = (address, a, fn, args = []) => pub.readContract({ address, abi: a, functionName: fn, args });
async function send(address, a, fn, args = []) {
  const hash = await wallet.writeContract({ address, abi: a, functionName: fn, args, ...FEES });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

const log = (...x) => console.log(...x);

async function main() {
  log(`\n=== Equinox V2 multi-collateral FHE verification ===\nuser: ${ME}\npool: ${POOL}\n`);

  // --- CoFHE client ---------------------------------------------------------
  const client = createCofheClient(
    createCofheConfig({ environment: 'node', supportedChains: [arbSepolia], useWorkers: false }),
  );
  await client.connect(pub, wallet);
  const encU64 = async (v) => {
    const [out] = await client.encryptInputs([Encryptable.uint64(v)]).execute();
    return { ctHash: BigInt(out.ctHash), securityZone: Number(out.securityZone ?? 0), utype: Number(out.utype ?? 0), signature: out.signature };
  };
  const retry = async (fn, label, n = 12, wait = 10_000) => {
    for (let i = 0; i < n; i++) {
      try { return await fn(); }
      catch (e) {
        if (i === n - 1) throw e;
        log(`   …${label} retry ${i + 1}/${n} after transient error: ${e?.code ?? e?.message ?? e}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
  const decTx = (h) => retry(async () => {
    const r = await client.decryptForTx(h).withoutPermit().execute();
    return { value: BigInt(r.decryptedValue), proof: r.signature };
  }, 'decryptForTx');
  const decView = (h) => retry(async () => {
    const r = await client.decryptForView(h, FheTypes.Uint64).withPermit().execute();
    return BigInt(typeof r === 'bigint' ? r : (r?.value ?? r ?? 0));
  }, 'decryptForView');

  // --- 1. KYC (deployer signs its own attestation) --------------------------
  if (!(await read(KYC, kycAbi, 'isRegistered', [ME]))) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400);
    const digest = keccak256(encodePacked(['address', 'uint256', 'address', 'uint256'], [ME, expiry, KYC, BigInt(CHAIN_ID)]));
    const signature = await account.signMessage({ message: { raw: digest } });
    await send(KYC, kycAbi, 'register', [expiry, signature]);
    log('✓ KYC registered');
  } else log('✓ KYC already registered');

  // --- 2. initBlinding (on the V2 pool) -------------------------------------
  if (!(await read(POOL, poolAbi, 'initialized', [ME]))) {
    await client.permits.getOrCreateSelfPermit();
    const encS = await encU64(73_194_028n); // secret blinding s
    await send(POOL, poolAbi, 'initBlinding', [encS]);
    log('✓ initBlinding done');
  } else {
    await client.permits.getOrCreateSelfPermit();
    log('✓ already initialised on V2');
  }

  // --- 3. mint + fund + deposit BOTH assets (idempotent via on-chain handle, no decrypt) ---
  for (const a of ASSETS) {
    const h = await read(POOL, poolAbi, 'encryptedCollateralOf', [ME, BigInt(a.id)]);
    if (h && BigInt(h) !== 0n) { log(`✓ ${a.sym} (asset ${a.id}) already has a sealed-collateral handle — skip deposit`); continue; }
    await send(a.addr, erc20Abi, 'mint', [ME, DEPOSIT * UNIT]);
    await send(a.addr, erc20Abi, 'approve', [POOL, DEPOSIT * UNIT]);
    await send(POOL, poolAbi, 'fundShares', [BigInt(a.id), DEPOSIT]);
    const encDep = await encU64(DEPOSIT);
    await send(POOL, poolAbi, 'deposit', [BigInt(a.id), encDep]);
    log(`✓ deposited ${DEPOSIT} ${a.sym} (asset ${a.id}) as sealed collateral`);
  }

  // --- 4. refresh the HELD assets' prices so the per-user staleness guard passes ---
  for (const a of ASSETS) await send(POOL, poolAbi, 'setAssetPrice', [BigInt(a.id), BigInt(a.price)]);
  const fresh0 = await read(POOL, poolAbi, 'isAssetPriceStale', [0n]);
  const fresh1 = await read(POOL, poolAbi, 'isAssetPriceStale', [1n]);
  log(`✓ held-asset prices refreshed (dTSLA stale=${fresh0}, dAAPL stale=${fresh1})`);

  // --- 5. confidential borrow against the COMBINED capacity (idempotent: skip if debt>0) ---
  const debtPre = await decView(await read(POOL, poolAbi, 'encryptedScaledDebtOf', [ME]));
  if (debtPre > 0n) {
    log(`✓ already borrowed (sealed scaledDebt=${debtPre}) — skip requestBorrow`);
  } else {
    const encR = await encU64(BORROW);
    await send(POOL, poolAbi, 'requestBorrow', [encR]);
    log(`✓ requestBorrow(${BORROW}) — drew against aggregated dTSLA+dAAPL capacity`);
  }

  // --- 6. AUDIT #7: poke so the blinded factors rebuild at the CURRENT price epoch,
  //         then settle (factorsAt binds to that epoch → factorsStale=false). --------
  await send(POOL, poolAbi, 'poke', [ME]);
  log(`✓ poke(ME) — factors rebuilt at current price epoch`);
  const [eA, eB] = await read(POOL, poolAbi, 'encryptedFactorsOf', [ME]);
  const a = await decTx(eA);
  const b = await decTx(eB);
  await send(POOL, poolAbi, 'settleFactors', [ME, a.value, b.value, a.proof, b.proof]);
  log(`✓ settleFactors — A=${a.value} B=${b.value}`);

  // --- 7. READ the aggregated health factor + decrypt the sealed state --------
  const hf = await read(POOL, poolAbi, 'healthFactorBps', [ME]);
  const idx = Number(await read(POOL, poolAbi, 'currentIndexBps'));
  const scaledDebt = Number(await decView(await read(POOL, poolAbi, 'encryptedScaledDebtOf', [ME])));
  const usdcCredit = await decView(await read(POOL, poolAbi, 'encryptedUsdcCreditOf', [ME]));
  const c0 = Number(await decView(await read(POOL, poolAbi, 'encryptedCollateralOf', [ME, 0n])));
  const c1 = Number(await decView(await read(POOL, poolAbi, 'encryptedCollateralOf', [ME, 1n])));

  // expected HF (bps) = collateralValue@LT / currentDebt · BPS, using the ACTUAL decrypted debt.
  const currentDebt = (scaledDebt * idx) / 10_000;
  const both = (c0 * ASSETS[0].price * ASSETS[0].lt) + (c1 * ASSETS[1].price * ASSETS[1].lt);
  const one = c0 * ASSETS[0].price * ASSETS[0].lt;
  const hfBoth = Math.round((both / currentDebt) * 10_000);
  const hfOne = Math.round((one / currentDebt) * 10_000);

  log(`\n=== RESULT ===`);
  log(`sealed collateral  dTSLA=${c0}  dAAPL=${c1}`);
  log(`sealed USDC credit = ${usdcCredit}   sealed scaledDebt = ${scaledDebt} (currentDebt ≈ ${currentDebt.toFixed(0)} USDC)`);
  log(`on-chain healthFactorBps = ${hf}  (${(Number(hf) / 10_000).toFixed(2)}x)`);
  log(`expected HF if BOTH assets count ≈ ${hfBoth}bps; dTSLA-ONLY would be ≈ ${hfOne}bps`);
  const aggregated = Math.abs(Number(hf) - hfBoth) < Math.abs(Number(hf) - hfOne);
  log(aggregated
    ? `✅ HF matches the TWO-asset aggregate → multi-collateral borrow/HF VERIFIED on-chain.`
    : `⚠️ HF closer to single-asset — inspect.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1); });
