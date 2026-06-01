/* Reproduce the full frontend borrow flow on-chain to locate the "Disburse USDC" stall:
   requestBorrow → requestWithdraw → decryptForTx → claimWithdraw, timing each step.
   PRIVATE_KEY=0x<deployer> node scripts/repro-borrow.mjs */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node';
import { arbSepolia } from '@cofhe/sdk/chains';
import { Encryptable } from '@cofhe/sdk';

const __dir = dirname(fileURLToPath(import.meta.url));
const poolAbi = JSON.parse(readFileSync(join(__dir, '..', 'src', 'abi', 'EquinoxPoolV2.json'), 'utf8'));
const erc20Abi = JSON.parse(readFileSync(join(__dir, '..', 'src', 'abi', 'MockERC20.json'), 'utf8'));
const RPC = process.env.ARBITRUM_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const pk = (process.env.PRIVATE_KEY.startsWith('0x') ? '' : '0x') + process.env.PRIVATE_KEY;
const POOL = '0xA1a36C6582128253C88f316CCF9d8384155D3d92';
const MUSDC = '0x0483f9CefB463CaF4Cdb93ceF4f9F077b0aA7e4f';
const BORROW = 50n;
const account = privateKeyToAccount(pk);
const ME = account.address;
const FEES = { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 0n };
const pub = createPublicClient({ chain: arbSepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: arbSepolia, transport: http(RPC) });
const read = (a, abi, fn, args = []) => pub.readContract({ address: a, abi, functionName: fn, args });
const t0 = () => Date.now();
async function send(label, a, abi, fn, args = []) {
  const s = t0();
  try {
    // mirror the frontend fix: estimate + generous headroom (Arb L1-calldata gas is volatile → OOG)
    let gas;
    try { const est = await pub.estimateContractGas({ address: a, abi, functionName: fn, args, account }); gas = est * 2n + 300_000n; } catch { /* fall back */ }
    const hash = await wallet.writeContract({ address: a, abi, functionName: fn, args, ...(gas ? { gas } : {}), ...FEES });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ✓ ${label} [${r.status}] ${Date.now() - s}ms ${hash}`);
    if (r.status === 'reverted') throw new Error(`${label} REVERTED`);
    return r;
  } catch (e) {
    console.log(`  ✗ ${label} FAILED ${Date.now() - s}ms: ${e?.shortMessage ?? e?.message ?? e}`);
    throw e;
  }
}
const enc = async (client, v) => {
  const [o] = await client.encryptInputs([Encryptable.uint64(v)]).execute();
  return { ctHash: BigInt(o.ctHash), securityZone: Number(o.securityZone ?? 0), utype: Number(o.utype ?? 0), signature: o.signature };
};

async function main() {
  const client = createCofheClient(createCofheConfig({ environment: 'node', supportedChains: [arbSepolia], useWorkers: false }));
  await client.connect(pub, wallet);
  console.log(`\nborrower ${ME}`);
  console.log(`  isWeekendMode: ${await read(POOL, poolAbi, 'isWeekendMode')}  isPriceStale: ${await read(POOL, poolAbi, 'isPriceStale')}`);
  console.log(`  pool USDC liq: ${Number(await read(POOL, poolAbi, 'availableLiquidity'))}`);
  const before = await read(MUSDC, erc20Abi, 'balanceOf', [ME]);

  console.log(`\n— requestBorrow(${BORROW}) —`);
  await send('requestBorrow', POOL, poolAbi, 'requestBorrow', [await enc(client, BORROW)]);

  console.log(`— requestWithdraw(${BORROW}, isUsdc) —`);
  await send('requestWithdraw', POOL, poolAbi, 'requestWithdraw', [await enc(client, BORROW), true, 0n]);
  const id = (await read(POOL, poolAbi, 'withdrawalsCount')) - 1n;

  console.log(`— decryptForTx(take) [threshold network] —`);
  const w = await read(POOL, poolAbi, 'withdrawals', [id]);
  let s = t0(), value, proof;
  for (let i = 0; i < 8; i++) {
    try { const r = await client.decryptForTx(BigInt(w[1])).withoutPermit().execute(); value = BigInt(r.decryptedValue); proof = r.signature; break; }
    catch (e) { console.log(`   …retry ${i + 1}/8 (${e?.code ?? e?.message})`); if (i === 7) throw e; await new Promise((r) => setTimeout(r, 6000)); }
  }
  console.log(`  ✓ decryptForTx → value=${value} ${Date.now() - s}ms`);

  console.log(`— claimWithdraw —`);
  await send('claimWithdraw', POOL, poolAbi, 'claimWithdraw', [id, value, proof]);
  const after = await read(MUSDC, erc20Abi, 'balanceOf', [ME]);
  console.log(`\n  USDC delta: +${(after - before) / 1_000_000n} (disbursed ${value / 1_000_000n}) ✅ borrow flow completes on-chain`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('STUCK/FAILED at:', e?.shortMessage ?? e?.message ?? e); process.exit(1); });
