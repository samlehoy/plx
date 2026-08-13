import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedToken, parsePlaylistId } from '../src/spotify.js';

describe('parsePlaylistId', () => {
  it('extracts id from URL, URI, and raw', () => {
    expect(parsePlaylistId('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe('37i9dQZF1DXcBWIGoYBM5M');
    expect(parsePlaylistId('spotify:playlist:abc123')).toBe('abc123');
    expect(parsePlaylistId('abc123')).toBe('abc123');
  });
});

describe('authenticatedToken', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mints a token from sp_dc via nuance TOTP + server time', async () => {
    // RFC 6238 test secret ("12345678901234567890") in base32; TOTP at T=59 is "287082".
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      seen.push(String(url));
      const res = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
      if (String(url).includes('nuances.json')) return res([{ s: secret, v: 61 }]);
      if (String(url).includes('/api/server-time')) return res({ serverTime: 59 });
      if (String(url).includes('/api/token')) return res({ accessToken: 'tok123', isAnonymous: false });
      throw new Error(`unexpected url ${url}`);
    }));
    const token = await authenticatedToken('dc-value');
    expect(token).toBe('tok123');
    const tokenUrl = seen.find((u) => u.includes('/api/token'))!;
    expect(tokenUrl).toContain('totp=287082');
    expect(tokenUrl).toContain('totpVer=61');
    expect(tokenUrl).toContain('productType=web-player');
  });
});
