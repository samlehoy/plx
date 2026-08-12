import type { DeezerClient } from './deezer.js';
import { readPlaylist } from './spotify.js';
import { writeCsv } from './csv.js';
import type { MatchResult, PlaylistRef, ReportRow } from './types.js';

export class Converter {
  readonly rows: ReportRow[] = [];
  constructor(private readonly deezer: DeezerClient, private readonly spotifyToken: string, private readonly output: string) {}
  private record(row: ReportRow) { this.rows.push(row); }
  async matchPlaylist(playlist: PlaylistRef, dryRun = false): Promise<MatchResult> {
    let result;
    try { result = await readPlaylist(playlist.uri, this.spotifyToken); }
    catch (error) { this.record({ playlist: playlist.name, title: '', artist: '', isrc: null, matched: false, note: `gagal baca playlist: ${error instanceof Error ? error.name : 'Error'}` }); return { matchedIds: [], total: 0, truncated: false }; }
    const matchedIds: string[] = [];
    for (let i = 0; i < result.tracks.length; i += 1) {
      const track = result.tracks[i];
      let match = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { match = await this.deezer.search(track); break; }
        catch (error) { if (attempt === 2) console.log(`  ⚠️ search gagal: ${error instanceof Error ? error.name : 'Error'}`); else await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000)); }
      }
      if (match) { matchedIds.push(match.id); this.record({ playlist: playlist.name, title: track.name, artist: track.artist, isrc: null, matched: true, deezer_id: match.id, method: match.method, note: dryRun ? 'dry-run' : null }); console.log(`  [${i + 1}/${result.tracks.length}] ✓ ${match.method} — ${track.name} — ${track.artist}`); }
      else { this.record({ playlist: playlist.name, title: track.name, artist: track.artist, isrc: null, matched: false, note: dryRun ? 'dry-run: tidak ketemu' : 'tidak ketemu' }); console.log(`  [${i + 1}/${result.tracks.length}] ✗ tidak ditemukan — ${track.name} — ${track.artist}`); }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    console.log(`[${playlist.name}] ${matchedIds.length}/${result.tracks.length} lagu cocok.`);
    return { matchedIds, total: result.tracks.length, truncated: result.truncated };
  }
  async writePlaylist(name: string, ids: string[], title = `[conv] ${name}`): Promise<void> {
    if (!ids.length) { console.log(`[${name}] Tidak ada lagu yang cocok — playlist tidak dibuat.`); return; }
    const id = await this.deezer.createPlaylist(title);
    for (let start = 0; start < ids.length; start += 100) { await this.deezer.addTracks(id, ids.slice(start, start + 100)); await new Promise((resolve) => setTimeout(resolve, 200)); }
    console.log(`[${name}] playlist Deezer dibuat: ${title}`);
  }
  async writeReport() { await writeCsv(this.output, this.rows); }
}
