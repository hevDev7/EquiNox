/* ============================================================
   CELP — icon component + path map (simple stroked paths only)
   ============================================================ */

import type { CSSProperties } from 'react';

export interface IconProps {
  d: string | readonly string[];
  size?: number;
  sw?: number;
  fill?: string;
  style?: CSSProperties;
}

export function Icon({ d, size = 18, sw = 1.6, fill = 'none', style }: IconProps) {
  const paths = typeof d === 'string' ? [d] : d;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {paths.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

export const ICON = {
  lock: 'M6 10V8a6 6 0 1 1 12 0v2 M5 10h14v10H5z',
  unlock: ['M7 10V8a5 5 0 0 1 9.9-1', 'M5 10h14v10H5z'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  eyeOff: [
    'M3 3l18 18',
    'M10.6 10.6a3 3 0 0 0 4.2 4.2',
    'M9.4 5.2A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a16 16 0 0 1-3.1 3.9',
    'M6.1 6.1A16 16 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 3.1-.5',
  ],
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  shieldCheck: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z', 'M9 12l2 2 4-4'],
  vault: ['M4 5h16v14H4z', 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'M12 9v-1', 'M12 16v-1', 'M15 12h1', 'M8 12h1'],
  arrowR: 'M5 12h14 M13 6l6 6-6 6',
  arrowDown: 'M12 5v14 M6 13l6 6 6-6',
  plus: 'M12 5v14 M5 12h14',
  check: 'M5 12l5 5 9-11',
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  layers: ['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M21 21l-4-4'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M5 20c0-3.5 3-6 7-6s7 2.5 7 6'],
  wallet: ['M3 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z', 'M3 7l1-3h13l1 3', 'M17 13h.01'],
  key: ['M15 9a3 3 0 1 0-3 3', 'M12 12l-7 7v2h2l1-1h2v-2h2l2-2'],
  fingerprint: [
    'M12 11a2 2 0 0 0-2 2c0 2 .5 4 1 5',
    'M12 7a6 6 0 0 0-6 6c0 1 .2 3 .8 4.5',
    'M12 4a9 9 0 0 0-9 9',
    'M16 5.5A9 9 0 0 1 21 13c0 1-.1 2-.3 3',
    'M15.5 13a3.5 3.5 0 0 0-3.5-3.5',
    'M14 13c0 3 .5 5 1 6.5',
  ],
  link: ['M9 15l6-6', 'M10 6l1-1a4 4 0 0 1 6 6l-1 1', 'M14 18l-1 1a4 4 0 0 1-6-6l1-1'],
  alert: ['M12 3l9 16H3l9-16z', 'M12 10v4', 'M12 17h.01'],
  moon: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z',
  refresh: ['M3 12a9 9 0 0 1 15-6.7L21 8', 'M21 4v4h-4', 'M21 12a9 9 0 0 1-15 6.7L3 16', 'M3 20v-4h4'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  x: 'M6 6l12 12 M18 6L6 18',
  dots: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4 20-7z'],
  scale: ['M12 3v18', 'M7 7h10', 'M7 7l-3 7a3 3 0 0 0 6 0L7 7z', 'M17 7l-3 7a3 3 0 0 0 6 0l-3-7z', 'M6 21h12'],
} as const;

export type IconName = keyof typeof ICON;
