#!/usr/bin/env node
import { confirm, intro, isCancel, outro, password, select, text } from '@clack/prompts';
import { credential, loadConfig, saveCredential, saveRecentUrl, tryAutoFillCredentials, type Config } from './config.js';
import { Conversion } from './conversion.js';
import { PROVIDERS, convertibleProviders, inferSource, providerFor, targetKeys, type ProviderSpec } from './registry.js';
import { HELP_TEXT, parseArgs, type CliOptions } from './args.js';
import type { Provider } from './types.js';

function args(): string[] { return process.argv.slice(2); }

// --- Credentials -----------------------------------------------------------

// Fill one provider's credential: browser auto-fill first, then a manual paste. Persists what it
// gets. Returns the credential, or null when the user cancels.
async function ensureCredential(cfg: Config, spec: ProviderSpec): Promise<string | null> {
  if (credential(cfg, spec.key)) return credential(cfg, spec.key);
  const filled = await tryAutoFillCredentials(cfg);
  if (filled.includes(spec.key)) return credential(cfg, spec.key);
  const entered = await password({ message: `${spec.credentialLabel} (${spec.credentialHint})` });
  if (isCancel(entered) || !entered) return null;
  await saveCredential(cfg, spec.key, String(entered));
  return credential(cfg, spec.key);
}

// Settings entry for one provider's credential: unlike ensureCredential this always asks, so a
// saved-but-expired credential can be replaced. Proves it against the live service before saying so.
async function reenterCredential(cfg: Config, spec: ProviderSpec): Promise<void> {
  warnLogin(spec.loginSite);
  const filled = await tryAutoFillCredentials(cfg);
  if (!filled.includes(spec.key)) {
    const entered = await password({ message: `${spec.credentialLabel} (${spec.credentialHint})` });
    if (isCancel(entered) || !entered) return;
    await saveCredential(cfg, spec.key, String(entered));
  }
  await report(cfg, spec);
}

// Check one provider's stored credential against the live service and say what happened.
async function report(cfg: Config, spec: ProviderSpec): Promise<boolean> {
  const cred = credential(cfg, spec.key);
  if (!cred) { console.log(`✗ No ${spec.credentialLabel} saved.`); return false; }
  try {
    console.log(`✓ ${spec.label}: ${await spec.validate(cred)}.`);
    return true;
  } catch (error) {
    console.log(`✗ ${spec.label}: ${error instanceof Error ? error.message : 'could not be verified'}`);
    return false;
  }
}

// Build a provider, asking for its credential only if it needs one. `needsWrite` marks the target
// side, which always needs one; a source that can read anonymously never asks.
async function build(cfg: Config, spec: ProviderSpec, needsWrite: boolean): Promise<Provider | null> {
  let cred = credential(cfg, spec.key);
  if (!cred && (needsWrite || !spec.anonymousRead)) {
    cred = (await ensureCredential(cfg, spec)) ?? '';
    if (!cred) return null;
  }
  try {
    return await spec.create(cred);
  } catch (error) {
    console.log(`⚠️ ${spec.label} rejected the saved credential (${error instanceof Error ? error.message : 'error'}). Replace it from the Credentials menu.`);
    return null;
  }
}

// --- Pickers ---------------------------------------------------------------

function warnLogin(sites: string): void {
  console.log(`⚠️ Make sure you're logged in at ${sites} in your browser, then grab the credentials.`);
}

// Pick a provider by role. Adding a provider adds an option here, never a menu entry.
async function pickProvider(message: string, from: ProviderSpec[], exclude?: ProviderSpec): Promise<ProviderSpec | null> {
  const choices = from.filter((p) => p !== exclude);
  const pick = await select({ message, options: choices.map((p) => ({ value: p.key, label: p.label })) });
  if (isCancel(pick)) return null;
  return providerFor(String(pick)) ?? null;
}

// Pick the playlist to read: a recent link, a pasted one, or one from the account. Same three
// options for every provider — the account option only appears when that provider can list.
async function pickSourcePlaylist(cfg: Config, spec: ProviderSpec, provider: Provider): Promise<{ id: string; name: string; ref?: string } | null> {
  const recents = cfg.recentUrls.filter((u) => inferSource(u) === spec);
  const options = [
    ...recents.map((u) => ({ value: u, label: u })),
    { value: '__new__', label: 'Paste playlist URL/ID' },
  ];
  if (credential(cfg, spec.key)) options.push({ value: '__lib__', label: `Pick from my ${spec.label} account` });
  const pick = await select({ message: `Source playlist (${spec.label})`, options });
  if (isCancel(pick)) return null;

  if (pick === '__lib__') {
    const chosen = await pickFromAccount(provider, spec, 'source');
    return chosen && { id: chosen.id, name: chosen.title };
  }
  const ref = pick === '__new__'
    ? await text({ message: 'Paste playlist URL/ID (q to go back)', initialValue: '' })
    : String(pick);
  if (isCancel(ref) || !ref || String(ref).toLowerCase() === 'q') return null;
  const id = await spec.parseRef(String(ref));
  return { id, name: await spec.playlistName(id), ref: String(ref) };
}

async function pickFromAccount(provider: Provider, spec: ProviderSpec, role: string): Promise<{ id: string; title: string } | null> {
  let playlists: { id: string; title: string }[];
  try { playlists = await provider.listPlaylists(); }
  catch (error) { console.log(`⚠️ Failed to read the ${spec.label} playlist list (${error instanceof Error ? error.message : 'error'}).`); return null; }
  if (!playlists.length) { console.log(`No writable ${spec.label} playlists found.`); return null; }
  const pick = await select({ message: `Pick ${role} playlist (${spec.label})`, options: playlists.map((p) => ({ value: p.id, label: p.title })) });
  if (isCancel(pick)) return null;
  return playlists.find((p) => p.id === pick) ?? null;
}

// Pick the target playlist: an existing one (from the account or pasted), or null for a new one.
// Returns undefined when the user cancels, to keep it apart from "a new playlist".
async function pickTargetPlaylist(spec: ProviderSpec, provider: Provider): Promise<string | null | undefined> {
  const kind = await select({
    message: 'Target destination',
    options: [
      { value: 'new', label: 'New playlist' },
      { value: 'existing', label: 'Existing playlist' },
    ],
  });
  if (isCancel(kind)) return undefined;
  if (kind === 'new') return null;

  const how = await select({
    message: `Pick target playlist (${spec.label})`,
    options: [
      { value: 'list', label: `List from my ${spec.label} account` },
      { value: 'paste', label: 'Paste playlist URL/ID' },
    ],
  });
  if (isCancel(how)) return undefined;
  if (how === 'list') return (await pickFromAccount(provider, spec, 'target'))?.id;
  const ref = await text({ message: 'Paste playlist URL/ID', initialValue: '' });
  if (isCancel(ref) || !ref) return undefined;
  return spec.parseRef(String(ref));
}

// --- Conversion ------------------------------------------------------------

// One flow for every direction: pick source provider, pick target provider, then convert.
async function runConversion(cfg: Config, options: CliOptions): Promise<void> {
  const sourceSpec = await pickProvider('Source provider', convertibleProviders());
  if (!sourceSpec) return;
  const targetSpec = await pickProvider('Target provider', convertibleProviders(), sourceSpec);
  if (!targetSpec) return;

  const source = await build(cfg, sourceSpec, false);
  if (!source) return;
  const picked = await pickSourcePlaylist(cfg, sourceSpec, source);
  if (!picked) return;

  // A dry run writes nothing, so it never asks for the target's credential or its destination.
  const target = await build(cfg, targetSpec, !options.dryRun);
  if (!target) return;
  let targetPlaylist: string | null = null;
  if (!options.dryRun) {
    const chosen = await pickTargetPlaylist(targetSpec, target);
    if (chosen === undefined) return;
    targetPlaylist = chosen;
  }

  const conversion = new Conversion(source, target, options.output);
  try {
    const result = await conversion.matchPlaylist({ name: picked.name, uri: picked.id }, options.dryRun);
    if (!options.dryRun && result.matchedIds.length) {
      if (targetPlaylist) await conversion.writeToExisting(picked.name, targetPlaylist, result.matchedIds);
      else await confirmAndCreate(conversion, picked.name, result);
    }
  } finally {
    await conversion.writeReport(); // a failed write must not cost the whole report
  }
  if (picked.ref) await saveRecentUrl(picked.ref);
}

async function confirmAndCreate(conversion: Conversion, name: string, result: Awaited<ReturnType<Conversion['matchPlaylist']>>): Promise<void> {
  if (result.truncated) {
    const proceed = await confirm({ message: `Playlist truncated at ${result.total} tracks. Continue with ${result.matchedIds.length} tracks?`, initialValue: false });
    if (isCancel(proceed) || !proceed) return;
  }
  const ok = await confirm({ message: `Create '[plx] ${name}' (${result.matchedIds.length} tracks)?`, initialValue: false });
  if (isCancel(ok) || !ok) return;
  await conversion.writePlaylist(name, result.matchedIds);
}

// --- Menu ------------------------------------------------------------------

// Fixed entry count: the two provider-shaped entries (Convert, Credentials) branch by provider
// rather than listing one option each, so adding a provider never lengthens this menu.
async function runInteractive(options: CliOptions): Promise<void> {
  intro('plx — playlist converter');
  const cfg = await loadConfig();
  if (cfg.legacyCredentials) console.log('⚠️ Your saved credentials are in an older format and were not carried over. Re-enter them from Credentials (or use Auto-fetch) — it only takes one browser dialog.');
  for (;;) {
    const saved = PROVIDERS.filter((p) => credential(cfg, p.key)).length;
    const choice = await select({
      message: 'Pick an action',
      options: [
        { value: 'convert', label: 'Convert a playlist' },
        { value: 'credentials', label: `Credentials: ${saved}/${PROVIDERS.length} saved` },
        { value: 'autofetch', label: 'Auto-fetch credentials (from browser)' },
        { value: 'output', label: `Report: ${options.output}` },
        { value: 'quit', label: 'Quit' },
      ],
    });
    if (isCancel(choice) || choice === 'quit') break;
    if (choice === 'convert') { await runConversion(cfg, options); continue; }
    if (choice === 'credentials') {
      const spec = await pickProvider('Which provider?', PROVIDERS);
      if (spec) await reenterCredential(cfg, spec);
      continue;
    }
    if (choice === 'autofetch') {
      warnLogin(PROVIDERS.map((p) => p.label).join(' & '));
      const filled = await tryAutoFillCredentials(cfg, true);
      if (!filled.length) { console.log('✗ No credentials could be fetched (browser not logged in / keychain denied).'); continue; }
      console.log(`Fetched from browser: ${filled.join(', ')}. Checking…`);
      for (const key of filled) { const spec = providerFor(key); if (spec) await report(cfg, spec); }
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

// --- Entry -----------------------------------------------------------------

async function main() {
  const options = parseArgs(args());
  if (options.help) { console.log(HELP_TEXT); return; }

  if (!options.urls.length) {
    await runInteractive(options);
    return;
  }

  // A target is never guessed — not naming one is an error, dry run or not.
  const targetSpec = options.target ? providerFor(options.target) : undefined;
  if (!targetSpec) {
    throw new Error(options.target
      ? `Unknown target provider '${options.target}'. Valid targets: ${targetKeys().join(', ')}.`
      : `No target provider. Name one with --to <${targetKeys().join('|')}>.`);
  }
  if (!targetSpec.convertible) throw new Error(`Writing into ${targetSpec.label} is not built yet. Valid targets: ${targetKeys().join(', ')}.`);

  const cfg = await loadConfig();
  if (cfg.legacyCredentials) console.log('⚠️ Saved credentials are in an older format and were not carried over. Run `plx` and re-enter them (one browser dialog).');

  for (const raw of options.urls) {
    const sourceSpec = inferSource(raw);
    if (sourceSpec && !sourceSpec.convertible) throw new Error(`Reading from ${sourceSpec.label} is not built yet.`);
    if (!sourceSpec) throw new Error(`Cannot tell which provider '${raw}' belongs to. Use a link from one of: ${PROVIDERS.map((p) => p.label).join(', ')}.`);
    if (sourceSpec === targetSpec) throw new Error(`Source and target are both ${sourceSpec.label}.`);

    const source = await sourceSpec.create(readCredential(cfg, sourceSpec));
    // A dry run only searches the target, which may need no credential at all; a write always does.
    const target = await targetSpec.create(options.dryRun ? credential(cfg, targetSpec.key) : writeCredential(cfg, targetSpec));

    const conversion = new Conversion(source, target, options.output);
    try {
      const id = await sourceSpec.parseRef(raw);
      const name = await sourceSpec.playlistName(id);
      const result = await conversion.matchPlaylist({ name, uri: id }, options.dryRun);
      if (!options.dryRun && result.matchedIds.length) await conversion.writePlaylist(name, result.matchedIds);
    } finally {
      await conversion.writeReport(); // a failed write must not cost the whole report
    }
  }
  outro(`Report saved to ${options.output}`);
}

// Reading: a provider that permits anonymous reads needs nothing.
function readCredential(cfg: Config, spec: ProviderSpec): string {
  const cred = credential(cfg, spec.key);
  if (!cred && !spec.anonymousRead) throw new Error(`No ${spec.label} credential, needed to read a ${spec.label} playlist. Run \`plx\` and save it from the Credentials menu.`);
  return cred;
}

// Writing: always needs one, whatever the provider allows for reads.
function writeCredential(cfg: Config, spec: ProviderSpec): string {
  const cred = credential(cfg, spec.key);
  if (!cred) throw new Error(`No ${spec.label} credential, needed to write into ${spec.label}. Run \`plx\` and save it from the Credentials menu, or use --dry-run to match without writing.`);
  return cred;
}

main().catch((error: unknown) => { console.error(`Error: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
