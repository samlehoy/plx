export type Track = { name: string; artist: string; durationMs?: number | null };
export type DeezerCandidate = { id: string; title: string; artist: string; duration?: number | null };
export type Match = { id: string; title: string; artist: string; method: MatchMethod };
export type MatchMethod = 'exact' | 'fuzzy-duration' | 'fuzzy-title';
export type PlaylistRef = { name: string; uri: string };
export type ReportRow = { playlist: string; title: string; artist: string; isrc: string | null; matched: boolean; deezer_id?: string | null; method?: string | null; note?: string | null };
export type MatchResult = { matchedIds: string[]; total: number; truncated: boolean };
