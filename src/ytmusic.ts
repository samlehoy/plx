import { createHash } from 'node:crypto';
import { browserHeaders, fetchJson } from './http.js';

const ORIGIN = 'https://music.youtube.com';
const INNERTUBE = `${ORIGIN}/youtubei/v1`;

// The cookies the YouTube Music web client sends. Google needs a bundle rather than the single
// cookie the other two providers use, which is why plx stores a whole cookie header for it and why
// the manual path is one paste instead of a prompt per cookie.
//
// SAPISID (or its __Secure- twin) is the one that must be present: request signing is derived from
// it. The rest carry the session and are sent as-is.
export const YTMUSIC_COOKIES = [
  'SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID',
  'SID', '__Secure-1PSID', '__Secure-3PSID',
  // The *SIDTS pair is not optional on a current Google session: without it the *PSID cookies are
  // treated as unbound and the request authenticates as logged out, with a 200 and no hint why.
  '__Secure-1PSIDTS', '__Secure-3PSIDTS',
  'HSID', 'SSID', 'APISID',
  'LOGIN_INFO', 'SIDCC', '__Secure-1PSIDCC', '__Secure-3PSIDCC',
  'PREF', 'VISITOR_INFO1_LIVE', 'YSC',
];

// The single joiner both browser backends route through: whatever cookies were found, in one header
// string. Only the names above are kept, in that order, so the header is stable regardless of the
// order a cookie store happened to yield them. Returns '' when the essential cookie is missing —
// a bundle without it cannot be signed, so it is not a credential.
export function cookieHeader(found: Record<string, string>): string {
  const pairs = YTMUSIC_COOKIES.filter((name) => found[name]).map((name) => `${name}=${found[name]}`);
  return sapisidFrom(pairs.join('; ')) ? pairs.join('; ') : '';
}

// The value request signing is derived from. Accepts the __Secure- variants, which is what a
// browser that has migrated to partitioned cookies will have instead of a bare SAPISID.
export function sapisidFrom(header: string): string {
  for (const name of ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID']) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return '';
}

// SAPISIDHASH: sha1 over "<unix seconds> <SAPISID> <origin>", the way the web client signs its own
// requests. Timestamp is a parameter so the hash is testable against a known vector.
export function sapisidHash(sapisid: string, origin = ORIGIN, nowSec = Math.floor(Date.now() / 1000)): string {
  const digest = createHash('sha1').update(`${nowSec} ${sapisid} ${origin}`).digest('hex');
  return `SAPISIDHASH ${nowSec}_${digest}`;
}

export function ytmusicHeaders(cookie: string): Record<string, string> {
  return {
    ...browserHeaders,
    Accept: '*/*',
    'Content-Type': 'application/json',
    Authorization: sapisidHash(sapisidFrom(cookie)),
    'X-Goog-AuthUser': '0',
    'x-origin': ORIGIN,
    Cookie: cookie,
  };
}

// InnerTube wants a client version; it is lenient about the exact value but not about the shape.
// Derived from today's date the way the web client's own version is, so it ages with the calendar
// instead of going stale as a pinned constant.
export function clientVersion(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `1.${date}.01.00`;
}

export const innertubeContext = () => ({ context: { client: { clientName: 'WEB_REMIX', clientVersion: clientVersion(), hl: 'en', gl: 'US' } } });

export async function innertube<T>(path: string, cookie: string, body: Record<string, unknown> = {}): Promise<T> {
  return fetchJson<T>(`${INNERTUBE}/${path}?prettyPrint=false`, {
    method: 'POST',
    headers: ytmusicHeaders(cookie),
    body: JSON.stringify({ ...innertubeContext(), ...body }),
  });
}

// First `accountName: { runs: [{ text }] }` anywhere in the response. The account-menu renderer is
// nested about six levels deep and the nesting is not a contract, so this walks rather than indexes.
export function accountNameFrom(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as Record<string, unknown>;
  const runs = (node.accountName as { runs?: Array<{ text?: string }> } | undefined)?.runs;
  if (runs?.[0]?.text) return runs[0].text;
  for (const child of Object.values(node)) {
    const found = accountNameFrom(child);
    if (found) return found;
  }
  return '';
}

const EXPIRED = 'Your YouTube Music session has expired. Log in at music.youtube.com again, then re-run auto-fetch or paste a fresh cookie header.';

// Prove the credential against the live service, resolving to the signed-in account name.
//
// Google answers a rejected session with **200 and a signed-out menu**, not an error status, so the
// only reliable proof is that the response actually names an account. Trusting the status code here
// reports a dead session as working.
export async function validateSession(cookie: string): Promise<string> {
  if (!sapisidFrom(cookie)) throw new Error('That cookie header has no SAPISID — copy the whole Cookie line from a music.youtube.com request.');
  let raw: unknown;
  try {
    raw = await innertube<unknown>('account/account_menu', cookie);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b(401|403)\b/.test(message)) throw new Error(EXPIRED);
    throw new Error(`Could not reach YouTube Music (${message}).`);
  }
  const account = accountNameFrom(raw);
  if (!account) throw new Error(EXPIRED);
  return account;
}

// --- Playlist ids ----------------------------------------------------------

// A YouTube Music playlist id *is* a YouTube playlist id, so both hosts name the same thing.
export function parsePlaylistRef(ref: string): string {
  const input = ref.trim();
  if (/^https?:\/\//i.test(input)) {
    try {
      const list = new URL(input).searchParams.get('list');
      if (list) return list;
      const last = new URL(input).pathname.replace(/\/+$/, '').split('/').pop() ?? '';
      return last.replace(/^VL/, '');
    } catch { /* fall through to the raw value */ }
  }
  return input.replace(/^VL/, '');
}

// A mix (radio) regenerates on every visit: its contents are not reproducible, so it is not a
// playlist and plx refuses it as a source. Every mix id starts with RD — RDCLAK, RDAMVM, RDEM…
// Checked on the id so the reason is explicit, rather than surfacing as an empty read.
export const isMix = (playlistId: string) => /^RD/i.test(parsePlaylistRef(playlistId));
