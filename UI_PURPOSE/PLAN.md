# Plan — plx landing page

Landing page untuk `plx`, diambil dari Superdesign draft `81bec207-c177-436d-a19f-90cfdf9138b0`
(v2). Keputusan hosting: **track file saja** di repo, host eksternal menyusul.

## Sudah dikerjakan (sesi ini)

- Fetch design via Superdesign CLI → `UI_PURPOSE/frontend-landingpage.html` (43 KB,
  self-contained: Tailwind CDN + Iconify CDN + Google Fonts). Tujuh section, occlusion
  weave, counter-travel record stage, match-tier picker, dan semua JS (chart, pipeline
  draw, scroll choreography) sudah utuh.

## Langkah

1. **Pindah ke lokasi kanonik** — `UI_PURPOSE/frontend-landingpage.html` → `site/index.html`
   (repo ini package npm CLI tanpa static dir; `site/` jadi rumah landing yang jelas).
2. **Fix versi** — meta pinned hero `v0.4.2 · cli` → `0.1.0` (selaras `package.json`).
3. **Fix footer link** — Github/Npm/Docs masih `href="#"`:
   - Github → `https://github.com/samlehoy/plx`
   - Npm → `https://www.npmjs.com/package/plx`
   - Docs → `https://github.com/samlehoy/plx/tree/master/docs`
4. **Reverse framing — tanpa perubahan.** Kalimat `Reverse (Deezer → Spotify) is planned.`
   sengaja dipertahankan sesuai `prompt-2.txt` (jangan tampil sebagai shipped), walau
   docs mencatat reverse sudah jalan.
5. **Tanpa perubahan** `package.json` / workflow CI (keputusan "track file saja").

## Verifikasi / item susulan

- **Aset vinyl** — hotlink eksternal (Shopify CDN), bukan keyed cut-out dari spec
  `Hero record artwork`. Perlu dicek transparansinya; kalau background putih, hero
  occlusion weave rusak. Bila iya: ganti dengan aset keyed yang di-self-host.
- Buka `site/index.html` di browser: cek occlusion weave, sticky stage, tier picker,
  dan `prefers-reduced-motion` (no-JS render harus tetap utuh).

## Di luar scope

- Deploy/hosting (Pages, Vercel, dll) — user host sendiri nanti.
- Lokalisasi.
