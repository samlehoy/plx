import type { DeezerClient } from './deezer.js';
import { addTracks, createPlaylist, fetchTrackUris, resolveTrackMeta, searchTrack } from './spotify.js';
import { matchCandidates, searchQuery } from './matcher.js';
import { writeCsv } from './csv.js';
import type { ReportRow } from './types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ReverseMatch = { rows: ReportRow[]; matchedUris: string[]; total: number };

// Match a Deezer playlist's tracks to Spotify track URIs, then resolve each matched
// URI back to its real Spotify metadata and compare to the source. `verified` counts
// matches whose resolved title+artist still match the source (precision); a matched
// URI whose metadata diverges is flagged `note: '⚠️ cek ulang (mungkin salah track)'`.
export async function reverseMatch(deezer: DeezerClient, token: string, sourceId: string, sourceName: string): Promise<ReverseMatch> {
  const tracks = await deezer.getPlaylistTracks(sourceId);
  const rows: ReportRow[] = [];
  const matchedUris: string[] = [];
  let verified = 0;
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i];
    let match: { id: string; method: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const candidates = await searchTrack(searchQuery(track.name, track.artist), token);
        match = matchCandidates(track.name, track.artist, track.durationMs, candidates);
        break;
      } catch (error) {
        if (attempt === 2) console.log(`  ⚠️ search gagal: ${error instanceof Error ? error.name : 'Error'}`);
        else await sleep(2 ** attempt * 1000);
      }
    }
    if (match) {
      let note: string | null = null;
      try {
        const meta = await resolveTrackMeta(match.id);
        if (matchCandidates(track.name, track.artist, track.durationMs, [{ id: match.id, title: meta.name, artist: meta.artist, duration: meta.durationMs != null ? Math.round(meta.durationMs / 1000) : null }])) verified += 1;
        else note = '⚠️ cek ulang (mungkin salah track)';
      } catch {
        note = '⚠️ verifikasi gagal';
      }
      matchedUris.push(match.id);
      rows.push({ playlist: sourceName, title: track.name, artist: track.artist, isrc: null, matched: true, deezer_id: match.id, method: match.method, note });
      console.log(`  [${i + 1}/${tracks.length}] ✓ ${match.method} — ${track.name} — ${track.artist}${note ? ` — ${note}` : ''}`);
    } else {
      rows.push({ playlist: sourceName, title: track.name, artist: track.artist, isrc: null, matched: false, note: 'tidak ketemu' });
      console.log(`  [${i + 1}/${tracks.length}] ✗ tidak ditemukan — ${track.name} — ${track.artist}`);
    }
    await sleep(300);
  }
  const missed = tracks.length - matchedUris.length;
  console.log(`[${sourceName}] ${matchedUris.length}/${tracks.length} cocok (${verified} terverifikasi${missed ? `, ${missed} gagal match` : ''}).`);
  return { rows, matchedUris, total: tracks.length };
}

// Deezer playlist (source) → new Spotify playlist (target).
export async function reverseConvert(deezer: DeezerClient, token: string, sourceId: string, sourceName: string, output: string): Promise<void> {
  const { rows, matchedUris } = await reverseMatch(deezer, token, sourceId, sourceName);
  if (matchedUris.length) {
    const uri = await createPlaylist(`[plx] ${sourceName}`, token);
    for (let start = 0; start < matchedUris.length; start += 100) { await addTracks(uri, matchedUris.slice(start, start + 100), token); await sleep(200); }
    console.log(`[${sourceName}] playlist Spotify dibuat: ${uri} (${matchedUris.length} lagu)`);
  }
  await writeCsv(output, rows);
}

// Deezer playlist (source) → an existing Spotify playlist (target). Dedupe + append (no reorder — Spotify has no move primitive in scope).
export async function reverseWriteToExisting(deezer: DeezerClient, token: string, sourceId: string, sourceName: string, targetUri: string, output: string): Promise<void> {
  const { rows, matchedUris } = await reverseMatch(deezer, token, sourceId, sourceName);
  if (!matchedUris.length) { await writeCsv(output, rows); return; }
  const targetId = targetUri.split(':').pop() ?? targetUri;
  const existing = new Set(await fetchTrackUris(targetId, token));
  const toAdd = [...new Set(matchedUris)].filter((u) => !existing.has(u));
  if (toAdd.length) {
    for (let start = 0; start < toAdd.length; start += 100) { await addTracks(targetUri, toAdd.slice(start, start + 100), token); await sleep(200); }
  }
  console.log(`[${sourceName}] ${toAdd.length} lagu baru ditambahkan (${matchedUris.length - toAdd.length} sudah ada, dilewati).`);
  await writeCsv(output, rows);
}
