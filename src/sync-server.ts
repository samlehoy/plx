import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { credentialsFromCookies } from './browser.js';

// The one place the port and the wait live. extension/popup.js has to name the port too (it cannot
// import from here); keep the two in step.
export const DEFAULT_SYNC_PORT = 45678;
export const DEFAULT_SYNC_TIMEOUT_MS = 60_000;

// Google alone sets a few dozen cookies across its subdomains; this is far above any real payload.
const MAX_BODY_BYTES = 256 * 1024;

export type SyncOptions = { port?: number; timeoutMs?: number; onListening?: () => void };

// Who may hand the CLI credentials. A web page cannot send a POST without an Origin header naming
// itself, so refusing every Origin except an extension's is what stops an open tab from planting its
// own cookies during the wait (DNS rebinding included: the Origin is still the attacker's). A request
// with no Origin at all is not from a web page; a local process could forge any header anyway, and
// such a process can already write credentials.json directly. Chrome, Edge and Brave all use the
// chrome-extension:// scheme.
function allowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin.startsWith('chrome-extension://');
}

function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

type CookieRow = { name: string; host: string; value: string };

// The extension's payload is raw cookie rows ({ name, domain, value }, as chrome.cookies yields
// them); anything else in it is ignored. Returns null when the body is not that shape at all.
function cookieRows(data: unknown): CookieRow[] | null {
  const cookies = (data as { cookies?: unknown } | null)?.cookies;
  if (!Array.isArray(cookies)) return null;
  return cookies.flatMap((c: unknown) => {
    const { name, domain, value } = (c ?? {}) as Record<string, unknown>;
    return typeof name === 'string' && typeof domain === 'string' && typeof value === 'string'
      ? [{ name, host: domain, value }]
      : [];
  });
}

/**
 * Wait on 127.0.0.1 for one sync from the plx Companion extension. Resolves with one credential per
 * provider found, or {} when the wait times out. A request that carries no usable credential is
 * answered 400 and the wait goes on, so a stray request cannot end it early. Rejects when the server
 * cannot listen (port in use, …) so the caller can say why instead of reporting "nothing received".
 */
export function listenForExtensionSync(options: SyncOptions = {}): Promise<Record<string, string>> {
  const { port = DEFAULT_SYNC_PORT, timeoutMs = DEFAULT_SYNC_TIMEOUT_MS, onListening } = options;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (result: Record<string, string> | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const handle = (req: IncomingMessage, res: ServerResponse) => {
      const origin = req.headers.origin;
      if (!allowedOrigin(origin)) return reply(res, 403, { error: 'Only the plx Companion extension may sync' });
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }

      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        // Chrome's Private Network Access preflight asks this before letting a request reach localhost.
        if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== 'POST' || req.url !== '/sync') return reply(res, 404, { error: 'Not found' });

      let body = '';
      let tooLarge = false;
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        if (tooLarge) return;
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          tooLarge = true;
          reply(res, 413, { error: 'Payload too large' });
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooLarge) return;
        let rows: CookieRow[] | null;
        try {
          rows = cookieRows(JSON.parse(body));
        } catch {
          return reply(res, 400, { error: 'Invalid JSON' });
        }
        if (!rows) return reply(res, 400, { error: 'Expected { cookies: [{ name, domain, value }] }' });
        const credentials = credentialsFromCookies(rows);
        const received = Object.keys(credentials);
        if (!received.length) return reply(res, 400, { error: 'No Spotify, Deezer or YouTube Music session in the cookies sent' });
        reply(res, 200, { ok: true, received });
        finish(credentials);
      });
    };

    const server = createServer(handle);
    server.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use — is another plx already waiting for the extension?`)
        : new Error(`Could not listen for the extension on 127.0.0.1:${port}: ${err.message}`));
    });
    server.listen(port, '127.0.0.1', () => {
      timer = setTimeout(() => finish({}), timeoutMs);
      onListening?.();
    });
  });
}
