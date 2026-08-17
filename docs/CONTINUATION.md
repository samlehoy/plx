# plx — Continuation Notes

**Handoff log for the next session.** This file tracks what changed and what's left. For *how the system works* read `ARCHITECTURE.md`; for *setup/credentials* read `CONFIG.md`.

Updated: 2026-08-17

## 2026-08-17

**One conversion path over a `Provider` interface** (issue #2, the restructure half of #1). No behaviour
change and no new external endpoint — the endpoint set is byte-identical to before.

- **`Provider`** (`src/types.ts`) is now the unit of extension: `readPlaylist`, `search`,
  `createPlaylist`, `addTracks`, `getPlaylistTrackIds`, `listPlaylists`, plus two **optional**
  capabilities, `reorder` and `resolveTrack` (ADR 0002). A fourth provider means implementing this
  and nothing else.
- **`src/converter.ts` and `src/reverse.ts` are gone**, replaced by `src/conversion.ts` — one
  `Conversion(source, target, output)` that serves both directions. The forward/reverse vocabulary is
  retired everywhere, module and function names included (`convert`/`reverseConvertFlow` →
  `spotifyToDeezer`/`deezerToSpotify` in `cli.ts`).
- **Capabilities in practice.** Deezer implements `reorder` (by track id — `moveTrack` and the
  order-sync loop moved out of `Converter` and into `DeezerClient.reorder`, returning whether it
  moved anything so the caller can log). Spotify implements `resolveTrack` instead, so every match
  into a Spotify target is verified exactly as `reverseMatch` used to do, and a Spotify target
  degrades to dedupe-and-append rather than failing.
- **`DeezerCandidate` → `Candidate`** (the prefactor rename). `deezer_id` in the CSV is *not* renamed
  — that is issue #3.
- **Tests.** `tests/converter.test.ts` + `tests/reverse.test.ts` → `tests/conversion.test.ts` +
  `tests/conversion-into-spotify.test.ts`. Every original assertion is unchanged; only the way each
  test constructs its subject changed — tests now pass providers in directly instead of reaching into
  a private `converter['deezer']` field. One test added for the capability gap (a target with no
  `reorder` still completes the write). 23 → 24 tests, all green.

## 2026-08-16

- **Reverse flow playlist not showing in library — fixed.** `createPlaylist` (REST `spclient`) makes a playlist but does **not** attach it to the account; the web player follows creation with `addItemsToRootlist`. Added `addItemsToRootlist` (Pathfinder v2, hash `bd9c5cae…`, variables `{ uris: [playlistUri] }`) right after `createPlaylist` in `spotify.ts`. Source: `spotube-plugin-spotify` `PlaylistClient.kt` `followPlaylist`.
- **Reverse-flow precision verify.** `reverseMatch` now resolves each matched Spotify URI back to its real metadata (`resolveTrackMeta` → anonymous embed `__NEXT_DATA__`) and re-checks against the Deezer source. Divergent matches are flagged `⚠️ cek ulang (mungkin salah track)` in the CSV `note` and counted separately in the summary line. Uses only primary artist + duration (embed), so it catches obvious false-positives, not full multi-artist precision.
- **New playlist prefix** `[conv]` → `[plx]` (forward + reverse).
- **Target-kind in-flow.** Main menu collapsed to two directions (`Spotify → Deezer`, `Deezer → Spotify`); the "new playlist vs existing playlist" choice moved inside each flow (`chooseTargetKind`), applied to the *target* side only.
- **Forward source from account.** `chooseSource` now offers "Pilih dari akun Spotify saya" (when `sp_dc` is set), reading the source playlist with the authenticated token so private playlists read correctly.
- **Credential prompts.** Input hint lines (`login … → F12 → Application → Cookies → arl/sp_dc`) + a `warnLogin` reminder before `arl`/`spdc`/`autofetch` menu entries.
- **Existing-target dedupe message.** `writeToExisting` now separates "N sudah ada" (already in target) from "N duplikat dihilangkan" (batch/collision dupes) instead of lumping both into "sudah ada".

## Pointers

- **System design & external contracts** → [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **Setup, env vars, config dir, storage** → [`CONFIG.md`](CONFIG.md)
- **Matching reference** — `tests/matcher.test.ts` (pins the match tiers + normalization invariants)

## Current state (as of 2026-08-13)

Both directions are implemented. Spotify → Deezer reads Spotify anonymously (no credentials) and writes via Deezer ARL; Deezer → Spotify reads via Deezer ARL and writes via a Spotify browser session (`sp_dc` cookie). Both directions support a new-playlist target and an existing-playlist target (dedupe + append).

Verified live this session:
- Deezer GraphQL mutations corrected against the real schema (single `input: {…}` argument, `String!` scalars) — `CreatePlaylist`, `AddTracksToPlaylist` both write successfully.
- Deezer JWT now decodes `exp` and refreshes 30s before expiry; auto-retries once on `not valid anymore`.
- Matching: free-text search first, field-syntax (`track:"…" artist:"…"`) fallback (K-pop covers/remixes otherwise win relevance).
- Artist compare is whitespace-insensitive (`JIHYO` == `Ji Hyo`).
- Dedupe on write: existing-track skip + **in-batch duplicate removal** (`[...new Set(ids)]`). Deezer rejects any chunk containing a repeated id (`PlaylistAddTracksError { isNotAllowed }`).
- Existing-playlist target: `listPlaylists` (GetUserPlaylists) + paste link (`resolveDeezerPlaylistId` follows `link.deezer.com/s/…` shortlinks).

## Semi-auto credential fill (macOS: Chromium family + Safari) — DONE (2026-08-13)

Instead of fully manual copy-paste, the ARL / `sp_dc` inputs now try to **read the
cookie from a logged-in browser session** first — the user only has to accept the
OS permission dialog — and fall back to manual paste if nothing is found.

- **Chromium family** (Brave, Chrome, Edge, Chromium, Vivaldi, Opera): same decrypt
  scheme, differing only by profile dir + Keychain service name. Cookie values are
  AES-128-CBC (`v10` prefix, fixed IV 16×`0x20`) under a key derived from the login
  Keychain password via PBKDF2-HMAC-SHA1 (`saltysalt`, 1003 iter, 16 bytes). DB
  version ≥ 24 prepends a 32-byte SHA256 domain-hash to the plaintext that must be
  stripped. **Verified live against a real Brave DB** (`arl` → hex string, `sp_dc`
  → base64 string).
- **Safari**: `Cookies.binarycookies` is plaintext (no encryption) but TCC-gated —
  reading it needs **Full Disk Access**, not just the Keychain "Allow" dialog.
  Parser mirrors `browser_cookie3` (`cook` magic + big-endian page table, then
  little-endian cookie records with null-terminated strings at record-relative
  offsets).
- Wired into `ensureDeezer`/`ensureSpotify` + the `arl`/`sp_dc` settings entries via
  `tryAutoFillCredentials(cfg)` — additive: env vars and stored credentials win,
  manual paste stays the fallback. First use pops the macOS Keychain "Allow" dialog.

Out of scope for now: Windows (DPAPI) / Linux (libsecret) cookie decrypt, and the
Firefox key4.db/encryptedcookies format.

## Deezer → Spotify (WORKING — verified live)

Goal: reverse direction — read a Deezer playlist, write to Spotify. **No Spotify Developer account, no third-party service.**

### The idea

Same trick as the other two surfaces: use Spotify's **internal web endpoint + browser session** instead of the official Web API.

| Token | Source | Read | Write |
|---|---|---|---|
| Anonymous (current) | embed page | ✅ | ❌ |
| Browser session | `sp_dc` cookie / `accessToken` on open.spotify.com while logged in | ✅ | ✅ |

### Spike findings (2026-08-13)

- **Path A — `https://open.spotify.com/get_access_token?reason=transport&productType=web_player` + `Cookie: sp_dc=…` → DEAD.** Returns `403 URL Blocked` (HTML), even with a valid `sp_dc`. Do not use.
- **Path B — `sp_dc` cookie + `https://open.spotify.com/embed/track/{id}` → `__NEXT_DATA__` → `props.pageProps.state.settings.session.accessToken` → yields a non-anonymous token, but READ-ONLY scope.** The embed token only covers playback/reads; it is rejected for search/write mutations. This was the original auth path and the root cause of the reverse flow failing.
- **Path C — `sp_dc` cookie + `https://open.spotify.com/api/token?reason=transport&productType=web-player&totp=<otp>&totpServer=<otp>&totpVer=<v>` → WORKS (full search+write scope).** The TOTP is HMAC-SHA1 over a rotating "nuance" secret (`gist/22ed9c6…/nuances.json`, take max `v`) + Spotify server-time (`/api/server-time`), 30s period, 6 digits. This is the path the web player itself uses; found in `spotube-plugin-spotify`'s `RealCoreAPI.kt` + `TOTP.kt`.
- **Write/search contract found** in `sonic-liberation/spotube-plugin-spotify` (AGPL; `.bruno` collection + Kotlin `spotify_gql_client`). This resolves the whole write surface — no live DevTools capture needed:
  - `createPlaylist` → **REST**, `POST https://spclient.wg.spotify.com/playlist/v2/playlist?format=json`, body `{ ops: [{ kind: "UPDATE_LIST_ATTRIBUTES", updateListAttributes: { newAttributes: { values: { name, description } } } }] }` → `{ uri, revision }`. No persisted-query hash.
  - `addTracksToPlaylist` → Pathfinder **v2**, `POST /pathfinder/v2/query`, `operationName: "addToPlaylist"`, `sha256Hash: 47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990`, variables `{ playlistItemUris, playlistUri, newPosition: { moveType: "BOTTOM_OF_PLAYLIST", fromUid: null } }`.
  - `searchTracks` → Pathfinder **v2**, `operationName: "searchTracks"`, `sha256Hash: bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428`, variables `{ searchTerm, offset, limit, numberOfTopResults, includePreReleases, includeAudiobooks, includeAuthors }` → `data.searchV2.tracksV2.items[].item.data` with `{ uri, name, artists.items[].profile.name, duration.totalMilliseconds }`.
  - `libraryV3` (list user's writable playlists) → Pathfinder **v2**, `operationName: "libraryV3"`, `sha256Hash: 973e511ca44261fda7eebac8b653155e7caee3675abb4fb110cc1b8c78b091c3`, variables `{ limit, offset, folderUri }` → `data.me.libraryV3.items[].item.data` with `{ name, uri, currentUserCapabilities.canEditItems }`. Filter to `canEditItems === true`.
  - **Deezer playlist track metadata** (source read) → GraphQL `GetPlaylistTracks` with `edges { node { id title duration contributorNames } }` — `contributorNames` is `[String!]` (primary artist first), `duration` in seconds. Verified live against `My Hanni`.

### Implemented (2026-08-13)

- `src/spotify.ts`: `authenticatedToken(spDc)` (Path C — `/api/token` + TOTP), `searchTrack(term, token)`, `createPlaylist(name, token)` (REST), `addTracks(playlistUri, trackUris, token)` (Pathfinder v2), `listPlaylists(token)` (libraryV3), `fetchTrackUris(id, token)` (reuses the v1 `fetchPlaylist` read path).
- `src/deezer.ts`: `getPlaylistTracks(playlistId)` — ordered full metadata for the reverse source.
- `src/reverse.ts`: `reverseMatch` (shared match loop) + `reverseConvert` (new target) + `reverseWriteToExisting` (existing target, dedupe + append).
- `src/config.ts`: `spotifyDc` credential (env `SPOTIFY_DC` or stored), prompted/saved like the ARL.
- `src/cli.ts`: menu options `Deezer → Spotify: playlist baru` and `Deezer → Spotify: playlist yang ada`, `sp_dc` setting entry.
- `tests/reverse.test.ts`: match+write + dedupe with mocked fetch.
- `tests/spotify.test.ts`: token minting test (pins TOTP to RFC 6238 secret at T=59 → `287082`).

### Not implemented (deliberate)

- **Spotify-side 1:1 order sync / remove-extras.** The reference client has no Spotify reorder primitive — only `addToPlaylist` with `moveType: "BOTTOM_OF_PLAYLIST"` (there is a `removeFromPlaylist` op, but it keys on `uids`, not track URIs). So the reverse existing-target flow is **dedupe + append to bottom**, not order-sync. Forward flow (Deezer target) *does* do 1:1 order sync via `moveTrackInPlaylist`.

### Remaining: reverse flow does NOT work yet (confirmed 2026-08-13)

Both reverse targets (new playlist and existing playlist) are broken in live use and need deeper investigation. Likely culprits, ranked:

1. **Write/search hashes rotated.** `addToPlaylist` / `searchTracks` / `libraryV3` hashes are from an active third-party client, but hashes **rotate** (that client's `fetchPlaylist` hash `cd2275433…` already differs from our live-captured `a65e12194…`, so multiple persisted-query revisions coexist). If `PersistedQueryNotFound` appears, re-capture the live hash from DevTools Network (filter `pathfinder`).
2. **Auth/token scope** — `authenticatedToken` (embed `__NEXT_DATA__` + `sp_dc`) may yield a token that reads but is rejected for writes on `api-partner` / `spclient`.
3. **Endpoint/header mismatch** — `libraryV3`/`searchTracks` use Pathfinder **v2** while `fetchPlaylist` uses **v1**; possible missing header (`client-token`, `Spotify-App-Version`, `content-access-token`) the web player sends but we don't.

To debug: run one reverse convert with a valid `sp_dc`, capture the exact request + response for `searchTracks` and `addToPlaylist`, and diff against the web player's own DevTools payload (headers included, not just the body).

### Fixed (2026-08-13): authenticated token minting

The root cause was **auth scope**, not hash rotation. The embed `__NEXT_DATA__` token only covers playback/reads; the web player obtains its full search+write token from `GET https://open.spotify.com/api/token?reason=transport&productType=web-player&totp=<otp>&totpServer=<otp>&totpVer=<v>` with `Cookie: sp_dc=…`. The TOTP is HMAC-SHA1 over a rotating "nuance" secret (`gist/22ed9c6…/nuances.json`, take max `v`) + Spotify server-time (`/api/server-time`), 30s period, 6 digits.

- `src/spotify.ts`: `authenticatedToken(spDc)` now mints the token via `/api/token` (TOTP in `totp()`, base32 decode in `base32Decode()`). The embed-`__NEXT_DATA__` fallback was removed — it only ever yielded a read-scope token that would fail writes confusingly. Added `Accept: application/json` to write headers.
- `tests/spotify.test.ts`: token minting test pins TOTP to the RFC 6238 secret at T=59 (`287082`).
- Verified against `sonic-liberation/spotube-plugin-spotify` (`RealCoreAPI.kt`, `TOTP.kt`), the active third-party client. TOTP self-check passes all 6 RFC 6238 vectors.

### Verified live (2026-08-13) — all surfaces pass

With a real `SPOTIFY_DC` in `.env`, every reverse-flow surface round-tripped against the live service:

- **Token mint** — `authenticatedToken` → 403-char `BQ…` token (non-anonymous).
- **`searchTracks`** — `"NewJeans Ditto"` → 10 results, correct URIs (`spotify:track:…`), duration in ms.
- **`libraryV3` (listPlaylists)** — 11 writable playlists returned, `canEditItems` filter correct.
- **`createPlaylist`** — REST `spclient` → new `spotify:playlist:3Hy3…` created.
- **`addTracks`** — added `Ditto` URI, confirmed present via `fetchTrackUris` (1 track).
- **Cleanup** — test playlist removed via `removeItemsFromRootlist` (`operationName`, hash `3422f186…`, variables `{ uris }`). No `PersistedQueryNotFound` on any op → the three write/search hashes are current.

The hashes in `spotify.ts` (`ADD_TO_PLAYLIST_SHA`, `SEARCH_TRACKS_SHA`, `LIBRARY_V3_SHA`) are confirmed current as of today. Note: Spotify may rotate them later — if `PersistedQueryNotFound` appears, re-capture from DevTools (see ARCHITECTURE.md).

### Known risks (fragility, ranked)

1. Spotify read-anonymous (working) — most stable.
2. Deezer ARL write (working) — stable.
3. **Spotify session write — most fragile**: Spotify patches browser-session access aggressively; write mutations' `sha256Hash` rotate; ToS is grey (non-commercial), higher risk than ARL.

## Release blockers

1. ~~Push to GitHub~~ — done (`4ca1db5`). **Confirm the CI matrix passes** (ubuntu/macos/windows × node 22/24) — pending.
2. ~~Fix the Deezer → Spotify reverse flow~~ — done, verified live (see "Verified live" above).
3. Publish `plx@0.1.0` to npm.

## Security & operational notes

- Never commit `.env`, ARL, `sp_dc`, or generated reports.
- All surfaces use unofficial web endpoints — personal, non-commercial use; keep the disclaimer in the README.
- The Pathfinder `sha256Hash` can rotate — isolated as constants in `src/spotify.ts`. If you see `PersistedQueryNotFound`, fetch a fresh hash from the web player's DevTools Network tab. This applies to every read/write mutation hash.
- Preserve duration-unit conversion (Spotify ms vs Deezer s), field-syntax search fallback, and whitespace-insensitive artist matching — all fixed this session.
