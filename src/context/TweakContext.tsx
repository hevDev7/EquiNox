import { createContext, useContext } from 'react';
import type { PrivacyMode } from '../types';

export interface TweakCtxValue {
  privacyMode: PrivacyMode;
}

export const TweakCtx = createContext<TweakCtxValue>({ privacyMode: 'cipher' });
export const useTweakCtx = () => useContext(TweakCtx);
