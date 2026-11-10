import type { Candidate, Match } from './types.js';

export function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[\[(]\s*(feat\.?|ft\.?)\s*/gi, '').replace(/\]/g, '').replace(/[^\p{L}\p{N}_\s]/gu, '').replace(/\s+/g, ' ').trim();
}
export function firstArtist(artist: string): string { return artist.split(',')[0].trim(); }
// The artist a comparison keys on. YouTube Music credits co-artists as one string — "ROSÉ & Bruno
// Mars" — where Spotify names ROSÉ alone, so this splits on " & " as well as ",". Both sides of a
// comparison split alike, which keeps a duo's own name ("Chase & Status") equal to itself. Search
// terms keep the whole credit (firstArtist): free text finds a duo by its full name.
function leadArtist(artist: string): string { return artist.split(/,|\s&\s/)[0].trim(); }
function artistKey(artist: string): string { return normalize(artist).replace(/\s+/g, ''); }
export function stripFeat(title: string): string { return title.replace(/\s*[([]\s*(feat|ft)\.?[^)\]]*[)\]]/gi, '').trim(); }
// A title with its bracketed tags kept as words. normalize() drops "(Eng Ver.)" outright, while a
// catalog writing the same tag as a suffix — "Algorithm - Eng Ver." — keeps it, so on normalize()
// alone it is the untagged original that compares equal.
function taggedTitle(title: string): string { return normalize(stripFeat(title).replace(/[()[\]]/g, ' ')); }
export function matchDurationMs(spotifyMs: number | null | undefined, deezerSec: number | null | undefined, toleranceMs = 3000): boolean { return spotifyMs == null || deezerSec == null || Math.abs(spotifyMs - deezerSec * 1000) <= toleranceMs; }
export function searchQuery(title: string, artist: string): string { return `${firstArtist(artist)} ${stripFeat(title)}`.trim(); }
// The field-syntax retry Deezer and Spotify send after free text misses. Double quotes would end the
// quoted field early, so they are dropped; with no artist there is nothing to pin, so no artist field.
export function fieldQuery(title: string, artist: string): string {
  const clean = (v: string) => v.replace(/"/g, '').trim();
  const a = clean(firstArtist(artist));
  return `track:"${clean(stripFeat(title))}"${a ? ` artist:"${a}"` : ''}`;
}
export function matchCandidates(title: string, artist: string, durationMs: number | null | undefined, candidates: Candidate[]): Match | null {
  const nt = normalize(stripFeat(title)); const tt = taggedTitle(title); const na = artistKey(leadArtist(artist));
  const sameArtist = (c: Candidate) => na === artistKey(leadArtist(c.artist));
  // The same title with its version tag intact beats one that only agrees once tags are dropped.
  for (const c of candidates) if (tt === taggedTitle(c.title) && sameArtist(c) && matchDurationMs(durationMs, c.duration)) return { id: c.id, title: c.title, artist: c.artist, method: 'exact' };
  for (const c of candidates) if (nt === normalize(c.title) && sameArtist(c) && matchDurationMs(durationMs, c.duration)) return { id: c.id, title: c.title, artist: c.artist, method: 'exact' };
  for (const c of candidates) if (nt === normalize(c.title) && sameArtist(c)) return { id: c.id, title: c.title, artist: c.artist, method: 'fuzzy-duration' };
  for (const c of candidates) { const ct = normalize(c.title); if (sameArtist(c) && nt && ct && (nt.includes(ct) || ct.includes(nt))) return { id: c.id, title: c.title, artist: c.artist, method: 'fuzzy-title' }; }
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

// Last-resort tier, the mirror of matchByDuration: the artist is not compared. It exists for one case
// — a catalog crediting the artist in another script, YouTube Music's 지효 for Spotify's JIHYO — so it
// applies only when the two artist names are in different scripts; two Latin names that differ are
// two artists, and "Intro" by A is not "Intro" by B.
//
// The title must be equal with its tags intact (never merely contained), the duration tightens to 2s
// and is mandatory, and the survivors must all be one artist: a single and its album release are two
// ids for one recording, but a title two artists share at the same length is refused.
const latinOnly = (s: string) => !/[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u.test(s);
export function matchByTitle(title: string, artist: string, durationMs: number | null | undefined, candidates: Candidate[]): Match | null {
  if (durationMs == null) return null;
  const tt = taggedTitle(title);
  const lead = leadArtist(artist);
  if (!tt || !lead) return null;
  const hits = candidates.filter((c) => c.duration != null && matchDurationMs(durationMs, c.duration, 2000)
    && taggedTitle(c.title) === tt && latinOnly(lead) !== latinOnly(leadArtist(c.artist)));
  if (!hits.length || new Set(hits.map((c) => artistKey(leadArtist(c.artist)))).size !== 1) return null;
  const [c] = hits;
  return { id: c.id, title: c.title, artist: c.artist, method: 'title-only' };
}

// The catalog song a music video carries. A video's own metadata is the uploader's: a channel where
// the artist belongs, a title dressed as "XG - MILLION PLACES (Official Music Video)" or "APT. - ROSÉ
// & Bruno Mars | Cover by TsunamiCat and Dangle". So it converts as the song it spells out: one whose
// title — or the other-language name it carries in brackets, 라비앙로즈 (La Vie en Rose) — appears in
// the video title as whole words, by a lead artist the video title or channel names. Tags count as
// words, so "NOT CUTE ANYMORE (Sped up)" is not what a video titled "NOT CUTE ANYMORE" carries.
// Duration is no guard here: an official video runs long (an intro, a dance break) and a re-upload
// is often trimmed. First such song, in search order.
// A bracket that names a version or a guest rather than the song itself: never an alternate name.
const TAG = /\bw\/|\b(feat|ft|prod|sped|slowed|speed|remix|mix|live|ver|version|inst|instrumental|acoustic|karaoke|cover|edit|remaster(ed)?|demo|english|korean|japanese|chinese)\b/i;
// Whether `name` is named in `text` as whole words, spaces aside: "Bruno Mars" in "ROSÉ & Bruno Mars",
// "BLACKPINK" in "BLACK PINK" — but not "V" inside "Love" or "IVE" inside "Live".
function namesArtist(text: string, name: string): boolean {
  const key = artistKey(name);
  const words = normalize(text.replace(/[()[\]]/g, ' ')).split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    let joined = '';
    for (let j = i; j < words.length && joined.length < key.length; j += 1) joined += words[j];
    if (joined === key) return true;
  }
  return false;
}
export function songForVideo(videoTitle: string, channel: string, songs: Candidate[]): Candidate | null {
  const words = ` ${taggedTitle(videoTitle)} `;
  const spelled = (title: string) => { const t = taggedTitle(title); return t !== '' && words.includes(` ${t} `); };
  return songs.find((s) => {
    const aliases = [...s.title.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => !TAG.test(a));
    const lead = leadArtist(s.artist);
    return [s.title, ...aliases].some(spelled) && lead !== '' && namesArtist(`${videoTitle} ${channel}`, lead);
  }) ?? null;
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
