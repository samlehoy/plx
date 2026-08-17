import { z } from 'zod';
import { fetchJson, retry } from './http.js';
import { firstArtist, matchCandidates, searchQuery, stripFeat } from './matcher.js';
import type { Match, Track } from './types.js';

const gqlSchema = z.object({ errors: z.array(z.object({ message: z.string() })).optional(), data: z.unknown() });

const API = 'https://api.deezer.com';
const GQL = 'https://pipe.deezer.com/api';

export function parseDeezerPlaylistId(ref: string): string {
  const input = ref.trim();
  if (input.includes('deezer.com')) return new URL(input).pathname.replace(/\/+$/, '').split('/').pop() ?? input;
  return input;
}

// Resolve a Deezer share shortlink (link.deezer.com/s/<code>) to its playlist id.
export async function resolveDeezerPlaylistId(ref: string): Promise<string> {
  const input = ref.trim();
  if (input.includes('link.deezer.com')) {
    const response = await fetch(input);
    const match = decodeURIComponent(response.url).match(/playlist\/(\d+)/);
    if (match) return match[1];
  }
  return parseDeezerPlaylistId(input);
}

function jwtExpiryMs(jwt: string): number {
  try {
    const payload = jwt.split('.')[1];
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as { exp?: number };
    return typeof decoded.exp === 'number' && decoded.exp > 0 ? decoded.exp * 1000 : Date.now() + 3600_000;
  } catch { return Date.now() + 3600_000; }
}

export class DeezerClient {
  private jwt?: string;
  private jwtExpiresAt = 0;
  constructor(private readonly arl: string) {}
  private async auth(force = false) {
    if (!force && this.jwt && Date.now() < this.jwtExpiresAt - 30_000) return this.jwt;
    const response = await fetch('https://auth.deezer.com/login/arl?jo=p&rto=c&i=c', { method: 'POST', headers: { Cookie: `arl=${this.arl}` } });
    if (!response.ok) throw new Error(`Deezer auth failed: ${response.status}`);
    const data = await response.json() as { jwt?: string };
    if (!data.jwt) throw new Error('Deezer JWT missing');
    this.jwt = data.jwt;
    this.jwtExpiresAt = jwtExpiryMs(data.jwt);
    return this.jwt;
  }
  private async gql<T>(query: string, operationName: string, variables: Record<string, unknown>): Promise<T> {
    const run = async (jwt: string) => gqlSchema.parse(await fetchJson<unknown>(GQL, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, operationName, variables }) }));
    let data = await run(await this.auth());
    if (data.errors?.length && /not valid anymore|re-authenticate/i.test(data.errors[0].message)) data = await run(await this.auth(true));
    if (data.errors?.length) throw new Error(`${operationName}: ${data.errors[0].message}`);
    return data.data as T;
  }
  async getMe() { return this.gql<{ me: { id: string } }>('query GetMe { me { id } }', 'GetMe', {}).then((x) => x.me); }
  async search(track: Track): Promise<Match | null> {
    const toCandidates = (data: { data: Array<{ id: number; title: string; duration: number; artist: { name: string } }> }) => data.data.map((x) => ({ id: String(x.id), title: x.title, artist: x.artist.name, duration: x.duration }));
    const free = `${API}/search?${new URLSearchParams({ q: searchQuery(track.name, track.artist), limit: '5' })}`;
    const data = await retry(async () => fetchJson<{ data: Array<{ id: number; title: string; duration: number; artist: { name: string } }> }>(free));
    const match = matchCandidates(track.name, track.artist, track.durationMs, toCandidates(data));
    if (match) return match;
    // Free-text relevance ranks covers/remixes above the real K-pop track; fall back to field syntax.
    const field = `${API}/search?${new URLSearchParams({ q: `track:"${stripFeat(track.name)}" artist:"${firstArtist(track.artist)}"`, limit: '5' })}`;
    const data2 = await retry(async () => fetchJson<{ data: Array<{ id: number; title: string; duration: number; artist: { name: string } }> }>(field));
    const match2 = matchCandidates(track.name, track.artist, track.durationMs, toCandidates(data2));
    if (match2) return match2;
    return this.searchByAlbum(track);
  }
  // Artist → albums → album tracks, for tracks the search index never surfaces (e.g. "Salty & Sweet").
  private async searchByAlbum(track: Track): Promise<Match | null> {
    const artistName = firstArtist(track.artist);
    const artistRes = await retry(async () => fetchJson<{ data: Array<{ id: number; name: string }> }>(`${API}/search/artist?${new URLSearchParams({ q: artistName, limit: '1' })}`));
    const artist = artistRes.data[0];
    if (!artist) return null;
    const albumsRes = await retry(async () => fetchJson<{ data: Array<{ id: number; title: string }> }>(`${API}/artist/${artist.id}/albums?${new URLSearchParams({ limit: '50' })}`));
    for (const album of albumsRes.data.slice(0, 25)) {
      const tracksRes = await retry(async () => fetchJson<{ data: Array<{ id: number; title: string; duration: number; artist: { name: string } }> }>(`${API}/album/${album.id}/tracks?${new URLSearchParams({ limit: '50' })}`));
      const m = matchCandidates(track.name, track.artist, track.durationMs, tracksRes.data.map((x) => ({ id: String(x.id), title: x.title, artist: x.artist.name, duration: x.duration })));
      if (m) return m;
    }
    return null;
  }
  async createPlaylist(title: string) { const x = await this.gql<{ createPlaylist: { playlist: { id: string } } }>('mutation CreatePlaylist($title:String!,$description:String="",$isPrivate:Boolean!=false,$isCollaborative:Boolean!=false){createPlaylist(input:{title:$title,description:$description,isPrivate:$isPrivate,isCollaborative:$isCollaborative}){playlist{id title}}}', 'CreatePlaylist', { title, description: '', isPrivate: true, isCollaborative: false }); return x.createPlaylist.playlist.id; }
  async addTracks(id: string, trackIds: string[]): Promise<number> {
    const x = await this.gql<{ addTracksToPlaylist: { __typename: string; addedTrackIds?: string[]; isNotAllowed?: boolean } }>('mutation AddTracksToPlaylist($playlistId:String!,$trackIds:[String!]!){addTracksToPlaylist(input:{playlistId:$playlistId,trackIds:$trackIds}){__typename ... on PlaylistAddTracksOutput{addedTrackIds} ... on PlaylistAddTracksError{isNotAllowed}}}', 'AddTracksToPlaylist', { playlistId: id, trackIds });
    const out = x.addTracksToPlaylist;
    if (out.__typename === 'PlaylistAddTracksError') throw new Error(out.isNotAllowed ? 'Not allowed to modify this playlist (not yours / follow-only)' : 'Failed to add tracks');
    if (!out.addedTrackIds || out.addedTrackIds.length !== trackIds.length) throw new Error(`Only ${out.addedTrackIds?.length ?? 0}/${trackIds.length} tracks were actually added`);
    return out.addedTrackIds.length;
  }
  // The user's own playlists. ponytail: capped at first 50 — personal use, paginate only if someone hits it.
  async listPlaylists(): Promise<{ id: string; title: string }[]> {
    const data = await this.gql<{ me: { playlists: { edges: Array<{ node: { id: string; title: string } }> } } }>('query GetUserPlaylists($first:Int=50){me{playlists(first:$first){edges{node{id title}}}}}', 'GetUserPlaylists', { first: 50 });
    return data.me.playlists.edges.map((e) => e.node);
  }
  // Full set of track ids currently in a playlist (paginated) — needed for dedupe.
  async getPlaylistTrackIds(playlistId: string): Promise<Set<string>> {
    return new Set(await this.getPlaylistTrackOrder(playlistId));
  }
  // Ordered list of track ids currently in a playlist (paginated) — preserves order.
  async getPlaylistTrackOrder(playlistId: string): Promise<string[]> {
    const ids: string[] = [];
    let after: string | null = null;
    for (;;) {
      const data: { playlist: { tracks: { edges: Array<{ node: { id: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } = await this.gql('query GetPlaylist($playlistId:String!,$first:Int=50,$after:String){playlist(playlistId:$playlistId){tracks(first:$first,after:$after){edges{node{id}} pageInfo{hasNextPage endCursor}}}}', 'GetPlaylist', { playlistId, first: 50, after });
      for (const e of data.playlist.tracks.edges) ids.push(e.node.id);
      if (!data.playlist.tracks.pageInfo.hasNextPage || !data.playlist.tracks.pageInfo.endCursor) return ids;
      after = data.playlist.tracks.pageInfo.endCursor;
    }
  }
  // Full track metadata (title/artist/duration) in playlist order — source read for the reverse flow.
  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    const tracks: Track[] = [];
    let after: string | null = null;
    for (;;) {
      const data: { playlist: { tracks: { edges: Array<{ node: { id: string; title: string; duration: number; contributorNames: string[] } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } = await this.gql('query GetPlaylistTracks($playlistId:String!,$first:Int=50,$after:String){playlist(playlistId:$playlistId){tracks(first:$first,after:$after){edges{node{id title duration contributorNames}} pageInfo{hasNextPage endCursor}}}}', 'GetPlaylistTracks', { playlistId, first: 50, after });
      for (const e of data.playlist.tracks.edges) tracks.push({ name: e.node.title, artist: e.node.contributorNames[0] ?? '', durationMs: e.node.duration * 1000 });
      if (!data.playlist.tracks.pageInfo.hasNextPage || !data.playlist.tracks.pageInfo.endCursor) return tracks;
      after = data.playlist.tracks.pageInfo.endCursor;
    }
  }
  // Move a track to be after `afterTrackId` (null = move to front).
  async moveTrack(playlistId: string, trackId: string, afterTrackId: string | null): Promise<void> {
    await this.gql('mutation MoveTrackInPlaylist($playlistId:String!,$trackId:String!,$afterTrackId:String){moveTrackInPlaylist(input:{playlistId:$playlistId,trackId:$trackId,afterTrackId:$afterTrackId}){__typename}}', 'MoveTrackInPlaylist', { playlistId, trackId, afterTrackId });
  }
}
