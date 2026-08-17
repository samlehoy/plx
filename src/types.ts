export type Track = { name: string; artist: string; durationMs?: number | null };
export type Candidate = { id: string; title: string; artist: string; duration?: number | null };
export type Match = { id: string; title: string; artist: string; method: MatchMethod };
// The tier that accepted a match. Open by design: a provider may produce a tier no other provider
// can, and 'video' is the first — YouTube Music's music-video fallback (ADR 0003). Widening this is
// how a new provider adds a tier; it is not a closed enum every provider must share.
export type MatchMethod = 'exact' | 'fuzzy-duration' | 'fuzzy-title' | 'video';
export type PlaylistRef = { name: string; uri: string };
export type ReportRow = { playlist: string; source?: string; target?: string; title: string; artist: string; isrc: string | null; matched: boolean; target_id?: string | null; method?: string | null; note?: string | null };
export type MatchResult = { matchedIds: string[]; total: number; truncated: boolean };

// A music service plx can both read playlists from and write playlists to. Every provider is a
// peer — any can be a conversion's source and any can be its target. Optional members are
// capabilities: a conversion whose target lacks one degrades quietly rather than failing (ADR 0002).
export type Provider = {
  readonly name: string;
  // `skipped` is for entries the provider read but deliberately refused to convert — a YouTube Music
  // music video, whose stated artist is the uploading channel. They are reported as their own kind
  // of row, distinct from a track that was searched for and not found.
  readPlaylist(playlistId: string): Promise<{ tracks: Track[]; truncated: boolean; skipped?: Array<{ name: string; artist: string }> }>;
  search(track: Track): Promise<Match | null>;
  createPlaylist(title: string): Promise<string>;
  addTracks(playlistId: string, trackIds: string[]): Promise<number>;
  getPlaylistTrackIds(playlistId: string): Promise<Set<string>>;
  listPlaylists(): Promise<{ id: string; title: string }[]>;
  // Optional. Resolve a playlist's display name from its id, where the provider can do so.
  playlistName?(playlistId: string): Promise<string>;
  // Optional. Reorder the playlist to `trackIds`, keyed on track id — a provider whose native
  // reorder uses an opaque per-item handle looks that up internally. Resolves true if it moved anything.
  reorder?(playlistId: string, trackIds: string[]): Promise<boolean>;
  // Optional. Re-read a track by identifier, so a match can be verified before it is trusted.
  resolveTrack?(trackId: string): Promise<Track>;
};
