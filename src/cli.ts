#!/usr/bin/env node
import { confirm, intro, isCancel, outro, password, select, text } from '@clack/prompts';
import { loadConfig, saveCredentials, saveRecentUrl, tryAutoFillCredentials, type Config } from './config.js';
import { DeezerClient, resolveDeezerPlaylistId } from './deezer.js';
import { Converter } from './converter.js';
import { anonymousToken, authenticatedToken, parsePlaylistId, playlistName } from './spotify.js';
import { reverseConvert, reverseWriteToExisting } from './reverse.js';
import { listPlaylists } from './spotify.js';
import { HELP_TEXT, parseArgs, type CliOptions } from './args.js';

function args(): string[] { return process.argv.slice(2); }

// Build a validated Deezer client. If no ARL is set, prompt for it and persist.
// Returns null when the user cancels or the ARL is rejected.
async function ensureDeezer(cfg: Config): Promise<DeezerClient | null> {
  if (!cfg.deezerArl) {
    const filled = await tryAutoFillCredentials(cfg);
    if (!filled.includes('deezerArl')) {
      const arl = await password({ message: 'Deezer ARL (cookie dari deezer.com: F12 → Application → Cookies → arl)' });
      if (isCancel(arl) || !arl) return null;
      cfg.deezerArl = String(arl);
      await saveCredentials({ deezerArl: cfg.deezerArl });
    }
  }
  const deezer = new DeezerClient(cfg.deezerArl);
  try {
    await deezer.getMe();
  } catch (error) {
    console.log(`⚠️ ARL Deezer tidak valid (${error instanceof Error ? error.message : 'error'}). Isi ulang lewat Pengaturan.`);
    return null;
  }
  return deezer;
}

// Pick a Spotify source: recent URLs first, else paste a new one. Returns ref or null.
async function chooseSource(cfg: Config): Promise<string | null> {
  if (cfg.recentUrls.length) {
    const pick = await select({
      message: 'Playlist asal (Spotify)',
      options: [
        ...cfg.recentUrls.map((u) => ({ value: u, label: u })),
        { value: '__new__', label: 'Tempel URL/ID baru' },
      ],
    });
    if (isCancel(pick)) return null;
    if (pick !== '__new__') return String(pick);
  }
  const ref = await text({ message: 'Tempel URL/ID playlist (q untuk kembali)', initialValue: '' });
  if (isCancel(ref) || !ref || String(ref).toLowerCase() === 'q') return null;
  return String(ref);
}

// Pick an existing Deezer playlist (as target or source). Returns { id, title } or null.
async function chooseTarget(deezer: DeezerClient, role: 'target' | 'source' = 'target'): Promise<{ id: string; title: string } | null> {
  const method = await select({
    message: `Pilih playlist ${role === 'source' ? 'asal' : 'target'} (Deezer)`,
    options: [
      { value: 'list', label: 'Daftar dari akun Deezer' },
      { value: 'paste', label: 'Tempel URL/ID Deezer' },
    ],
  });
  if (isCancel(method)) return null;
  if (method === 'list') {
    let playlists: { id: string; title: string }[];
    try { playlists = await deezer.listPlaylists(); }
    catch (error) { console.log(`⚠️ Gagal baca daftar playlist (${error instanceof Error ? error.message : 'error'}).`); return null; }
    if (!playlists.length) { console.log('Tidak ada playlist Deezer ditemukan di akun ini.'); return null; }
    const pick = await select({ message: 'Pilih playlist', options: playlists.map((p) => ({ value: p.id, label: p.title })) });
    if (isCancel(pick)) return null;
    return playlists.find((p) => p.id === pick) ?? null;
  }
  const ref = await text({ message: 'Tempel URL/ID playlist Deezer', initialValue: '' });
  if (isCancel(ref) || !ref) return null;
  const id = await resolveDeezerPlaylistId(String(ref));
  return { id, title: id };
}

// Core convert: read source, match, then write to a new playlist or an existing target.
async function convert(cfg: Config, options: CliOptions, useExisting: boolean): Promise<void> {
  const source = await chooseSource(cfg);
  if (!source) return;
  const deezer = await ensureDeezer(cfg);
  if (!deezer) return;
  const id = parsePlaylistId(source);
  const name = await playlistName(id);
  const converter = new Converter(deezer, await anonymousToken(), options.output);
  const result = await converter.matchPlaylist({ name, uri: id }, options.dryRun);

  if (!options.dryRun && result.matchedIds.length) {
    if (useExisting) {
      const target = await chooseTarget(deezer);
      if (target) await converter.writeToExisting(name, target.id, result.matchedIds);
    } else {
      await maybeWrite(converter, name, result);
    }
  }
  await converter.writeReport();
  await saveRecentUrl(source);
}

async function maybeWrite(converter: Converter, name: string, result: Awaited<ReturnType<Converter['matchPlaylist']>>): Promise<void> {
  if (!result.matchedIds.length) return;
  if (result.truncated) {
    const proceed = await confirm({ message: `Playlist terpotong di 100 lagu. Lanjut dengan ${result.matchedIds.length} lagu?`, initialValue: false });
    if (isCancel(proceed) || !proceed) return;
  }
  const ok = await confirm({ message: `Buat '[conv] ${name}' (${result.matchedIds.length} lagu)?`, initialValue: false });
  if (isCancel(ok) || !ok) return;
  await converter.writePlaylist(name, result.matchedIds);
}

// Build a validated Spotify session (sp_dc cookie → authenticated token). Returns token or null.
async function ensureSpotify(cfg: Config): Promise<string | null> {
  if (!cfg.spotifyDc) {
    const filled = await tryAutoFillCredentials(cfg);
    if (!filled.includes('spotifyDc')) {
      const dc = await password({ message: 'Spotify sp_dc (cookie dari open.spotify.com: F12 → Application → Cookies → sp_dc)' });
      if (isCancel(dc) || !dc) return null;
      cfg.spotifyDc = String(dc);
      await saveCredentials({ spotifyDc: cfg.spotifyDc });
    }
  }
  try {
    return await authenticatedToken(cfg.spotifyDc);
  } catch (error) {
    console.log(`⚠️ sp_dc Spotify tidak valid (${error instanceof Error ? error.message : 'error'}). Isi ulang lewat Pengaturan.`);
    return null;
  }
}

// Pick an existing Spotify playlist (writable) as reverse target. Returns uri or null.
async function chooseSpotifyTarget(token: string): Promise<string | null> {
  let playlists: { uri: string; name: string }[];
  try { playlists = await listPlaylists(token); }
  catch (error) { console.log(`⚠️ Gagal baca daftar playlist Spotify (${error instanceof Error ? error.message : 'error'}).`); return null; }
  if (!playlists.length) { console.log('Tidak ada playlist Spotify (yang bisa diubah) ditemukan.'); return null; }
  const pick = await select({ message: 'Pilih playlist target (Spotify)', options: playlists.map((p) => ({ value: p.uri, label: p.name })) });
  if (isCancel(pick)) return null;
  return String(pick);
}

// Reverse flow: Deezer playlist (source) → new or existing Spotify playlist (target).
async function reverseConvertFlow(cfg: Config, options: CliOptions, useExisting: boolean): Promise<void> {
  const deezer = await ensureDeezer(cfg);
  if (!deezer) return;
  const source = await chooseTarget(deezer, 'source');
  if (!source) return;
  const token = await ensureSpotify(cfg);
  if (!token) return;
  if (useExisting) {
    const target = await chooseSpotifyTarget(token);
    if (target) await reverseWriteToExisting(deezer, token, source.id, source.title, target, options.output);
  } else {
    await reverseConvert(deezer, token, source.id, source.title, options.output);
  }
}

async function runInteractive(options: CliOptions): Promise<void> {
  intro('plx — Spotify ⇄ Deezer');
  const cfg = await loadConfig(false); // no requirement at menu entry
  for (;;) {
    const choice = await select({
      message: 'Pilih aksi',
      options: [
        { value: 'url', label: 'Spotify → Deezer: playlist baru' },
        { value: 'existing', label: 'Spotify → Deezer: playlist yang ada' },
        { value: 'reverse', label: 'Deezer → Spotify: playlist baru' },
        { value: 'reverse-existing', label: 'Deezer → Spotify: playlist yang ada' },
        { value: 'arl', label: `Deezer ARL: ${cfg.deezerArl ? '✓ tersimpan' : '(belum diisi)'}` },
        { value: 'spdc', label: `Spotify sp_dc: ${cfg.spotifyDc ? '✓ tersimpan' : '(belum diisi)'}` },
        { value: 'autofetch', label: 'Ambil kredensial otomatis (dari browser)' },
        { value: 'output', label: `Laporan: ${options.output}` },
        { value: 'quit', label: 'Keluar' },
      ],
    });
    if (isCancel(choice) || choice === 'quit') break;
    if (choice === 'reverse') { await reverseConvertFlow(cfg, options, false); continue; }
    if (choice === 'reverse-existing') { await reverseConvertFlow(cfg, options, true); continue; }
    if (choice === 'arl') {
      const filled = await tryAutoFillCredentials(cfg);
      if (!filled.includes('deezerArl')) {
        const arl = await password({ message: 'Deezer ARL' });
        if (isCancel(arl) || !arl) continue;
        cfg.deezerArl = String(arl);
        await saveCredentials({ deezerArl: cfg.deezerArl });
      }
      console.log('✓ Deezer ARL tersimpan.');
      continue;
    }
    if (choice === 'spdc') {
      const filled = await tryAutoFillCredentials(cfg);
      if (!filled.includes('spotifyDc')) {
        const dc = await password({ message: 'Spotify sp_dc' });
        if (isCancel(dc) || !dc) continue;
        cfg.spotifyDc = String(dc);
        await saveCredentials({ spotifyDc: cfg.spotifyDc });
      }
      console.log('✓ Spotify sp_dc tersimpan.');
      continue;
    }
    if (choice === 'autofetch') {
      const filled = await tryAutoFillCredentials(cfg, true);
      console.log(filled.length
        ? `✓ Terambil dari browser: ${filled.join(', ')}.`
        : '✗ Tidak ada kredensial yang bisa diambil (browser belum login / keychain ditolak).');
      continue;
    }
    if (choice === 'output') {
      const output = await text({ message: 'Path file laporan', initialValue: options.output });
      if (isCancel(output) || !output) continue;
      options.output = String(output);
      continue;
    }
    await convert(cfg, options, choice === 'existing');
  }
  outro(`Selesai. Laporan: ${options.output}`);
}

async function main() {
  const options = parseArgs(args());
  if (options.help) { console.log(HELP_TEXT); return; }

  if (!options.urls.length) {
    await runInteractive(options);
    return;
  }

  const cfg = await loadConfig(true);
  const deezer = new DeezerClient(cfg.deezerArl);
  await deezer.getMe();
  const converter = new Converter(deezer, await anonymousToken(), options.output);

  for (const raw of options.urls) {
    const id = parsePlaylistId(raw);
    const name = await playlistName(id);
    const result = await converter.matchPlaylist({ name, uri: id }, options.dryRun);
    if (!options.dryRun && result.matchedIds.length) await converter.writePlaylist(name, result.matchedIds);
  }
  await converter.writeReport();
  outro(`Report saved to ${options.output}`);
}

main().catch((error: unknown) => { console.error(`Error: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
