/* Dependency-free unit test for the CoFHE error classifiers (src/lib/cofhe-errors.ts).
   Run: `npm test` (or `node --experimental-strip-types scripts/cofhe-errors.test.mjs`).

   Guards the /v2/sealoutput 403 fix: a 403/401 is an AUTH REJECTION (recover by re-minting the
   permit), NOT transient — even though the SDK tags it code SEAL_OUTPUT_FAILED, which previously
   made isTransient() return true and burn ~15s of pointless retries on a permanent failure. */
import { isSealAuthRejection, isTransient } from '../src/lib/cofhe-errors.ts';

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
}

// --- shapes the SDK actually throws ---
const seal403 = {
  name: 'CofheError',
  code: 'SEAL_OUTPUT_FAILED',
  message: 'sealOutput request failed: HTTP 403',
  context: { status: 403, statusText: 'Forbidden' },
};
const seal401 = { code: 'SEAL_OUTPUT_FAILED', message: 'sealOutput request failed: unauthorized', context: { status: 401 } };
const seal503 = { code: 'SEAL_OUTPUT_FAILED', message: 'sealOutput request failed: HTTP 503', context: { status: 503 } };
const sealNetwork = { code: 'SEAL_OUTPUT_FAILED', message: 'sealOutput request failed' }; // fetch threw, no status
const decryptFailed = { code: 'DECRYPT_FAILED', message: 'decrypt failed' };
const plainFetch = new Error('fetch failed');
const unrelated = new Error('something totally unrelated');

// --- isSealAuthRejection: only 401/403 ---
check('403 (status) -> auth rejection', isSealAuthRejection(seal403), true);
check('401 (status) -> auth rejection', isSealAuthRejection(seal401), true);
check('403 via message string only', isSealAuthRejection({ message: 'HTTP 403 Forbidden' }), true);
check('503 -> NOT auth rejection', isSealAuthRejection(seal503), false);
check('network throw -> NOT auth rejection', isSealAuthRejection(sealNetwork), false);
check('plain fetch failed -> NOT auth rejection', isSealAuthRejection(plainFetch), false);

// --- isTransient: the core regression. 403 must NOT be transient ---
check('403 -> NOT transient (regression guard)', isTransient(seal403), false);
check('401 -> NOT transient', isTransient(seal401), false);
check('503 -> transient', isTransient(seal503), true);
check('network seal throw -> transient', isTransient(sealNetwork), true);
check('DECRYPT_FAILED -> transient', isTransient(decryptFailed), true);
check('plain fetch failed -> transient', isTransient(plainFetch), true);
check('unrelated error -> NOT transient', isTransient(unrelated), false);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll cofhe-errors assertions passed.');
