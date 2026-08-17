# plx — Architecture

Source of truth for the system's design and its external contracts. Read this before changing any file in `src/`.

## Goal

`plx` is a personal Spotify ⇄ Deezer playlist converter distributed as a CLI (`npm install -g plx`). It reads a Spotify playlist **without a Spotify account, Premium, or OAuth**:

```bash
plx --url "https://open.spotify.com/playlist/PLAYLIST_ID" --dry-run
```

Both directions are supported:
- **Spotify → Deezer** — reads Spotify anonymously, writes via a Deezer `arl` cookie.
- **Deezer → Spotify** — reads via `arl`, writes via a Spotify `sp_dc` web-session cookie.

## Flow

```
CLI args (args.ts)  /  interactive menu (cli.ts)
   │
   ▼
Conversion(source: Provider, target: Provider)   ← src/conversion.ts
   │
   ├─ source.readPlaylist()  ────────────►  Track[]
   │
   ├─ target.search(track)   ────────────►  Match | null   (provider owns the strategy, ADR 0003)
   │
   ├─ target.resolveTrack?(id)  ─────────►  verify the match, flag it if it diverges
   │
   ▼
target.createPlaylist / addTracks   +   target.reorder?()   +   CSV report (csv.ts)
```

One conversion path, both providers as parameters — N providers give N×(N−1) directions with no
direction-specific code. The pieces:

- **`Provider`** (`src/types.ts`) — the interface every provider implements. Its optional members
  (`reorder`, `resolveTrack`) are **capabilities**: a conversion whose target lacks one degrades
  quietly rather than failing (ADR 0002).
- **`Conversion`** (`src/conversion.ts`) — read → match → verify → report, plus the two write modes
  (new playlist / dedupe-and-append into an existing one). Knows no provider by name.
- **Providers** — `SpotifyProvider` (`src/spotify.ts`) and `DeezerClient` (`src/deezer.ts`). Each owns
  its own search strategy and its own transport; the shared matcher owns the match rules (ADR 0003).

Providers meet only in `Conversion`, which is why the conversion tests supply providers directly and
mock each one's `fetch`.

| Capability | Spotify | Deezer |
|---|---|---|
| `reorder` | ✗ — no move primitive in the endpoints plx uses; a Spotify target is dedupe-and-append | ✓ by track id |
| `resolveTrack` | ✓ — every match into a Spotify target is verified | ✗ — matches into Deezer are unverified |

## Module map

| File | Responsibility |
|---|---|
| `src/cli.ts` | Entry. Arg parsing dispatch, interactive menu (`@clack/prompts`), ARL/`sp_dc` prompt + semi-auto fill + persist. |
| `src/args.ts` | Pure typed CLI parsing → `CliOptions`. No I/O. |
| `src/config.ts` | Config dir + `credentials.json` read/write. Holds **one opaque string per provider, keyed by provider name** — it never parses a credential's contents. Per-provider env overrides, `tryAutoFillCredentials`. |
| `src/browser.ts` | Reads `arl`/`sp_dc` from a logged-in browser (Chromium family decrypt + Safari binarycookies parse). macOS only. |
| `src/spotify.ts` | `SpotifyProvider` + its transport: anonymous token, Pathfinder fetch, embed fallback, `resolveTrackMeta` (match verify), `authenticatedToken(spDc)` (TOTP), search/write/list. |
| `src/deezer.ts` | `DeezerClient` (a `Provider`): ARL→JWT auth, GraphQL mutations, public search, `reorder`. |
| `src/conversion.ts` | The one conversion path. Orchestrates read → match → verify → report; retry; write modes; CSV rows. Provider-agnostic. |
| `src/matcher.ts` | Pure normalization + tiered matching. No I/O. |
| `src/csv.ts` | CSV escaping/writing. |
| `src/types.ts` | Domain types, including the `Provider` interface. |
| `src/http.ts` | fetch helpers: timeout, JSON, retry, browser UA. |

## External contracts (unofficial — fragile)

The project intentionally uses **unofficial web endpoints**. They can change without notice. Isolate each contract to its module; a single constant or schema per surface.

### Spotify

| Surface | Endpoint | Fragility | Constant |
|---|---|---|---|
| Anonymous token | `https://open.spotify.com/embed/track/...` → `__NEXT_DATA__` → `props.pageProps.state.settings.session.accessToken` | Embed HTML shape can change | — |
| Authenticated token | `GET https://open.spotify.com/api/token?reason=transport&productType=web-player&totp=<otp>&totpServer=<otp>&totpVer=<v>` with `Cookie: sp_dc=…` (TOTP = HMAC-SHA1 over the rotating "nuance" secret + `/api/server-time`) | Full search+write scope; the embed token is read-only and must NOT be used for writes | — |
| Playlist tracks (full) | `https://api-partner.spotify.com/pathfinder/v1/query` — persisted query `fetchPlaylist` | **The `sha256Hash` rotates periodically.** If you see `PersistedQueryNotFound`, grab a fresh hash from the web player's DevTools Network tab. | `FETCH_PLAYLIST_SHA` |
| Playlist tracks (fallback) | `https://open.spotify.com/embed/playlist/{id}` → `trackList` | Capped at **100** tracks (`EMBED_TRACK_LIMIT`). Used only when Pathfinder fails. | `EMBED_TRACK_LIMIT` |
| Track metadata (match verify) | `https://open.spotify.com/embed/track/{id}` → `__NEXT_DATA__` → `entity.name` / `artists[0].name` / `duration` (ms) | Anonymous; backs `SpotifyProvider.resolveTrack`, which verifies every match into a Spotify target (precision). Primary artist + duration only — not full multi-artist metadata. | — |
| Search tracks | Pathfinder **v2** `POST /pathfinder/v2/query`, `operationName: "searchTracks"` | Hash rotates (see above) | `SEARCH_TRACKS_SHA` |
| Create playlist | REST `POST https://spclient.wg.spotify.com/playlist/v2/playlist?format=json` | No persisted-query hash. Creates the playlist but does **not** attach it to the account — must be followed by `addItemsToRootlist`, else it never shows in the library. | — |
| Add to library/rootlist | Pathfinder **v2**, `operationName: "addItemsToRootlist"`, `{ uris: [playlistUri] }` | Hash rotates | `ADD_ITEMS_TO_ROOTLIST_SHA` |
| Add tracks | Pathfinder **v2**, `operationName: "addToPlaylist"` | Hash rotates | `ADD_TO_PLAYLIST_SHA` |
| List playlists | Pathfinder **v2**, `operationName: "libraryV3"` | Hash rotates | `LIBRARY_V3_SHA` |

### Deezer

| Surface | Endpoint | Fragility |
|---|---|---|
| Auth | `https://auth.deezer.com/login/arl?jo=p&rto=c&i=c` with `Cookie: arl=...` | Returns `{ jwt }`. ARL is a session cookie — expires; re-paste from browser. |
| Search | `https://api.deezer.com/search?q=...` (public, no auth) | Returns candidates with `duration` in **seconds**. |
| Mutations | `https://pipe.deezer.com/api` GraphQL: `GetMe`, `CreatePlaylist`, `AddTracksToPlaylist` | Operation names/args are internal and unversioned. Validate against the real service before relying on a change. |

## Critical invariants (do not regress)

1. **Duration unit conversion** — Spotify reports milliseconds, Deezer seconds. `matchDurationMs` compares `spotifyMs` vs `deezerSec * 1000`. Comparing raw units rejects every correct match.
2. **Free-text Deezer search** — `searchQuery` uses free words (`"artist title"`), NOT `artist:"..." track:"..."` field syntax. Measured on real playlists: field syntax matched 9/19 tracks, free text 19/19.
3. **Truncated source read** — when a provider's `readPlaylist` reports `truncated`, a `WARNING: truncated at N tracks` report row is recorded. Today only Spotify's embed fallback truncates (at `EMBED_TRACK_LIMIT`), but the conversion path stays provider-agnostic: it reports the count it actually read, not any one provider's cap.
4. **No Spotify Developer account / OAuth** — reading is anonymous; writing into a Spotify target uses a personal `sp_dc` web-session cookie (minted to a token via TOTP), never an official Client ID/Secret or OAuth.

## Matching tiers (`matcher.ts`)

`matchCandidates` returns the first tier that holds, marking the method:

1. `exact` — normalized title + first artist equal, duration within ±3s.
2. `fuzzy-duration` — title + artist equal, duration ignored (live/remaster variants).
3. `fuzzy-title` — one normalized title contains the other + artist equal.

`normalize` strips accents, parentheticals, `(feat./ft.)` labels, punctuation, and collapses whitespace.

## Matching reference

Matching behavior is pinned by the unit tests in `tests/matcher.test.ts`. When changing matching logic, keep those tests green — they encode the invariants above (tiers, normalization, duration tolerance).

## Security notes

- Never commit `.env`, `arl`, `sp_dc`, or generated reports. `.gitignore` excludes them.
- `credentials.json` is written with `0600` on Unix.
- The unofficial endpoints are personal, non-commercial use; keep that disclaimer in the README.

## Config & session storage

See `CONFIG.md` for env vars, the config directory, and `credentials.json` shape.
