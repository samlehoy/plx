# Playlist Converter: Spotify → Deezer (CLI pribadi)

Konversi playlist Spotify ke playlist baru di Deezer, dari terminal — **tanpa
memerlukan Spotify Premium untuk membaca isi playlist.**

## Kenapa dibangun begini

- **Soundiiz** dan sejenisnya berbayar, membatasi jumlah lagu, dan tak menyinkronkan.
- **API resmi Spotify menolak baca playlist**: sejak kebijakan dev-mode 2026,
  `GET /playlists/{id}/tracks` membalas **403 Forbidden** untuk semua 50 playlist
  yang diuji, walau token sah dan `/me/playlists` berhasil.
- **Jalur cookie `sp_dc`** (`/get_access_token`) membalas **403 "URL Blocked"** —
  diblokir di level jaringan, bahkan dengan header browser lengkap.
- **Yang bekerja:** token anonim dari halaman embed, lalu pathfinder GraphQL.
  Tanpa login, tanpa cookie, tanpa Premium.

## Cara kerja

```
1. Token anonim  ← open.spotify.com/embed/track/…  (__NEXT_DATA__)
2. Baca playlist ← api-partner.spotify.com/pathfinder  (paging penuh, >100 lagu)
3. Cari lagu     ← api.deezer.com/search              (publik, tanpa auth)
4. Tulis playlist← GraphQL Deezer + cookie ARL        (satu-satunya yang butuh kredensial)
5. Laporan CSV
```

Hanya langkah 4 yang butuh kredensial. Membaca playlist Spotify **tak butuh
apa pun** — tak ada OAuth, tak ada Premium.

> ⚠️ **Disclaimer:** Jalur baca Spotify dan tulis Deezer sama-sama memakai endpoint
> tak resmi. Untuk penggunaan pribadi non-komersial. Bisa berhenti bekerja kapan saja
> bila Spotify/Deezer mengubah sistemnya.

## Setup

1. **Ambil cookie `arl` Deezer** (satu kali):
   - Login ke [deezer.com](https://www.deezer.com), buka DevTools (F12)
   - **Application → Cookies → deezer.com** → salin nilai cookie `arl`

2. **Install**:
   ```bash
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt
   cp .env.example .env      # isi DEEZER_ARL
   ```

3. **Opsional — kredensial Spotify.** Hanya diperlukan untuk *mendaftar* playlist
   Anda secara otomatis. Dengan `--url` Anda tak membutuhkannya sama sekali.
   Kalau mau dipakai: buat app di [dashboard](https://developer.spotify.com/dashboard),
   tambahkan redirect URI **`http://127.0.0.1:8888/callback`** (Spotify menolak
   `localhost`; wajib IP literal, dan loopback boleh HTTP).

## Pakai

Tanpa argumen, aplikasi berjalan sebagai interactive terminal:

```bash
.venv/bin/python playlist_converter.py
```

Menu menyediakan:

1. Login Spotify lewat browser dan pilih satu, beberapa, atau semua playlist
2. Tempel URL/ID playlist langsung sebagai fallback tanpa API Premium Spotify
3. Pengaturan
4. Keluar

Aplikasi menampilkan progres per lagu, meminta konfirmasi sebelum menulis ke Deezer,
mempertahankan urutan dan duplikat, serta kembali ke menu jika satu playlist gagal.
Pencarian Deezer memakai jeda 0,3 detik dan retry backoff `1s → 2s → 4s`.

CLI lama tetap tersedia:

```bash
# Tanpa kredensial Spotify sama sekali — tempel URL/ID playlist
.venv/bin/python playlist_converter.py --url "https://open.spotify.com/playlist/xxxx"

# Dry-run dulu: baca & cocokkan, tanpa menyentuh akun Deezer
.venv/bin/python playlist_converter.py --url xxxx --dry-run

# Beberapa playlist sekaligus
.venv/bin/python playlist_converter.py --url id1 id2 id3

# Pakai OAuth untuk mendaftar playlist Anda otomatis
.venv/bin/python playlist_converter.py --all
.venv/bin/python playlist_converter.py --playlists "Chill"
```

Hasilnya: playlist privat bernama `[conv] <nama>` di Deezer, plus
`conversion_report.csv`.

## Cara mencocokkan lagu

Bertingkat, dari ketat ke longgar (ISRC tak tersedia di jalur tanpa-auth):

| Metode | Aturan |
|---|---|
| `exact` | Judul & artis identik setelah normalisasi, durasi ±3 detik |
| `fuzzy-duration` | Judul & artis identik, durasi berbeda — **audit** |
| `fuzzy-title` | Artis identik, satu judul memuat yang lain — **audit** |

Baris ber-metode `fuzzy*` layak diperiksa mata di CSV. Pada uji nyata 122 lagu:
114 `exact`, 5 `fuzzy-title` (semuanya benar — hanya beda `- live sessions`
vs `(live sessions)`), 3 tak ketemu.

Dua detail yang mudah salah dan sudah ditangani:

- **Satuan durasi berbeda**: Spotify milidetik, Deezer detik. Membandingkan
  mentah-mentah menolak *setiap* kecocokan yang benar.
- **Kueri kata-bebas, bukan berfield**: sintaks `artist:"…" track:"…"` gagal
  diam-diam. Pada 19 lagu nyata, berfield menemukan 9, kueri bebas menemukan 19.

## Laporan

`conversion_report.csv`: playlist asal, judul, artis, status `matched`,
id Deezer, metode pencocokan, catatan. Bisa dibuka di Excel.

## Uji

```bash
.venv/bin/python test_flow.py    # unit + integrasi, tanpa jaringan/kredensial
```

## Batasan

- **Menulis** ke Deezer tetap butuh cookie ARL; tak ada jalur publik untuk itu.
- **Mendaftar playlist Anda** butuh OAuth Spotify. Membacanya tidak — pakai `--url`.
- Hash persisted-query (`FETCH_PLAYLIST_SHA`) sesekali dirotasi Spotify. Kalau
  muncul `PersistedQueryNotFound`, tool jatuh ke embed (maksimal 100 lagu);
  ambil hash baru dari tab Network DevTools web player dan ganti satu konstanta itu.
- Sinkronisasi dua arah dan idempotensi antar-run: di luar cakupan.
