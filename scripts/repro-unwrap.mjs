/* Reproduce the full frontend collateral-unwrap flow on the upgraded pool:
   withdrawCollateral(assetId, enc) → decryptForTx → claimWithdraw → real dShares back.
   Proves HF-gated multi-collateral unwrap end-to-end. PRIVATE_KEY=0x… node scripts/repro-unwrap.mjs */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node';
import { arbSepolia } from '@cofhe/sdk/chains';
import { Encryptable, FheTypes } from '@cofhe/sdk';

const __dir = dirname(fileURLToPath(import.meta.url));
const poolAbi = JSON.parse(readFileSync(join(__dir, '..', 'src', 'abi', 'EquinoxPoolV2.json'), 'utf8'));
const erc20Abi = JSON.parse(readFileSync(join(__dir, '..', 'src', 'abi', 'MockERC20.json'), 'utf8'));
const RPC = process.env.ARBITRUM_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const pk = (process.env.PRIVATE_KEY.startsWith('0x') ? '' : '0x') + process.env.PRIVATE_KEY;
const POOL = '0xA1a36C6582128253C88f316CCF9d8384155D3d92';
const ASSET_ID = 0n; // dTSLA
const WITHDRAW = 2n; // whole shares
const account = privateKeyToAccount(pk);
const ME = account.address;
const FEES = { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 0n };
const pub = createPublicClient({ chain: arbSepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: arbSepolia, transport: http(RPC) });
const read = (a, abi, fn, args = []) => pub.readContract({ address: a, abi, functionName: fn, args });
const t0 = () => Date.now();
async function send(label, a, abi, fn, args = []) {
  const s = t0();
  let gas;
  try { const est = await pub.estimateContractGas({ address: a, abi, functionName: fn, args, account }); gas = est * 2n + 300_000n; } catch { /* fall back */ }
  const hash = await wallet.writeContract({ address: a, abi, functionName: fn, args, ...(gas ? { gas } : {}), ...FEES });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${r.status === 'success' ? '✓' : '✗'} ${label} [${r.status}] ${Date.now() - s}ms ${hash}`);
  if (r.status === 'reverted') throw new Error(`${label} REVERTED`);
  return r;
}
const enc = async (client, v) => {
  const [o] = await client.encryptInputs([Encryptable.uint64(v)]).execute();
  return { ctHash: BigInt(o.ctHash), securityZone: Number(o.securityZone ?? 0), utype: Number(o.utype ?? 0), signature: o.signature };
};

async function main() {
  const client = createCofheClient(createCofheConfig({ environment: 'node', supportedChains: [arbSepolia], useWorkers: false }));
  await client.connect(pub, wallet);
  const a = await read(POOL, poolAbi, 'assets', [ASSET_ID]); // (token, priceUsd, ...)
  const token = a[0];
  console.log(`\nborrower ${ME}  asset ${ASSET_ID} token ${token}`);
  console.log(`  isPriceStale: ${await read(POOL, poolAbi, 'isPriceStale')}`);
  const collH = await read(POOL, poolAbi, 'encryptedCollateralOf', [ME, ASSET_ID]);
  let collBefore = '??';
  try { collBefore = (await client.decryptForView(BigInt(collH), FheTypes.Uint64).withPermit().execute()).toString(); } catch (e) { collBefore = `(decrypt: ${e?.code ?? e?.message})`; }
  const balBefore = await read(token, erc20Abi, 'balanceOf', [ME]);
  console.log(`  sealed collateral[${ASSET_ID}] before: ${collBefore}   wallet dShares: ${balBefore / 1_000_000n}`);

  console.log(`\n— withdrawCollateral(${ASSET_ID}, ${WITHDRAW}) —`);
  await send('withdrawCollateral', POOL, poolAbi, 'withdrawCollateral', [ASSET_ID, await enc(client, WITHDRAW)]);
  const id = (await read(POOL, poolAbi, 'withdrawalsCount')) - 1n;

  console.log(`— decryptForTx(take) [threshold network] —`);
  const w = await read(POOL, poolAbi, 'withdrawals', [id]);
  let s = t0(), value, proof;
  for (let i = 0; i < 8; i++) {
    try { const r = await client.decryptForTx(BigInt(w[1])).withoutPermit().execute(); value = BigInt(r.decryptedValue); proof = r.signature; break; }
    catch (e) { console.log(`   …retry ${i + 1}/8 (${e?.code ?? e?.message})`); if (i === 7) throw e; await new Promise((r) => setTimeout(r, 6000)); }
  }
  console.log(`  ✓ decryptForTx → freed take=${value} shares ${Date.now() - s}ms`);

  console.log(`— claimWithdraw —`);
  await send('claimWithdraw', POOL, poolAbi, 'claimWithdraw', [id, value, proof]);
  const balAfter = await read(token, erc20Abi, 'balanceOf', [ME]);
  const collAfterH = await read(POOL, poolAbi, 'encryptedCollateralOf', [ME, ASSET_ID]);
  let collAfter = '??';
  try { collAfter = (await client.decryptForView(BigInt(collAfterH), FheTypes.Uint64).withPermit().execute()).toString(); } catch (e) { collAfter = `(decrypt: ${e?.code ?? e?.message})`; }
  console.log(`\n  dShares delta: +${(balAfter - balBefore) / 1_000_000n}   sealed collateral[${ASSET_ID}] after: ${collAfter}`);
  console.log(`  ✅ HF-gated collateral unwrap completes on-chain (freed ${value} ${(balAfter - balBefore) > 0n ? '→ real dShares received' : ''})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED at:', e?.shortMessage ?? e?.message ?? e); process.exit(1); });
