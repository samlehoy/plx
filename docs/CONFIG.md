# plx — Configuration

Setup guide for credentials, config directory, and storage.

## Prerequisites

- **Node.js ≥ 22**
- **Deezer account** (free is fine) — needed to *write* playlists.
- **No Spotify account or app registration** — playlist reading is anonymous.

## Quick start

```bash
npm install -g plx
plx --url "https://open.spotify.com/playlist/PLAYLIST_ID" --dry-run
```

Reads Spotify anonymously — no Premium, no OAuth, no Spotify credentials.

## The one credential: `DEEZER_ARL`

The only credential `plx` needs is a **Deezer ARL session cookie**, used to authenticate playlist writes.

How to get it:

1. Log in to [deezer.com](https://www.deezer.com) in a browser.
2. Open DevTools (F12) → **Application** (Chrome/Edge) or **Storage** (Firefox) → **Cookies** → `https://www.deezer.com`.
3. Find the cookie named `arl` and copy its value.

You can supply it two ways:

- **Env var** — set `DEEZER_ARL` in `.env` or your shell.
- **Interactive** — run `plx`, pick **Deezer ARL**, and paste it. It's saved to `credentials.json` for next time.

## Env vars

Copy `.env.example` to `.env` (or export in shell). Env vars **override** stored credentials.

| Variable | Required | Purpose |
|---|---|---|
| `DEEZER_ARL` | **Yes** (for writing) | Deezer session cookie (see above). |

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

- Never commit `.env`, `credentials.json`, or ARL.
- The Spotify reader and Deezer writer use **unofficial web endpoints** for personal, non-commercial use. They can change or break without notice. See `ARCHITECTURE.md` for the full contract details.
