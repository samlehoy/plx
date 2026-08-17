#!/usr/bin/env node
import { confirm, intro, isCancel, outro, password, select, text } from '@clack/prompts';
import { credential, loadConfig, saveCredential, saveRecentUrl, tryAutoFillCredentials, type Config } from './config.js';
import { DeezerClient, resolveDeezerPlaylistId } from './deezer.js';
import { Conversion } from './conversion.js';
import { SpotifyProvider, anonymousToken, authenticatedToken, parsePlaylistId, playlistName } from './spotify.js';
import { listPlaylists } from './spotify.js';
import { HELP_TEXT, parseArgs, type CliOptions } from './args.js';

function args(): string[] { return process.argv.slice(2); }

// Fill one provider's credential: browser auto-fill first, then a manual paste. Persists what it
// gets. Returns the credential, or null when the user cancels.
async function ensureCredential(cfg: Config, provider: string, hint: string): Promise<string | null> {
  if (credential(cfg, provider)) return credential(cfg, provider);
  const filled = await tryAutoFillCredentials(cfg);
  if (filled.includes(provider)) return credential(cfg, provider);
  const entered = await password({ message: hint });
  if (isCancel(entered) || !entered) return null;
  await saveCredential(cfg, provider, String(entered));
  return credential(cfg, provider);
}

// Build a validated Deezer client. If no credential is set, prompt for it and persist.
// Returns null when the user cancels or Deezer rejects it.
async function ensureDeezer(cfg: Config): Promise<DeezerClient | null> {
  const arl = await ensureCredential(cfg, 'deezer', `Deezer ARL (${ARL_HINT})`);
  if (!arl) return null;
  const deezer = new DeezerClient(arl);
  try {
    await deezer.getMe();
  } catch (error) {
    console.log(`⚠️ Invalid Deezer ARL (${error instanceof Error ? error.message : 'error'}). Re-enter it via Settings.`);
    return null;
  }
  return deezer;
}

// Pick a Spotify source: recent URLs, paste new, or (with sp_dc) pick from the account.
// Returns the ref plus an authenticated read token when picked from the account
// (covers private playlists); token is null on the anonymous paste/recent paths.
async function chooseSource(cfg: Config): Promise<{ ref: string; token: string | null } | null> {
  const options: Array<{ value: string; label: string }> = [
    ...cfg.recentUrls.map((u) => ({ value: u, label: u })),
    { value: '__new__', label: 'Paste new URL/ID' },
  ];
  if (credential(cfg, 'spotify')) options.push({ value: '__lib__', label: 'Pick from my Spotify account' });
  const pick = await select({ message: 'Source playlist (Spotify)', options });
  if (isCancel(pick)) return null;
  if (pick === '__new__') {
    const ref = await text({ message: 'Paste playlist URL/ID (q to go back)', initialValue: '' });
    if (isCancel(ref) || !ref || String(ref).toLowerCase() === 'q') return null;
    return { ref: String(ref), token: null };
  }
  if (pick === '__lib__') {
    const token = await ensureSpotify(cfg);
    if (!token) return null;
    const uri = await pickSpotifyPlaylist(token, 'source');
    return uri ? { ref: uri, token } : null;
  }
  return { ref: String(pick), token: null };
}

// Pick an existing Deezer playlist (as target or source). Returns { id, title } or null.
async function chooseTarget(deezer: DeezerClient, role: 'target' | 'source' = 'target'): Promise<{ id: string; title: string } | null> {
  const method = await select({
    message: `Pick ${role === 'source' ? 'source' : 'target'} playlist (Deezer)`,
    options: [
      { value: 'list', label: 'List from Deezer account' },
      { value: 'paste', label: 'Paste Deezer URL/ID' },
    ],
  });
  if (isCancel(method)) return null;
  if (method === 'list') {
    let playlists: { id: string; title: string }[];
    try { playlists = await deezer.listPlaylists(); }
    catch (error) { console.log(`⚠️ Failed to read playlist list (${error instanceof Error ? error.message : 'error'}).`); return null; }
    if (!playlists.length) { console.log('No Deezer playlists found on this account.'); return null; }
    const pick = await select({ message: 'Pick a playlist', options: playlists.map((p) => ({ value: p.id, label: p.title })) });
    if (isCancel(pick)) return null;
    return playlists.find((p) => p.id === pick) ?? null;
  }
  const ref = await text({ message: 'Paste Deezer playlist URL/ID', initialValue: '' });
  if (isCancel(ref) || !ref) return null;
  const id = await resolveDeezerPlaylistId(String(ref));
  return { id, title: id };
}

// Pick how to write the target: a new playlist or an existing one.
async function chooseTargetKind(): Promise<'new' | 'existing' | null> {
  const kind = await select({
    message: 'Target destination',
    options: [
      { value: 'new', label: 'New playlist' },
      { value: 'existing', label: 'Existing playlist' },
    ],
  });
  if (isCancel(kind)) return null;
  return kind as 'new' | 'existing';
}

// Spotify source → Deezer target: read source, match, then write to a new playlist or an existing target.
async function spotifyToDeezer(cfg: Config, options: CliOptions): Promise<void> {
  const source = await chooseSource(cfg);
  if (!source) return;
  const deezer = await ensureDeezer(cfg);
  if (!deezer) return;
  const id = parsePlaylistId(source.ref);
  const name = await playlistName(id);
  const conversion = new Conversion(new SpotifyProvider(source.token ?? await anonymousToken()), deezer, options.output);
  const result = await conversion.matchPlaylist({ name, uri: id }, options.dryRun);

  if (!options.dryRun && result.matchedIds.length) {
    const kind = await chooseTargetKind();
    if (kind === 'existing') {
      const target = await chooseTarget(deezer);
      if (target) await conversion.writeToExisting(name, target.id, result.matchedIds);
    } else if (kind === 'new') {
      await maybeWrite(conversion, name, result);
    }
  }
  await conversion.writeReport();
  await saveRecentUrl(source.ref);
}

async function maybeWrite(conversion: Conversion, name: string, result: Awaited<ReturnType<Conversion['matchPlaylist']>>): Promise<void> {
  if (!result.matchedIds.length) return;
  if (result.truncated) {
    const proceed = await confirm({ message: `Playlist truncated at ${result.total} tracks. Continue with ${result.matchedIds.length} tracks?`, initialValue: false });
    if (isCancel(proceed) || !proceed) return;
  }
  const ok = await confirm({ message: `Create '[plx] ${name}' (${result.matchedIds.length} tracks)?`, initialValue: false });
  if (isCancel(ok) || !ok) return;
  await conversion.writePlaylist(name, result.matchedIds);
}

// Build a validated Spotify session (sp_dc cookie → authenticated token). Returns token or null.
async function ensureSpotify(cfg: Config): Promise<string | null> {
  const dc = await ensureCredential(cfg, 'spotify', `Spotify sp_dc (${SPDC_HINT})`);
  if (!dc) return null;
  try {
    return await authenticatedToken(dc);
  } catch (error) {
    console.log(`⚠️ Invalid Spotify sp_dc (${error instanceof Error ? error.message : 'error'}). Re-enter it via Settings.`);
    return null;
  }
}

// Pick a Spotify playlist by URI from the user's account (role 'asal' | 'target').
async function pickSpotifyPlaylist(token: string, role: 'source' | 'target'): Promise<string | null> {
  let playlists: { uri: string; name: string }[];
  try { playlists = await listPlaylists(token); }
  catch (error) { console.log(`⚠️ Failed to read Spotify playlist list (${error instanceof Error ? error.message : 'error'}).`); return null; }
  if (!playlists.length) { console.log('No writable Spotify playlists found.'); return null; }
  const pick = await select({ message: `Pick ${role} playlist (Spotify)`, options: playlists.map((p) => ({ value: p.uri, label: p.name })) });
  if (isCancel(pick)) return null;
  return String(pick);
}

// Pick an existing Spotify playlist (writable) as the target. Returns uri or null.
async function chooseSpotifyTarget(token: string): Promise<string | null> {
  return pickSpotifyPlaylist(token, 'target');
}

// Deezer source → Spotify target, new or existing playlist.
async function deezerToSpotify(cfg: Config, options: CliOptions): Promise<void> {
  const deezer = await ensureDeezer(cfg);
  if (!deezer) return;
  const source = await chooseTarget(deezer, 'source');
  if (!source) return;
  const token = await ensureSpotify(cfg);
  if (!token) return;
  let target: string | null = null;
  if (!options.dryRun) {
    const kind = await chooseTargetKind();
    if (!kind) return;
    if (kind === 'existing') {
      target = await chooseSpotifyTarget(token);
      if (!target) return;
    }
  }
  const conversion = new Conversion(deezer, new SpotifyProvider(token), options.output);
  const result = await conversion.matchPlaylist({ name: source.title, uri: source.id }, options.dryRun);
  if (!options.dryRun && result.matchedIds.length) {
    if (target) await conversion.writeToExisting(source.title, target, result.matchedIds);
    else await conversion.writePlaylist(source.title, result.matchedIds);
  }
  await conversion.writeReport();
}

function warnLogin(sites: string): void {
  console.log(`⚠️ Make sure you're logged in at ${sites} in your browser, then grab the credentials.`);
}

const ARL_HINT = 'login deezer.com → F12 → Application → Cookies → arl → copy value';
const SPDC_HINT = 'login open.spotify.com → F12 → Application → Cookies → sp_dc → copy value';

// Settings entry for one provider's credential: unlike ensureCredential this always asks, so a
// saved-but-expired credential can be replaced.
async function reenterCredential(cfg: Config, provider: string, site: string, label: string, hint: string): Promise<void> {
  warnLogin(site);
  const filled = await tryAutoFillCredentials(cfg);
  if (!filled.includes(provider)) {
    const entered = await password({ message: `${label} (${hint})` });
    if (isCancel(entered) || !entered) return;
    await saveCredential(cfg, provider, String(entered));
  }
  console.log(`✓ ${label} saved.`);
}

async function runInteractive(options: CliOptions): Promise<void> {
  intro('plx — Spotify ⇄ Deezer');
  const cfg = await loadConfig();
  if (cfg.legacyCredentials) console.log('⚠️ Your saved credentials are in an older format and were not carried over. Re-enter them below (or use Auto-fetch) — it only takes one browser dialog.');
  for (;;) {
    const choice = await select({
      message: 'Pick an action',
      options: [
        { value: 'sp2dz', label: 'Spotify → Deezer' },
        { value: 'dz2sp', label: 'Deezer → Spotify' },
        { value: 'arl', label: `Deezer ARL: ${credential(cfg, 'deezer') ? '✓ saved' : '(not set)'}` },
        { value: 'spdc', label: `Spotify sp_dc: ${credential(cfg, 'spotify') ? '✓ saved' : '(not set)'}` },
        { value: 'autofetch', label: 'Auto-fetch credentials (from browser)' },
        { value: 'output', label: `Report: ${options.output}` },
        { value: 'quit', label: 'Quit' },
      ],
    });
    if (isCancel(choice) || choice === 'quit') break;
    if (choice === 'sp2dz') { await spotifyToDeezer(cfg, options); continue; }
    if (choice === 'dz2sp') { await deezerToSpotify(cfg, options); continue; }
    if (choice === 'arl') { await reenterCredential(cfg, 'deezer', 'Deezer (deezer.com)', 'Deezer ARL', ARL_HINT); continue; }
    if (choice === 'spdc') { await reenterCredential(cfg, 'spotify', 'Spotify (open.spotify.com)', 'Spotify sp_dc', SPDC_HINT); continue; }
    if (choice === 'autofetch') {
      warnLogin('Deezer & Spotify');
      const filled = await tryAutoFillCredentials(cfg, true);
      console.log(filled.length
        ? `✓ Fetched from browser: ${filled.join(', ')}.`
        : '✗ No credentials could be fetched (browser not logged in / keychain denied).');
      continue;
    }
    if (choice === 'output') {
      const output = await text({ message: 'Report file path', initialValue: options.output });
      if (isCancel(output) || !output) continue;
      options.output = String(output);
      continue;
    }
  }
  outro(`Done. Report: ${options.output}`);
}

async function main() {
  const options = parseArgs(args());
  if (options.help) { console.log(HELP_TEXT); return; }

  if (!options.urls.length) {
    await runInteractive(options);
    return;
  }

  const cfg = await loadConfig();
  if (cfg.legacyCredentials) console.log('⚠️ Saved credentials are in an older format and were not carried over. Run `plx` and re-enter them (one browser dialog).');
  // Deezer's search is public, so a dry run into a Deezer target needs no credential at all —
  // only the write does. Demand it for the side that actually needs one, and not before.
  const deezer = new DeezerClient(credential(cfg, 'deezer'));
  if (!options.dryRun) {
    if (!credential(cfg, 'deezer')) throw new Error('No Deezer credential. Set DEEZER_ARL, or run `plx` and save it from the menu. (A --dry-run needs none.)');
    await deezer.getMe();
  }
  const conversion = new Conversion(new SpotifyProvider(await anonymousToken()), deezer, options.output);

  for (const raw of options.urls) {
    const id = parsePlaylistId(raw);
    const name = await playlistName(id);
    const result = await conversion.matchPlaylist({ name, uri: id }, options.dryRun);
    if (!options.dryRun && result.matchedIds.length) await conversion.writePlaylist(name, result.matchedIds);
  }
  await conversion.writeReport();
  outro(`Report saved to ${options.output}`);
}

main().catch((error: unknown) => { console.error(`Error: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
