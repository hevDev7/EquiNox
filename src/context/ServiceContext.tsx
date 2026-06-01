import { createContext, useContext } from 'react';
import type { EquinoxService } from '../services/types';
import { mockEquinoxService } from '../services/mock-equinox-service';
import { cofheEquinoxService } from '../services/cofhe-equinox-service';
import { USE_REAL_CHAIN } from '../config/contracts';

export interface Services {
  equinox: EquinoxService;
}

/**
 * Pick the real Arbitrum Sepolia + CoFHE service when VITE_USE_REAL_CHAIN=true,
 * otherwise the in-memory mock. Both implement the same interface. Wallet
 * connection is handled separately by wagmi/RainbowKit.
 */
const services: Services = USE_REAL_CHAIN
  ? { equinox: cofheEquinoxService }
  : { equinox: mockEquinoxService };

export const ServiceCtx = createContext<Services>(services);

export const useServices = () => useContext(ServiceCtx);
