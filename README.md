# plx

Spotify → Deezer playlist converter CLI.

Convert a Spotify playlist to a Deezer playlist. Reads Spotify **without a Spotify account, Premium, or OAuth**; writes to your Deezer account via your ARL session cookie.

> ⚠️ **Non-commercial / personal use.** The Spotify reader and Deezer writer use unofficial web endpoints that can change or break without notice. Not affiliated with Spotify or Deezer.

## Install

```bash
npm install -g plx
```

Requires Node.js ≥ 22.

## Quick start

```bash
# Convert a single playlist — no Spotify login needed
plx --url "https://open.spotify.com/playlist/PLAYLIST_ID"

# Preview matching without writing to Deezer
plx --url "https://open.spotify.com/playlist/PLAYLIST_ID" --dry-run

# Interactive menu
plx
```

The only credential is `DEEZER_ARL` (Deezer session cookie). Set it in `.env`, or paste it when the menu asks. See [`docs/CONFIG.md`](docs/CONFIG.md) for full setup.

## Usage

```text
Usage:
  plx                              interactive menu
  plx --url <URL|ID> [--url ...]   convert specific playlist(s) — no Spotify account or OAuth needed

Options:
  -u, --url <URL|ID>      Spotify playlist URL, URI, or ID (repeatable)
  -o, --output <file>     CSV report path (default: conversion_report.csv)
  -d, --dry-run           match only; do not create Deezer playlists
  -h, --help              show this help
```

Every run writes a CSV report of matches to `conversion_report.csv` (override with `--output`).

## Development

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the system works, external endpoint contracts, invariants.
- [`docs/CONFIG.md`](docs/CONFIG.md) — setup, env vars, config directory, storage.
- [`docs/CONTINUATION.md`](docs/CONTINUATION.md) — handoff log / outstanding work.

## License

MIT
