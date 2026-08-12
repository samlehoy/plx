import { fetchJson, retry } from './http.js';
import { matchCandidates, searchQuery } from './matcher.js';
import type { Match, Track } from './types.js';

const API = 'https://api.deezer.com';
const GQL = 'https://pipe.deezer.com/api';

export class DeezerClient {
  private jwt?: string;
  constructor(private readonly arl: string) {}
  private async auth() {
    if (this.jwt) return this.jwt;
    const response = await fetch('https://auth.deezer.com/login/arl?jo=p&rto=c&i=c', { method: 'POST', headers: { Cookie: `arl=${this.arl}` } });
    if (!response.ok) throw new Error(`Deezer auth failed: ${response.status}`);
    const data = await response.json() as { jwt?: string };
    if (!data.jwt) throw new Error('Deezer JWT missing');
    this.jwt = data.jwt; return this.jwt;
  }
  private async gql<T>(query: string, operationName: string, variables: Record<string, unknown>): Promise<T> {
    const jwt = await this.auth();
    const data = await fetchJson<any>(GQL, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, operationName, variables }) });
    if (data.errors?.length) throw new Error(data.errors[0].message);
    return data.data as T;
  }
  async getMe() { return this.gql<{ me: { id: string } }>('query GetMe { me { id } }', 'GetMe', {}).then((x) => x.me); }
  async search(track: Track): Promise<Match | null> {
    const url = `${API}/search?${new URLSearchParams({ q: searchQuery(track.name, track.artist), limit: '5' })}`;
    const data = await retry(async () => fetchJson<{ data: Array<{ id: number; title: string; duration: number; artist: { name: string } }> }>(url));
    return matchCandidates(track.name, track.artist, track.durationMs, data.data.map((x) => ({ id: String(x.id), title: x.title, artist: x.artist.name, duration: x.duration })));
  }
  async createPlaylist(title: string) { const x = await this.gql<{ createPlaylist: { playlist: { id: string } } }>('mutation CreatePlaylist($title:String!,$isPrivate:Boolean!,$isCollaborative:Boolean!){createPlaylist(title:$title,isPrivate:$isPrivate,isCollaborative:$isCollaborative){playlist{id}}}', 'CreatePlaylist', { title, isPrivate: true, isCollaborative: false }); return x.createPlaylist.playlist.id; }
  async addTracks(id: string, trackIds: string[]) { await this.gql('mutation AddTracksToPlaylist($playlistId:ID!,$trackIds:[ID!]!){addTracksToPlaylist(playlistId:$playlistId,trackIds:$trackIds){... on PlaylistAddTracksOutput{addedTrackIds}}}', 'AddTracksToPlaylist', { playlistId: id, trackIds }); }
}
