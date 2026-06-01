import { useCallback, useState } from 'react';
import type { Tweaks } from '../types';

/** Single source of truth for tweak values (theme/privacy/density/demo). */
export function useTweaks(
  defaults: Tweaks,
): [Tweaks, <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void] {
  const [values, setValues] = useState<Tweaks>(defaults);
  const setTweak = useCallback(<K extends keyof Tweaks>(key: K, value: Tweaks[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);
  return [values, setTweak];
}
