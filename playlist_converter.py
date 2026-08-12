#!/usr/bin/env python3
"""Spotify -> Deezer playlist converter (pribadi).

Baca playlist dari akun Spotify via API resmi (OAuth), cocokkan ke library
Deezer via GraphQL internal (cookie `arl`), buat playlist baru di Deezer.

DISCLAIMER: Sisi Deezer memakai akses tak-resmi (cookie ARL) karena API resmi
Deezer menutup pendaftaran app baru. Risiko: bisa putus kapan pun. Non-komersial.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from deezer_python_gql import DeezerGQLClient
from spotify_client import Config as SpotifyConfig
from spotify_client import SpotifyClient


# --------------------------------------------------------------------------- #
# Config & load kredensial
# --------------------------------------------------------------------------- #

@dataclass
class Config:
    spotify_client_id: str
    spotify_secret: str
    deezer_arl: str
    output_csv: Path = Path("conversion_report.csv")


def load_config(need_spotify: bool = True) -> Config:
    """Baca kredensial dari .env.

    DEEZER_ARL selalu wajib (untuk MENULIS playlist). Kredensial Spotify hanya
    dipakai untuk mendaftar playlist Anda; dengan --url ia tak diperlukan sama sekali.
    """
    load_dotenv()
    client_id = os.getenv("SPOTIFY_CLIENT_ID")
    secret = os.getenv("SPOTIFY_CLIENT_SECRET")
    arl = os.getenv("DEEZER_ARL")

    required = [("DEEZER_ARL", arl)]
    if need_spotify:
        required += [("SPOTIFY_CLIENT_ID", client_id), ("SPOTIFY_CLIENT_SECRET", secret)]
    missing = [n for n, v in required if not v]
    if missing:
        sys.exit(f"Set env berikut di .env: {', '.join(missing)}\n"
                 "(Kredensial Spotify bisa dilewati sepenuhnya dengan flag --url.)")
    return Config(client_id, secret, arl)


# --------------------------------------------------------------------------- #
# Spotify: OAuth + baca playlist
# --------------------------------------------------------------------------- #

REDIRECT_URI = "http://127.0.0.1:8888/callback"


def spotify_oauth(client: SpotifyClient) -> tuple[str, str]:
    """Alur OAuth otomatis: buka link, jalankan server callback di 127.0.0.1:8888,
    tangkap code dari redirect, tukar jadi access_token. Non-interaktif."""
    import threading
    import time as _time
    import urllib.parse
    import webbrowser
    from http.server import BaseHTTPRequestHandler, HTTPServer

    state = "playlist-converter"
    scopes = ["playlist-read-private", "playlist-read-collaborative"]
    auth_url = client.build_spotify_oauth_confirm_link(state, scopes, REDIRECT_URI)

    code_holder = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("code"):
                code_holder["code"] = q["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            body = ("Login OK. Silakan kembali ke terminal." if code_holder.get("code")
                    else "Gagal: tak ada code.")
            self.wfile.write(body.encode())

        def log_message(self, *args):
            pass  # redam log HTTP

    srv = HTTPServer(("127.0.0.1", 8888), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    print("1. Buka link ini di browser dan login Spotify:")
    print(f"   {auth_url}\n")
    print("2. Setelah klik 'Agree', kamu akan diarahkan ke 127.0.0.1:8888/callback.")
    print("   Browser akan otomatis terbuka — kalau tidak, klik link di atas.")
    # buka browser di thread agar tidak memblokir polling loop
    threading.Thread(target=lambda: webbrowser.open(auth_url), daemon=True).start()

    # tunggu code (90s)
    deadline = _time.time() + 90
    while _time.time() < deadline and not code_holder.get("code"):
        _time.sleep(0.5)
    srv.shutdown()
    code = code_holder.get("code")
    if not code:
        sys.exit("Gagal: tidak menerima kode OAuth Spotify (timeout 90s). Coba buka link manual & login.")

    tokens = client.get_access_and_refresh_tokens(code, REDIRECT_URI)
    access = tokens["access_token"]
    profile = client.get_user_profile(access)
    return access, profile["id"]


def sp_get(client: SpotifyClient, token: str, path: str, params: dict | None = None) -> dict:
    """Raw GET ke Spotify API dengan user-token eksplisit (library tak nerusin header user)."""
    url = f"{client.API_URL}{path}"
    return client._make_spotify_request("GET", url, params=params, headers={"Authorization": f"Bearer {token}"})


def spotify_playlist_uris(client: SpotifyClient, token: str, user_id: str) -> list[dict]:
    """List semua playlist user + uri. Pakai /me/playlists (endpoint untuk user yang
    login; /users/{id}/playlists butuh scope berbeda & bisa 403 di dev-mode)."""
    playlists = sp_get(client, token, "/me/playlists")
    out = []
    for p in playlists.get("items", []):
        out.append({"name": p["name"], "uri": p["id"]})
    return out


BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v1/query"

# Hash persisted-query untuk operasi fetchPlaylist. Spotify sesekali merotasinya;
# kalau respons memuat "PersistedQueryNotFound", ambil hash baru dari tab Network
# DevTools di web player dan ganti nilai ini.
FETCH_PLAYLIST_SHA = "a65e12194ed5fc443a1cdebed5fabe33ca5b07b987185d63c72483867ad13cb4"

# Halaman embed memotong trackList tepat di angka ini — dipakai jalur cadangan saja.
EMBED_TRACK_LIMIT = 100


def _http_json(url: str, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _next_data(url: str) -> dict:
    """Ambil blob __NEXT_DATA__ dari halaman embed Spotify."""
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise RuntimeError("Blob __NEXT_DATA__ tak ditemukan — format embed mungkin berubah")
    return json.loads(m.group(1))


def anon_token() -> str:
    """Bearer token anonim dari halaman embed track — tanpa login, cookie, atau OAuth.

    Ini melewati /get_access_token (yang membalas 403 "URL Blocked" untuk IP kita)
    dan tak butuh cookie sp_dc sama sekali.
    """
    nd = _next_data("https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC")
    return nd["props"]["pageProps"]["state"]["settings"]["session"]["accessToken"]


def fetch_tracks_embed(playlist_id: str) -> tuple[list[dict], bool]:
    """Cadangan: baca trackList dari halaman embed. Terpotong di 100 lagu."""
    nd = _next_data(f"https://open.spotify.com/embed/playlist/{playlist_id}")
    entity = nd["props"]["pageProps"]["state"]["data"]["entity"]
    tracks = [{
        "name": t.get("title", ""),
        "artist": t.get("subtitle", ""),
        "duration_ms": t.get("duration"),
    } for t in entity.get("trackList", [])]
    return tracks, len(tracks) >= EMBED_TRACK_LIMIT


def playlist_name(playlist_id: str) -> str:
    """Nama asli playlist dari halaman embed — supaya --url tak menghasilkan nama acak."""
    try:
        nd = _next_data(f"https://open.spotify.com/embed/playlist/{playlist_id}")
        name = nd["props"]["pageProps"]["state"]["data"]["entity"].get("name")
        if name:
            return name
    except Exception:
        pass
    return f"playlist-{playlist_id[:8]}"


def fetch_tracks(playlist_id: str, token: str) -> tuple[list[dict], bool]:
    """Baca SEMUA lagu playlist lewat pathfinder GraphQL — tanpa auth pengguna.

    API resmi membalas 403 untuk /playlists/{id}/tracks (kebijakan dev-mode 2026).
    Pathfinder menerima token anonim dan mendukung paging sungguhan, jadi playlist
    di atas 100 lagu ikut terbaca — tak seperti halaman embed.

    Return (tracks, terpotong). Terpotong hanya True bila jatuh ke jalur embed.
    """
    out: list[dict] = []
    offset = 0
    while True:
        variables = {"uri": f"spotify:playlist:{playlist_id}", "offset": offset,
                     "limit": 100, "enableWatchFeedEntrypoint": False}
        query = urllib.parse.urlencode({
            "operationName": "fetchPlaylist",
            "variables": json.dumps(variables, separators=(",", ":")),
            "extensions": json.dumps(
                {"persistedQuery": {"version": 1, "sha256Hash": FETCH_PLAYLIST_SHA}},
                separators=(",", ":")),
        })
        raw = _http_json(f"{PATHFINDER_URL}?{query}",
                         {"Authorization": f"Bearer {token}", "app-platform": "WebPlayer"})
        if raw.get("errors"):
            raise RuntimeError(f"pathfinder: {raw['errors'][0].get('message')}")

        content = raw["data"]["playlistV2"]["content"]
        items = content["items"]
        for item in items:
            data = item.get("itemV2", {}).get("data", {})
            if not data.get("uri"):
                continue  # episode podcast / lagu yang sudah dihapus
            artists = data.get("artists", {}).get("items", [])
            out.append({
                "name": data.get("name", ""),
                "artist": artists[0]["profile"]["name"] if artists else "",
                "duration_ms": (data.get("trackDuration") or {}).get("totalMilliseconds"),
            })
        offset += len(items)
        if not items or offset >= content["totalCount"]:
            return out, False


# --------------------------------------------------------------------------- #
# Normalisasi & matching
# --------------------------------------------------------------------------- #

def normalize(s: str) -> str:
    """Lowercase, buang aksen, tanda baca, dan info parenthetical/tambahan."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    # buang info parenthetical (remastered), (deluxe), dst.
    s = re.sub(r"\(.*?\)", "", s)
    # dalam kurung siku: buang label "feat./ft.", pertahankan nama yang di-feature
    s = re.sub(r"[\[(]\s*(feat\.?|ft\.?)\s*", "", s)
    s = re.sub(r"[\]]", "", s)                    # buang kurung siku tersisa
    s = re.sub(r"[^\w\s]", "", s)                 # buang tanda baca
    s = re.sub(r"\s+", " ", s).strip()
    return s


def match_duration_ms(spotify_ms: int | None, deezer_sec: int | None, tolerance_ms: int = 3000) -> bool:
    """Cocok jika durasi berdekatan (default ±3s) atau salah satu tak diketahui.

    Satuannya BERBEDA antar-layanan: Spotify melaporkan milidetik, Deezer detik.
    Membandingkannya mentah-mentah akan menolak setiap pencocokan yang benar.
    """
    if spotify_ms is None or deezer_sec is None:
        return True
    return abs(spotify_ms - deezer_sec * 1000) <= tolerance_ms


# --------------------------------------------------------------------------- #
# Deezer: cari, buat, tambah
# --------------------------------------------------------------------------- #

def first_artist(artist: str) -> str:
    """Nama artis pertama saja — pathfinder/embed menggabungkan artis dengan koma."""
    return artist.split(",")[0].strip()


def strip_feat(title: str) -> str:
    """Buang embel-embel '(feat. X)' / '[ft. Y]' yang jarang cocok di sisi Deezer."""
    return re.sub(r"\s*[\(\[]\s*(feat|ft)\.?[^)\]]*[\)\]]", "", title, flags=re.I).strip()


def dz_search_top(title: str, artist: str, limit: int = 5) -> list[dict]:
    """Cari lagu lewat api.deezer.com publik — tanpa auth, tanpa cookie ARL.

    Memakai kueri kata-bebas, bukan sintaks berfield 'artist:"..." track:"..."'.
    Diukur pada 19 lagu nyata dari playlist pengguna: berfield menemukan 9,
    kueri bebas menemukan 19. Sintaks berfield gagal diam-diam untuk banyak artis.
    """
    q = f"{first_artist(artist)} {strip_feat(title)}".strip()
    url = "https://api.deezer.com/search?" + urllib.parse.urlencode({"q": q, "limit": limit})
    data = _http_json(url)
    return [{
        "id": str(t["id"]),
        "title": t.get("title", ""),
        "artist": (t.get("artist") or {}).get("name", ""),
        "duration": t.get("duration"),  # detik
    } for t in data.get("data", [])]


def dz_match_title_artist(title: str, artist: str, duration_ms: int | None) -> dict | None:
    """Cocokkan bertingkat, tanpa ISRC (embed tak menyediakannya).

    Tahap 1 (ketat): judul & artis sama persis setelah normalisasi, durasi ±3s.
    Tahap 2 (longgar): judul & artis sama, durasi diabaikan — ditandai 'fuzzy'
    di laporan supaya bisa diaudit (versi live/remaster bisa lolos di sini).
    Tahap 3 (longgar): judul salah satu memuat yang lain + artis sama — ditandai 'fuzzy'.
    """
    candidates = dz_search_top(title, artist)
    n_title, n_artist = normalize(strip_feat(title)), normalize(first_artist(artist))

    for c in candidates:
        if (n_title == normalize(c["title"]) and n_artist == normalize(c["artist"])
                and match_duration_ms(duration_ms, c["duration"])):
            return {"id": c["id"], "title": c["title"], "artist": c["artist"], "method": "exact"}

    for c in candidates:
        if n_title == normalize(c["title"]) and n_artist == normalize(c["artist"]):
            return {"id": c["id"], "title": c["title"], "artist": c["artist"], "method": "fuzzy-duration"}

    for c in candidates:
        ct, ca = normalize(c["title"]), normalize(c["artist"])
        if n_artist == ca and n_title and ct and (n_title in ct or ct in n_title):
            return {"id": c["id"], "title": c["title"], "artist": c["artist"], "method": "fuzzy-title"}

    return None


# --------------------------------------------------------------------------- #
# Core alur
# --------------------------------------------------------------------------- #

@dataclass
class ReportRow:
    playlist: str
    title: str
    artist: str
    isrc: str | None
    matched: bool
    deezer_id: str | None = None
    method: str | None = None
    note: str | None = None


@dataclass
class MatchResult:
    matched_ids: list[str]
    total: int
    truncated: bool = False


@dataclass
class Converter:
    deezer: DeezerGQLClient
    spotify_token: str          # token anonim dari embed, bukan OAuth
    output_csv: Path
    rows: list[ReportRow] = field(default_factory=list)

    def record(self, **kw):
        self.rows.append(ReportRow(**kw))

    async def match_playlist(self, name: str, playlist_id: str, *, dry_run: bool = False) -> MatchResult:
        print(f"\n[{name}] membaca playlist dari Spotify...")
        try:
            tracks, truncated = fetch_tracks(playlist_id, self.spotify_token)
        except Exception as e:
            print(f"[{name}] pathfinder gagal ({type(e).__name__}), mencoba embed...")
            try:
                tracks, truncated = fetch_tracks_embed(playlist_id)
            except Exception as e2:
                self.record(playlist=name, title="", artist="", isrc=None, matched=False,
                            note=f"gagal baca playlist: {type(e2).__name__}")
                print(f"[{name}] ⚠️ TIDAK BISA dibaca ({type(e2).__name__}). Dilewati.")
                return MatchResult([], 0)

        print(f"[{name}] {len(tracks)} lagu.")
        if truncated:
            print(f"[{name}] ⚠️ Terpotong di {EMBED_TRACK_LIMIT} lagu.")
            self.record(playlist=name, title="", artist="", isrc=None, matched=False,
                        note=f"PERINGATAN: terpotong di {EMBED_TRACK_LIMIT} lagu; sisanya tidak dikonversi")
        matched_ids = []
        for i, meta in enumerate(tracks, 1):
            res = await self._match_track(meta)
            if res:
                matched_ids.append(res["id"])
                self.record(playlist=name, title=meta["name"], artist=meta["artist"], isrc=None,
                            matched=True, deezer_id=res["id"], method=res["method"],
                            note="dry-run" if dry_run else None)
                mark = f"✓ {res['method']}"
            else:
                self.record(playlist=name, title=meta["name"], artist=meta["artist"], isrc=None,
                            matched=False, note="dry-run: tidak ketemu" if dry_run else "tidak ketemu")
                mark = "✗ tidak ditemukan"
            print(f"  [{i}/{len(tracks)}] {mark} — {meta['name']} — {meta['artist']}")
            await asyncio.sleep(0.3)
        print(f"[{name}] {len(matched_ids)}/{len(tracks)} lagu cocok.")
        return MatchResult(matched_ids, len(tracks), truncated)

    async def write_playlist(self, name: str, matched_ids: list[str], title: str | None = None) -> None:
        if not matched_ids:
            print(f"[{name}] Tidak ada lagu yang cocok — playlist tidak dibuat.")
            return
        title = title or f"[conv] {name}"
        created = await self.deezer.create_playlist(title=title, is_private=True, is_collaborative=False)
        dz_playlist_id = str(created.playlist.id)
        added = 0
        for start in range(0, len(matched_ids), 100):
            res = await self.deezer.add_tracks_to_playlist(dz_playlist_id, matched_ids[start:start + 100])
            added += len(getattr(res, "added_track_ids", [])) if res else 0
            await asyncio.sleep(0.2)
        print(f"[{name}] playlist Deezer dibuat: {title} ({added}/{len(matched_ids)} lagu).")

    async def convert_playlist(self, name: str, playlist_id: str, *, dry_run: bool = False) -> None:
        result = await self.match_playlist(name, playlist_id, dry_run=dry_run)
        if not dry_run:
            await self.write_playlist(name, result.matched_ids)

    async def _match_track(self, meta: dict) -> dict | None:
        for attempt in range(3):
            try:
                return dz_match_title_artist(meta["name"], meta["artist"], meta.get("duration_ms"))
            except Exception as e:
                if attempt == 2:
                    print(f"  ⚠️ pencarian gagal setelah 3 percobaan: {type(e).__name__}")
                else:
                    await asyncio.sleep((1, 2, 4)[attempt])
        return None

    def write_report(self) -> None:
        with open(self.output_csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(ReportRow.__dataclass_fields__))
            w.writeheader()
            for r in self.rows:
                w.writerow(r.__dict__)
        print(f"\nLaporan: {self.output_csv} ({len(self.rows)} baris)")


# --------------------------------------------------------------------------- #
# Entry
# --------------------------------------------------------------------------- #

def parse_playlist_ref(ref: str) -> str:
    """Terima URL Spotify, URI, atau ID mentah — kembalikan ID playlist."""
    ref = ref.strip()
    if "open.spotify.com" in ref:
        return urllib.parse.urlparse(ref).path.rstrip("/").rsplit("/", 1)[-1]
    if ref.startswith("spotify:playlist:"):
        return ref.rsplit(":", 1)[-1]
    return ref


def choose_playlist_numbers(all_pls: list[dict], picks: str) -> list[dict]:
    if picks.lower() == "a":
        return list(all_pls)
    if picks.lower() == "q":
        return []
    out = []
    for part in picks.split(","):
        if part.strip().isdigit():
            i = int(part.strip())
            if 1 <= i <= len(all_pls):
                out.append(all_pls[i - 1])
    return out


def ask_yes_no(prompt: str) -> bool:
    try:
        return input(prompt).strip().lower() in {"y", "yes"}
    except (EOFError, KeyboardInterrupt):
        return False


async def process_playlist(conv: Converter, p: dict, *, dry_run: bool = False,
                           confirm: bool = False) -> None:
    result = await conv.match_playlist(p["name"], p["uri"], dry_run=dry_run)
    if dry_run or not result.matched_ids:
        return
    if result.truncated and not ask_yes_no("⚠️ Playlist terpotong. Tetap lanjut? [y/N] "):
        return
    if confirm and not ask_yes_no(
            f"Buat '[conv] {p['name']}' ({len(result.matched_ids)} lagu)? [y/N] "):
        print("Dilewati.")
        return
    await conv.write_playlist(p["name"], result.matched_ids)


async def interactive(cfg: Config, output: str) -> None:
    print("\n=== Playlist Converter ===")
    print("Spotify: siap untuk login OAuth | Deezer: ARL tersimpan")
    print("Catatan: Ctrl+C membatalkan playlist saat ini dan menyimpan laporan.\n")
    print("Mengambil token Spotify anonim (tanpa Premium)...")
    sp_token = anon_token()
    async with DeezerGQLClient(arl=cfg.deezer_arl) as dz:
        me = await dz.get_me()
        if not me or not me.id:
            print("ARL Deezer tidak valid / gagal login.")
            return
        conv = Converter(dz, sp_token, Path(output))
        while True:
            print("\n1. Login Spotify dan pilih playlist")
            print("2. Konversi dari URL/ID Spotify")
            print("3. Pengaturan")
            print("4. Keluar")
            try:
                choice = input("\nPilih: ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if choice == "4":
                break
            if choice == "3":
                print(f"Laporan saat ini: {conv.output_csv}")
                continue
            if choice == "2":
                ref = input("Tempel URL/ID playlist (q untuk kembali): ").strip()
                if not ref or ref.lower() == "q":
                    continue
                pid = parse_playlist_ref(ref)
                try:
                    await process_playlist(conv, {"name": playlist_name(pid), "uri": pid}, confirm=True)
                except KeyboardInterrupt:
                    print("\nPlaylist dibatalkan.")
                except Exception as e:
                    print(f"Gagal memproses playlist: {type(e).__name__}")
                conv.write_report()
                continue
            if choice == "1":
                try:
                    SpotifyConfig.configure(cfg.spotify_client_id, cfg.spotify_secret)
                    sp = SpotifyClient()
                    token, user_id = spotify_oauth(sp)
                    all_pls = spotify_playlist_uris(sp, token, user_id)
                except (Exception, SystemExit) as e:
                    print(f"OAuth gagal: {e}")
                    continue
                for i, p in enumerate(all_pls, 1):
                    print(f"  {i}. {p['name']}")
                selected = choose_playlist_numbers(
                    all_pls, input("Pilih nomor (1,3), a=semua, q=kembali: ").strip())
                for p in selected:
                    try:
                        await process_playlist(conv, p, confirm=True)
                    except KeyboardInterrupt:
                        print("\nPlaylist dibatalkan; kembali ke menu.")
                    except Exception as e:
                        print(f"Gagal memproses {p['name']}: {type(e).__name__}")
                conv.write_report()
        conv.write_report()


async def main() -> None:
    ap = argparse.ArgumentParser(
        description="Konversi playlist Spotify ke Deezer (baca tanpa Spotify Premium)")
    ap.add_argument("--playlists", nargs="*", help="Nama playlist (sebagian) yang mau dikonversi")
    ap.add_argument("--all", action="store_true", help="Konversi semua playlist")
    ap.add_argument("--url", nargs="*", help="URL/ID playlist langsung — tak butuh OAuth Spotify")
    ap.add_argument("--output", default="conversion_report.csv", help="File CSV laporan")
    ap.add_argument("--dry-run", action="store_true", help="Baca & match saja, tanpa membuat playlist")
    args = ap.parse_args()
    if not args.url and not args.all and not args.playlists:
        try:
            cfg = load_config(need_spotify=True)
            await interactive(cfg, args.output)
        except (KeyboardInterrupt, EOFError):
            print("\nSelesai.")
        return

    cfg = load_config(need_spotify=not args.url)
    print("Mengambil token Spotify anonim (tanpa login)...")
    sp_token = anon_token()
    if args.url:
        ids = [parse_playlist_ref(u) for u in args.url]
        pls = [{"name": playlist_name(pid), "uri": pid} for pid in ids]
    else:
        SpotifyConfig.configure(cfg.spotify_client_id, cfg.spotify_secret)
        sp = SpotifyClient()
        print("Autentikasi Spotify (hanya untuk mendaftar playlist)...")
        token, user_id = spotify_oauth(sp)
        print(f"Login Spotify OK (user {user_id}).")
        all_pls = spotify_playlist_uris(sp, token, user_id)
        if args.all:
            pls = all_pls
        else:
            keys = [x.lower() for x in args.playlists]
            pls = [p for p in all_pls if any(k in p["name"].lower() for k in keys)]
            if not pls:
                sys.exit("Tidak ada playlist yang cocok dengan filter.")
    async with DeezerGQLClient(arl=cfg.deezer_arl) as dz:
        me = await dz.get_me()
        if not me or not me.id:
            sys.exit("ARL Deezer tidak valid / gagal login. Periksa DEEZER_ARL.")
        conv = Converter(dz, sp_token, Path(args.output))
        for p in pls:
            await process_playlist(conv, p, dry_run=args.dry_run)
        conv.write_report()
        matched = sum(1 for r in conv.rows if r.matched)
        fuzzy = sum(1 for r in conv.rows if r.method and r.method.startswith("fuzzy"))
        print(f"\nRingkasan: {matched} lagu cocok" +
              (f" ({fuzzy} perlu diaudit)" if fuzzy else ""))


if __name__ == "__main__":
    asyncio.run(main())
