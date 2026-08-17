# Plan — plx landing page (final)

Landing page untuk `plx-converter` (bin `plx`), di-rebuild dari Superdesign draft
`81bec207-c177-436d-a19f-90cfdf9138b0` (v2, sudah di-fetch → `UI_PURPOSE/frontend-landingpage.html`
sebagai referensi visual + JS).

## Keputusan (grilling — settled)

| Keputusan | Hasil |
|---|---|
| Framework | React + Vite (bukan single HTML statis) |
| Lokasi | `web/` standalone package (bukan monorepo) |
| Bahasa | TypeScript |
| Styling | Tailwind v4 + `@tailwindcss/vite`, token di `@theme` |
| Font | self-host `@fontsource/archivo` + `@fontsource/ibm-plex-mono` |
| Aset vinyl | self-host `UI_PURPOSE/vinyl.png` (keyed cut-out tidak perlu) |
| Hosting | track file saja; deploy menyusul |

## Aset vinyl — RESOLVED

`UI_PURPOSE/vinyl.png`: 2500×2500, `hasAlpha: yes`, black vinyl disc di background transparan.
Ideal untuk occlusion weave (square + alpha, tanpa keying). Catatan: file **8-bit colormap**
(palette PNG); kalau palette-alpha bermasalah saat render, konversi ke 8-bit RGBA sekali di waktu
implementasi.

## Copy / positioning (binding — dari prompt-2.txt)

- Eyebrow `SPOTIFY ⇄ DEEZER`, headline accent `No dev account.`, lede "browser sessions, not API keys".
- Reverse (Deezer → Spotify) HANYA tampil sebagai "planned"/"soon" — tidak pernah shipped
  (codebase sudah implement, tapi landing jangan bilang shipped).
- Jangan ubah: 7 section, palet achromatic + 1 accent, Archivo/IBM Plex Mono, occlusion weave /
  counter-travel / tier-picker.

## Identitas npm (fix dari stale)

- Package: `plx-converter@0.1.1` (bin tetap `plx`).
- Install: `npm i -g plx-converter` — **bukan** `npm i -g plx` (itu package orang lain).
- Versi hero pinned: `0.1.1 · cli` (bukan `v0.4.2`).
- Footer links:
  - Github → `https://github.com/samlehoy/plx`
  - Npm → `https://www.npmjs.com/package/plx-converter`
  - Docs → `https://github.com/samlehoy/plx/tree/master/docs`

## Langkah implementasi (belum dieksekusi)

1. Scaffold `web/` — Vite + React + TypeScript.
2. Tailwind v4 + plugin; token palet/font/easing di `@theme`.
3. Font via `@fontsource/archivo` + `@fontsource/ibm-plex-mono`.
4. Salin `UI_PURPOSE/vinyl.png` → `web/public/vinyl.png`; konversi RGBA8 bila perlu.
5. Port 7 section + 3 signature component (occlusion weave, counter-travel stage, tier picker)
   + scroll choreography (IntersectionObserver, rAF, `prefers-reduced-motion` gating).
6. Terapkan identitas npm di atas pada semua titik copy (nav pill, hero buttons, spec table,
   close button, footer).

## Verifikasi

- Dev server: occlusion weave (vinyl di z-2), sticky stage, tier picker, `prefers-reduced-motion`
  (no-JS render utuh).
- Pastikan setiap titik install berbunyi `npm i -g plx-converter` dan versi `0.1.1`.

## Out of scope

- Deploy/hosting, lokalisasi, reverse-flow sebagai fitur shipped.
