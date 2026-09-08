import type { Candidate, Match } from './types.js';

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

// A recording that is a *version* of the source rather than the source itself. Tested against the
// raw title, not the normalized one: normalize() strips parenthesised text, which is exactly where
// the marker lives ("estrangement(Instrumental)" and "estrangement" normalize to the same string).
const VERSION_MARKER = /instrumental|karaoke|off ?vocal|acoustic|remix|live|cover|伴奏/i;

function artistOverlaps(a: string, b: string): boolean { return Boolean(a && b) && (a.includes(b) || b.includes(a)); }

// Last-resort tier: the title is not compared at all. A catalog often carries a track under a
// translated title — Deezer lists 红线 as "RED LINE", 愛你但說不出口 as "Hard to say" — so a search
// built from the source title returns the right recording under a name that can never string-match.
//
// With the title gone, duration is the only real guard, so it tightens to 2s and a candidate
// without one is rejected. Artist equality relaxes to containment (Spotify's "LBI利比" is Deezer's
// "LBI"), and the guard that carries the weight is uniqueness: exactly one surviving candidate, or
// no match. Version-marked candidates drop out first, unless the source is itself a version.
//
// Only ever call this on relevance-ranked search results. Run over a whole artist catalog it will
// happily pair a source track with whatever unrelated release happens to share its length.
export function matchByDuration(title: string, artist: string, durationMs: number | null | undefined, candidates: Candidate[]): Match | null {
  if (durationMs == null) return null;
  const na = artistKey(firstArtist(artist));
  if (!na) return null;
  const sourceIsVersion = VERSION_MARKER.test(title);
  const seen = new Set<string>();
  const hits = candidates.filter((c) => {
    if (seen.has(c.id)) return false; // the same recording found by two queries is still one candidate
    if (c.duration == null || !matchDurationMs(durationMs, c.duration, 2000)) return false;
    if (!artistOverlaps(na, artistKey(c.artist))) return false;
    if (!sourceIsVersion && VERSION_MARKER.test(c.title)) return false;
    seen.add(c.id);
    return true;
  });
  // ponytail: two ids for the same recording (single + album release) read as ambiguous and are
  // rejected. Collapse on normalized title if that turns out to cost real matches.
  if (hits.length !== 1) return null;
  const [c] = hits;
  return { id: c.id, title: c.title, artist: c.artist, method: 'duration-only' };
}

// Match rules for a music video, used only after the catalog has produced nothing.
//
// A music video's stated artist is usually the uploading channel, so the artist rule relaxes from
// equality to containment: the source artist must appear somewhere in the video's title or channel
// name. That is a much weaker guard, so in exchange the duration tolerance becomes **mandatory**
// rather than optional — a candidate with no duration is rejected outright. Duration is what
// separates the same recording uploaded as a video from someone else's cover of it.
export function matchVideoCandidates(title: string, artist: string, durationMs: number | null | undefined, candidates: Candidate[]): Match | null {
  if (durationMs == null) return null; // nothing left to guard with
  const nt = normalize(stripFeat(title));
  const na = artistKey(firstArtist(artist));
  if (!nt || !na) return null;
  for (const c of candidates) {
    if (c.duration == null || !matchDurationMs(durationMs, c.duration)) continue;
    const ct = normalize(c.title);
    // The source artist has to show up somewhere attributable — the video's title or its channel.
    if (!artistKey(c.title).includes(na) && !artistKey(c.artist).includes(na)) continue;
    if (!ct.includes(nt) && !nt.includes(ct)) continue;
    return { id: c.id, title: c.title, artist: c.artist, method: 'video' };
  }
  return null;
}
