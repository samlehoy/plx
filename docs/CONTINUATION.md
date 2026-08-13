# plx — Continuation Notes

**Handoff log for the next session.** This file tracks what changed and what's left. For *how the system works* read `ARCHITECTURE.md`; for *setup/credentials* read `CONFIG.md`.

Updated: 2026-08-13

## Pointers

- **System design & external contracts** → [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **Setup, env vars, config dir, storage** → [`CONFIG.md`](CONFIG.md)
- **Historical Python reference** — `playlist_converter.py` (behavioral reference for matching & reports)

## Current state (as of 2026-08-13)

Spotify → Deezer works, no Spotify credentials. `plx` reads a Spotify playlist anonymously (Pathfinder → embed fallback) and writes to Deezer via ARL cookie (GraphQL).

Verified live this session:
- Deezer GraphQL mutations corrected against the real schema (single `input: {…}` argument, `String!` scalars) — `CreatePlaylist`, `AddTracksToPlaylist` both write successfully.
- Deezer JWT now decodes `exp` and refreshes 30s before expiry; auto-retries once on `not valid anymore`.
- Matching: free-text search first, field-syntax (`track:"…" artist:"…"`) fallback (K-pop covers/remixes otherwise win relevance).
- Artist compare is whitespace-insensitive (`JIHYO` == `Ji Hyo`).
- Dedupe on write: existing-track skip + **in-batch duplicate removal** (`[...new Set(ids)]`). Deezer rejects any chunk containing a repeated id (`PlaylistAddTracksError { isNotAllowed }`).
- Existing-playlist target: `listPlaylists` (GetUserPlaylists) + paste link (`resolveDeezerPlaylistId` follows `link.deezer.com/s/…` shortlinks).

## Next: Deezer → Spotify (implemented, pending live verify)

Goal: reverse direction — read a Deezer playlist, write to Spotify. **No Spotify Developer account, no third-party service.**

### The idea

Same trick as the other two surfaces: use Spotify's **internal web endpoint + browser session** instead of the official Web API.

- Read Deezer: already done (ARL → `listPlaylists` / `getPlaylistTrackIds`).
- Write Spotify: need an **authenticated** session token (the anonymous embed token can read but cannot write). Get it from a logged-in browser session, mirroring how Deezer ARL works.

| Token | Source | Read | Write |
|---|---|---|---|
| Anonymous (current) | embed page | ✅ | ❌ |
| Browser session | `sp_dc` cookie / `accessToken` on open.spotify.com while logged in | ✅ | ✅ |

### Steps (to be done in a future session)

1. **Spike** — research the exact write mutations on `api-partner.spotify.com/pathfinder`:
   - `createPlaylist` (or equivalent) — persisted-query `sha256Hash` must be hunted fresh from the web player's Network tab, same pattern as `FETCH_PLAYLIST_SHA`.
   - `addTracksToPlaylist` (or equivalent) mutation + its `sha256Hash`.
   - Confirm the authenticated token can be derived from the `sp_dc` cookie (or extract the `accessToken` directly from `__NEXT_DATA__` when logged in).
2. **Credential** — add `SPOTIFY_DC` (or session token) to config, prompted/saved like Deezer ARL. User logs into spotify.com in browser → DevTools → Application → Cookies → copy `sp_dc`.
3. **Implement** reverse flow — mirror the existing `readPlaylist` → match → write, but:
   - source = Deezer playlist (ARL read),
   - target = Spotify playlist (authenticated session write).
4. **Verify live** — needs a logged-in Spotify session from the user (like the Deezer ARL verification this session).

### Spike findings (2026-08-13)

- **Path A — `https://open.spotify.com/get_access_token?reason=transport&productType=web_player` + `Cookie: sp_dc=…` → DEAD.** Returns `403 URL Blocked` (HTML), even with a valid `sp_dc`. Do not use.
- **Path B — `sp_dc` cookie + `https://open.spotify.com/embed/track/{id}` → `__NEXT_DATA__` → `props.pageProps.state.settings.session.accessToken` → WORKS.** With the `sp_dc` cookie attached, the session is `isAnonymous: false` and the token is authenticated. This is the same `__NEXT_DATA__` extraction the existing `anonymousToken()` already does — just add the `sp_dc` cookie to the request.
- **Write/search contract found** in `sonic-liberation/spotube-plugin-spotify` (AGPL; `.bruno` collection + Kotlin `spotify_gql_client`). This resolves the whole write surface — no live DevTools capture needed:
  - `createPlaylist` → **REST**, `POST https://spclient.wg.spotify.com/playlist/v2/playlist?format=json`, body `{ ops: [{ kind: "UPDATE_LIST_ATTRIBUTES", updateListAttributes: { newAttributes: { values: { name, description } } } }] }` → `{ uri, revision }`. No persisted-query hash.
  - `addTracksToPlaylist` → Pathfinder **v2**, `POST /pathfinder/v2/query`, `operationName: "addToPlaylist"`, `sha256Hash: 47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990`, variables `{ playlistItemUris, playlistUri, newPosition: { moveType: "BOTTOM_OF_PLAYLIST", fromUid: null } }`.
  - `searchTracks` → Pathfinder **v2**, `operationName: "searchTracks"`, `sha256Hash: bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428`, variables `{ searchTerm, offset, limit, numberOfTopResults, includePreReleases, includeAudiobooks, includeAuthors }` → `data.searchV2.tracksV2.items[].item.data` with `{ uri, name, artists.items[].profile.name, duration.totalMilliseconds }`.
  - **Deezer playlist track metadata** (source read) → GraphQL `GetPlaylistTracks` with `edges { node { id title duration contributorNames } }` — `contributorNames` is `[String!]` (primary artist first), `duration` in seconds. Verified live against `My Hanni`.

### Implemented this session (2026-08-13)

- `src/spotify.ts`: `authenticatedToken(spDc)` (Path B), `searchTrack(term, token)`, `createPlaylist(name, token)` (REST), `addTracks(playlistUri, trackUris, token)` (Pathfinder v2).
- `src/deezer.ts`: `getPlaylistTracks(playlistId)` — ordered full metadata for the reverse source.
- `src/reverse.ts`: `reverseConvert(deezer, token, sourceId, sourceName, output)` — match Deezer tracks to Spotify via `searchTrack` + existing `matchCandidates`, then create + add.
- `src/config.ts`: `spotifyDc` credential (env `SPOTIFY_DC` or stored), prompted/saved like the ARL.
- `src/cli.ts`: menu option `Deezer → Spotify: playlist baru`, `sp_dc` setting entry, `chooseTarget(deezer, 'source')` reuse.
- `tests/reverse.test.ts`: end-to-end match+write with mocked fetch (15 tests total pass).

### Remaining: live verify the write hashes

The `addToPlaylist` / `searchTracks` hashes are from an active third-party client, but hashes **can rotate** (note: that client's `fetchPlaylist` hash `cd2275433…` differs from our live-captured `a65e12194…`, so multiple persisted-query revisions coexist). The read path is proven; the write path needs one live run with a valid `sp_dc` to confirm the hashes are still accepted. If `PersistedQueryNotFound` appears, re-capture from DevTools Network (filter `pathfinder`).

### Known risks (fragility, ranked)

1. Spotify read-anonymous (working) — most stable.
2. Deezer ARL write (working) — stable.
3. **Spotify session write — most fragile**: Spotify patches browser-session access aggressively; write mutations' `sha256Hash` rotate; ToS is grey (non-commercial), higher risk than ARL.

## Release blockers (unchanged, still pending)

1. Push to GitHub and confirm CI matrix passes.
2. Publish `plx@0.1.0` to npm.

## Security & operational notes

- Never commit `.env`, ARL, `sp_dc`, or generated reports.
- All surfaces use unofficial web endpoints — personal, non-commercial use; keep the disclaimer in the README.
- The Pathfinder `sha256Hash` can rotate — isolated as `FETCH_PLAYLIST_SHA` in `src/spotify.ts`. If you see `PersistedQueryNotFound`, fetch a fresh hash from the web player's DevTools Network tab. The same will apply to any new write-mutation hash.
- Preserve duration-unit conversion (Spotify ms vs Deezer s), field-syntax search fallback, and whitespace-insensitive artist matching — all fixed this session.
