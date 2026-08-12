# plx — Continuation Notes

Updated: 2026-08-12

## Project goal

`plx` is a personal Spotify → Deezer playlist converter distributed as a CLI. The intended public interface is:

```bash
npm install -g plx
plx
```

Direct URL mode must work without Spotify Premium or Spotify OAuth:

```bash
plx --url "https://open.spotify.com/playlist/PLAYLIST_ID" --dry-run
```

## Historical Python implementation

The original implementation is still present as `playlist_converter.py` and is the behavioral reference. It was verified against real playlists using:

- anonymous token extracted from Spotify embed `__NEXT_DATA__`;
- Spotify Pathfinder persisted query for full playlist paging;
- embed fallback capped at 100 tracks;
- public Deezer search;
- Deezer ARL GraphQL writes;
- tiered matching: `exact`, `fuzzy-duration`, `fuzzy-title`;
- Spotify duration in milliseconds versus Deezer duration in seconds.

The Python test command remains:

```bash
.venv/bin/python test_flow.py
```

## TypeScript migration status

The TypeScript/npm port has been started in these modules:

```text
src/
├── cli.ts        # current CLI entry and basic URL/OAuth flow
├── config.ts     # dotenv plus cross-platform config directory
├── converter.ts  # matching, retry, CSV report, Deezer writes
├── csv.ts        # CSV escaping/writing
├── deezer.ts     # ARL auth, GraphQL mutations, public search
├── http.ts       # fetch timeout, JSON, retry helpers
├── index.ts      # type/matcher exports
├── matcher.ts    # normalization and tiered matching
├── spotify.ts    # anonymous token, Pathfinder, embed fallback, OAuth
└── types.ts      # domain/report types
```

Project setup files:

- `package.json`: package name `plx`, version `0.1.0`, npm `bin` entry, scripts, dependencies.
- `tsconfig.json`: strict NodeNext TypeScript build into `dist/`.
- `eslint.config.js`, `.prettierrc`.
- `tests/matcher.test.ts`: initial Vitest regression tests.
- `LICENSE`: MIT.

## Current commands

Install dependencies:

```bash
npm install
```

Development run:

```bash
npm run dev -- --url "https://open.spotify.com/playlist/PLAYLIST_ID" --dry-run
```

Build and run compiled output:

```bash
npm run build
node dist/cli.js --url "https://open.spotify.com/playlist/PLAYLIST_ID" --dry-run
```

Verification:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
```

Global local install after build:

```bash
npm install -g .
plx --url "https://open.spotify.com/playlist/PLAYLIST_ID" --dry-run
```

## Verification status at handoff

Passed:

- TypeScript typecheck.
- TypeScript build.
- Vitest: 3 matcher tests.
- `npm pack --dry-run`; archive contains `dist`, `README.md`, `LICENSE`, and package metadata.
- Python unit/integration test before the TypeScript port.

Lint has no errors, but currently reports seven `no-explicit-any` warnings around untrusted Spotify/Deezer API response shapes. These should be replaced with Zod schemas or narrow response types before publishing.

## Known incomplete work

The TypeScript port is **not release-ready** yet. Complete these before npm publish:

1. Finish the full interactive terminal menu using `@clack/prompts`:
   - list all Spotify playlists;
   - choose one, multiple, or all in entered order;
   - manual URL fallback when OAuth/listing fails;
   - settings menu;
   - confirmation before writes;
   - truncation confirmation;
   - duplicate target choices: create suffix, skip, cancel;
   - Ctrl+C returns to menu and saves partial report.
2. Implement complete CLI argument parsing for `--all`, `--playlists`, multiple `--url` values, and help output.
3. Verify Spotify OAuth callback and token persistence in the cross-platform config directory.
4. Validate Deezer ARL JWT response shape and GraphQL operation names/variables against the real service. The Python client was the known-good reference.
5. Add Zod validation for external API responses and remove the current `any` warnings where practical.
6. Add parity tests for:
   - full fixture conversion;
   - fallback embed/truncation;
   - retry behavior;
   - CSV quoting;
   - no-match playlist guard;
   - duplicate/order preservation;
   - OAuth and manual fallback with mocked servers.
7. Add GitHub Actions for typecheck, test, lint, and build on macOS, Linux, and Windows.
8. Run real end-to-end tests using a test playlist and Deezer account before publishing.
9. Inspect the tarball from a clean directory and run `plx --help` and URL dry-run without repository source files.
10. Only then publish `plx@0.1.0` to npm.

## Security and operational notes

- Never commit `.env`, ARL, OAuth tokens, or generated reports.
- `.gitignore` excludes environment files, node modules, build output, reports, and local config/session files.
- The Spotify reader and Deezer writer use unofficial web endpoints. Keep the personal/non-commercial disclaimer in the README.
- The Pathfinder persisted-query hash can rotate; isolate it as a single constant in `src/spotify.ts`.
- Preserve the duration-unit conversion and free-text Deezer search. Both were critical production fixes in the Python implementation.

## Recommended next session

Start with the CLI layer and tests rather than publishing:

1. Read `src/cli.ts`, `src/converter.ts`, `src/spotify.ts`, and `src/deezer.ts`.
2. Implement typed argument parsing and the full interactive menu.
3. Add mocked integration tests for `Converter`.
4. Add Zod response schemas.
5. Run all verification commands and compare TypeScript/Python reports.
