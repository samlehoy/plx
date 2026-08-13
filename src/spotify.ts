import { z } from 'zod';
import { browserHeaders, fetchJson, fetchText } from './http.js';
import type { DeezerCandidate, Track } from './types.js';

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query';
const FETCH_PLAYLIST_SHA = 'a65e12194ed5fc443a1cdebed5fabe33ca5b07b987185d63c72483867ad13cb4';
export const EMBED_TRACK_LIMIT = 100;

const pathfinderItemData = z.object({
  uri: z.string().optional(),
  name: z.string().optional(),
  artists: z.object({ items: z.array(z.object({ profile: z.object({ name: z.string().optional() }) })) }).optional(),
  trackDuration: z.object({ totalMilliseconds: z.number().optional() }).optional(),
});
const pathfinderItem = z.object({ itemV2: z.object({ data: pathfinderItemData.optional() }).optional() });
const pathfinderContent = z.object({ totalCount: z.number(), items: z.array(pathfinderItem) });
const pathfinderTrackSchema = z.object({
  errors: z.array(z.object({ message: z.string() })).optional(),
  data: z.object({ playlistV2: z.object({ content: pathfinderContent }) }),
});

type NextData = { props?: { pageProps?: { state?: { settings?: { session?: { accessToken?: string; isAnonymous?: boolean } }; data?: { entity?: Record<string, unknown> } } } } };

async function nextData(url: string, cookie?: string): Promise<NextData> {
  const headers = cookie ? { ...browserHeaders, Cookie: cookie } : browserHeaders;
  const html = await fetchText(url, { headers });
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
    const raw = pathfinderTrackSchema.parse(await fetchJson<unknown>(`${PATHFINDER_URL}?${params}`, { headers: { ...browserHeaders, Authorization: `Bearer ${token}`, 'app-platform': 'WebPlayer' } }));
    if (raw.errors?.length) throw new Error(`pathfinder: ${raw.errors[0].message}`);
    const content = raw.data.playlistV2.content;
    const items = content.items;
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

export function parsePlaylistId(ref: string): string {
  const input = ref.trim();
  if (input.includes('open.spotify.com')) return new URL(input).pathname.replace(/\/+$/, '').split('/').pop() ?? input;
  if (input.startsWith('spotify:playlist:')) return input.split(':').pop() ?? input;
  return input;
}

// --- Authenticated write (reverse flow: Deezer → Spotify) ---
const PATHFINDER_V2_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
const SPCLIENT_URL = 'https://spclient.wg.spotify.com';
// Persisted-query hashes for write/search — captured from the web player; they rotate (see CONTINUATION.md).
const ADD_TO_PLAYLIST_SHA = '47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990';
const SEARCH_TRACKS_SHA = 'bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428';
const LIBRARY_V3_SHA = '973e511ca44261fda7eebac8b653155e7caee3675abb4fb110cc1b8c78b091c3';

const writeHeaders = (token: string) => ({ ...browserHeaders, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'app-platform': 'WebPlayer' });

// Authenticated token from a logged-in browser session (sp_dc cookie) via the embed __NEXT_DATA__ trick.
export async function authenticatedToken(spDc: string): Promise<string> {
  const data = await nextData('https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC', `sp_dc=${spDc}`);
  const session = data.props?.pageProps?.state?.settings?.session;
  if (session?.isAnonymous !== false) throw new Error('Spotify session masih anonim — sp_dc tidak valid atau kedaluwarsa');
  if (!session.accessToken) throw new Error('Spotify token missing');
  return session.accessToken;
}

// Spotify search, shaped as DeezerCandidate (duration in seconds) so matchCandidates is reusable.
export async function searchTrack(term: string, token: string): Promise<DeezerCandidate[]> {
  const body = { variables: { searchTerm: term, offset: 0, limit: 10, numberOfTopResults: 10, includePreReleases: false, includeAudiobooks: false, includeAuthors: false }, operationName: 'searchTracks', extensions: { persistedQuery: { version: 1, sha256Hash: SEARCH_TRACKS_SHA } } };
  const raw = await fetchJson<{ errors?: Array<{ message: string }>; data?: { searchV2?: { tracksV2?: { items?: Array<{ item?: { data?: { uri?: string; name?: string; artists?: { items?: Array<{ profile?: { name?: string } }> }; duration?: { totalMilliseconds?: number } } } }> } } } }>(PATHFINDER_V2_URL, { method: 'POST', headers: writeHeaders(token), body: JSON.stringify(body) });
  if (raw.errors?.length) throw new Error(`searchTracks: ${raw.errors[0].message}`);
  const items = raw.data?.searchV2?.tracksV2?.items ?? [];
  return items.flatMap((it) => {
    const d = it.item?.data;
    if (!d?.uri || !d.name) return [];
    return [{ id: d.uri, title: d.name, artist: d.artists?.items?.[0]?.profile?.name ?? '', duration: d.duration?.totalMilliseconds != null ? Math.round(d.duration.totalMilliseconds / 1000) : null }];
  });
}

export async function createPlaylist(name: string, token: string): Promise<string> {
  const body = { ops: [{ kind: 'UPDATE_LIST_ATTRIBUTES', updateListAttributes: { newAttributes: { values: { name, description: '' } } } }] };
  const raw = await fetchJson<{ uri?: string }>(`${SPCLIENT_URL}/playlist/v2/playlist?format=json`, { method: 'POST', headers: writeHeaders(token), body: JSON.stringify(body) });
  if (!raw.uri) throw new Error('Spotify create playlist: no uri');
  return raw.uri;
}

export async function addTracks(playlistUri: string, trackUris: string[], token: string): Promise<void> {
  const body = { variables: { playlistItemUris: trackUris, playlistUri, newPosition: { moveType: 'BOTTOM_OF_PLAYLIST', fromUid: null } }, operationName: 'addToPlaylist', extensions: { persistedQuery: { version: 1, sha256Hash: ADD_TO_PLAYLIST_SHA } } };
  const raw = await fetchJson<{ errors?: Array<{ message: string }> }>(PATHFINDER_V2_URL, { method: 'POST', headers: writeHeaders(token), body: JSON.stringify(body) });
  if (raw.errors?.length) throw new Error(`addToPlaylist: ${raw.errors[0].message}`);
}

// The user's own (writable) playlists. Filters out Liked Songs and followed playlists (canEditItems: false).
export async function listPlaylists(token: string): Promise<{ uri: string; name: string }[]> {
  const body = { variables: { limit: 50, offset: 0, folderUri: null }, operationName: 'libraryV3', extensions: { persistedQuery: { version: 1, sha256Hash: LIBRARY_V3_SHA } } };
  type Item = { item?: { __typename?: string; data?: { name?: string; uri?: string; currentUserCapabilities?: { canEditItems?: boolean } } } };
  const raw = await fetchJson<{ errors?: Array<{ message: string }>; data?: { me?: { libraryV3?: { items?: Item[] } } } }>(PATHFINDER_V2_URL, { method: 'POST', headers: writeHeaders(token), body: JSON.stringify(body) });
  if (raw.errors?.length) throw new Error(`libraryV3: ${raw.errors[0].message}`);
  const items = raw.data?.me?.libraryV3?.items ?? [];
  return items.flatMap((it) => {
    const d = it.item?.data;
    if (it.item?.__typename !== 'PlaylistResponseWrapper' || !d?.uri || !d.name || d.currentUserCapabilities?.canEditItems !== true) return [];
    return [{ uri: d.uri, name: d.name }];
  });
}

// Track URIs currently in a playlist — for dedupe on the reverse flow. Reuses the proven v1 fetchPlaylist read path.
export async function fetchTrackUris(id: string, token: string): Promise<string[]> {
  const uris: string[] = [];
  for (let offset = 0; ; ) {
    const variables = { uri: `spotify:playlist:${id}`, offset, limit: 100, enableWatchFeedEntrypoint: false };
    const params = new URLSearchParams({ operationName: 'fetchPlaylist', variables: JSON.stringify(variables), extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: FETCH_PLAYLIST_SHA } }) });
    const raw = pathfinderTrackSchema.parse(await fetchJson<unknown>(`${PATHFINDER_URL}?${params}`, { headers: { ...browserHeaders, Authorization: `Bearer ${token}`, 'app-platform': 'WebPlayer' } }));
    if (raw.errors?.length) throw new Error(`pathfinder: ${raw.errors[0].message}`);
    const content = raw.data.playlistV2.content;
    for (const item of content.items) { const u = item.itemV2?.data?.uri; if (u) uris.push(u); }
    offset += content.items.length;
    if (!content.items.length || offset >= content.totalCount) return uris;
  }
}
