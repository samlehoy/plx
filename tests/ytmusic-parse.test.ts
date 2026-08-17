import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { continuationToken, parseDuration, parseItems, playlistTitle } from '../src/ytmusic-parse.js';
import { isMix, parsePlaylistRef } from '../src/ytmusic.js';

// Every fixture here was recorded from the live service and trimmed by hand to the paths the parser
// reads. Hand-written literals are rejected for this provider: the renderer nesting is ~6 levels
// deep, so a literal written from assumption pins the assumption and stays green while production
// goes red. A failure here should mean YouTube Music changed.
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/ytmusic', `${name}.json`), 'utf8')) as unknown;

describe('parseDuration', () => {
  it('reads the durations the service actually prints', () => {
    expect(parseDuration('2:40')).toBe(160);
    expect(parseDuration('3:49')).toBe(229);
    expect(parseDuration('1:02:03')).toBe(3723);
  });
  it('returns nothing for text that is not a duration', () => {
    expect(parseDuration('313M plays')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('a recorded playlist read', () => {
  const response = fixture('playlist');

  it('takes the playlist title from the microformat block', () => {
    expect(playlistTitle(response)).toBe('My Hanni');
  });

  it('reads title, artist, duration and ids off each entry', () => {
    const items = parseItems(response);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ title: 'Rising', artist: 'tripleS', durationSec: 160, videoId: 'ZftSRpQFTew', isSong: true });
    // The per-item reorder handle, which is not the track id.
    expect(items[0].setVideoId).toBeTruthy();
    expect(items[0].setVideoId).not.toBe(items[0].videoId);
  });

  it('gives every entry a duration', () => {
    expect(parseItems(response).every((i) => i.durationSec != null)).toBe(true);
  });
});

// One real entry of each type the service returned for a mixed playlist.
describe('a recorded playlist of mixed entry types', () => {
  const items = parseItems(fixture('playlist-mixed-types'));

  it('counts only a catalog release as a song', () => {
    // ATV is the catalog track. UGC, OMV, official-source, and an entry with no type at all are
    // videos or unavailable — their stated artist is the uploading channel, not the performer.
    expect(items.filter((i) => i.isSong)).toHaveLength(1);
    expect(items.filter((i) => !i.isSong).length).toBeGreaterThanOrEqual(3);
  });

  it('still parses the videos it will not convert, so they can be reported', () => {
    for (const item of items) {
      expect(item.videoId).toBeTruthy();
      expect(item.title).toBeTruthy();
    }
  });
});

describe('a recorded song search', () => {
  const items = parseItems(fixture('search-songs'));

  it('parses the trailing duration off the subtitle line', () => {
    // "Taylor Swift • THE TORTURED POETS DEPARTMENT • 3:49" — artist first, duration last.
    expect(items[0]).toMatchObject({ title: 'Fortnight (feat. Post Malone)', artist: 'Taylor Swift', durationSec: 229 });
  });

  it('marks catalog results as songs', () => {
    expect(items.every((i) => i.isSong)).toBe(true);
  });
});

describe('a recorded video search', () => {
  const items = parseItems(fixture('search-videos'));

  it('never marks a video result as a song', () => {
    expect(items.some((i) => i.isSong)).toBe(false);
  });

  it('parses the channel as the artist and the trailing duration', () => {
    // "Taylor Swift • 178M views • 4:10" — the middle part is a view count, not an album.
    expect(items[0]).toMatchObject({ artist: 'Taylor Swift', durationSec: 250 });
  });

  it('reads a user upload whose channel is not the artist', () => {
    // The real UGC case the containment rule exists for: artist is in the title, channel is not it.
    const ugc = items.find((i) => i.artist === 'TrendingTracks');
    expect(ugc?.title).toContain('Taylor Swift');
    expect(ugc?.durationSec).toBe(229);
  });
});

describe('continuationToken', () => {
  it('returns nothing when a response has no further pages', () => {
    expect(continuationToken(fixture('search-songs'))).toBeNull();
  });
});

describe('playlist references', () => {
  it('resolves music.youtube.com and youtube.com links to the same id', () => {
    const id = 'PLk5rTSgAZ9W0GBaPy00PTTb-06YUlyHKr';
    expect(parsePlaylistRef(`https://music.youtube.com/playlist?list=${id}`)).toBe(id);
    expect(parsePlaylistRef(`https://www.youtube.com/playlist?list=${id}`)).toBe(id);
    expect(parsePlaylistRef(id)).toBe(id);
    expect(parsePlaylistRef(`VL${id}`)).toBe(id); // the browse-id form
  });

  it('refuses a mix, whatever form its id arrives in', () => {
    expect(isMix('RDCLAK5uy_kLWIr9gv1XLlPbaDS965-Db4ODFbLD0Q')).toBe(true);
    expect(isMix('https://music.youtube.com/playlist?list=RDAMVMabc123')).toBe(true);
    expect(isMix('RDEMabc')).toBe(true);
  });

  it('accepts user playlists, Liked Music, and auto-generated album playlists', () => {
    expect(isMix('PLk5rTSgAZ9W0GBaPy00PTTb-06YUlyHKr')).toBe(false); // user playlist
    expect(isMix('LM')).toBe(false); // Liked Music
    expect(isMix('OLAK5uy_kZm0dJmZOJ7yQxKmL5Vw2gU1TVzFvXqYs')).toBe(false); // album playlist
  });
});
