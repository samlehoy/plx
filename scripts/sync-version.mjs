#!/usr/bin/env node
// One version for the whole project: the root package.json's. Releases are cut by release-please
// (.github/workflows/release.yml), which bumps package.json and — through `extra-files` in
// release-please-config.json — the extension manifest, the one other file that must carry a copy.
// `plx --version` and the website read package.json directly and keep no copy.
//
// This script is the guard and the manual fallback for that copy:
//   node scripts/sync-version.mjs           write the root version into extension/manifest.json
//   node scripts/sync-version.mjs --check   exit non-zero if it has drifted (CI, prepublishOnly)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const MANIFEST = 'extension/manifest.json';

const read = (path) => readFileSync(join(root, path), 'utf8');
const { version } = JSON.parse(read('package.json'));

// Chrome takes only 1–4 dot-separated integers in a manifest `version`, so a prerelease is refused
// here rather than shipped as a manifest Chrome will not load.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json version "${version}" is not plain x.y.z, which a Chrome manifest requires`);
}

const before = read(MANIFEST);
const eol = before.includes('\r\n') ? '\r\n' : '\n';
const manifest = JSON.parse(before);

if (manifest.version === version) {
  console.log(`${MANIFEST} already at ${version}`);
} else if (check) {
  console.error(`${MANIFEST} is at ${manifest.version}, package.json at ${version}. Run: pnpm run version:sync`);
  process.exit(1);
} else {
  manifest.version = version;
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`.replace(/\n/g, eol));
  console.log(`Synced ${MANIFEST} to ${version}`);
}
