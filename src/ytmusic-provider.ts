import { matchCandidates, matchVideoCandidates, searchQuery } from './matcher.js';
import { innertube, isMix, parsePlaylistRef } from './ytmusic.js';
import { continuationToken, parseItems, playlistTitle, toCandidate, type YtItem } from './ytmusic-parse.js';
import type { Match, Provider, Track } from './types.js';

// Search filter params, as the web client sends them: catalog songs, and music videos.
const SONGS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
const VIDEOS = 'EgWKAQIQAWoKEAkQBRAKEAMQBA%3D%3D';

const secToMs = (s: number | null | undefined) => (s == null ? null : s * 1000);

export class YtMusicProvider implements Provider {
  readonly name = 'YouTube Music';
  constructor(private readonly cookie: string) {}

  private call<T>(path: string, body: Record<string, unknown>): Promise<T> { return innertube<T>(path, this.cookie, body); }

  // Every page of a playlist, following continuations.
  private async browseAll(playlistId: string): Promise<{ pages: unknown[]; items: YtItem[] }> {
    const pages: unknown[] = [];
    const items: YtItem[] = [];
    let token: string | null = null;
    for (;;) {
      const page: unknown = token
        ? await this.call('browse', { continuation: token })
        : await this.call('browse', { browseId: `VL${parsePlaylistRef(playlistId)}` });
      pages.push(page);
      items.push(...parseItems(page));
      token = continuationToken(page);
      if (!token) return { pages, items };
    }
  }

  // Music videos are read but not converted: their stated artist is the uploading channel, so
  // matching on it produces confident wrong answers. They come back as `skipped` so the report can
  // show them as their own kind of row rather than silently dropping them.
  async readPlaylist(playlistId: string): Promise<{ tracks: Track[]; truncated: boolean; skipped: Array<{ name: string; artist: string }> }> {
    if (isMix(playlistId)) {
      throw new Error('That is a mix, not a playlist. A mix is generated fresh every time it is opened, so it has no fixed contents to convert — open the playlist you want and use its link.');
    }
    const { items } = await this.browseAll(playlistId);
    return {
      tracks: items.filter((i) => i.isSong).map((i) => ({ name: i.title, artist: i.artist, durationMs: secToMs(i.durationSec) })),
      truncated: false,
      skipped: items.filter((i) => !i.isSong).map((i) => ({ name: i.title, artist: i.artist })),
    };
  }

  async playlistName(playlistId: string): Promise<string> {
    if (isMix(playlistId)) return parsePlaylistRef(playlistId);
    const page = await this.call<unknown>('browse', { browseId: `VL${parsePlaylistRef(playlistId)}` });
    return playlistTitle(page) || parsePlaylistRef(playlistId);
  }

  private async searchItems(track: Track, params: string): Promise<YtItem[]> {
    const response = await this.call<unknown>('search', { query: searchQuery(track.name, track.artist), params });
    return parseItems(response);
  }

  // Catalog songs first. Only when nothing in the catalog matches does a music video get a look, and
  // then under stricter rules — see matchVideoCandidates (ADR 0003: the provider owns the search
  // strategy, the matcher owns the rules).
  async search(track: Track): Promise<Match | null> {
    const songs = await this.searchItems(track, SONGS);
    const song = matchCandidates(track.name, track.artist, track.durationMs, songs.filter((i) => i.isSong).map(toCandidate));
    if (song) return song;

    const videos = await this.searchItems(track, VIDEOS);
    return matchVideoCandidates(track.name, track.artist, track.durationMs, videos.map(toCandidate));
  }

  async createPlaylist(title: string): Promise<string> {
    const response = await this.call<{ playlistId?: string }>('playlist/create', { title, description: '', privacyStatus: 'PRIVATE' });
    if (!response.playlistId) throw new Error('YouTube Music did not return a playlist id');
    return response.playlistId;
  }

  // Not part of the Provider interface — plx never deletes a user's playlist during a conversion.
  // It exists so a live write can be undone, which is the only way to exercise the write path
  // against the real service without leaving litter behind.
  async deletePlaylist(playlistId: string): Promise<void> {
    await this.call('playlist/delete', { playlistId: parsePlaylistRef(playlistId) });
  }

  async addTracks(playlistId: string, videoIds: string[]): Promise<number> {
    const response = await this.call<{ status?: string }>('browse/edit_playlist', {
      playlistId: parsePlaylistRef(playlistId),
      actions: videoIds.map((videoId) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId })),
    });
    if (response.status && response.status !== 'STATUS_SUCCEEDED') throw new Error(`YouTube Music refused the add (${response.status})`);
    return videoIds.length;
  }

  async getPlaylistTrackIds(playlistId: string): Promise<Set<string>> {
    const { items } = await this.browseAll(playlistId);
    return new Set(items.map((i) => i.videoId));
  }

  async listPlaylists(): Promise<{ id: string; title: string }[]> {
    const response = await this.call<unknown>('browse', { browseId: 'FEmusic_liked_playlists' });
    const found: { id: string; title: string }[] = [];
    (function walk(node: unknown) {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const row = record.musicTwoRowItemRenderer as { navigationEndpoint?: { browseEndpoint?: { browseId?: string } }; title?: { runs?: Array<{ text?: string }> } } | undefined;
      const browseId = row?.navigationEndpoint?.browseEndpoint?.browseId;
      const title = row?.title?.runs?.[0]?.text;
      // Anything not a playlist (an artist row, say) has no VL-prefixed browse id.
      if (browseId?.startsWith('VL') && title) found.push({ id: browseId.slice(2), title });
      for (const child of Object.values(record)) walk(child);
    })(response);
    return found;
  }

  // Verification: re-resolve a match by its own id and hand back what the service says it is.
  // `player` reports flat `videoDetails` rather than the deep renderer nesting everything else uses,
  // which makes it both cheaper and far less likely to break.
  async resolveTrack(videoId: string): Promise<Track> {
    const response = await this.call<{ videoDetails?: { title?: string; author?: string; lengthSeconds?: string } }>('player', { videoId });
    const details = response.videoDetails;
    if (!details?.title) throw new Error('YouTube Music returned nothing for that track');
    const seconds = Number(details.lengthSeconds);
    return {
      name: details.title,
      // A catalog track's uploader is the artist's auto-generated "<Artist> - Topic" channel.
      artist: (details.author ?? '').replace(/\s*-\s*Topic$/, ''),
      durationMs: Number.isFinite(seconds) ? seconds * 1000 : null,
    };
  }

  // Reorder capability (ADR 0002), keyed on track id. YouTube Music moves by `setVideoId`, an opaque
  // per-item handle that is *not* the track id — the same song added twice has two of them. That
  // lookup happens here, inside the provider; the handle never reaches the conversion interface.
  async reorder(playlistId: string, trackIds: string[]): Promise<boolean> {
    const desired = [...new Set(trackIds)].filter(Boolean);
    if (desired.length < 2) return false;
    const { items } = await this.browseAll(playlistId);

    const handles = new Map<string, string>();
    for (const item of items) if (item.setVideoId && !handles.has(item.videoId)) handles.set(item.videoId, item.setVideoId);
    const movable = desired.filter((id) => handles.has(id));
    const current = items.map((i) => i.videoId).filter((id) => movable.includes(id));
    if (current.length === movable.length && movable.every((id, i) => current[i] === id)) return false;

    // Walk backwards placing each track before the one that should follow it, so a single pass
    // leaves the run in source order without needing to know where anything moved to.
    for (let i = movable.length - 2; i >= 0; i -= 1) {
      await this.call('browse/edit_playlist', {
        playlistId: parsePlaylistRef(playlistId),
        actions: [{
          action: 'ACTION_MOVE_VIDEO_BEFORE',
          setVideoId: handles.get(movable[i]),
          movedSetVideoIdSuccessor: handles.get(movable[i + 1]),
        }],
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  }
}
