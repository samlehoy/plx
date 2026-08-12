import { createServer } from 'node:http';
import { URL } from 'node:url';
import open from 'open';
import { browserHeaders, fetchJson, fetchText } from './http.js';
import type { PlaylistRef, Track } from './types.js';

export const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query';
const FETCH_PLAYLIST_SHA = 'a65e12194ed5fc443a1cdebed5fabe33ca5b07b987185d63c72483867ad13cb4';
const EMBED_TRACK_LIMIT = 100;

type NextData = { props?: { pageProps?: { state?: { settings?: { session?: { accessToken?: string } }; data?: { entity?: Record<string, unknown> } } } } };

async function nextData(url: string): Promise<NextData> {
  const html = await fetchText(url, { headers: browserHeaders });
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!match) throw new Error('__NEXT_DATA__ not found');
  return JSON.parse(match[1]) as NextData;
}

export async function anonymousToken(): Promise<string> {
  const data = await nextData('https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC');
  const token = data.props?.pageProps?.state?.settings?.session?.accessToken;
  if (!token) throw new Error('Spotify anonymous token missing');
  return token;
}

export async function playlistName(id: string): Promise<string> {
  try {
    const entity = (await nextData(`https://open.spotify.com/embed/playlist/${id}`)).props?.pageProps?.state?.data?.entity;
    if (typeof entity?.name === 'string' && entity.name) return entity.name;
  } catch { /* fallback below */ }
  return `playlist-${id.slice(0, 8)}`;
}

export async function fetchTracksEmbed(id: string): Promise<{ tracks: Track[]; truncated: boolean }> {
  const entity = (await nextData(`https://open.spotify.com/embed/playlist/${id}`)).props?.pageProps?.state?.data?.entity;
  const list = Array.isArray(entity?.trackList) ? entity.trackList : [];
  const tracks = list.map((item) => {
    const track = item as Record<string, unknown>;
    return { name: String(track.title ?? ''), artist: String(track.subtitle ?? ''), durationMs: typeof track.duration === 'number' ? track.duration : null };
  });
  return { tracks, truncated: tracks.length >= EMBED_TRACK_LIMIT };
}

export async function fetchTracks(id: string, token: string): Promise<{ tracks: Track[]; truncated: boolean }> {
  const tracks: Track[] = [];
  for (let offset = 0; ; ) {
    const variables = { uri: `spotify:playlist:${id}`, offset, limit: 100, enableWatchFeedEntrypoint: false };
    const params = new URLSearchParams({ operationName: 'fetchPlaylist', variables: JSON.stringify(variables), extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: FETCH_PLAYLIST_SHA } }) });
    const raw = await fetchJson<any>(`${PATHFINDER_URL}?${params}`, { headers: { ...browserHeaders, Authorization: `Bearer ${token}`, 'app-platform': 'WebPlayer' } });
    if (raw.errors?.length) throw new Error(`pathfinder: ${raw.errors[0].message}`);
    const content = raw.data.playlistV2.content;
    const items = content.items as any[];
    for (const item of items) {
      const data = item.itemV2?.data;
      if (!data?.uri) continue;
      tracks.push({ name: data.name ?? '', artist: data.artists?.items?.[0]?.profile?.name ?? '', durationMs: data.trackDuration?.totalMilliseconds ?? null });
    }
    offset += items.length;
    if (!items.length || offset >= content.totalCount) return { tracks, truncated: false };
  }
}

export async function readPlaylist(id: string, token: string) {
  try { return await fetchTracks(id, token); }
  catch { return fetchTracksEmbed(id); }
}

export async function oauth(clientId: string, clientSecret: string): Promise<{ token: string; userId: string }> {
  const state = 'playlist-converter';
  const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI, state, scope: 'playlist-read-private playlist-read-collaborative' });
  const authUrl = `https://accounts.spotify.com/authorize?${params}`;
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/callback') { response.end('Not found'); return; }
      const received = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      response.end(received ? 'Login OK. Kembali ke terminal.' : 'Login gagal.');
      server.close();
      if (received) resolve(received); else reject(new Error(error ?? 'OAuth callback failed'));
    });
    server.listen(8888, '127.0.0.1', () => { console.log(`Login Spotify: ${authUrl}`); void open(authUrl); });
    setTimeout(() => { server.close(); reject(new Error('OAuth timeout 90s')); }, 90_000);
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenResponse = await fetchJson<any>('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }) as any });
  const token = tokenResponse.access_token as string;
  const profile = await fetchJson<{ id: string }>('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
  return { token, userId: profile.id };
}

export async function listPlaylists(token: string): Promise<PlaylistRef[]> {
  const data = await fetchJson<any>('https://api.spotify.com/v1/me/playlists', { headers: { Authorization: `Bearer ${token}` } });
  return (data.items ?? []).map((item: any) => ({ name: item.name, uri: item.id }));
}
