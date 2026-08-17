import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { YTMUSIC_COOKIES, accountNameFrom, clientVersion, cookieHeader, sapisidFrom, sapisidHash, validateSession, ytmusicHeaders } from '../src/ytmusic.js';

// The one place "which cookies, joined how" is decided. Both browser backends route through it, and
// it is the only part of browser reading that can be tested without a keychain.
describe('cookieHeader', () => {
  it('joins the cookies it recognises into one header', () => {
    const header = cookieHeader({ SAPISID: 'sap', SID: 'sid', HSID: 'hs' });
    expect(header).toBe('SAPISID=sap; SID=sid; HSID=hs');
  });

  it('ignores cookies that are not part of the bundle', () => {
    expect(cookieHeader({ SAPISID: 'sap', arl: 'deezer-cookie', sp_dc: 'spotify-cookie' })).toBe('SAPISID=sap');
  });

  it('emits a stable order regardless of how the cookie store yielded them', () => {
    const forwards = cookieHeader({ SAPISID: 'a', SID: 'b', LOGIN_INFO: 'c' });
    const backwards = cookieHeader({ LOGIN_INFO: 'c', SID: 'b', SAPISID: 'a' });
    expect(forwards).toBe(backwards);
  });

  it('refuses a bundle with no signing cookie, since it cannot be signed', () => {
    expect(cookieHeader({ SID: 'sid', HSID: 'hs', LOGIN_INFO: 'x' })).toBe('');
    expect(cookieHeader({})).toBe('');
  });

  it('accepts the __Secure- variant as the signing cookie', () => {
    expect(cookieHeader({ '__Secure-3PAPISID': 'sap', SID: 'sid' })).toBe('__Secure-3PAPISID=sap; SID=sid');
  });

  it('keeps every cookie the web client sends when the browser has them all', () => {
    const all = Object.fromEntries(YTMUSIC_COOKIES.map((name) => [name, 'v']));
    expect(cookieHeader(all).split('; ')).toHaveLength(YTMUSIC_COOKIES.length);
  });

  // Found the hard way against the live service: without the *SIDTS pair the *PSID cookies are
  // treated as unbound and the session authenticates as logged out — with a 200 and no hint why.
  it('carries the session-binding cookies a current Google login needs', () => {
    expect(YTMUSIC_COOKIES).toContain('__Secure-1PSIDTS');
    expect(YTMUSIC_COOKIES).toContain('__Secure-3PSIDTS');
    expect(cookieHeader({ SAPISID: 'a', __SID: 'x', '__Secure-3PSID': 'b', '__Secure-3PSIDTS': 'c' }))
      .toBe('SAPISID=a; __Secure-3PSID=b; __Secure-3PSIDTS=c');
  });
});

describe('validateSession', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respondWith = (body: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200, text: async () => JSON.stringify(body),
  }));

  it('reports the account name when the session is live', async () => {
    respondWith({ actions: [{ menu: { accountName: { runs: [{ text: 'Ada Lovelace' }] } } }] });
    await expect(validateSession('SAPISID=real')).resolves.toBe('Ada Lovelace');
  });

  // The bug this pins: Google answers a rejected session with 200 and a signed-out menu, so a check
  // that trusts the status code reports a dead session as working.
  it('rejects a signed-out response even though it arrives as a 200', async () => {
    respondWith({ responseContext: { serviceTrackingParams: [{ params: [{ key: 'yt_li', value: '0' }] }] }, actions: [] });
    await expect(validateSession('SAPISID=stale')).rejects.toThrow(/session has expired/i);
  });

  it('says what to copy when the header has no signing cookie, without calling out', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(validateSession('SID=x; HSID=y')).rejects.toThrow(/SAPISID/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('sapisidFrom', () => {
  it('reads SAPISID out of a header', () => {
    expect(sapisidFrom('YSC=a; SAPISID=the-value; SID=b')).toBe('the-value');
  });

  it('falls back to the __Secure- variants a partitioned-cookie browser has instead', () => {
    expect(sapisidFrom('SID=b; __Secure-3PAPISID=three')).toBe('three');
    expect(sapisidFrom('SID=b; __Secure-1PAPISID=one')).toBe('one');
  });

  it('does not mistake a lookalike name for the real cookie', () => {
    expect(sapisidFrom('NOTSAPISID=x')).toBe('');
    expect(sapisidFrom('SID=b; HSID=c')).toBe('');
  });
});

describe('sapisidHash', () => {
  // The signature the web client computes for its own requests: sha1 over
  // "<unix seconds> <SAPISID> <origin>", prefixed with the scheme and the timestamp.
  it('signs the way the web client does', () => {
    const expected = createHash('sha1').update('1700000000 secret https://music.youtube.com').digest('hex');
    expect(sapisidHash('secret', 'https://music.youtube.com', 1700000000)).toBe(`SAPISIDHASH 1700000000_${expected}`);
  });

  it('changes with the timestamp, so a captured header does not stay valid', () => {
    expect(sapisidHash('secret', 'https://music.youtube.com', 1)).not.toBe(sapisidHash('secret', 'https://music.youtube.com', 2));
  });
});

describe('ytmusicHeaders', () => {
  it('sends the cookie, the signature, and the origin the service expects', () => {
    const headers = ytmusicHeaders('SAPISID=sap; SID=sid');
    expect(headers.Cookie).toBe('SAPISID=sap; SID=sid');
    expect(headers.Authorization).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}$/);
    expect(headers['x-origin']).toBe('https://music.youtube.com');
    expect(headers['X-Goog-AuthUser']).toBe('0');
  });
});

describe('clientVersion', () => {
  it('tracks the calendar rather than going stale as a pinned constant', () => {
    expect(clientVersion(new Date('2026-08-17T00:00:00Z'))).toBe('1.20260817.01.00');
  });
});

describe('accountNameFrom', () => {
  // The account-menu renderer nests about six levels deep and the nesting is not a contract.
  it('finds the account name wherever the renderer buried it', () => {
    const response = { a: { b: [{ c: { accountName: { runs: [{ text: 'Ada Lovelace' }] } } }] } };
    expect(accountNameFrom(response)).toBe('Ada Lovelace');
  });

  it('returns nothing rather than throwing when the shape is unfamiliar', () => {
    expect(accountNameFrom({ responseContext: {} })).toBe('');
    expect(accountNameFrom(null)).toBe('');
    expect(accountNameFrom({ accountName: { runs: [] } })).toBe('');
  });
});
