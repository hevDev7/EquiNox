/* ============================================================
   CELP — formatting + ciphertext-glyph helpers
   ============================================================ */

const GLYPHS = 'ABCDEF0123456789abcdef';

export { GLYPHS };

export function randCipher(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += GLYPHS[(Math.random() * GLYPHS.length) | 0];
  return s;
}

export function randDecimal(): string {
  return '$0.' + String((Math.random() * 10000) | 0).padStart(4, '0');
}

/** fake tx hash */
export function txHash(): string {
  return '0x' + randCipher(60).toLowerCase();
}

export function fmtUSD(n: number, dp = 0): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtNum(n: number, dp = 0): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function bigInt(n: number): string {
  return n.toLocaleString('en-US');
}
