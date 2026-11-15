import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { listenForExtensionSync } from '../src/sync-server.js';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

// Listen, and only hand back the pending result once the port is actually bound.
async function listening(port: number, timeoutMs = 5000) {
  let ready!: () => void;
  const bound = new Promise<void>((r) => { ready = r; });
  const result = listenForExtensionSync({ port, timeoutMs, onListening: ready });
  result.catch(() => {}); // asserted by the caller; avoid an unhandled rejection meanwhile
  await bound;
  return { result };
}

function post(port: number, body: unknown, origin: string | null = EXTENSION) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  return fetch(`http://127.0.0.1:${port}/sync`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

const cookies = [
  { name: 'sp_dc', domain: '.spotify.com', value: 'dc-value' },
  { name: 'arl', domain: '.deezer.com', value: 'arl-value' },
  { name: 'unrelated', domain: '.spotify.com', value: 'ignored' },
];

describe('listenForExtensionSync', () => {
  it('turns the cookie rows an extension sends into one credential per provider', async () => {
    const port = 45991;
    const { result } = await listening(port);
    const res = await post(port, { cookies });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: ['deezer', 'spotify'] });
    expect(await result).toEqual({ deezer: 'arl-value', spotify: 'dc-value' });
  });

  it('refuses a web page, so an open tab cannot plant its own cookies', async () => {
    const port = 45992;
    const { result } = await listening(port, 300);
    const res = await post(port, { cookies }, 'https://evil.example');
    expect(res.status).toBe(403);
    const preflight = await fetch(`http://127.0.0.1:${port}/sync`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(preflight.status).toBe(403);
    expect(await result).toEqual({}); // still waiting until the timeout, nothing accepted
  });

  it('answers the extension preflight, Private Network Access included', async () => {
    const port = 45993;
    const { result } = await listening(port);
    const res = await fetch(`http://127.0.0.1:${port}/sync`, {
      method: 'OPTIONS',
      headers: { Origin: EXTENSION, 'Access-Control-Request-Private-Network': 'true' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXTENSION);
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    await post(port, { cookies });
    await result;
  });

  it('keeps waiting after a request with no usable credential', async () => {
    const port = 45994;
    const { result } = await listening(port);
    expect((await post(port, {})).status).toBe(400);
    expect((await post(port, 'not json')).status).toBe(400);
    expect((await post(port, { cookies: [{ name: 'unrelated', domain: '.spotify.com', value: 'x' }] })).status).toBe(400);
    expect((await post(port, { cookies })).status).toBe(200); // the real sync still lands
    expect(await result).toEqual({ deezer: 'arl-value', spotify: 'dc-value' });
  });

  it('rejects with the reason when the port is already taken', async () => {
    const port = 45995;
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', r));
    try {
      await expect(listenForExtensionSync({ port, timeoutMs: 5000 })).rejects.toThrow(/already in use/);
    } finally {
      blocker.close();
    }
  });

  it('resolves with nothing when the wait times out', async () => {
    expect(await listenForExtensionSync({ port: 45996, timeoutMs: 50 })).toEqual({});
  });
});
