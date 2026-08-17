# plx — playlist converter (Spotify ⇄ Deezer ⇄ YouTube Music)

## How to work here

- **Flow**: clarify → spec/tickets → implement → code-review → commit, per `/mattpocock-skills`.
- **Keep context bounded**: one unbroken window through to `/to-tickets`; each `/implement` starts fresh.
- **Primary sources on disk**: `CONTEXT.md` (glossary/decisions) and `docs/adr/` (0001–0003). `docs/CONTINUATION.md` is the handoff log. All live at repo root / `docs/`.
- **Blocking edges**: GitHub Issues on `samlehoy/plx`, via the `gh` CLI. One issue per ticket; a ticket whose blockers are all done is grabbable.
- **Quality bar** (before every commit): `npm run typecheck`, `npm test`, `npm run lint`, `npm run build` all green. Live-service providers (ytmusic in particular) expect fixtures recorded from the real service, never hand-written literals.
- **No secrets in commits.** Credentials live in `credentials.json` (gitignored) or the Keychain; the repo only ever ships env-var names.
