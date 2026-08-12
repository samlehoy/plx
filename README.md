# plx

Spotify → Deezer playlist converter CLI.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Usage

```bash
npm install -g plx
plx
plx --url "https://open.spotify.com/playlist/ID" --dry-run
```

The direct URL mode reads Spotify without Premium or Spotify OAuth. Deezer ARL is required to create playlists. The Spotify reading and Deezer writing paths use unofficial web endpoints for personal, non-commercial use and may change.
