# plx

Playlist converter CLI for Spotify, Deezer, and YouTube Music.

Converts a playlist from any of the three services into any other — six directions — using your own logged-in browser session. No developer account, no OAuth, no API keys.

> ⚠️ **Personal, non-commercial use.** Uses unofficial web endpoints that can change or break without notice. Not affiliated with Spotify, Deezer, or YouTube.

<img src="https://raw.githubusercontent.com/samlehoy/plx/master/screenshots/cli-interactive-menu.png" width="640" alt="plx interactive menu: Convert a playlist, Credentials 3/3 saved, Auto-fetch credentials from browser, Report, Quit" />

## Install

```bash
npm install -g plx-converter
```

Requires Node.js ≥ 22.

## Usage

Run `plx` with no arguments for the interactive menu, which walks you through source, target, and credentials:

<img src="https://raw.githubusercontent.com/samlehoy/plx/master/screenshots/cli-provider-selection.png" width="640" alt="Interactive prompt picking a source provider between Spotify, Deezer, and YouTube Music" />

Or name everything up front:

```bash
plx                                                          # interactive menu
plx --url "https://open.spotify.com/playlist/ID"   --to deezer
plx --url "https://www.deezer.com/playlist/ID"     --to ytmusic
plx --url "https://music.youtube.com/playlist?list=ID" --to spotify
plx --url "<LINK>" --to deezer --dry-run                     # preview matches without writing
```

You name the **target**; the source is inferred from the link, since the link already says which
service it belongs to. plx never guesses a destination — omitting `--to` is an error.

```text
Options:
  -u, --url <LINK>        playlist URL/URI/ID (repeatable)
  -t, --to <PROVIDER>     target provider: spotify | deezer | ytmusic (required)
  -o, --output <file>     CSV report path (default: conversion_report.csv)
  -d, --dry-run           match only, don't write
  -h, --help              show help
```

Every run writes a CSV report — one row per track, with the match method and target id, so you can
see exactly what moved and what didn't.

## Credentials

One browser session credential per provider. All are optional — you only need the ones your chosen
direction actually touches.

| Provider | Credential | Env var | Needed for |
|---|---|---|---|
| Spotify | `sp_dc` cookie | `SPOTIFY_DC` | writing to Spotify, or reading your *private* playlists |
| Deezer | `arl` cookie | `DEEZER_ARL` | reading **or** writing a Deezer playlist |
| YouTube Music | whole `cookie:` header | `YTMUSIC_COOKIE` | reading **or** writing a YouTube Music playlist |

Reading a **public Spotify** playlist needs no credentials at all — which is what makes a
credential-free `--dry-run` possible.

**YouTube Music takes a whole cookie header, not a single cookie.** Google splits a session across a
dozen-odd cookies, so copy the entire `cookie:` value: on [music.youtube.com](https://music.youtube.com),
DevTools → **Network** → any request → **Request Headers** → `cookie:`. Google sessions also expire
faster than the other two, so expect to redo this occasionally.

### Auto-fetch from your browser (macOS)

Rather than copying cookies by hand, plx can read them straight from a logged-in browser — you only
accept the macOS Keychain prompt. Pick **"Auto-fetch credentials (from browser)"** from the menu, or
let it run automatically when a credential is missing. Works with the Chromium family (Brave, Chrome,
Edge, Chromium, Vivaldi, Opera) and Safari (needs Full Disk Access). Manual paste stays the fallback
everywhere else.

Set credentials in `.env`, export them in your shell, or paste when prompted. Full setup:
[`docs/CONFIG.md`](docs/CONFIG.md).

## Website

[plx.sh](https://plx.sh) — overview, matching rules, and install steps.

<img src="https://raw.githubusercontent.com/samlehoy/plx/master/screenshots/website-landing.png" width="640" alt="plx landing page: Move your playlist. No dev account." />

## Development

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design, endpoint contracts, invariants.
- [`docs/CONFIG.md`](docs/CONFIG.md) — setup, env vars, config directory.
- [`docs/CONTINUATION.md`](docs/CONTINUATION.md) — handoff log.

## License

MIT
