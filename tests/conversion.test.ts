import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Conversion } from '../src/conversion.js';
import { DeezerClient } from '../src/deezer.js';
import { SpotifyProvider } from '../src/spotify.js';
import { writeCsv } from '../src/csv.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function mockFetch(handler: (url: string, init?: RequestInit) => unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const body = await handler(url, init);
    return {
      ok: status < 400,
      status,
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }));
}

function deezerFixture(): DeezerClient {
  return new DeezerClient('test-arl');
}

// Spotify source → Deezer target, the direction these cases exercise.
function conversionFixture(target: DeezerClient, output = 'report.csv'): Conversion {
  return new Conversion(new SpotifyProvider('token'), target, output);
}

const samplePlaylist = { name: 'Test Playlist', uri: 'spotify:playlist:abc123' };

const pathfinderResponse = (items: unknown[]) => ({
  data: {
    playlistV2: {
      content: { totalCount: items.length, items },
    },
  },
});

function pathfinderItem(name: string, artist: string, durationMs?: number) {
  return {
    itemV2: {
      data: {
        uri: `spotify:track:${Math.random()}`,
        name,
        artists: { items: [{ profile: { name: artist } }] },
        trackDuration: durationMs != null ? { totalMilliseconds: durationMs } : undefined,
      },
    },
  };
}

describe('Conversion', () => {
  beforeEach(() => { vi.stubGlobal('setTimeout', setTimeout); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('matches tracks and writes a report without creating playlists on dry-run', async () => {
    mockFetch((url) => {
      if (url.includes('api-partner.spotify.com')) return pathfinderResponse([pathfinderItem('Song One', 'Artist One', 240000)]);
      if (url.includes('api.deezer.com')) return { data: [{ id: 42, title: 'Song One', artist: { name: 'Artist One' }, duration: 240 }] };
      return {};
    });
    const converter = conversionFixture(deezerFixture());
    const result = await converter.matchPlaylist(samplePlaylist, true);
    expect(result.matchedIds).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
    expect(converter.rows).toHaveLength(1);
    expect(converter.rows[0].matched).toBe(true);
    expect(converter.rows[0].target_id).toBe('42');
    expect(converter.rows[0].source).toBe('Spotify');
    expect(converter.rows[0].target).toBe('Deezer');
    expect(converter.rows[0].method).toBe('exact');
    expect(converter.rows[0].note).toBe('dry-run');
  });

  it('records a failed read and does not throw when playlist read fails', async () => {
    mockFetch((url) => {
      if (url.includes('api-partner.spotify.com')) throw new Error('network down');
      return {};
    });
    const converter = conversionFixture(deezerFixture());
    const result = await converter.matchPlaylist(samplePlaylist, false);
    expect(result.matchedIds).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(converter.rows[0].note).toContain('failed to read playlist');
  });
});

describe('truncation parity', () => {
  // Unstub here or the instant-setTimeout shim below leaks into every later describe block.
  afterEach(() => { vi.unstubAllGlobals(); });

  it('records a truncation warning when embed fallback truncates at 100', async () => {
    vi.stubGlobal('setTimeout', (fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout; });
    mockFetch((url) => {
      if (url.includes('api-partner.spotify.com')) throw new Error('pathfinder down');
      if (url.includes('open.spotify.com/embed/playlist')) {
        const nextData = { props: { pageProps: { state: { data: { entity: { trackList: Array.from({ length: 100 }, (_, i) => ({ title: `T${i}`, subtitle: 'A', duration: 200 })) } } } } } };
        return `<html><script id="__NEXT_DATA__">${JSON.stringify(nextData)}</script></html>`;
      }
      if (url.includes('api.deezer.com')) return { data: [] };
      return {};
    });
    const converter = conversionFixture(deezerFixture());
    const result = await converter.matchPlaylist(samplePlaylist, false);
    expect(result.truncated).toBe(true);
    expect(converter.rows[0].note).toContain('WARNING: truncated');
  });
});

describe('no-match guard', () => {
  it('does not create a playlist when nothing matches', async () => {
    mockFetch((url) => {
      if (url.includes('api-partner.spotify.com')) return pathfinderResponse([pathfinderItem('Song One', 'Artist One', 240000)]);
      return { data: [] };
    });
    const deezer = deezerFixture();
    const converter = conversionFixture(deezer);
    const result = await converter.matchPlaylist(samplePlaylist, false);
    expect(result.matchedIds).toHaveLength(0);
    const createSpy = vi.spyOn(deezer, 'createPlaylist').mockResolvedValue('plx-id');
    await converter.writePlaylist(samplePlaylist.name, result.matchedIds);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('writeToExisting dedupe', () => {
  it('adds only tracks not already in the target playlist', async () => {
    const deezer = deezerFixture();
    const converter = conversionFixture(deezer);
    const existing = new Set(['111', '222']);
    const getIdsSpy = vi.spyOn(deezer, 'getPlaylistTrackIds').mockResolvedValue(existing);
    const addSpy = vi.spyOn(deezer, 'addTracks').mockResolvedValue(2);
    vi.spyOn(deezer, 'getPlaylistTrackOrder').mockResolvedValue(['333', '444']);
    vi.spyOn(deezer, 'moveTrack').mockResolvedValue(undefined);
    await converter.writeToExisting('Test', 'target-id', ['111', '222', '333', '444']);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith('target-id', ['333', '444']);
    expect(getIdsSpy).toHaveBeenCalledWith('target-id');
  });
  it('dedupes duplicates within the batch', async () => {
    const deezer = deezerFixture();
    const converter = conversionFixture(deezer);
    vi.spyOn(deezer, 'getPlaylistTrackIds').mockResolvedValue(new Set());
    const addSpy = vi.spyOn(deezer, 'addTracks').mockResolvedValue(2);
    vi.spyOn(deezer, 'getPlaylistTrackOrder').mockResolvedValue(['111', '222', '333']);
    await converter.writeToExisting('Test', 'target-id', ['111', '111', '222', '222', '333']);
    expect(addSpy).toHaveBeenCalledWith('target-id', ['111', '222', '333']);
  });
});

// The reorder capability lives on the provider that has it (ADR 0002), so it is exercised there.
describe('reorder', () => {
  it('moves tracks into source order', async () => {
    const deezer = deezerFixture();
    vi.spyOn(deezer, 'getPlaylistTrackOrder').mockResolvedValue(['C', 'A', 'B']);
    const moveSpy = vi.spyOn(deezer, 'moveTrack').mockResolvedValue(undefined);
    await deezer.reorder('target-id', ['A', 'B', 'C']);
    // A to front (after null), B after A, C after B
    expect(moveSpy).toHaveBeenNthCalledWith(1, 'target-id', 'A', null);
    expect(moveSpy).toHaveBeenNthCalledWith(2, 'target-id', 'B', 'A');
    expect(moveSpy).toHaveBeenNthCalledWith(3, 'target-id', 'C', 'B');
  });
  it('skips reorder when already in order', async () => {
    const deezer = deezerFixture();
    vi.spyOn(deezer, 'getPlaylistTrackOrder').mockResolvedValue(['A', 'B', 'C']);
    const moveSpy = vi.spyOn(deezer, 'moveTrack').mockResolvedValue(undefined);
    await deezer.reorder('target-id', ['A', 'B', 'C']);
    expect(moveSpy).not.toHaveBeenCalled();
  });
});

// A target with no reorder capability still completes the write by appending (ADR 0002).
describe('target without reorder', () => {
  it('completes writeToExisting by appending', async () => {
    const spotify = new SpotifyProvider('token');
    expect(spotify.reorder).toBeUndefined();
    const conversion = new Conversion(deezerFixture(), spotify, 'report.csv');
    vi.spyOn(spotify, 'getPlaylistTrackIds').mockResolvedValue(new Set(['spotify:track:111']));
    const addSpy = vi.spyOn(spotify, 'addTracks').mockResolvedValue(1);
    await conversion.writeToExisting('Test', 'spotify:playlist:target', ['spotify:track:111', 'spotify:track:222']);
    expect(addSpy).toHaveBeenCalledWith('spotify:playlist:target', ['spotify:track:222']);
  });
});

describe('CSV quoting', () => {
  it('quotes fields containing commas and quotes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plx-'));
    const path = join(dir, 'out.csv');
    await writeCsv(path, [{ playlist: 'A, B', title: 'Song "X"', artist: 'Artist', isrc: null, matched: true, target_id: '123', method: 'exact', note: 'ok', source: 'Spotify', target: 'Deezer' }]);
    const content = await readFile(path, 'utf8');
    expect(content).toContain('"A, B"');
    expect(content).toContain('"Song ""X"""');
    expect(content).toContain(',123,exact,ok');
    expect(content.split('\n')[0]).toBe('playlist,source,target,title,artist,isrc,matched,target_id,method,note');
  });
});
