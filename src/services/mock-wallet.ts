/* ============================================================
   Equinox — mock wallet provider. Swap for a wagmi adapter later.
   ============================================================ */

import { PROTOCOL } from '../lib/protocol';
import type { WalletInfo, WalletService } from './types';

const MOCK_ADDRESS = '0x7a3f1c9d2e4b6a8f0c1d3e5f7a9b1c3d5e7f9a3f';

export class MockWalletService implements WalletService {
  private info: WalletInfo | null = null;

  async connect(kind: WalletInfo['kind']): Promise<WalletInfo> {
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    this.info = { address: MOCK_ADDRESS, chainId: PROTOCOL.chainId, kind };
    return this.info;
  }

  current(): WalletInfo | null {
    return this.info;
  }
}

export const mockWalletService = new MockWalletService();

/** Short display form: 0x7a…3f1c */
export function shortAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
