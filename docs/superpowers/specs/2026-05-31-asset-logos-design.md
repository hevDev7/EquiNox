# Spec — Logo asli untuk asset (stock tokens)

- **Tanggal:** 2026-05-31
- **Status:** Disetujui (desain), siap implementasi
- **Lingkup:** kecil — 1 komponen + 1 modul loader + 18 SVG vendored

## Konteks

Asset (tokenized equities / dShares: `dTSLA`, `dAAPL`, … 18 simbol di `src/config/stocks.ts`,
plus wrapper terenkripsi `fbTSLA` dan `USDC`) saat ini divisualkan oleh komponen
**`AssetMark`** (`src/components/primitives.tsx`) yang hanya menampilkan **lettermark**
(huruf pertama simbol dalam chip rounded-square). Dipakai di `MarketsPanel`, `actions.tsx`,
`common.tsx`.

**Tujuan:** menampilkan **logo asli** tiap stock token.

## Keputusan: hybrid 3-tier (per persetujuan user)

1. **Tier 0 — CDN utama:** Parqet, berbasis ticker →
   `https://assets.parqet.com/logos/symbol/{TICKER}`. Format **SVG**, tanpa token.
   Diverifikasi live `200 image/svg+xml` untuk **18/18** saham (ukuran byte distinct →
   logo asli, bukan placeholder). Ticker diturunkan dari `sym` (`dTSLA`/`fbTSLA` → `TSLA`) —
   **tidak ada field baru** di `stocks.ts`.
2. **Tier 1 — fallback lokal:** SVG di `src/assets/logos/{TICKER}.svg`, **di-vendor** dari
   Parqet (18 file di-commit). App tetap menampilkan logo saat **offline / CDN down**.
3. **Tier 2 — fallback akhir:** lettermark (persis `AssetMark` sekarang) untuk `USDC`,
   simbol tanpa logo, atau jika semua tier gagal.

## Arsitektur

### `src/lib/logos.ts` (baru, unit fokus)
- `tickerFromSym(sym)` → strip `^fb|^d`, uppercase.
- `STOCK_TICKERS` `Set` diturunkan dari `STOCKS` → `isKnownStock(ticker)` (gate CDN hanya
  untuk saham yang dikenal; mencegah hit CDN utk `USDC` dll).
- Loader `import.meta.glob('../assets/logos/*.svg', { eager:true, query:'?url', import:'default' })`
  → map `ticker → url lokal`. Menjatuhkan SVG baru ke folder otomatis terpakai.
- `logoSources(sym)` → array URL berurut prioritas: `[cdn?, local?]` (kosong bila bukan
  saham & tak ada lokal).

### `AssetMark` (`src/components/primitives.tsx`) — di-upgrade
- Props **tidak berubah** (`sym`, `size`) → **nol perubahan di call-site**.
- Stateful via `useState({ ticker, idx })` (derivasi reset saat `ticker` berubah → tanpa flash).
- Render `<img>` dari `logoSources[idx]`; `onError` → naikkan `idx`. Bila `idx` melewati
  daftar → render lettermark (Tier 2).

### `src/assets/logos/*.svg` (baru)
- 18 file vendored dari Parqet.

## Tampilan
- Chip rounded-square existing dipertahankan (radius 9, border `--line-2`, sistem `size`).
- Tier logo: background **terang/netral** + `overflow:hidden` + sedikit padding +
  `object-fit:contain` agar logo berwarna terbaca jelas & rasio terjaga.
- Tier lettermark: **persis seperti sekarang** (`--surface-2`, serif, `--ink-2`).

## Edge cases
- **Wrapped (`fbTSLA`)** → logo sama dgn underlying (konsisten perilaku strip `fb` saat ini).
  Badge gembok "confidential" = opsional, di luar lingkup (YAGNI).
- **USDC / non-saham** → bukan known stock & tak ada lokal → langsung lettermark, tanpa hit CDN.

## File tersentuh
- `src/lib/logos.ts` — baru.
- `src/components/primitives.tsx` — logika `AssetMark`.
- `src/assets/logos/*.svg` — 18 file baru.
- `src/config/stocks.ts`, semua call-site — **tidak diubah**.

## Verifikasi
1. `npm run typecheck` (tsc --noEmit) bersih.
2. `npm run build` sukses.
3. Dev: kartu MarketsPanel render logo asli; wrapper `fb*` pakai logo underlying;
   `USDC` → lettermark; simulasi CDN-gagal → fallback lokal → lettermark.

## Risiko & mitigasi
- CDN Parqet berubah/down → ditutup Tier 1 (lokal) lalu Tier 2 (lettermark): UX selalu degradasi mulus.
- Logo "putih" pada chip terang → risiko rendah (Parqet menyajikan versi standar utk light bg); bisa di-tune setelah cek visual.
- Trademark: penggunaan nominatif untuk identifikasi aset (demo/dapp) — wajar.
