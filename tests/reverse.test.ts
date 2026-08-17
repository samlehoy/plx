import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reverseConvert, reverseWriteToExisting } from '../src/reverse.js';
import { DeezerClient } from '../src/deezer.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function mockFetch(handler: (url: string, init?: RequestInit) => unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const body = await handler(url, init);
    return { ok: status < 400, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  }));
}

// pathfinder v2 search response: "Song One / Artist One" matches, "Song Two / Artist Two" absent.
function searchResponse(hasMatch: boolean) {
  return {
    data: { searchV2: { tracksV2: { items: hasMatch ? [{ item: { data: { uri: 'spotify:track:777', name: 'Song One', artists: { items: [{ profile: { name: 'Artist One' } }] }, duration: { totalMilliseconds: 240000 } } } }] : [] } } },
  };
}

describe('reverseConvert', () => {
  beforeEach(() => { vi.stubGlobal('setTimeout', (fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout; }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('matches Deezer tracks to Spotify and writes a new playlist with only matched URIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plx-'));
    const output = join(dir, 'out.csv');
    const deezer = new DeezerClient('test-arl');
    vi.spyOn(deezer, 'getPlaylistTracks').mockResolvedValue([
      { name: 'Song One', artist: 'Artist One', durationMs: 240000 },
      { name: 'Song Two', artist: 'Artist Two', durationMs: 180000 },
    ]);
    const added: string[][] = [];
    let created = '';
    mockFetch((url, init) => {
      if (url.includes('pathfinder/v2/query')) {
        const body = JSON.parse(String((init as RequestInit).body)) as { operationName: string; variables: { searchTerm: string; playlistItemUris?: string[] } };
        if (body.operationName === 'searchTracks') return searchResponse(body.variables.searchTerm.includes('Song One'));
        if (body.operationName === 'addToPlaylist') { added.push(body.variables.playlistItemUris ?? []); return { data: { addItemsToPlaylist: { __typename: 'AddItemsToPlaylistPayload' } } }; }
      }
      if (url.includes('spclient.wg.spotify.com')) { created = url; return { uri: 'spotify:playlist:newid' }; }
      return {};
    });
    await reverseConvert(deezer, 'token', 'source-id', 'My Playlist', output);
    expect(created).toContain('spclient.wg.spotify.com');
    expect(added).toEqual([['spotify:track:777']]);
    const csv = await readFile(output, 'utf8');
    expect(csv).toContain('My Playlist,Song One,Artist One,,true,spotify:track:777,exact,');
    expect(csv).toContain('My Playlist,Song Two,Artist Two,,false,,,no match');
  });

  it('dedupes against existing target tracks and only adds the missing URI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plx-'));
    const output = join(dir, 'out.csv');
    const deezer = new DeezerClient('test-arl');
    vi.spyOn(deezer, 'getPlaylistTracks').mockResolvedValue([
      { name: 'Song One', artist: 'Artist One', durationMs: 240000 },
    ]);
    const added: string[][] = [];
    mockFetch((url, init) => {
      if (url.includes('pathfinder/v2/query')) {
        const body = JSON.parse(String((init as RequestInit).body)) as { operationName: string; variables: { searchTerm?: string; playlistItemUris?: string[] } };
        if (body.operationName === 'searchTracks') return searchResponse(true);
        if (body.operationName === 'addToPlaylist') { added.push(body.variables.playlistItemUris ?? []); return { data: {} }; }
      }
      // v1 fetchPlaylist (existing track URIs): return track:777 already present.
      if (url.includes('api-partner.spotify.com')) {
        return { data: { playlistV2: { content: { totalCount: 1, items: [{ itemV2: { data: { uri: 'spotify:track:777' } } }] } } } };
      }
      return {};
    });
    await reverseWriteToExisting(deezer, 'token', 'source-id', 'My Playlist', 'spotify:playlist:target123', output);
    expect(added).toEqual([]); // already present → nothing added
  });
});
