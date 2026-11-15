# Releasing

plx has **one version** for everything it ships: the npm package (`plx-converter`), the plx
Companion extension and the website. The root `package.json` holds it.

- **Reads it directly, keeps no copy:**
  - `plx --version`, at runtime.
  - The website, at build time (`__PLX_VERSION__` in `web/vite.config.ts`).
- **Keeps a copy:** only `extension/manifest.json`, because Chrome requires one. release-please
  updates it together with `package.json`.

## How a release happens

Releases are automatic (`.github/workflows/release.yml`, driven by
[release-please](https://github.com/googleapis/release-please)):

1. **Write Conventional Commits.** The commit type decides the next version:

   | Commit | Bump (while < 1.0) | Changelog |
   |---|---|---|
   | `fix: …` | patch | Bug Fixes |
   | `feat: …` | minor | Features |
   | `feat!: …` or a `BREAKING CHANGE:` footer | major | ⚠ Breaking |
   | `docs:`, `test:`, `chore:`, `refactor:` | none | hidden |

2. **Every push to `master`** updates a single release PR, titled `chore(master): release x.y.z`.
   It carries the bumped `package.json`, `package-lock.json`, `extension/manifest.json` and a new
   `CHANGELOG.md` entry. Merge it when you want to ship.
3. **Merging it is the release.** release-please tags `vX.Y.Z` and creates the GitHub release. Then:
   - **npm:** the package is published with trusted publishing (OIDC, with provenance), after
     typecheck, lint and tests pass.
   - **Extension:** `plx-companion-x.y.z.zip` is attached to the GitHub release.
   - **Website:** it is rebuilt and deployed with wrangler, so it shows the new version. This step
     runs only once the Cloudflare secrets exist.

Never bump versions by hand. To force a specific number, add `"release-as": "x.y.z"` to the `.`
package in `release-please-config.json`, and remove it after that release.

## One-time setup

- **npm:** on npmjs.com, open `plx-converter` → Settings → Trusted publishing, and add GitHub
  Actions with repository `samlehoy/plx` and workflow `release.yml`. A recent npm CLI can do the
  same with `npm trust github plx-converter --file release.yml --repo samlehoy/plx`. No `NPM_TOKEN`
  secret is needed.
- **GitHub:** Settings → Actions → General → enable **"Allow GitHub Actions to create and approve
  pull requests"**, so release-please can open its PR.
- **Website (optional):** add the repository secrets `CLOUDFLARE_API_TOKEN` (permission: Workers
  Scripts edit) and `CLOUDFLARE_ACCOUNT_ID`. Without them the deploy job is skipped, and the site
  shows the new version on its next deploy, whoever runs it.
- **Tags:** push the backfilled tags once with `git push origin --tags` (`v0.1.6`–`v0.1.9`, see
  below).

## Guards

- `tests/version.test.ts` runs in CI and checks three things:
  - The extension manifest matches `package.json`.
  - `web/package.json` carries no version of its own.
  - `plx --version` prints the root version.
- `npm run version:check` runs as part of `prepublishOnly` and fails on manifest drift.
  `npm run version:sync` repairs drift by hand.
- A pull request created with the default `GITHUB_TOKEN` does not trigger other workflows, so CI does
  not run on the release PR itself. The release jobs run the checks again before publishing.

## History

Before automation, versions drifted. The tags `v0.1.6`–`v0.1.9` were backfilled from the `gitHead`
that npm recorded for each published version. 0.1.9 was published from a commit that was never pushed
(`f186c00`, a version bump). Its tag sits on the parent, `51c9b22`, whose build was verified
byte-identical to the `dist/` in the npm tarball. `release-please-config.json` bootstraps from that
commit.
