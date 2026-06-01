/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" to use the real Arbitrum Sepolia + CoFHE layer instead of mocks. */
  readonly VITE_USE_REAL_CHAIN?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_WC_PROJECT_ID?: string;
  readonly VITE_EQUINOX_POOL?: string;
  readonly VITE_KYC_REGISTRY?: string;
  readonly VITE_FHERC20_WRAPPER?: string;
  readonly VITE_USDC?: string;
  readonly VITE_DSHARES?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ethereum?: any;
}
