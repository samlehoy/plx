import { matchCandidates } from './matcher.js';
import { writeCsv } from './csv.js';
import type { Match, MatchResult, PlaylistRef, Provider, ReportRow, Track } from './types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One conversion path for every direction: read the playlist from `source`, match each track into
// `target`, report. Both providers are parameters, so N providers give N×(N−1) directions without
// a line of direction-specific code.
//
// Where the target can resolve a track by identifier, each match is re-resolved and compared to the
// source track; a match that diverges is still written but flagged in the report. Where the target
// can reorder, the target order is synced to the source; where it cannot, the conversion still
// completes by appending (ADR 0002).
export class Conversion {
  readonly rows: ReportRow[] = [];
  constructor(private readonly source: Provider, private readonly target: Provider, private readonly output: string) {}
  private record(row: ReportRow) { this.rows.push(row); }

  async matchPlaylist(playlist: PlaylistRef, dryRun = false): Promise<MatchResult> {
    let result;
    try { result = await this.source.readPlaylist(playlist.uri); }
    catch (error) { this.record({ playlist: playlist.name, title: '', artist: '', isrc: null, matched: false, note: `failed to read playlist: ${error instanceof Error ? error.name : 'Error'}` }); return { matchedIds: [], total: 0, truncated: false }; }
    if (result.truncated) {
      // The provider hit its own read cap; how many it managed is the only limit the path knows.
      this.record({ playlist: playlist.name, title: '', artist: '', isrc: null, matched: false, note: `WARNING: truncated at ${result.tracks.length} tracks; remainder not converted` });
      console.log(`[${playlist.name}] ⚠️ Truncated at ${result.tracks.length} tracks.`);
    }
    const matchedIds: string[] = [];
    let verified = 0;
    for (let i = 0; i < result.tracks.length; i += 1) {
      const track = result.tracks[i];
      let match: Match | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { match = await this.target.search(track); break; }
        catch (error) { if (attempt === 2) console.log(`  ⚠️ search failed: ${error instanceof Error ? error.name : 'Error'}`); else await sleep(2 ** attempt * 1000); }
      }
      if (match) {
        const flag = await this.verify(track, match);
        if (this.target.resolveTrack && flag === null) verified += 1;
        matchedIds.push(match.id);
        this.record({ playlist: playlist.name, title: track.name, artist: track.artist, isrc: null, matched: true, deezer_id: match.id, method: match.method, note: [flag, dryRun ? 'dry-run' : null].filter(Boolean).join('; ') || null });
        console.log(`  [${i + 1}/${result.tracks.length}] ✓ ${match.method} — ${track.name} — ${track.artist}${flag ? ` — ${flag}` : ''}`);
      } else {
        this.record({ playlist: playlist.name, title: track.name, artist: track.artist, isrc: null, matched: false, note: dryRun ? 'dry-run: no match' : 'no match' });
        console.log(`  [${i + 1}/${result.tracks.length}] ✗ not found — ${track.name} — ${track.artist}`);
      }
      await sleep(300);
    }
    const missed = result.tracks.length - matchedIds.length;
    console.log(this.target.resolveTrack
      ? `[${playlist.name}] ${matchedIds.length}/${result.tracks.length} matched (${verified} verified${missed ? `, ${missed} match failed` : ''}).`
      : `[${playlist.name}] ${matchedIds.length}/${result.tracks.length} tracks matched.`);
    return { matchedIds, total: result.tracks.length, truncated: result.truncated };
  }

  // Resolve the match back from the target and re-check it against the source track (precision).
  // Returns null when it verifies — or the target cannot resolve at all — and a report flag otherwise.
  private async verify(track: Track, match: Match): Promise<string | null> {
    if (!this.target.resolveTrack) return null;
    try {
      const meta = await this.target.resolveTrack(match.id);
      const same = matchCandidates(track.name, track.artist, track.durationMs, [{ id: match.id, title: meta.name, artist: meta.artist, duration: meta.durationMs != null ? Math.round(meta.durationMs / 1000) : null }]);
      return same ? null : '⚠️ recheck (possibly wrong track)';
    } catch { return '⚠️ verification failed'; }
  }

  async writePlaylist(name: string, ids: string[], title = `[plx] ${name}`): Promise<void> {
    if (!ids.length) { console.log(`[${name}] No matching tracks — playlist not created.`); return; }
    const unique = [...new Set(ids)];
    await this.addInChunks(await this.target.createPlaylist(title), unique);
    console.log(`[${name}] ${this.target.name} playlist created: ${title} (${unique.length} tracks)`);
  }

  // Append to an existing playlist, skipping tracks already present (dedupe), then reorder if the
  // target can. A target that cannot reorder ends here — appended, not order-synced.
  async writeToExisting(name: string, playlistId: string, ids: string[]): Promise<void> {
    if (!ids.length) { console.log(`[${name}] No matching tracks.`); return; }
    const existing = await this.target.getPlaylistTrackIds(playlistId);
    // Dedupe within the batch too — Deezer rejects any chunk containing a repeated id.
    const unique = [...new Set(ids)];
    const batchDupes = ids.length - unique.length;
    const alreadyThere = unique.filter((id) => existing.has(id)).length;
    const toAdd = unique.filter((id) => !existing.has(id));
    const added = toAdd.length ? await this.addInChunks(playlistId, toAdd) : 0;
    const parts: string[] = [];
    if (alreadyThere) parts.push(`${alreadyThere} already present`);
    if (batchDupes) parts.push(`${batchDupes} duplicates removed`);
    console.log(`[${name}] ${added} new tracks added${parts.length ? ` (${parts.join(', ')})` : ''}.`);
    if (await this.target.reorder?.(playlistId, ids)) console.log(`[${name}] playlist order synced to source.`);
  }

  private async addInChunks(playlistId: string, ids: string[]): Promise<number> {
    let added = 0;
    for (let start = 0; start < ids.length; start += 100) { added += await this.target.addTracks(playlistId, ids.slice(start, start + 100)); await sleep(200); }
    return added;
  }

  async writeReport() { await writeCsv(this.output, this.rows); }
}
