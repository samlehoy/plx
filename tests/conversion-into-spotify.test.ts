import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversion } from '../src/conversion.js';
import { DeezerClient } from '../src/deezer.js';
import { SpotifyProvider } from '../src/spotify.js';
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

// Deezer source → Spotify target. Same Conversion as the other direction, with the providers swapped.
describe('conversion into a Spotify target', () => {
  beforeEach(() => { vi.stubGlobal('setTimeout', (fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout; }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('matches Deezer tracks to Spotify and writes a new playlist with only matched URIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plx-'));
    const output = join(dir, 'out.csv');
    const deezer = new DeezerClient('test-arl');
    vi.spyOn(deezer, 'readPlaylist').mockResolvedValue({
      tracks: [
        { name: 'Song One', artist: 'Artist One', durationMs: 240000 },
        { name: 'Song Two', artist: 'Artist Two', durationMs: 180000 },
      ],
      truncated: false,
    });
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
    const conversion = new Conversion(deezer, new SpotifyProvider('token'), output);
    const result = await conversion.matchPlaylist({ name: 'My Playlist', uri: 'source-id' });
    await conversion.writePlaylist('My Playlist', result.matchedIds);
    await conversion.writeReport();
    expect(created).toContain('spclient.wg.spotify.com');
    expect(added).toEqual([['spotify:track:777']]);
    const csv = await readFile(output, 'utf8');
    expect(csv).toContain('My Playlist,Deezer,Spotify,Song One,Artist One,,true,spotify:track:777,exact,');
    expect(csv).toContain('My Playlist,Deezer,Spotify,Song Two,Artist Two,,false,,,no match');
  });

  // The target can resolve a track by identifier, so every match is re-resolved and re-checked
  // against the source track. Both outcomes are pinned: agreeing metadata leaves the row clean,
  // diverging metadata still writes the match but flags it.
  it.each([
    { label: 'leaves the row unflagged when the resolved track still agrees', resolved: { name: 'Song One', artists: [{ name: 'Artist One' }], duration: 240000 }, note: null },
    { label: 'flags the row when the resolved track diverges', resolved: { name: 'Some Other Song', artists: [{ name: 'Another Artist' }], duration: 120000 }, note: '⚠️ recheck (possibly wrong track)' },
  ])('$label', async ({ resolved, note }) => {
    const deezer = new DeezerClient('test-arl');
    vi.spyOn(deezer, 'readPlaylist').mockResolvedValue({
      tracks: [{ name: 'Song One', artist: 'Artist One', durationMs: 240000 }],
      truncated: false,
    });
    mockFetch((url, init) => {
      if (url.includes('pathfinder/v2/query')) {
        const body = JSON.parse(String((init as RequestInit).body)) as { operationName: string };
        if (body.operationName === 'searchTracks') return searchResponse(true);
      }
      if (url.includes('open.spotify.com/embed/track/')) {
        return `<html><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { state: { data: { entity: resolved } } } } })}</script></html>`;
      }
      return {};
    });
    const conversion = new Conversion(deezer, new SpotifyProvider('token'), 'report.csv');
    const result = await conversion.matchPlaylist({ name: 'My Playlist', uri: 'source-id' });
    expect(result.matchedIds).toEqual(['spotify:track:777']); // flagged or not, the match is still written
    expect(conversion.rows[0].note).toBe(note);
  });

  it('dedupes against existing target tracks and only adds the missing URI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plx-'));
    const output = join(dir, 'out.csv');
    const deezer = new DeezerClient('test-arl');
    vi.spyOn(deezer, 'readPlaylist').mockResolvedValue({
      tracks: [{ name: 'Song One', artist: 'Artist One', durationMs: 240000 }],
      truncated: false,
    });
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
    const conversion = new Conversion(deezer, new SpotifyProvider('token'), output);
    const result = await conversion.matchPlaylist({ name: 'My Playlist', uri: 'source-id' });
    await conversion.writeToExisting('My Playlist', 'spotify:playlist:target123', result.matchedIds);
    await conversion.writeReport();
    expect(added).toEqual([]); // already present → nothing added
  });
});
