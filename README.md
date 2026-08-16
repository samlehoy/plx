# plx

Spotify ⇄ Deezer playlist converter CLI.

Converts playlists in both directions — reads Spotify **without an account, Premium, or OAuth**; writes via your session cookies.

> ⚠️ **Personal, non-commercial use.** Uses unofficial web endpoints that can change or break without notice. Not affiliated with Spotify or Deezer.

## Install

```bash
npm install -g plx
```

Requires Node.js ≥ 22.

## Usage

```bash
plx                                              # interactive menu (both directions)
plx --url "https://open.spotify.com/playlist/ID" # Spotify → Deezer
plx --url "<URL>" --dry-run                      # preview matches without writing
```

```text
Options:
  -u, --url <URL|ID>      playlist URL/URI/ID (repeatable)
  -o, --output <file>     CSV report path (default: conversion_report.csv)
  -d, --dry-run           match only, don't write
  -h, --help              show help
```

## Credentials

| Cookie | Env var | Needed for |
|---|---|---|
| Deezer `arl` | `DEEZER_ARL` | writing to Deezer |
| Spotify `sp_dc` | `SPOTIFY_DC` | writing to Spotify (reverse flow) |

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
