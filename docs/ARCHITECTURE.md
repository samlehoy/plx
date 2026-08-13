# plx — Architecture

Source of truth for the system's design and its external contracts. Read this before changing any file in `src/`.

## Goal

`plx` is a personal Spotify → Deezer playlist converter distributed as a CLI (`npm install -g plx`). It reads a Spotify playlist **without a Spotify account, Premium, or OAuth**:

```bash
plx --url "https://open.spotify.com/playlist/PLAYLIST_ID" --dry-run
```

The only credential the whole tool needs is a **Deezer ARL cookie** (to write playlists).

## Flow

```
CLI args (args.ts)
   │
   ├─ --url ──────────►  read playlist from Spotify
   │                     (Pathfinder → embed fallback)
   │                              │
   │                              ▼
   │                     match each track via Deezer search
   │                              │
   │                              ▼
   │                     matchedIds
   │                              │
   └─ interactive menu (cli.ts) ──┘
   │
   ▼
write Deezer playlist (GraphQL)   +   write CSV report (csv.ts)
```

Two decoupled halves:
- **Read** (Spotify) — `src/spotify.ts`. Produces `Track[] { name, artist, durationMs }`. No auth.
- **Match & Write** (Deezer) — `src/converter.ts` + `src/deezer.ts`. Matches to Deezer track ids, creates playlists, writes the CSV report.

They meet only in `Converter` (`src/converter.ts`), which is why the parity tests mock each half's `fetch`.

## Module map

| File | Responsibility |
|---|---|
| `src/cli.ts` | Entry. Arg parsing dispatch, interactive menu (`@clack/prompts`), ARL prompt/persist. |
| `src/args.ts` | Pure typed CLI parsing → `CliOptions`. No I/O. |
| `src/config.ts` | Config dir + `credentials.json` read/write (Deezer ARL only). |
| `src/spotify.ts` | Anonymous token, Pathfinder fetch, embed fallback. No OAuth. |
| `src/deezer.ts` | ARL→JWT auth, GraphQL mutations, public search. |
| `src/converter.ts` | Orchestrates read → match → report; retry; CSV rows. |
| `src/matcher.ts` | Pure normalization + tiered matching. No I/O. |
| `src/csv.ts` | CSV escaping/writing. |
| `src/types.ts` | Domain types. |
| `src/http.ts` | fetch helpers: timeout, JSON, retry, browser UA. |

## External contracts (unofficial — fragile)

The project intentionally uses **unofficial web endpoints**. They can change without notice. Isolate each contract to its module; a single constant or schema per surface.

### Spotify

| Surface | Endpoint | Fragility | Constant |
|---|---|---|---|
| Anonymous token | `https://open.spotify.com/embed/track/...` → `__NEXT_DATA__` → `props.pageProps.state.settings.session.accessToken` | Embed HTML shape can change | `FETCH_PLAYLIST_SHA` |
| Playlist tracks (full) | `https://api-partner.spotify.com/pathfinder/v1/query` — persisted query `fetchPlaylist` | **The `sha256Hash` rotates periodically.** If you see `PersistedQueryNotFound`, grab a fresh hash from the web player's DevTools Network tab. | `FETCH_PLAYLIST_SHA` |
| Playlist tracks (fallback) | `https://open.spotify.com/embed/playlist/{id}` → `trackList` | Capped at **100** tracks (`EMBED_TRACK_LIMIT`). Used only when Pathfinder fails. | `EMBED_TRACK_LIMIT` |

### Deezer

| Surface | Endpoint | Fragility |
|---|---|---|
| Auth | `https://auth.deezer.com/login/arl?jo=p&rto=c&i=c` with `Cookie: arl=...` | Returns `{ jwt }`. ARL is a session cookie — expires; re-paste from browser. |
| Search | `https://api.deezer.com/search?q=...` (public, no auth) | Returns candidates with `duration` in **seconds**. |
| Mutations | `https://pipe.deezer.com/api` GraphQL: `GetMe`, `CreatePlaylist`, `AddTracksToPlaylist` | Operation names/args are internal and unversioned. Validate against the real service before relying on a change. |

## Critical invariants (do not regress)

1. **Duration unit conversion** — Spotify reports milliseconds, Deezer seconds. `matchDurationMs` compares `spotifyMs` vs `deezerSec * 1000`. Comparing raw units rejects every correct match.
2. **Free-text Deezer search** — `searchQuery` uses free words (`"artist title"`), NOT `artist:"..." track:"..."` field syntax. Measured on real playlists: field syntax matched 9/19 tracks, free text 19/19.
3. **Embed fallback truncation** — when `result.truncated`, a report row `PERINGATAN: terpotong di 100 lagu` is recorded. This matches the Python reference.
4. **No Spotify credentials** — the tool reads Spotify anonymously. There is no OAuth, no Spotify Client ID/Secret, no Spotify account requirement.

## Matching tiers (`matcher.ts`)

`matchCandidates` returns the first tier that holds, marking the method:

1. `exact` — normalized title + first artist equal, duration within ±3s.
2. `fuzzy-duration` — title + artist equal, duration ignored (live/remaster variants).
3. `fuzzy-title` — one normalized title contains the other + artist equal.

`normalize` strips accents, parentheticals, `(feat./ft.)` labels, punctuation, and collapses whitespace.

## Matching the Python reference

The Python implementation (`playlist_converter.py`) is the behavioral reference. Both must produce equivalent reports. When changing matching logic, re-run the Python test and compare reports.

## Security notes

- Never commit `.env`, ARL, or generated reports. `.gitignore` excludes them.
- `credentials.json` is written with `0600` on Unix.
- The unofficial endpoints are personal, non-commercial use; keep that disclaimer in the README.

## Config & session storage

See `CONFIG.md` for env vars, the config directory, and `credentials.json` shape.
