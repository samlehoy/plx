import type { Candidate, Match, Track } from './types.js';

export function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[\[(]\s*(feat\.?|ft\.?)\s*/gi, '').replace(/\]/g, '').replace(/[^\p{L}\p{N}_\s]/gu, '').replace(/\s+/g, ' ').trim();
}
export function firstArtist(artist: string): string { return artist.split(',')[0].trim(); }
function artistKey(artist: string): string { return normalize(artist).replace(/\s+/g, ''); }
export function stripFeat(title: string): string { return title.replace(/\s*[([]\s*(feat|ft)\.?[^)\]]*[)\]]/gi, '').trim(); }
export function matchDurationMs(spotifyMs: number | null | undefined, deezerSec: number | null | undefined, toleranceMs = 3000): boolean { return spotifyMs == null || deezerSec == null || Math.abs(spotifyMs - deezerSec * 1000) <= toleranceMs; }
export function searchQuery(title: string, artist: string): string { return `${firstArtist(artist)} ${stripFeat(title)}`.trim(); }
export function matchCandidates(title: string, artist: string, durationMs: number | null | undefined, candidates: Candidate[]): Match | null {
  const nt = normalize(stripFeat(title)); const na = artistKey(firstArtist(artist));
  for (const c of candidates) if (nt === normalize(c.title) && na === artistKey(c.artist) && matchDurationMs(durationMs, c.duration)) return { id: c.id, title: c.title, artist: c.artist, method: 'exact' };
  for (const c of candidates) if (nt === normalize(c.title) && na === artistKey(c.artist)) return { id: c.id, title: c.title, artist: c.artist, method: 'fuzzy-duration' };
  for (const c of candidates) { const ct = normalize(c.title); if (na === artistKey(c.artist) && nt && ct && (nt.includes(ct) || ct.includes(nt))) return { id: c.id, title: c.title, artist: c.artist, method: 'fuzzy-title' }; }
  return null;
}
export function matchTrack(track: Track, candidates: Candidate[]): Match | null { return matchCandidates(track.name, track.artist, track.durationMs, candidates); }
