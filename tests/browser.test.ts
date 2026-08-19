import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { decryptCookie, firefoxProfiles, parseSafariCookies, readFirefox } from '../src/browser.js';
import { cookieHeader } from '../src/ytmusic.js';

const key = pbkdf2Sync('test-password', 'saltysalt', 1003, 16, 'sha1');

// Encrypt the way Chromium v10 does: fixed IV (16 × 0x20), PKCS7 (auto), "v10"
// prefix. Optionally prepend a 32-byte SHA256 domain-hash to the plaintext
// (DB version ≥ 24) — the hash lives *inside* the ciphertext, before the value.
function v10Encrypt(plain: string, withDomainHash = false): Buffer {
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const data = withDomainHash ? Buffer.concat([Buffer.alloc(32, 0xab), Buffer.from(plain, 'utf8')]) : Buffer.from(plain, 'utf8');
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), body]);
}

describe('decryptCookie', () => {
  it('round-trips a v10 cookie blob', () => {
    expect(decryptCookie(v10Encrypt('AQAA-secret-arl-value'), key)).toBe('AQAA-secret-arl-value');
  });

  it('strips the 32-byte domain-hash prefix when requested (DB v>=24)', () => {
    expect(decryptCookie(v10Encrypt('e2ebece1d0163ae8f9c6', true), key, true)).toBe('e2ebece1d0163ae8f9c6');
  });

  it('rejects a blob without the v10 prefix', () => {
    const blob = Buffer.concat([Buffer.from('v11', 'latin1'), v10Encrypt('x').subarray(3)]);
    expect(decryptCookie(blob, key)).toBeNull();
  });

  it('rejects a blob shorter than the prefix', () => {
    expect(decryptCookie(Buffer.from('v1'), key)).toBeNull();
  });
});

// Build a minimal binarycookies buffer: "cook" + one page holding the given cookies.
// Cookie record (64-byte header): [size(4)][unk(4)][flags(4)][unk(4)]
//   [host off(4)][name off(4)][path off(4)][value off(4)][comment off(4)]
//   [zeros(4)][expiry(8)][created(8)] — string offsets are record-relative.
function binarycookies(cookies: Array<{ host: string; name: string; value: string }>): Buffer {
  const records = cookies.map(({ host, name, value }) => {
    const [h, n, p, v] = [`${host}\0`, `${name}\0`, '/\0', `${value}\0`];
    const hostOff = 64;
    const nameOff = hostOff + h.length;
    const pathOff = nameOff + n.length;
    const valueOff = pathOff + p.length;
    const rec = Buffer.alloc(64);
    rec.writeUInt32LE(hostOff, 16);
    rec.writeUInt32LE(nameOff, 20);
    rec.writeUInt32LE(pathOff, 24);
    rec.writeUInt32LE(valueOff, 28);
    return Buffer.concat([rec, Buffer.from(h), Buffer.from(n), Buffer.from(p), Buffer.from(v)]);
  });

  // Page header: magic 0x00000100 (BE) + nCookies (LE) + one offset per cookie (LE) + 4 zero bytes.
  const headerLength = 12 + records.length * 4;
  const pageHeader = Buffer.alloc(headerLength);
  pageHeader.writeUInt32BE(0x00000100, 0);
  pageHeader.writeUInt32LE(records.length, 4);
  let offset = headerLength;
  records.forEach((rec, i) => { pageHeader.writeUInt32LE(offset, 8 + i * 4); offset += rec.length; });
  const page = Buffer.concat([pageHeader, ...records]);

  // File header: "cook" + totalPages (BE) + pageSize (BE)
  const fileHeader = Buffer.alloc(12);
  fileHeader.write('cook', 0, 'latin1');
  fileHeader.writeUInt32BE(1, 4);
  fileHeader.writeUInt32BE(page.length, 8);
  return Buffer.concat([fileHeader, page]);
}

describe('parseSafariCookies', () => {
  it('extracts arl and sp_dc from a binarycookies page', () => {
    expect(parseSafariCookies(binarycookies([{ host: '.deezer.com', name: 'arl', value: 'abc123arl' }]))).toEqual({ arl: 'abc123arl' });
  });

  it('rejects a non-cookie buffer', () => {
    expect(parseSafariCookies(Buffer.from('nope'))).toEqual({});
  });

  it('ignores a wanted cookie name served from the wrong host', () => {
    expect(parseSafariCookies(binarycookies([{ host: '.evil.example', name: 'arl', value: 'nope' }]))).toEqual({});
  });

  // The Safari backend's half of AC5: what it finds feeds the same joiner the Chromium backend uses.
  it('yields Google cookies that the shared joiner turns into a header', () => {
    const found = parseSafariCookies(binarycookies([
      { host: '.youtube.com', name: 'SAPISID', value: 'sap' },
      { host: '.youtube.com', name: 'SID', value: 'sid' },
      { host: '.google.com', name: 'HSID', value: 'hs' },
      { host: '.deezer.com', name: 'arl', value: 'arl-value' },
    ]));
    expect(found).toEqual({ SAPISID: 'sap', SID: 'sid', HSID: 'hs', arl: 'arl-value' });
    expect(cookieHeader(found)).toBe('SAPISID=sap; SID=sid; HSID=hs');
  });
});

// Firefox needs no encryption fixture at all — that is the whole point of the backend. The schema plx
// touches is three columns of `moz_cookies`, and node:sqlite writes a DB as readily as it reads one,
// so these run against a real database file rather than a stand-in for one.
function firefoxDb(cookies: Array<{ host: string; name: string; value: string }>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'plx-ff-test-')), 'cookies.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT)');
  const insert = db.prepare('INSERT INTO moz_cookies (name, value, host) VALUES (?, ?, ?)');
  for (const { host, name, value } of cookies) insert.run(name, value, host);
  db.close();
  return path;
}

describe('readFirefox', () => {
  it('reads plaintext cookies straight out of a profile DB', () => {
    expect(readFirefox(firefoxDb([{ host: '.deezer.com', name: 'arl', value: 'abc123arl' }]))).toEqual({ arl: 'abc123arl' });
  });

  it('ignores a wanted cookie name served from the wrong host', () => {
    expect(readFirefox(firefoxDb([{ host: '.evil.example', name: 'arl', value: 'nope' }]))).toEqual({});
  });

  it('feeds the same joiner the other two backends use', () => {
    const found = readFirefox(firefoxDb([
      { host: '.youtube.com', name: 'SAPISID', value: 'sap' },
      { host: '.youtube.com', name: 'SID', value: 'sid' },
      { host: '.google.com', name: 'HSID', value: 'hs' },
    ]));
    expect(cookieHeader(found)).toBe('SAPISID=sap; SID=sid; HSID=hs');
  });

  // Google sets SID on both .google.com and .youtube.com with *different* values, and a bundle
  // mixing the two authenticates as neither. Listed google-first so row order cannot mask a
  // ranking that silently took whichever came back first.
  it('prefers the .youtube.com copy of a cookie Google also set on .google.com', () => {
    const found = readFirefox(firefoxDb([
      { host: '.google.com', name: 'SID', value: 'google-copy' },
      { host: '.youtube.com', name: 'SID', value: 'youtube-copy' },
    ]));
    expect(found.SID).toBe('youtube-copy');
  });

  it('returns nothing rather than throwing when the path is not a database', () => {
    expect(readFirefox(join(tmpdir(), 'plx-nonexistent-profile.sqlite'))).toEqual({});
  });
});

describe('firefoxProfiles', () => {
  const profileDir = (base: string, name: string, mtime: number): string => {
    mkdirSync(join(base, name), { recursive: true });
    const db = join(base, name, 'cookies.sqlite');
    writeFileSync(db, '');
    utimesSync(db, mtime, mtime);
    return db;
  };

  // Named so that alphabetical order is the *opposite* of mtime order: readdir yielding the right
  // answer by luck would still fail this.
  it('lists profiles holding a cookie DB, most recently written first', () => {
    const root = mkdtempSync(join(tmpdir(), 'plx-ff-root-'));
    const profiles = join(root, 'Profiles');
    const stale = profileDir(profiles, 'aaa.default', 1_000);
    const current = profileDir(profiles, 'zzz.default-release', 9_000);
    mkdirSync(join(profiles, 'never-used'), { recursive: true }); // a profile that stored no cookies
    expect(firefoxProfiles(root)).toEqual([current, stale]);
  });

  it('falls back to the root when a packaging omits the Profiles/ level', () => {
    const root = mkdtempSync(join(tmpdir(), 'plx-ff-flat-'));
    const db = profileDir(root, 'abcd1234.default', 5_000);
    expect(firefoxProfiles(root)).toEqual([db]);
  });

  it('returns nothing when Firefox is not installed', () => {
    expect(firefoxProfiles(join(tmpdir(), 'plx-no-firefox-here'))).toEqual([]);
  });
});
