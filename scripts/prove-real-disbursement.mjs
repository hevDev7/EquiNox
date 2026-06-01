/* ============================================================
   Equinox — prove the REAL borrow→USDC disbursement edge works end-to-end:
   realize the deployer's existing sealed USDC credit (from the D3 borrow) into
   real (MockUSDC) tokens in the wallet via requestWithdraw → decryptForTx → claimWithdraw.

   Run:  PRIVATE_KEY=0x<deployer-key> node scripts/prove-real-disbursement.mjs
   ============================================================ */
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
const WITHDRAW = 1000n; // realize 1000 of the deployer's sealed USDC credit
const UNIT = 1_000_000n;

const account = privateKeyToAccount(pk);
const ME = account.address;
const FEES = { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 0n };
const pub = createPublicClient({ chain: arbSepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: arbSepolia, transport: http(RPC) });
const read = (a, abi, fn, args = []) => pub.readContract({ address: a, abi, functionName: fn, args });
async function send(a, abi, fn, args = []) {
  const hash = await wallet.writeContract({ address: a, abi, functionName: fn, args, ...FEES });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = createCofheClient(createCofheConfig({ environment: 'node', supportedChains: [arbSepolia], useWorkers: false }));
  await client.connect(pub, wallet);

  const before = await read(MUSDC, erc20Abi, 'balanceOf', [ME]);
  console.log(`\nwallet ${ME}\n  MockUSDC before: ${before} (${Number(before) / 1e6} USDC)`);

  // 1. requestWithdraw the sealed USDC credit (isUsdc=true, assetId ignored)
  const [enc] = await client.encryptInputs([Encryptable.uint64(WITHDRAW)]).execute();
  await send(POOL, poolAbi, 'requestWithdraw', [
    { ctHash: BigInt(enc.ctHash), securityZone: Number(enc.securityZone ?? 0), utype: Number(enc.utype ?? 0), signature: enc.signature },
    true,
    0n,
  ]);
  const id = (await read(POOL, poolAbi, 'withdrawalsCount')) - 1n;
  console.log(`  ✓ requestWithdraw(${WITHDRAW}) → withdrawId ${id}`);

  // 2. threshold-decrypt the sealed `take` into (value, proof)  [retry transient 503]
  const w = await read(POOL, poolAbi, 'withdrawals', [id]); // (owner, amount, isUsdc, claimed, assetId)
  let value, proof;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await client.decryptForTx(BigInt(w[1])).withoutPermit().execute();
      value = BigInt(r.decryptedValue);
      proof = r.signature;
      break;
    } catch (e) {
      if (i === 7) throw e;
      console.log(`   …decryptForTx retry ${i + 1}/8 (${e?.code ?? e?.message})`);
      await sleep(8000);
    }
  }
  console.log(`  ✓ decryptForTx → value=${value}`);

  // 3. claimWithdraw → real MockUSDC transferred to the wallet
  await send(POOL, poolAbi, 'claimWithdraw', [id, value, proof]);
  const after = await read(MUSDC, erc20Abi, 'balanceOf', [ME]);
  console.log(`  ✓ claimWithdraw`);
  console.log(`\n  MockUSDC after:  ${after} (${Number(after) / 1e6} USDC)`);
  const delta = (after - before) / UNIT;
  console.log(delta === WITHDRAW
    ? `\n✅ REAL DISBURSEMENT VERIFIED — ${delta} USDC moved from pool → wallet on-chain.`
    : `\n⚠️ delta=${delta} (expected ${WITHDRAW})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e?.shortMessage ?? e?.message ?? e); process.exit(1); });
