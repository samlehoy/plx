# plx — Architecture

Source of truth for the system's design and its external contracts. Read this before changing any file in `src/`.

## Goal

`plx` is a personal playlist converter for Spotify, Deezer, and YouTube Music, distributed as a CLI (`npm install -g plx`). It uses the user's own logged-in browser session, never a developer account or an official API (ADR 0001):

```bash
plx --url "https://open.spotify.com/playlist/PLAYLIST_ID" --dry-run
```

All six directions are supported — every provider is a peer, so any can be the source and any the
target. Each is authenticated by a browser session credential: Spotify `sp_dc`, Deezer `arl`, and a
whole cookie header for YouTube Music. Reading a public Spotify playlist needs no credential at all,
which is what makes a credential-free `--dry-run` possible.

## Flow

```
CLI args (args.ts)  /  interactive menu (cli.ts)
   │                      pick source provider → pick target provider
   │                      (non-interactive: --to names the target,
   │                       the link's host infers the source)
   │
   ▼
registry.ts — ProviderSpec: build each provider from its credential
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

| Capability | Spotify | Deezer | YouTube Music |
|---|---|---|---|
| `reorder` | ✗ — no move primitive in the endpoints plx uses; a Spotify target is dedupe-and-append | ✓ by track id | ✓ by `setVideoId`, mapped from track id inside the provider |
| `resolveTrack` | ✓ — every match into a Spotify target is verified | ✗ — matches into Deezer are unverified | ✓ via `player` |

## Module map

| File | Responsibility |
|---|---|
| `src/cli.ts` | Entry. Arg dispatch, interactive menu (`@clack/prompts`), credential prompt + semi-auto fill + persist. Names no provider — it drives off the registry. |
| `src/registry.ts` | The `ProviderSpec` list: label, link hosts, credential prompt, ref parsing, validation, and how to build each provider. The one place a provider is registered. |
| `src/ytmusic.ts` | YouTube Music credential + transport: the cookie bundle, the shared cookie-header joiner, SAPISIDHASH signing, InnerTube calls, session validation, playlist-ref parsing, mix detection. |
| `src/ytmusic-parse.ts` | Pure parsing of InnerTube responses. Pinned by fixtures recorded from the real service (`tests/fixtures/ytmusic/`). No I/O. |
| `src/ytmusic-provider.ts` | `YtMusicProvider` (a `Provider`): read, search songs then videos, create/add, verify, and reorder by `setVideoId`. |
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

### YouTube Music

| Surface | Endpoint | Fragility |
|---|---|---|
| Session credential | The browser cookie bundle for `.youtube.com`, sent as one `Cookie` header | **`__Secure-1PSIDTS` / `__Secure-3PSIDTS` are required.** Without them the `*PSID` cookies are unbound and the request authenticates as **logged out — with a 200 and no error**. Cookies must also come from one profile and prefer `.youtube.com` over `.google.com`, which set the same names to *different* values. |
| Request signing | `Authorization: SAPISIDHASH <unix-seconds>_<sha1("<ts> <SAPISID> https://music.youtube.com")>`, plus `x-origin` | Mirrors what the web client computes. `SAPISID` may instead be `__Secure-3PAPISID`/`__Secure-1PAPISID`. |
| Session validation | InnerTube `POST /youtubei/v1/account/account_menu`, client `WEB_REMIX` | **A rejected session returns 200 with a signed-out menu**, so validity is judged by whether the response names an account, never by the status code. |
| Playlist read | `POST browse` with `browseId: VL<playlistId>`, following `continuationItemRenderer` tokens | Entries are `musicResponsiveListItemRenderer`, ~6 levels deep; the path differs between browse, search, and continuation, so the parser walks rather than indexes. Title comes from `microformat`. |
| Song vs music video | `watchEndpointMusicConfig.musicVideoType` | Only `MUSIC_VIDEO_TYPE_ATV` is a catalog song. `OMV`, `UGC`, `OFFICIAL_SOURCE_MUSIC` and a missing type are all treated as videos — their stated artist is the uploading channel. |
| Search | `POST search` with the web client's filter `params` — songs and music videos are separate filters | A playlist read puts duration in a fixed column; a search trails it on the subtitle line (`Artist • Album • 3:49`). |
| Create / add / reorder | `POST playlist/create` (`privacyStatus: PRIVATE`), `POST browse/edit_playlist` with `ACTION_ADD_VIDEO` / `ACTION_MOVE_VIDEO_BEFORE` | Reorder moves by `setVideoId`, an opaque per-item handle that is **not** the video id — the same song added twice has two. Resolved inside the provider (ADR 0002). |
| Track metadata (verify) | `POST player` → `videoDetails` | Flat, unlike everything else here. A catalog track's `author` is the artist's auto-generated `"<Artist> - Topic"` channel. |

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
4. `video` — **YouTube Music only**, and only after the catalog returns nothing. The artist rule relaxes to containment (the source artist must appear in the video's title *or* channel name) because a video's stated artist is usually the uploader; in exchange the duration tolerance becomes **mandatory**, and a candidate with no duration is rejected. Duration is the only guard left, and it is what separates the same recording uploaded as a video from someone else's cover.

The tier set is open, not a closed enum every provider shares (ADR 0003) — `video` is the first tier only one provider can produce.

`normalize` strips accents, parentheticals, `(feat./ft.)` labels, punctuation, and collapses whitespace.

## Matching reference

Matching behavior is pinned by the unit tests in `tests/matcher.test.ts`. When changing matching logic, keep those tests green — they encode the invariants above (tiers, normalization, duration tolerance).

## Security notes

- Never commit `.env`, `arl`, `sp_dc`, or generated reports. `.gitignore` excludes them.
- `credentials.json` is written with `0600` on Unix.
- The unofficial endpoints are personal, non-commercial use; keep that disclaimer in the README.

## Config & session storage

See `CONFIG.md` for env vars, the config directory, and `credentials.json` shape.
