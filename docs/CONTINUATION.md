# plx — Continuation Notes

**Handoff log for the next session.** This file tracks what changed and what's left. For *how the system works* read `ARCHITECTURE.md`; for *setup/credentials* read `CONFIG.md`.

Updated: 2026-08-13

## Pointers

- **System design & external contracts** → [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **Setup, env vars, config dir, storage** → [`CONFIG.md`](CONFIG.md)
- **Historical Python reference** — `playlist_converter.py` (behavioral reference for matching & reports)

## Current state (as of 2026-08-13)

Both directions are implemented. Spotify → Deezer reads Spotify anonymously (no credentials) and writes via Deezer ARL; Deezer → Spotify reads via Deezer ARL and writes via a Spotify browser session (`sp_dc` cookie). Both directions support a new-playlist target and an existing-playlist target (dedupe + append).

Verified live this session:
- Deezer GraphQL mutations corrected against the real schema (single `input: {…}` argument, `String!` scalars) — `CreatePlaylist`, `AddTracksToPlaylist` both write successfully.
- Deezer JWT now decodes `exp` and refreshes 30s before expiry; auto-retries once on `not valid anymore`.
- Matching: free-text search first, field-syntax (`track:"…" artist:"…"`) fallback (K-pop covers/remixes otherwise win relevance).
- Artist compare is whitespace-insensitive (`JIHYO` == `Ji Hyo`).
- Dedupe on write: existing-track skip + **in-batch duplicate removal** (`[...new Set(ids)]`). Deezer rejects any chunk containing a repeated id (`PlaylistAddTracksError { isNotAllowed }`).
- Existing-playlist target: `listPlaylists` (GetUserPlaylists) + paste link (`resolveDeezerPlaylistId` follows `link.deezer.com/s/…` shortlinks).

## Planned: auto-fetch credentials (Deezer ARL + Spotify sp_dc)

Currently the user must manually find the Deezer `arl` / Spotify `sp_dc` cookie in DevTools and paste it. Plan: **auto-retrieve both** so the user just logs in and the tool grabs the cookie itself, while keeping the manual path as a fallback.

- Goal: detect the cookie from an existing logged-in browser session (or a headless one we drive through login) instead of hand-copying from F12.
- Manual entry stays available (the current prompt + settings menu) — auto is additive, not a replacement.
- Open questions to settle before building: which browser(s) to read from (Chrome/Edge cookie DB vs. a bundled headless login), whether OS keychain/DPAPI decryption is needed, and whether Spotify/Deezer set the cookie `HttpOnly` (which would rule out JS-only access).

## Deezer → Spotify (implemented, NOT working — needs investigation)

Goal: reverse direction — read a Deezer playlist, write to Spotify. **No Spotify Developer account, no third-party service.**

### The idea

Same trick as the other two surfaces: use Spotify's **internal web endpoint + browser session** instead of the official Web API.

| Token | Source | Read | Write |
|---|---|---|---|
| Anonymous (current) | embed page | ✅ | ❌ |
| Browser session | `sp_dc` cookie / `accessToken` on open.spotify.com while logged in | ✅ | ✅ |

### Spike findings (2026-08-13)

- **Path A — `https://open.spotify.com/get_access_token?reason=transport&productType=web_player` + `Cookie: sp_dc=…` → DEAD.** Returns `403 URL Blocked` (HTML), even with a valid `sp_dc`. Do not use.
- **Path B — `sp_dc` cookie + `https://open.spotify.com/embed/track/{id}` → `__NEXT_DATA__` → `props.pageProps.state.settings.session.accessToken` → WORKS.** With the `sp_dc` cookie attached, the session is `isAnonymous: false` and the token is authenticated. This is the same `__NEXT_DATA__` extraction the existing `anonymousToken()` already does — just add the `sp_dc` cookie to the request.
- **Write/search contract found** in `sonic-liberation/spotube-plugin-spotify` (AGPL; `.bruno` collection + Kotlin `spotify_gql_client`). This resolves the whole write surface — no live DevTools capture needed:
  - `createPlaylist` → **REST**, `POST https://spclient.wg.spotify.com/playlist/v2/playlist?format=json`, body `{ ops: [{ kind: "UPDATE_LIST_ATTRIBUTES", updateListAttributes: { newAttributes: { values: { name, description } } } }] }` → `{ uri, revision }`. No persisted-query hash.
  - `addTracksToPlaylist` → Pathfinder **v2**, `POST /pathfinder/v2/query`, `operationName: "addToPlaylist"`, `sha256Hash: 47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990`, variables `{ playlistItemUris, playlistUri, newPosition: { moveType: "BOTTOM_OF_PLAYLIST", fromUid: null } }`.
  - `searchTracks` → Pathfinder **v2**, `operationName: "searchTracks"`, `sha256Hash: bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428`, variables `{ searchTerm, offset, limit, numberOfTopResults, includePreReleases, includeAudiobooks, includeAuthors }` → `data.searchV2.tracksV2.items[].item.data` with `{ uri, name, artists.items[].profile.name, duration.totalMilliseconds }`.
  - `libraryV3` (list user's writable playlists) → Pathfinder **v2**, `operationName: "libraryV3"`, `sha256Hash: 973e511ca44261fda7eebac8b653155e7caee3675abb4fb110cc1b8c78b091c3`, variables `{ limit, offset, folderUri }` → `data.me.libraryV3.items[].item.data` with `{ name, uri, currentUserCapabilities.canEditItems }`. Filter to `canEditItems === true`.
  - **Deezer playlist track metadata** (source read) → GraphQL `GetPlaylistTracks` with `edges { node { id title duration contributorNames } }` — `contributorNames` is `[String!]` (primary artist first), `duration` in seconds. Verified live against `My Hanni`.

### Implemented (2026-08-13)

- `src/spotify.ts`: `authenticatedToken(spDc)` (Path B), `searchTrack(term, token)`, `createPlaylist(name, token)` (REST), `addTracks(playlistUri, trackUris, token)` (Pathfinder v2), `listPlaylists(token)` (libraryV3), `fetchTrackUris(id, token)` (reuses the v1 `fetchPlaylist` read path).
- `src/deezer.ts`: `getPlaylistTracks(playlistId)` — ordered full metadata for the reverse source.
- `src/reverse.ts`: `reverseMatch` (shared match loop) + `reverseConvert` (new target) + `reverseWriteToExisting` (existing target, dedupe + append).
- `src/config.ts`: `spotifyDc` credential (env `SPOTIFY_DC` or stored), prompted/saved like the ARL.
- `src/cli.ts`: menu options `Deezer → Spotify: playlist baru` and `Deezer → Spotify: playlist yang ada`, `sp_dc` setting entry.
- `tests/reverse.test.ts`: match+write + dedupe with mocked fetch (16 tests total pass).

### Not implemented (deliberate)

- **Spotify-side 1:1 order sync / remove-extras.** The reference client has no Spotify reorder primitive — only `addToPlaylist` with `moveType: "BOTTOM_OF_PLAYLIST"` (there is a `removeFromPlaylist` op, but it keys on `uids`, not track URIs). So the reverse existing-target flow is **dedupe + append to bottom**, not order-sync. Forward flow (Deezer target) *does* do 1:1 order sync via `moveTrackInPlaylist`.

### Remaining: reverse flow does NOT work yet (confirmed 2026-08-13)

Both reverse targets (new playlist and existing playlist) are broken in live use and need deeper investigation. Likely culprits, ranked:

1. **Write/search hashes rotated.** `addToPlaylist` / `searchTracks` / `libraryV3` hashes are from an active third-party client, but hashes **rotate** (that client's `fetchPlaylist` hash `cd2275433…` already differs from our live-captured `a65e12194…`, so multiple persisted-query revisions coexist). If `PersistedQueryNotFound` appears, re-capture the live hash from DevTools Network (filter `pathfinder`).
2. **Auth/token scope** — `authenticatedToken` (embed `__NEXT_DATA__` + `sp_dc`) may yield a token that reads but is rejected for writes on `api-partner` / `spclient`.
3. **Endpoint/header mismatch** — `libraryV3`/`searchTracks` use Pathfinder **v2** while `fetchPlaylist` uses **v1**; possible missing header (`client-token`, `Spotify-App-Version`, `content-access-token`) the web player sends but we don't.

To debug: run one reverse convert with a valid `sp_dc`, capture the exact request + response for `searchTracks` and `addToPlaylist`, and diff against the web player's own DevTools payload (headers included, not just the body).

### Known risks (fragility, ranked)

1. Spotify read-anonymous (working) — most stable.
2. Deezer ARL write (working) — stable.
3. **Spotify session write — most fragile**: Spotify patches browser-session access aggressively; write mutations' `sha256Hash` rotate; ToS is grey (non-commercial), higher risk than ARL.

## Release blockers

1. ~~Push to GitHub~~ — done (`4ca1db5`). **Confirm the CI matrix passes** (ubuntu/macos/windows × node 22/24) — pending.
2. Fix the Deezer → Spotify reverse flow (see "Remaining" above) — currently broken.
3. Publish `plx@0.1.0` to npm.

## Security & operational notes

- Never commit `.env`, ARL, `sp_dc`, or generated reports.
- All surfaces use unofficial web endpoints — personal, non-commercial use; keep the disclaimer in the README.
- The Pathfinder `sha256Hash` can rotate — isolated as constants in `src/spotify.ts`. If you see `PersistedQueryNotFound`, fetch a fresh hash from the web player's DevTools Network tab. This applies to every read/write mutation hash.
- Preserve duration-unit conversion (Spotify ms vs Deezer s), field-syntax search fallback, and whitespace-insensitive artist matching — all fixed this session.
