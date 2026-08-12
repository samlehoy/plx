"""Uji alur konversi dengan API tiruan (tanpa kredensial, tanpa jaringan).

Menjalankan Converter.convert_playlist yang ASLI terhadap Spotify/Deezer tiruan,
lalu memeriksa playlist yang dibuat, lagu yang ditambahkan, dan isi CSV.
Jalankan: .venv/bin/python test_flow.py
"""

import asyncio
import csv
import sys
from pathlib import Path

import playlist_converter as pc
from deezer_python_gql.generated.create_playlist import (
    CreatePlaylistCreatePlaylist,
    CreatePlaylistCreatePlaylistPlaylist,
)
from deezer_python_gql.generated.add_tracks_to_playlist import (
    AddTracksToPlaylistAddTracksToPlaylistPlaylistAddTracksOutput,
)


# --------------------------------------------------------------------------- #
# Data tiruan
# --------------------------------------------------------------------------- #

# Spotify melaporkan milidetik.
SPOTIFY_PLAYLIST = [
    {"name": "One More Time", "artist": "Daft Punk", "duration_ms": 320000},
    {"name": "Fortnight (feat. Post Malone)", "artist": "Taylor Swift, Post Malone",
     "duration_ms": 228965},
    {"name": "Track Not On Deezer", "artist": "Nobody", "duration_ms": 180000},
]

# Deezer melaporkan DETIK — bila konversi satuan rusak, tak ada yang cocok.
DEEZER_CATALOG = {
    "daft punk one more time": [
        {"id": "1001", "title": "One More Time", "artist": {"name": "Daft Punk"}, "duration": 320},
    ],
    # Judul di-strip 'feat.' dan artis dipangkas ke yang pertama saat membentuk kueri.
    "taylor swift fortnight": [
        {"id": "1002", "title": "Fortnight", "artist": {"name": "Taylor Swift"}, "duration": 228},
    ],
    "nobody track not on deezer": [],
}


def fake_http_json(url, headers=None):
    """Gantikan _http_json: layani pencarian Deezer dari katalog tiruan."""
    import urllib.parse
    if "api.deezer.com/search" in url:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["q"][0]
        return {"data": DEEZER_CATALOG.get(q.lower().strip(), [])}
    raise AssertionError(f"HTTP tak terduga: {url}")


def fake_fetch_tracks(playlist_id, token):
    assert token == "anon-token", "converter harus meneruskan token anonim"
    return list(SPOTIFY_PLAYLIST), False


class FakeDeezer:
    def __init__(self):
        self.created = []
        self.added = []

    async def create_playlist(self, title, is_private, is_collaborative, **kw):
        self.created.append(title)
        return CreatePlaylistCreatePlaylist(
            playlist=CreatePlaylistCreatePlaylistPlaylist(id="pz1", title=title))

    async def add_tracks_to_playlist(self, playlist_id, track_ids, **kw):
        self.added.extend(track_ids)
        return AddTracksToPlaylistAddTracksToPlaylistPlaylistAddTracksOutput(
            typename__="PlaylistAddTracksOutput", added_track_ids=track_ids)


# --------------------------------------------------------------------------- #
# Uji
# --------------------------------------------------------------------------- #

def _rows(path: Path) -> list[dict]:
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def test_units():
    """Fungsi pure: normalisasi, pembersihan kueri, dan konversi satuan durasi."""
    assert pc.normalize("Song (Remastered 2021)") == "song"
    assert pc.normalize("Artist [feat. Someone]") == "artist someone"
    assert pc.normalize("Café Éclair") == "cafe eclair"

    assert pc.first_artist("Taylor Swift, Post Malone") == "Taylor Swift"
    assert pc.first_artist("Daft Punk") == "Daft Punk"
    assert pc.strip_feat("Fortnight (feat. Post Malone)") == "Fortnight"
    assert pc.strip_feat("Song [ft. X]") == "Song"

    # Spotify=ms, Deezer=detik. Membandingkan mentah akan menolak semua kecocokan.
    assert pc.match_duration_ms(320000, 320) is True
    assert pc.match_duration_ms(320000, 320000) is False, "satuan wajib dikonversi"
    assert pc.match_duration_ms(320000, 400) is False
    assert pc.match_duration_ms(None, 320) is True

    assert pc.parse_playlist_ref("https://open.spotify.com/playlist/ABC123") == "ABC123"
    assert pc.parse_playlist_ref("spotify:playlist:ABC123") == "ABC123"
    assert pc.parse_playlist_ref("ABC123") == "ABC123"
    print("unit checks OK")


async def test_flow():
    pc._http_json = fake_http_json
    pc.fetch_tracks = fake_fetch_tracks

    out = Path("test_report.csv")
    dz = FakeDeezer()
    conv = pc.Converter(dz, "anon-token", out)
    await conv.convert_playlist("Chill Vibes", "pl1", dry_run=False)
    conv.write_report()

    assert dz.created == ["[conv] Chill Vibes"], f"judul playlist salah: {dz.created}"
    assert sorted(dz.added) == ["1001", "1002"], f"lagu ditambahkan salah: {dz.added}"

    rows = _rows(out)
    assert len(rows) == 3, f"harus 3 baris, dapat {len(rows)}"
    assert sum(r["matched"] == "True" for r in rows) == 2

    # Lagu ber-feat dengan artis ganda tetap harus cocok: inilah kasus yang
    # gagal diam-diam pada kueri berfield Deezer.
    ft = next(r for r in rows if r["title"].startswith("Fortnight"))
    assert ft["matched"] == "True" and ft["deezer_id"] == "1002", f"feat gagal cocok: {ft}"

    missing = next(r for r in rows if r["title"] == "Track Not On Deezer")
    assert missing["matched"] == "False" and missing["note"] == "tidak ketemu"

    # dry-run tak boleh menyentuh Deezer
    out2 = Path("test_report_dry.csv")
    dz2 = FakeDeezer()
    conv2 = pc.Converter(dz2, "anon-token", out2)
    await conv2.convert_playlist("Chill Vibes", "pl1", dry_run=True)
    conv2.write_report()
    assert dz2.created == [] and dz2.added == [], "dry-run tak boleh menulis ke Deezer"
    assert all("dry-run" in r["note"] for r in _rows(out2))

    out.unlink()
    out2.unlink()
    print("INTEGRATION TEST PASS: 2/3 cocok, lagu feat cocok, yang hilang dilaporkan, dry-run bersih.")


if __name__ == "__main__":
    try:
        test_units()
        asyncio.run(test_flow())
    except AssertionError as e:
        print(f"FAIL: {e}")
        sys.exit(1)
