import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Converter } from '../src/converter.js';
import { DeezerClient } from '../src/deezer.js';
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

describe('Converter', () => {
  beforeEach(() => { vi.stubGlobal('setTimeout', setTimeout); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('matches tracks and writes a report without creating playlists on dry-run', async () => {
    mockFetch((url) => {
      if (url.includes('api-partner.spotify.com')) return pathfinderResponse([pathfinderItem('Song One', 'Artist One', 240000)]);
      if (url.includes('api.deezer.com')) return { data: [{ id: 42, title: 'Song One', artist: { name: 'Artist One' }, duration: 240 }] };
      return {};
    });
    const converter = new Converter(deezerFixture(), 'token', 'report.csv');
    const result = await converter.matchPlaylist(samplePlaylist, true);
    expect(result.matchedIds).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
    expect(converter.rows).toHaveLength(1);
    expect(converter.rows[0].matched).toBe(true);
    expect(converter.rows[0].deezer_id).toBe('42');
    expect(converter.rows[0].method).toBe('exact');
    expect(converter.rows[0].note).toBe('dry-run');
  });

  it('records a failed read and does not throw when playlist read fails', async () => {
    mockFetch((url) => {
      if (url.includes('api-partner.spotify.com')) throw new Error('network down');
      return {};
    });
    const converter = new Converter(deezerFixture(), 'token', 'report.csv');
    const result = await converter.matchPlaylist(samplePlaylist, false);
    expect(result.matchedIds).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(converter.rows[0].note).toContain('failed to read playlist');
  });
});

describe('truncation parity', () => {
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
    const converter = new Converter(deezerFixture(), 'token', 'report.csv');
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
    const converter = new Converter(deezerFixture(), 'token', 'report.csv');
    const result = await converter.matchPlaylist(samplePlaylist, false);
    expect(result.matchedIds).toHaveLength(0);
    const createSpy = vi.spyOn(converter['deezer'] as unknown as { createPlaylist: () => Promise<string> }, 'createPlaylist').mockResolvedValue('plx-id');
    await converter.writePlaylist(samplePlaylist.name, result.matchedIds);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('writeToExisting dedupe', () => {
  it('adds only tracks not already in the target playlist', async () => {
    const converter = new Converter(deezerFixture(), 'token', 'report.csv');
    const existing = new Set(['111', '222']);
    const getIdsSpy = vi.spyOn(converter['deezer'] as unknown as { getPlaylistTrackIds: (id: string) => Promise<Set<string>> }, 'getPlaylistTrackIds').mockResolvedValue(existing);
    const addSpy = vi.spyOn(converter['deezer'] as unknown as { addTracks: (id: string, ids: string[]) => Promise<number> }, 'addTracks').mockResolvedValue(2);
    vi.spyOn(converter['deezer'] as unknown as { getPlaylistTrackOrder: (id: string) => Promise<string[]> }, 'getPlaylistTrackOrder').mockResolvedValue(['333', '444']);
    vi.spyOn(converter['deezer'] as unknown as { moveTrack: (id: string, trackId: string, after: string | null) => Promise<void> }, 'moveTrack').mockResolvedValue(undefined);
    await converter.writeToExisting('Test', 'target-id', ['111', '222', '333', '444']);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith('target-id', ['333', '444']);
    expect(getIdsSpy).toHaveBeenCalledWith('target-id');
  });
  it('dedupes duplicates within the batch', async () => {
    const converter = new Converter(deezerFixture(), 'token', 'report.csv');
    vi.spyOn(converter['deezer'] as unknown as { getPlaylistTrackIds: (id: string) => Promise<Set<string>> }, 'getPlaylistTrackIds').mockResolvedValue(new Set());
    const addSpy = vi.spyOn(converter['deezer'] as unknown as { addTracks: (id: string, ids: string[]) => Promise<number> }, 'addTracks').mockResolvedValue(2);
    vi.spyOn(converter['deezer'] as unknown as { getPlaylistTrackOrder: (id: string) => Promise<string[]> }, 'getPlaylistTrackOrder').mockResolvedValue(['111', '222', '333']);
    await converter.writeToExisting('Test', 'target-id', ['111', '111', '222', '222', '333']);
    expect(addSpy).toHaveBeenCalledWith('target-id', ['111', '222', '333']);
  });
});

describe('reorderToMatch', () => {
  it('moves tracks into source order', async () => {
    const converter = new Converter(deezerFixture(), 'token', 'report.csv');
    vi.spyOn(converter['deezer'] as unknown as { getPlaylistTrackOrder: (id: string) => Promise<string[]> }, 'getPlaylistTrackOrder').mockResolvedValue(['C', 'A', 'B']);
    const moveSpy = vi.spyOn(converter['deezer'] as unknown as { moveTrack: (id: string, trackId: string, after: string | null) => Promise<void> }, 'moveTrack').mockResolvedValue(undefined);
    await converter.reorderToMatch('Test', 'target-id', ['A', 'B', 'C']);
    // A to front (after null), B after A, C after B
    expect(moveSpy).toHaveBeenNthCalledWith(1, 'target-id', 'A', null);
    expect(moveSpy).toHaveBeenNthCalledWith(2, 'target-id', 'B', 'A');
    expect(moveSpy).toHaveBeenNthCalledWith(3, 'target-id', 'C', 'B');
  });
  it('skips reorder when already in order', async () => {
    const converter = new Converter(deezerFixture(), 'token', 'report.csv');
    vi.spyOn(converter['deezer'] as unknown as { getPlaylistTrackOrder: (id: string) => Promise<string[]> }, 'getPlaylistTrackOrder').mockResolvedValue(['A', 'B', 'C']);
    const moveSpy = vi.spyOn(converter['deezer'] as unknown as { moveTrack: (id: string, trackId: string, after: string | null) => Promise<void> }, 'moveTrack').mockResolvedValue(undefined);
    await converter.reorderToMatch('Test', 'target-id', ['A', 'B', 'C']);
    expect(moveSpy).not.toHaveBeenCalled();
  });
});

describe('CSV quoting', () => {
  it('quotes fields containing commas and quotes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plx-'));
    const path = join(dir, 'out.csv');
    await writeCsv(path, [{ playlist: 'A, B', title: 'Song "X"', artist: 'Artist', isrc: null, matched: true, deezer_id: '123', method: 'exact', note: 'ok' }]);
    const content = await readFile(path, 'utf8');
    expect(content).toContain('"A, B"');
    expect(content).toContain('"Song ""X"""');
    expect(content).toContain(',123,exact,ok');
  });
});
