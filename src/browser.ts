import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { YTMUSIC_COOKIES, cookieHeader } from './ytmusic.js';

// Read the Deezer `arl` / Spotify `sp_dc` cookies from an already-logged-in
// browser session so the user only has to accept the OS keychain permission.
// macOS only for now. Two backends:
//   - Chromium family (Brave/Chrome/Edge/Chromium/…) — SQLite cookie DB, values
//     AES-128-CBC encrypted under a key held in the login Keychain.
//   - Safari — `Cookies.binarycookies`, plaintext (no encryption) but TCC-gated
//     (requires Full Disk Access, not just a keychain "Allow").

// Cookie name → value, for every cookie plx cares about that a browser happened to have. Kept in
// cookie terms; the mapping to one credential per provider happens in fetchBrowserCredentials.
export type BrowserCredentials = Record<string, string>;

// One decrypt scheme for the whole Chromium family; only the profile dir and
// Keychain service name differ. Verified against a live Brave DB (key hex
// e93fc524…, arl → hex string, sp_dc → base64 string).
type ChromiumBrowser = { dir: string; keychain: string };

const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  { dir: 'BraveSoftware/Brave-Browser', keychain: 'Brave Safe Storage' },
  { dir: 'Google/Chrome', keychain: 'Chrome Safe Storage' },
  { dir: 'Microsoft Edge', keychain: 'Microsoft Edge Safe Storage' },
  { dir: 'Chromium', keychain: 'Chromium Safe Storage' },
  { dir: 'Vivaldi', keychain: 'Vivaldi Safe Storage' },
  { dir: 'com.operasoftware.Opera', keychain: 'Opera Safe Storage' },
];

// Chromium v10 blob: 3-byte "v10" prefix + AES-128-CBC (IV = 16 × 0x20, PKCS7).
// Key = PBKDF2-HMAC-SHA1(keychain pw string, "saltysalt", 1003, 16 bytes).
// DB version ≥ 24 prepends a 32-byte SHA256 domain hash to the plaintext.
const PBKDF2_SALT = 'saltysalt';
const PBKDF2_ITER = 1003;
const PBKDF2_KEYLEN = 16;

export function decryptCookie(blob: Buffer, key: Buffer, stripDomainHash = false): string | null {
  if (blob.length < 3 || blob.subarray(0, 3).toString('latin1') !== 'v10') return null;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    let plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
    if (stripDomainHash) plain = plain.subarray(32);
    const value = plain.toString('utf8');
    // arl is hex, sp_dc is base64 — both printable ASCII. Reject key-mismatch garbage.
    return /^[\x20-\x7e]*$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function keychainPassword(service: string): string | null {
  if (platform() !== 'darwin') return null;
  try {
    // This call pops the macOS Keychain "Allow" permission dialog on first use.
    return execFileSync('security', ['find-generic-password', '-w', '-s', service], { encoding: 'utf8', timeout: 60_000 }).replace(/\n$/, '');
  } catch {
    return null; // keychain denied / no such item — skip this browser
  }
}

// Which cookie names matter, and which hosts they may come from **in priority order**.
//
// This ordering is not cosmetic. Google sets `SID`, `SAPISID` and friends on `.google.com` *and*
// `.youtube.com` with **different values**, so taking whichever the cookie store happened to return
// first yields a bundle mixing two sessions — which the service reads as logged out. `.youtube.com`
// wins because that is the host the requests actually go to; `.google.com` is only a fallback for a
// cookie YouTube did not set itself.
const WANTED: Array<{ name: string; hosts: string[] }> = [
  { name: 'arl', hosts: ['deezer.com'] },
  { name: 'sp_dc', hosts: ['spotify.com'] },
  ...YTMUSIC_COOKIES.map((name) => ({ name, hosts: ['youtube.com', 'google.com'] })),
];

const COOKIE_NAMES = WANTED.map((w) => w.name);

// How preferred this host is for this cookie name: 0 is best, -1 means "not a host we want it from".
export function hostRank(name: string, host: string): number {
  const want = WANTED.find((w) => w.name === name);
  if (!want) return -1;
  return want.hosts.findIndex((h) => host === h || host.endsWith(`.${h}`));
}

// Keep the best-ranked host for each cookie name, whatever order the store yielded rows in.
function collect(rows: Array<{ name: string; host: string; value: string }>): BrowserCredentials {
  const best = new Map<string, { rank: number; value: string }>();
  for (const row of rows) {
    const rank = hostRank(row.name, row.host);
    if (rank < 0) continue;
    const current = best.get(row.name);
    if (!current || rank < current.rank) best.set(row.name, { rank, value: row.value });
  }
  return Object.fromEntries([...best].map(([name, { value }]) => [name, value]));
}

function readChromium(browser: ChromiumBrowser): BrowserCredentials {
  const dbPath = join(homedir(), 'Library', 'Application Support', browser.dir, 'Default', 'Cookies');
  if (!existsSync(dbPath)) return {};
  const pw = keychainPassword(browser.keychain);
  if (pw == null) return {};
  const key = pbkdf2Sync(pw, PBKDF2_SALT, PBKDF2_ITER, PBKDF2_KEYLEN, 'sha1');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
    const dbVersion = meta?.value ? Number(meta.value) : 0;
    const query = `SELECT name, host_key, encrypted_value FROM cookies WHERE name IN (${COOKIE_NAMES.map(() => '?').join(',')})`;
    const rows = db.prepare(query).all(...COOKIE_NAMES) as Array<{ name: string; host_key: string; encrypted_value: Uint8Array }>;
    return collect(rows.flatMap((row) => {
      const value = decryptCookie(Buffer.from(row.encrypted_value), key, dbVersion >= 24);
      return value ? [{ name: row.name, host: row.host_key, value }] : [];
    }));
  } catch {
    return {}; // locked DB / changed schema — skip this browser
  } finally {
    db.close();
  }
}

// Safari `Cookies.binarycookies` layout (mirrors browser_cookie3):
// "cook" magic + big-endian page table, then little-endian cookie records with
// null-terminated host/name/value strings at cookie-relative offsets.
const SAFARI_PATHS = [
  join(homedir(), 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies', 'Cookies.binarycookies'),
  join(homedir(), 'Library', 'Cookies', 'Cookies.binarycookies'),
];

function readCStr(buf: Buffer, start: number): string {
  let end = start;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.subarray(start, end).toString('utf8');
}

export function parseSafariCookies(buf: Buffer): BrowserCredentials {
  if (buf.length < 8 || buf.subarray(0, 4).toString('latin1') !== 'cook') return {};
  const totalPages = buf.readUInt32BE(4);
  const pageSizes: number[] = [];
  for (let i = 0; i < totalPages; i++) pageSizes.push(buf.readUInt32BE(8 + i * 4));

  const found: Array<{ name: string; host: string; value: string }> = [];
  let base = 8 + totalPages * 4;
  for (let p = 0; p < totalPages; p++) {
    const page = buf.subarray(base, base + pageSizes[p]);
    base += pageSizes[p];
    if (page.length < 8 || page.readUInt32BE(0) !== 0x00000100) continue;
    const nCookies = page.readUInt32LE(4);
    for (let i = 0; i < nCookies; i++) {
      const cookieOffset = page.readUInt32LE(8 + i * 4);
      const host = readCStr(page, cookieOffset + page.readUInt32LE(cookieOffset + 16));
      const name = readCStr(page, cookieOffset + page.readUInt32LE(cookieOffset + 20));
      const value = readCStr(page, cookieOffset + page.readUInt32LE(cookieOffset + 28));
      found.push({ name, host, value });
    }
  }
  return collect(found);
}

function readSafari(): BrowserCredentials {
  for (const path of SAFARI_PATHS) {
    if (!existsSync(path)) continue;
    try {
      return parseSafariCookies(readFileSync(path));
    } catch {
      return {}; // TCC-denied or unreadable — skip
    }
  }
  return {};
}

// Auto-retrieve credentials from the first logged-in browser that has them, keyed by provider —
// the parsers above speak in cookie names, and this is where that becomes one opaque string per
// provider for the config layer to store. Never throws: a missing browser, locked DB, denied
// keychain, or TCC block just yields {}. Manual paste stays the fallback.
export function fetchBrowserCredentials(): Record<string, string> {
  if (platform() !== 'darwin') return {};
  const credentials: Record<string, string> = {};
  // Every backend is read rather than stopping at the first: a user may be logged into Deezer in one
  // browser and YouTube Music in another.
  for (const found of [...CHROMIUM_BROWSERS.map(readChromium), readSafari()]) {
    if (!credentials.deezer && found.arl) credentials.deezer = found.arl;
    if (!credentials.spotify && found.sp_dc) credentials.spotify = found.sp_dc;
    // A cookie bundle is only a session as a *set* from one profile, so it is built per browser and
    // never merged across them — half of one login plus half of another authenticates as neither.
    // Both backends funnel through the one joiner, so "which cookies, joined how" is decided in a
    // single place, and that place is testable without a browser.
    if (!credentials.ytmusic) {
      const header = cookieHeader(found);
      if (header) credentials.ytmusic = header;
    }
  }
  return credentials;
}
