import type { DeezerClient } from './deezer.js';
import { EMBED_TRACK_LIMIT, readPlaylist } from './spotify.js';
import { writeCsv } from './csv.js';
import type { MatchResult, PlaylistRef, ReportRow } from './types.js';

export class Converter {
  readonly rows: ReportRow[] = [];
  output: string;
  constructor(private readonly deezer: DeezerClient, private readonly spotifyToken: string, output: string) { this.output = output; }
  private record(row: ReportRow) { this.rows.push(row); }
  async matchPlaylist(playlist: PlaylistRef, dryRun = false): Promise<MatchResult> {
    let result;
    try { result = await readPlaylist(playlist.uri, this.spotifyToken); }
    catch (error) { this.record({ playlist: playlist.name, title: '', artist: '', isrc: null, matched: false, note: `failed to read playlist: ${error instanceof Error ? error.name : 'Error'}` }); return { matchedIds: [], total: 0, truncated: false }; }
    if (result.truncated) {
      this.record({ playlist: playlist.name, title: '', artist: '', isrc: null, matched: false, note: `WARNING: truncated at ${EMBED_TRACK_LIMIT} tracks; remainder not converted` });
      console.log(`[${playlist.name}] ⚠️ Truncated at ${EMBED_TRACK_LIMIT} tracks (embed fallback).`);
    }
    const matchedIds: string[] = [];
    for (let i = 0; i < result.tracks.length; i += 1) {
      const track = result.tracks[i];
      let match = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { match = await this.deezer.search(track); break; }
        catch (error) { if (attempt === 2) console.log(`  ⚠️ search failed: ${error instanceof Error ? error.name : 'Error'}`); else await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000)); }
      }
      if (match) { matchedIds.push(match.id); this.record({ playlist: playlist.name, title: track.name, artist: track.artist, isrc: null, matched: true, deezer_id: match.id, method: match.method, note: dryRun ? 'dry-run' : null }); console.log(`  [${i + 1}/${result.tracks.length}] ✓ ${match.method} — ${track.name} — ${track.artist}`); }
      else { this.record({ playlist: playlist.name, title: track.name, artist: track.artist, isrc: null, matched: false, note: dryRun ? 'dry-run: no match' : 'no match' }); console.log(`  [${i + 1}/${result.tracks.length}] ✗ not found — ${track.name} — ${track.artist}`); }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    console.log(`[${playlist.name}] ${matchedIds.length}/${result.tracks.length} tracks matched.`);
    return { matchedIds, total: result.tracks.length, truncated: result.truncated };
  }
  async writePlaylist(name: string, ids: string[], title = `[plx] ${name}`): Promise<void> {
    if (!ids.length) { console.log(`[${name}] No matching tracks — playlist not created.`); return; }
    const id = await this.deezer.createPlaylist(title);
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length; start += 100) { await this.deezer.addTracks(id, unique.slice(start, start + 100)); await new Promise((resolve) => setTimeout(resolve, 200)); }
    console.log(`[${name}] Deezer playlist created: ${title} (${unique.length} tracks)`);
  }
  // Append to an existing playlist, skipping tracks already present (dedupe), then reorder 1:1.
  async writeToExisting(name: string, playlistId: string, ids: string[]): Promise<void> {
    if (!ids.length) { console.log(`[${name}] No matching tracks.`); return; }
    const existing = await this.deezer.getPlaylistTrackIds(playlistId);
    // Dedupe within the batch too — Deezer rejects any chunk containing a repeated id.
    const unique = [...new Set(ids)];
    const batchDupes = ids.length - unique.length;
    const alreadyThere = unique.filter((id) => existing.has(id)).length;
    const toAdd = unique.filter((id) => !existing.has(id));
    let added = 0;
    if (toAdd.length) {
      for (let start = 0; start < toAdd.length; start += 100) { added += await this.deezer.addTracks(playlistId, toAdd.slice(start, start + 100)); await new Promise((resolve) => setTimeout(resolve, 200)); }
    }
    const parts: string[] = [];
    if (alreadyThere) parts.push(`${alreadyThere} already present`);
    if (batchDupes) parts.push(`${batchDupes} duplicates removed`);
    console.log(`[${name}] ${added} new tracks added${parts.length ? ` (${parts.join(', ')})` : ''}.`);
    await this.reorderToMatch(name, playlistId, ids);
  }
  // Reorder the target to mirror the source order (1:1 sync). Moves each matched track into place
  // from the front, so matched tracks land in source order and anything extra is pushed to the end.
  async reorderToMatch(name: string, playlistId: string, ids: string[]): Promise<void> {
    const desired = [...new Set(ids)].filter((id) => id);
    if (desired.length < 2) return;
    const current = await this.deezer.getPlaylistTrackOrder(playlistId);
    const movable = new Set(desired);
    const kept = current.filter((id) => movable.has(id));
    if (kept.length === desired.length && desired.every((id, i) => kept[i] === id)) return;
    for (let i = 0; i < desired.length; i += 1) {
      await this.deezer.moveTrack(playlistId, desired[i], i === 0 ? null : desired[i - 1]);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log(`[${name}] playlist order synced to source.`);
  }
  async writeReport() { await writeCsv(this.output, this.rows); }
}
