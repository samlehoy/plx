import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchCandidates, matchVideoCandidates } from '../src/matcher.js';
import { YtMusicProvider } from '../src/ytmusic-provider.js';
import { Conversion } from '../src/conversion.js';
import { DeezerClient } from '../src/deezer.js';

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/ytmusic', `${name}.json`), 'utf8')) as unknown;

// Stub the one fetch the provider makes, answering by InnerTube path.
function stubInnertube(handler: (path: string, body: Record<string, unknown>) => unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace('/youtubei/v1/', '');
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    const result = handler(path, body);
    return { ok: true, status: 200, text: async () => JSON.stringify(result ?? {}) };
  }));
}

const provider = () => new YtMusicProvider('SAPISID=test');

// ── The music video rule (#9), at the matcher level where match rules live (ADR 0003) ────────────
describe('the music video match rule', () => {
  const song = { title: 'Fortnight', artist: 'Taylor Swift', durationMs: 229_000 };

  it('accepts a video whose channel is the artist', () => {
    const match = matchVideoCandidates(song.title, song.artist, song.durationMs, [
      { id: 'v1', title: 'Fortnight (feat. Post Malone)', artist: 'Taylor Swift', duration: 229 },
    ]);
    expect(match).toMatchObject({ id: 'v1', method: 'video' });
  });

  // The real UGC shape: the artist is in the video's title, the channel is some uploader.
  it('accepts a video whose title contains the artist even when the channel does not', () => {
    const match = matchVideoCandidates(song.title, song.artist, song.durationMs, [
      { id: 'v2', title: 'Taylor Swift feat. Post Malone - Fortnight (Lyrics)', artist: 'TrendingTracks', duration: 229 },
    ]);
    expect(match?.id).toBe('v2');
  });

  // Duration is the only guard left once the artist rule relaxes, so it becomes mandatory.
  it('rejects a video outside the duration tolerance even when title and artist look right', () => {
    expect(matchVideoCandidates(song.title, song.artist, song.durationMs, [
      { id: 'live', title: 'Fortnight', artist: 'Taylor Swift', duration: 300 },
    ])).toBeNull();
  });

  it('rejects a video with no duration at all, rather than letting it through', () => {
    expect(matchVideoCandidates(song.title, song.artist, song.durationMs, [
      { id: 'v3', title: 'Fortnight', artist: 'Taylor Swift', duration: null },
    ])).toBeNull();
  });

  it('rejects a video by someone else entirely', () => {
    expect(matchVideoCandidates(song.title, song.artist, song.durationMs, [
      { id: 'cover', title: 'Fortnight', artist: 'Some Cover Band', duration: 229 },
    ])).toBeNull();
  });

  it('is stricter than the catalog rule, which tolerates a missing duration', () => {
    const candidates = [{ id: 'x', title: 'Fortnight', artist: 'Taylor Swift', duration: null }];
    expect(matchCandidates(song.title, song.artist, song.durationMs, candidates)).not.toBeNull();
    expect(matchVideoCandidates(song.title, song.artist, song.durationMs, candidates)).toBeNull();
  });
});

// ── Searching: catalog first, video only as a fallback (#8, #9) ──────────────────────────────────
describe('YtMusicProvider.search', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never chooses a music video when a catalog song matches', async () => {
    let videoSearched = false;
    stubInnertube((path, body) => {
      if (path !== 'search') return {};
      if (String(body.params).includes('EgWKAQIQ')) videoSearched = true;
      return fixture(String(body.params).includes('EgWKAQIQ') ? 'search-videos' : 'search-songs');
    });
    const match = await provider().search({ name: 'Fortnight', artist: 'Taylor Swift', durationMs: 229_000 });
    expect(match).toMatchObject({ id: 'eXrmLd5mer4', method: 'exact' }); // the ATV catalog track
    expect(videoSearched).toBe(false); // the catalog answered, so videos were never asked for
  });

  it('falls back to a music video when the catalog has nothing', async () => {
    stubInnertube((path, body) => {
      if (path !== 'search') return {};
      return String(body.params).includes('EgWKAQIQ') ? fixture('search-videos') : {};
    });
    const match = await provider().search({ name: 'Fortnight', artist: 'Taylor Swift', durationMs: 250_000 });
    expect(match).toMatchObject({ method: 'video' });
  });

  it('reports no match rather than substituting a video of the wrong length', async () => {
    stubInnertube((path, body) => {
      if (path !== 'search') return {};
      return String(body.params).includes('EgWKAQIQ') ? fixture('search-videos') : {};
    });
    expect(await provider().search({ name: 'Fortnight', artist: 'Taylor Swift', durationMs: 30_000 })).toBeNull();
  });
});

// ── Reading a playlist (#7) ──────────────────────────────────────────────────────────────────────
describe('YtMusicProvider.readPlaylist', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses a mix with a reason, without calling the service', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(provider().readPlaylist('RDCLAK5uy_abc')).rejects.toThrow(/mix.*no fixed contents/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('converts the catalog songs and holds the music videos back as skipped', async () => {
    stubInnertube(() => fixture('playlist-mixed-types'));
    const { tracks, skipped } = await provider().readPlaylist('PLtest');
    expect(tracks).toHaveLength(1); // only the ATV entry
    expect(skipped.length).toBeGreaterThanOrEqual(3);
    expect(skipped.every((s) => s.name)).toBe(true);
  });

  it('accepts Liked Music and album playlists as sources', async () => {
    stubInnertube(() => fixture('playlist'));
    for (const id of ['LM', 'OLAK5uy_kZm0dJmZOJ7yQxKmL5Vw2gU1TVzFvXqYs']) {
      await expect(provider().readPlaylist(id)).resolves.toMatchObject({ truncated: false });
    }
  });
});

// A skipped music video is its own kind of report row, not an unmatched track.
describe('skipped videos in the report', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('records them distinctly from tracks that were searched for and not found', async () => {
    stubInnertube(() => fixture('playlist-mixed-types'));
    const deezer = new DeezerClient('arl');
    vi.spyOn(deezer, 'search').mockResolvedValue(null); // the one real song finds no match
    const conversion = new Conversion(provider(), deezer, 'report.csv');
    await conversion.matchPlaylist({ name: 'Mixed', uri: 'PLtest' });

    const skipped = conversion.rows.filter((r) => r.note?.startsWith('skipped:'));
    const unmatched = conversion.rows.filter((r) => r.note === 'no match');
    expect(skipped.length).toBeGreaterThanOrEqual(3);
    expect(unmatched).toHaveLength(1);
    expect(skipped[0].note).toContain('music video');
    expect(conversion.rows.every((r) => r.source === 'YouTube Music' && r.target === 'Deezer')).toBe(true);
  });
});

// ── Reorder (#10) ────────────────────────────────────────────────────────────────────────────────
describe('YtMusicProvider.reorder', () => {
  afterEach(() => vi.unstubAllGlobals());

  // A playlist read shaped like the real one, with the per-item handles reorder depends on.
  const playlistOf = (entries: Array<[videoId: string, setVideoId: string]>) => ({
    contents: {
      items: entries.map(([videoId, setVideoId]) => ({
        musicResponsiveListItemRenderer: {
          flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: videoId }] } } }],
          playlistItemData: { videoId, playlistSetVideoId: setVideoId },
          overlay: { musicItemThumbnailOverlayRenderer: { content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchEndpoint: { videoId, watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' } } } } } } } },
        },
      })),
    },
  });

  it('moves tracks into source order using the per-item handle, not the track id', async () => {
    const edits: Array<Record<string, unknown>> = [];
    stubInnertube((path, body) => {
      if (path === 'browse') return playlistOf([['C', 'setC'], ['A', 'setA'], ['B', 'setB']]);
      if (path === 'browse/edit_playlist') { edits.push((body.actions as Record<string, unknown>[])[0]); return { status: 'STATUS_SUCCEEDED' }; }
      return {};
    });
    expect(await provider().reorder('PLtest', ['A', 'B', 'C'])).toBe(true);
    // Handles, never track ids, cross the wire.
    expect(edits.every((e) => String(e.setVideoId).startsWith('set'))).toBe(true);
    expect(edits.map((e) => [e.setVideoId, e.movedSetVideoIdSuccessor])).toEqual([['setB', 'setC'], ['setA', 'setB']]);
  });

  it('leaves a target that is already in order alone', async () => {
    let edited = false;
    stubInnertube((path) => {
      if (path === 'browse') return playlistOf([['A', 'setA'], ['B', 'setB'], ['C', 'setC']]);
      if (path === 'browse/edit_playlist') { edited = true; return {}; }
      return {};
    });
    expect(await provider().reorder('PLtest', ['A', 'B', 'C'])).toBe(false);
    expect(edited).toBe(false);
  });

  it('keeps the handle out of the conversion interface', () => {
    // The capability is declared as (playlistId, trackIds) — the same shape Deezer implements.
    expect(YtMusicProvider.prototype.reorder).toHaveLength(2);
  });
});

// ── Writing (#8) ─────────────────────────────────────────────────────────────────────────────────
describe('YtMusicProvider writes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates the playlist private', async () => {
    let sent: Record<string, unknown> | null = null;
    stubInnertube((path, body) => {
      if (path !== 'playlist/create') return {};
      sent = body;
      return { playlistId: 'PLnew' };
    });
    expect(await provider().createPlaylist('[plx] Mine')).toBe('PLnew');
    expect(sent).toMatchObject({ title: '[plx] Mine', privacyStatus: 'PRIVATE' });
  });

  it('fails loudly rather than returning a playlist id it did not get', async () => {
    stubInnertube(() => ({}));
    await expect(provider().createPlaylist('x')).rejects.toThrow(/did not return a playlist id/);
  });

  it('adds tracks as one edit action per video', async () => {
    let actions: Array<Record<string, unknown>> = [];
    stubInnertube((path, body) => {
      if (path === 'browse/edit_playlist') { actions = body.actions as Array<Record<string, unknown>>; return { status: 'STATUS_SUCCEEDED' }; }
      return {};
    });
    expect(await provider().addTracks('PLx', ['a', 'b'])).toBe(2);
    expect(actions).toEqual([
      { action: 'ACTION_ADD_VIDEO', addedVideoId: 'a' },
      { action: 'ACTION_ADD_VIDEO', addedVideoId: 'b' },
    ]);
  });

  it('throws when the service refuses the add instead of reporting success', async () => {
    stubInnertube((path) => (path === 'browse/edit_playlist' ? { status: 'STATUS_FAILED' } : {}));
    await expect(provider().addTracks('PLx', ['a'])).rejects.toThrow(/refused the add/);
  });

  // Verification reads flat videoDetails rather than the deep renderer nesting everything else uses.
  it('resolves a track for verification, dropping the "- Topic" channel suffix', async () => {
    stubInnertube((path) => (path === 'player'
      ? { videoDetails: { title: 'Fortnight', author: 'Taylor Swift - Topic', lengthSeconds: '229' } }
      : {}));
    expect(await provider().resolveTrack('abc')).toEqual({ name: 'Fortnight', artist: 'Taylor Swift', durationMs: 229_000 });
  });

  it('reports an unresolvable track rather than inventing metadata', async () => {
    stubInnertube(() => ({}));
    await expect(provider().resolveTrack('gone')).rejects.toThrow(/returned nothing/);
  });
});
