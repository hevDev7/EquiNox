/* ============================================================
   Equinox — REFERENCE KYC attester signer.  DEV / TESTNET ONLY.

   The KYCRegistry gates registration on an ECDSA signature from a trusted
   attester over keccak256(user, expiry, registry, chainId) (EIP-191
   personal-sign). In production this signature comes from your KYC
   provider's backend after the user passes identity checks. This script is
   a minimal stand-in so you can exercise the real on-chain flow on testnet.

   Run it with the attester key (the SAME address you pass as KYC_ATTESTER
   when deploying), then point the frontend at it:

     ATTESTER_PRIVATE_KEY=0x<key> node scripts/attester.mjs
     # frontend .env:  VITE_KYC_ATTESTER_URL=http://localhost:8787/attest

   ⚠️ This signs for ANY caller — it performs no identity verification.
      Replace it with your KYC provider's attested endpoint for production.
   ============================================================ */

import { createServer } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { encodePacked, keccak256 } from 'viem';

const PK = process.env.ATTESTER_PRIVATE_KEY;
if (!PK) {
  console.error('Set ATTESTER_PRIVATE_KEY (the attester EOA whose address == on-chain KYC_ATTESTER).');
  process.exit(1);
}
const account = privateKeyToAccount(PK);
const PORT = Number(process.env.PORT ?? 8787);
const TTL = Number(process.env.ATTESTATION_TTL_SECONDS ?? 86_400);

const server = createServer((req, res) => {
  // CORS so the Vite dev server can call this directly
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  if (req.method !== 'POST') return void res.writeHead(405).end();

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const { user, registry, chainId } = JSON.parse(body || '{}');
      if (!user || !registry || chainId == null) throw new Error('user, registry, chainId required');

      const expiry = BigInt(Math.floor(Date.now() / 1000) + TTL);
      // must match KYCRegistry.attestationDigest exactly
      const digest = keccak256(
        encodePacked(
          ['address', 'uint256', 'address', 'uint256'],
          [user, expiry, registry, BigInt(chainId)],
        ),
      );
      // EIP-191 personal-sign (== Solidity toEthSignedMessageHash)
      const signature = await account.signMessage({ message: { raw: digest } });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ expiry: expiry.toString(), signature, attester: account.address }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
});

server.listen(PORT, () =>
  console.log(`Equinox KYC attester (DEV) signing as ${account.address} → http://localhost:${PORT}/`),
);
