/* One-off test (no test runner in this project): transpiles the TS helper with
   esbuild and asserts canRepay's behaviour, including the bug-fix case where
   debt is UNKNOWN (sealed read failed) and repay must NOT be blocked. */
import { build } from 'esbuild';
import assert from 'node:assert/strict';

const out = await build({
  entryPoints: ['src/lib/sealed-read.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const mod = await import('data:text/javascript,' + encodeURIComponent(out.outputFiles[0].text));
const { canRepay } = mod;

const cases = [
  // [n, debtUSDC, debtUnknown, expected, label]
  [0, 1000, false, false, 'zero amount is invalid'],
  [-5, 1000, false, false, 'negative amount is invalid'],
  [500, 1000, false, true, 'positive amount within known debt is valid'],
  [1000, 1000, false, true, 'exact known debt is valid'],
  [1500, 1000, false, false, 'amount over known debt is invalid'],
  // the bug: debt UNKNOWN (decryption failed) → displayed debt 0 must NOT block repay
  [1000, 0, true, true, 'positive amount allowed when debt is unknown'],
  [0, 0, true, false, 'zero amount still invalid even when debt is unknown'],
];

let failed = 0;
for (const [n, debt, unknown, expected, label] of cases) {
  try {
    assert.equal(canRepay(n, debt, unknown), expected, label);
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${label} — got ${canRepay(n, debt, unknown)}, expected ${expected}`);
  }
}
console.log(failed ? `\n${failed} case(s) FAILED` : `\nall ${cases.length} cases passed`);
process.exit(failed ? 1 : 0);
