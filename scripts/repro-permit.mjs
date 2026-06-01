/* Diagnose whether @cofhe/sdk getOrCreateSelfPermit REUSES the active self-permit or re-mints
   each call (the "signature pop-up keeps appearing" bug). PRIVATE_KEY=0x… node scripts/repro-permit.mjs */
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node';
import { arbSepolia } from '@cofhe/sdk/chains';

const RPC = process.env.ARBITRUM_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const pk = (process.env.PRIVATE_KEY.startsWith('0x') ? '' : '0x') + process.env.PRIVATE_KEY;
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: arbSepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: arbSepolia, transport: http(RPC) });
const cid = arbSepolia.id, acc = account.address;

const client = createCofheClient(createCofheConfig({ environment: 'node', supportedChains: [arbSepolia], useWorkers: false }));
await client.connect(pub, wallet);
const P = client.permits;
const info = (tag) => {
  const a = P.getActivePermit?.(cid, acc);
  const h = P.getActivePermitHash?.(cid, acc);
  console.log(`  ${tag}: active=${a ? 'present' : 'NULL'} type=${a?.type ?? '-'} exp=${a?.expiration ?? '-'} hash=${h ? String(h).slice(0, 14) : '-'}`);
  return h;
};

console.log(`chainId=${cid} account=${acc}`);
info('before any mint');
let t = Date.now();
await P.getOrCreateSelfPermit();
console.log(`getOrCreateSelfPermit #1 took ${Date.now() - t}ms`);
const h1 = info('after #1');
t = Date.now();
await P.getOrCreateSelfPermit();
console.log(`getOrCreateSelfPermit #2 took ${Date.now() - t}ms`);
const h2 = info('after #2');
t = Date.now();
await P.getOrCreateSelfPermit();
console.log(`getOrCreateSelfPermit #3 took ${Date.now() - t}ms`);
const h3 = info('after #3');

console.log(`\nREUSED across calls? ${h1 && h1 === h2 && h2 === h3 ? '✅ YES (same permit hash — SDK reuses, no re-mint)' : '❌ NO (hash changed → re-mints each call = the bug)'}`);
process.exit(0);
