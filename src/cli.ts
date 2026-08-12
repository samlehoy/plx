#!/usr/bin/env node
import { intro, outro, text, isCancel } from '@clack/prompts';
import { loadConfig } from './config.js';
import { DeezerClient } from './deezer.js';
import { Converter } from './converter.js';
import { anonymousToken, listPlaylists, oauth, playlistName } from './spotify.js';

function args() { return process.argv.slice(2); }
function value(flag: string) { const i = args().indexOf(flag); return i >= 0 ? args()[i + 1] : undefined; }

async function main() {
  const url = value('--url'); const dryRun = args().includes('--dry-run');
  const cfg = await loadConfig(!url);
  const token = await anonymousToken();
  const deezer = new DeezerClient(cfg.deezerArl);
  await deezer.getMe();
  const converter = new Converter(deezer, token, value('--output') ?? 'conversion_report.csv');
  let playlists = url ? [{ name: await playlistName(url), uri: url }] : [];
  if (!url) {
    if (!cfg.spotifyClientId || !cfg.spotifySecret) throw new Error('Spotify credentials are required for OAuth playlist discovery');
    const auth = await oauth(cfg.spotifyClientId, cfg.spotifySecret);
    playlists = await listPlaylists(auth.token);
  }
  if (!playlists.length) {
    intro('plx — Spotify → Deezer');
    const ref = await text({ message: 'Spotify playlist URL or ID' });
    if (isCancel(ref)) return;
    playlists = [{ name: await playlistName(String(ref)), uri: String(ref) }];
  }
  for (const playlist of playlists) {
    const result = await converter.matchPlaylist(playlist, dryRun);
    if (!dryRun && result.matchedIds.length) await converter.writePlaylist(playlist.name, result.matchedIds);
  }
  await converter.writeReport();
  outro(`Report saved to ${converter}`);
}

main().catch((error: unknown) => { console.error(`Error: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
