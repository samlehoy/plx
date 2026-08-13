# plx — Configuration

Setup guide for credentials, config directory, and storage.

## Prerequisites

- **Node.js ≥ 22**
- **Deezer account** (free is fine) — needed to *write* Deezer playlists.
- **No Spotify Developer account or app registration** — reading is anonymous; writing needs only a logged-in Spotify web session.

## Quick start

```bash
npm install -g plx
plx --url "https://open.spotify.com/playlist/PLAYLIST_ID" --dry-run
```

Spotify → Deezer reads Spotify anonymously — no Premium, no OAuth.

## Credentials

`plx` needs at most **two** cookies, both optional depending on direction:

| Cookie | Env var | Used for | Needed when |
|---|---|---|---|
| Deezer `arl` | `DEEZER_ARL` | authenticate Deezer playlist writes | any flow that writes to Deezer (Spotify → Deezer) |
| Spotify `sp_dc` | `SPOTIFY_DC` | mint an authenticated Spotify token (full search+write scope) | the reverse flow (Deezer → Spotify) |

Reading a Spotify playlist for a dry run needs **no credentials**.

### Getting the cookies

1. Log in to [deezer.com](https://www.deezer.com) / [open.spotify.com](https://open.spotify.com) in a browser.
2. Open DevTools (F12) → **Application** (Chrome/Edge) or **Storage** (Firefox) → **Cookies** → the site domain.
3. Find `arl` (Deezer) or `sp_dc` (Spotify) and copy its value.

### Semi-auto fill (macOS)

Instead of hand-copying, the `arl` / `sp_dc` inputs can **read the cookie straight
from a logged-in browser** — you only accept the macOS Keychain "Allow" dialog. It
works for the **Chromium family** (Brave, Chrome, Edge, Chromium, Vivaldi, Opera)
and **Safari** (Safari needs **Full Disk Access** in System Settings → Privacy &
Security). Pick **"Ambil kredensial otomatis"** from the menu, or it runs
automatically when a credential is missing. Manual paste stays as fallback.

## Env vars

Copy `.env.example` to `.env` (or export in shell). Env vars **override** stored credentials.

| Variable | Required | Purpose |
|---|---|---|
| `DEEZER_ARL` | for writing to Deezer | Deezer session cookie (see above). |
| `SPOTIFY_DC` | for writing to Spotify | Spotify web session cookie (reverse flow only). |

## Config directory

`loadConfig` reads `credentials.json` from the platform config dir:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\plx\credentials.json` |
| macOS/Linux | `~/.config/plx/credentials.json` (or `$XDG_CONFIG_HOME` if set) |

The file is written with mode `0600` on Unix.

## Report output

Default CSV report path is `conversion_report.csv`. Override with `--output <file>` or the interactive menu's **Laporan** option.

## Security

- Never commit `.env`, `credentials.json`, `arl`, or `sp_dc`.
- Cookie auto-fill reads from the browser's local cookie DB; the value is never printed or logged — only stored in `credentials.json` (`0600`).
- The Spotify reader and Deezer writer use **unofficial web endpoints** for personal, non-commercial use. They can change or break without notice. See `ARCHITECTURE.md` for the full contract details.
