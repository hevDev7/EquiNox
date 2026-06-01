/* ============================================================
   Equinox — mock protocol world: reference assets (tokenized-equity
   basket), initial position, anonymous on-chain accounts for the
   liquidator. Assets are derived from the verified STOCKS basket.
   ============================================================ */

import type { Account, Asset, AssetMap, Position } from '../types';
import { PROTOCOL } from './protocol';
import { STOCKS } from '../config/stocks';

/** Known PRD/testnet reference addresses; others default to the zero placeholder
 *  (real addresses come from `DeployMocks.s.sol` via Vite env). */
const REF_ADDR: Record<string, string> = {
  dTSLA: '0x1be207f7ae412c6deb0505485a36bfbdbd921d89',
  dAAPL: '0x1be207f7ae412c6deb0505485a36bfbdbd921d8a',
};
const ZERO = '0x0000000000000000000000000000000000000000';

export const ASSETS: AssetMap = {
  ...Object.fromEntries(
    STOCKS.map((s): [string, Asset] => [
      s.sym,
      {
        sym: s.sym,
        name: s.name,
        wrapped: s.wrapped,
        price: s.price,
        chg: s.chg,
        decimals: s.decimals,
        addr: REF_ADDR[s.sym] ?? ZERO,
      },
    ]),
  ),
  USDC: { sym: 'USDC', name: 'USD Coin', decimals: 6, addr: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' },
};

/** The user's TRUE (locally-decryptable) position — multi-collateral basket. */
export const INITIAL_POSITION: Position = {
  collateral: [
    { sym: 'fbTSLA', under: 'dTSLA', shares: 1000 },
    { sym: 'fbAAPL', under: 'dAAPL', shares: 620 },
    { sym: 'fbNVDA', under: 'dNVDA', shares: 140 },
  ],
  walletShares: { dTSLA: 1430, dAAPL: 300, dNVDA: 80, dMSFT: 50 }, // plaintext shares still in wallet
  walletUSDC: 2500,
  debtUSDC: 180000, // D_i principal
  blinding: 73194028, // s_i (secret)
};

/** Empty position — the REAL-mode initial state, so no demo numbers flash before the
 *  first on-chain fetchPosition resolves. */
export const EMPTY_POSITION: Position = {
  collateral: [],
  walletShares: {},
  walletUSDC: 0,
  debtUSDC: 0,
  blinding: 1,
};

/** Anonymous on-chain accounts — only A,B,P,I are public; C,D,s stay hidden.
 *  Spread across the basket so the liquidator console shows varied collateral. */
export function makeAccounts(): Account[] {
  const rows: Omit<Account, 'A' | 'B'>[] = [
    { id: '0x7a3f…b91c', under: 'dTSLA', C: 420, D: 92000, s: 51820394 },
    { id: '0x2e9d…04a7', under: 'dAAPL', C: 1850, D: 246000, s: 88401273 },
    { id: '0xc14b…7f02', under: 'dNVDA', C: 1500, D: 165000, s: 12903844 },
    { id: '0x9f86…d5e1', under: 'dTSLA', C: 1240, D: 285000, s: 67324019 },
    { id: '0x4d20…aa38', under: 'dMSFT', C: 610, D: 205000, s: 33910882 },
    { id: '0xb1c7…3e90', under: 'dGOOGL', C: 905, D: 118000, s: 47120093 },
    { id: '0xe773…1b4f', under: 'dAMZN', C: 2100, D: 332000, s: 90233110 },
    { id: '0x05af…c862', under: 'dNVDA', C: 380, D: 41000, s: 8120394 },
    { id: '0x3b66…9d12', under: 'dMETA', C: 540, D: 268000, s: 71840221 },
    { id: '0x8c41…2ef7', under: 'dCOIN', C: 1320, D: 320000, s: 26714509 },
    { id: '0xa902…5b73', under: 'dGOOGL', C: 410, D: 58000, s: 60391822 },
    { id: '0xd5e8…77a0', under: 'dMSFT', C: 1180, D: 360000, s: 19283746 },
  ];
  return rows.map((r) => ({
    ...r,
    A: Math.round(r.s * r.C * PROTOCOL.LT),
    B: Math.round(r.s * r.D),
  }));
}
