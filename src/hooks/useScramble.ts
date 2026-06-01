import { useMemo } from 'react';
import { randCipher } from '../lib/format';

/**
 * Returns a stable ciphertext placeholder of length `len`.
 *
 * Previously this re-rolled the glyphs on an interval to fake an "encryption"
 * animation. That cosmetic effect was removed — the value stays sealed (the
 * real privacy property) but no longer flickers. `active`/`speed` are kept for
 * call-site compatibility and intentionally ignored.
 */
export function useScramble(len = 10, _active = true, _speed = 90): string {
  return useMemo(() => randCipher(len), [len]);
}
