import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Read the Deezer `arl` / Spotify `sp_dc` cookies from an already-logged-in
// browser session so the user only has to accept the OS keychain permission.
// macOS only for now. Two backends:
//   - Chromium family (Brave/Chrome/Edge/Chromium/…) — SQLite cookie DB, values
//     AES-128-CBC encrypted under a key held in the login Keychain.
//   - Safari — `Cookies.binarycookies`, plaintext (no encryption) but TCC-gated
//     (requires Full Disk Access, not just a keychain "Allow").

export type BrowserCredentials = { arl?: string; spDc?: string };

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

const COOKIE_QUERY = `SELECT name, host_key, encrypted_value FROM cookies WHERE (name = 'arl' AND host_key = '.deezer.com') OR (name = 'sp_dc' AND host_key = '.spotify.com')`;

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
    const out: BrowserCredentials = {};
    const rows = db.prepare(COOKIE_QUERY).all() as Array<{ name: string; encrypted_value: Uint8Array }>;
    for (const row of rows) {
      const value = decryptCookie(Buffer.from(row.encrypted_value), key, dbVersion >= 24);
      if (value) {
        if (row.name === 'arl') out.arl = value;
        else if (row.name === 'sp_dc') out.spDc = value;
      }
    }
    return out;
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

  const out: BrowserCredentials = {};
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
      if (!out.arl && name === 'arl' && host.includes('deezer.com')) out.arl = value;
      else if (!out.spDc && name === 'sp_dc' && host.includes('spotify.com')) out.spDc = value;
      if (out.arl && out.spDc) return out;
    }
  }
  return out;
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

// Auto-retrieve credentials from the first logged-in browser that has them.
// Never throws — a missing browser, locked DB, denied keychain, or TCC block
// just yields {}. Callers persist what's found; manual paste stays the fallback.
export function fetchBrowserCredentials(): BrowserCredentials {
  if (platform() !== 'darwin') return {};
  const result: BrowserCredentials = {};
  for (const browser of CHROMIUM_BROWSERS) {
    const found = readChromium(browser);
    if (found.arl && !result.arl) result.arl = found.arl;
    if (found.spDc && !result.spDc) result.spDc = found.spDc;
    if (result.arl && result.spDc) break;
  }
  if (!result.arl || !result.spDc) {
    const safari = readSafari();
    if (safari.arl && !result.arl) result.arl = safari.arl;
    if (safari.spDc && !result.spDc) result.spDc = safari.spDc;
  }
  return result;
}
