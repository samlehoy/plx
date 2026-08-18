# plx

Playlist converter CLI for Spotify, Deezer, and YouTube Music.

Converts a playlist from any of the three services into any other — six directions — using your own logged-in browser session. No developer account, no OAuth, no API keys.

> ⚠️ **Personal, non-commercial use.** Uses unofficial web endpoints that can change or break without notice. Not affiliated with Spotify, Deezer, or YouTube.

## Install

```bash
npm install -g plx-converter
```

Requires Node.js ≥ 22.

## Usage

```bash
plx                                                        # interactive menu
plx --url "https://open.spotify.com/playlist/ID" --to deezer
plx --url "https://www.deezer.com/playlist/ID" --to spotify
plx --url "https://music.youtube.com/playlist?list=ID" --to deezer
plx --url "<LINK>" --to deezer --dry-run                   # preview matches without writing
```

You name the **target**; the source is inferred from the link, since the link already says which
service it belongs to. plx never guesses a destination — omitting `--to` is an error.

```text
Options:
  -u, --url <LINK>        playlist URL/URI/ID (repeatable)
  -t, --to <PROVIDER>     target provider (required)
  -o, --output <file>     CSV report path (default: conversion_report.csv)
  -d, --dry-run           match only, don't write
  -h, --help              show help
```

## Credentials

| Cookie | Env var | Needed for |
|---|---|---|
| Deezer `arl` | `DEEZER_ARL` | writing to Deezer |
| Spotify `sp_dc` | `SPOTIFY_DC` | writing to a Spotify target |

Set in `.env`, or paste when prompted. Reading a Spotify playlist needs **no credentials**. Full setup: [`docs/CONFIG.md`](docs/CONFIG.md).

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
