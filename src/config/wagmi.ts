/* ============================================================
   Equinox — wagmi + RainbowKit config (Arbitrum Sepolia).
   ============================================================ */

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { arbitrumSepolia } from 'wagmi/chains';
import { http } from 'wagmi';
import { RPC_URL } from './contracts';

/** WalletConnect Cloud projectId — required for the WalletConnect/mobile flows.
 *  Injected wallets (MetaMask) work without it. Get one at https://cloud.reown.com */
// `||` (not `??`): an empty VITE_WC_PROJECT_ID= in .env is "" — must fall back too,
// else getDefaultConfig throws "No projectId found" and the whole app fails to mount.
const projectId = import.meta.env.VITE_WC_PROJECT_ID || 'equinox-dev';

export const wagmiConfig = getDefaultConfig({
  appName: 'Equinox',
  projectId,
  chains: [arbitrumSepolia],
  transports: {
    [arbitrumSepolia.id]: http(RPC_URL),
  },
  ssr: false,
});
