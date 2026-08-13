import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptCookie, parseSafariCookies } from '../src/browser.js';

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

describe('parseSafariCookies', () => {
  // Build a minimal binarycookies buffer: "cook" + one page with one cookie.
  // Page: 0x00000100 (big-endian) + nCookies (LE) + cookie offset (LE) + 4 bytes
  // 0x00, then the cookie record at that offset.
  it('extracts arl and sp_dc from a binarycookies page', () => {
    const host = '.deezer.com\0';
    const name = 'arl\0';
    const path = '/\0';
    const value = 'abc123arl\0';
    // Cookie record (64-byte header): [size(4)][unk(4)][flags(4)][unk(4)]
    //   [host off(4)][name off(4)][path off(4)][value off(4)][comment off(4)]
    //   [zeros(4)][expiry(8)][created(8)] — string offsets are record-relative.
    const hostOff = 64;
    const nameOff = hostOff + host.length;
    const pathOff = nameOff + name.length;
    const valueOff = pathOff + path.length;
    const rec = Buffer.alloc(64);
    rec.writeUInt32LE(hostOff, 16);
    rec.writeUInt32LE(nameOff, 20);
    rec.writeUInt32LE(pathOff, 24);
    rec.writeUInt32LE(valueOff, 28);
    const tail = Buffer.concat([Buffer.from(host), Buffer.from(name), Buffer.from(path), Buffer.from(value)]);

    // Page header: magic 0x00000100 (BE) + nCookies (LE) + offset (LE) + 4 zero bytes = 16 for one cookie.
    const recordOffset = 16;
    const pageHeader = Buffer.alloc(16);
    pageHeader.writeUInt32BE(0x00000100, 0);
    pageHeader.writeUInt32LE(1, 4);
    pageHeader.writeUInt32LE(recordOffset, 8);
    const page = Buffer.concat([pageHeader, rec, tail]);

    // File header: "cook" + totalPages (BE) + pageSize (BE)
    const fileHeader = Buffer.alloc(12);
    fileHeader.write('cook', 0, 'latin1');
    fileHeader.writeUInt32BE(1, 4);
    fileHeader.writeUInt32BE(page.length, 8);
    const file = Buffer.concat([fileHeader, page]);

    expect(parseSafariCookies(file)).toEqual({ arl: 'abc123arl' });
  });

  it('rejects a non-cookie buffer', () => {
    expect(parseSafariCookies(Buffer.from('nope'))).toEqual({});
  });
});
