# Plan: Playlist Converter Spotify → Deezer (CLI pribadi)

## Pemahaman bersama (keputusan yang disepakati)

| # | Keputusan | Nilai |
|---|-----------|-------|
| Q1 | Bentuk | **CLI** (bukan web app) |
| Q2 | Frekuensi | **Sekali jalan** dulu (bukan sinkron berkala) |
| Q3 | Volume | Diasumsikan puluhan playlist / ribuan lagu — ditangani batch + backoff (bisa dikoreksi) |
| Q4/Q6 | Lagu gagal cocok | **Auto-skip + laporan CSV** |
| Q5 | Akun | Spotify Premium → akan turun **Free**. Deezer Premium jangka panjang |
| Q7 | Build-vs-buy | **Bangun sendiri** (Soundiiz ditolak: berbayar, cap lagu, tanpa sync) |
| Q8 | Arah | **Satu arah** dulu |
| Q9 | Baca Spotify | **Tak resmi via cookie `sp_dc`** (`music-assistant/spotify-client`) |
| Q10 | Urutan | **Spotify → Deezer** |

## Temuan yang membatasi arsitektur

1. **Deezer**: pendaftaran app API resmi **dibekukan** → tidak ada APP_ID/APP_SECRET baru.
   Jalur yang bisa dibangun: **ARL cookie + GraphQL internal** via `deezer-python-gql`.
2. **Spotify**: mulai 2026, pemilik app wajib **Premium** → begitu akun turun Free, API
   resmi mati. Solusi yang bertahan: **token `sp_dc` dari cookie browser** via
   `music-assistant/spotify-client` (dipakai Home Assistant, bekerja di Free).
3. Kedua jalur **tak resmi** (abu-abu ToS, bisa putus kapan pun) → `ponytail` risk noted.

## Arsitektur

- **Bahasa**: Python 3.14 (kedua library building-block adalah Python).
- **Satu file utama** `playlist_converter.py` + `requirements.txt` + `README.md`.
- Alur:

```
1. Auth      : baca sp_dc (Spotify) + arl (Deezer) dari .env / prompt
2. Read      : list playlist Spotify → pilih → fetch tracks (pagination)
3. Match     : per track → ISRC → fallback normalized title+artist (+durasi ±2s)
4. Write     : buat playlist baru di Deezer → add track IDs (batch)
5. Report    : CSV per run (matched / gagal / method match)
```

## Langkah implementasi

0. **Spike verifikasi API** (paling penting): pastikan cara autentikasi & method yang
   benar untuk `music-assistant/spotify-client` (session dengan `sp_dc`) dan
   `deezer-python-gql` (`DeezerGQLClient(arl=...)`) — search, playlist create/add, ISRC.
1. `requirements.txt` — `deezer-python-gql`, `music-assistant/spotify-client`, `python-dotenv`.
2. Modul config: load `SP_DC` & `ARL` dari `.env` (bukan di-commit) atau prompt interaktif.
3. Modul spotify: `list_playlists()`, `get_tracks(playlist_id)` dengan pagination.
4. Modul deezer: `search_track()`, `create_playlist()`, `add_tracks()` (batch, rate-limit).
5. Modul match: `normalize()` (lowercase, strip tanda baca/parenthetical feat/remaster),
   `match_spotify_to_deezer()` → ISRC dulu, lalu fallback.
6. Modul report: tulis CSV (kolom: playlist, judul, artis, album, ISRC, matched,
   deezer_id, method, catatan).
7. `main()`: argparse (`--playlists`, `--all`, `--output`), progress print, backoff pada
   rate-limit (`sleep` + retry `Retry-After` bila ada).
8. Self-check kecil untuk `normalize`/matching (assert-based, tanpa framework).
9. `README.md`: cara ambil `sp_dc` dan `arl` dari browser, cara pakai, peringatan ToS.

## Detail teknis

- **Matching**: ISRC normalisasi (strip spasi) → `title_short`+artis utama ternormalisasi
  → durasi ±2s sebagai disambiguasi.
- **Rate limit**: sleep kecil antar request; backoff eksponensial saat error/429;
  cek header `Retry-After` bila tersedia.
- **CSV**: selalu dibuat per run, bisa dibuka Excel untuk manual-fix.
- **Idempotensi**: skip untuk sekali-jalan (`ponytail`: tambahkan kalau sync).

## Risiko & ekspektasi

- Akses tak resmi di **dua sisi**; bisa break kapan pun (Deezer sudah menunjukkan
  kemauan memutus akses pihak ketiga).
- Maintenance ada di tangan Anda; bukan untuk distribusi.
- ToS: non-komersial, pribadi = risiko rendah secara praktik.

## Di luar scope (defer)

- Sinkron dua arah, dedup/idempotensi antar-run, web UI, penjadwalan.

## Estimasi

- ~400 baris, 1 file utama + deps + README. Langkah 0 (spike) menentukan sisanya.
