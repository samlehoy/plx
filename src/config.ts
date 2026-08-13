import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import 'dotenv/config';
import { fetchBrowserCredentials } from './browser.js';

export type Config = { deezerArl: string; spotifyDc: string; recentUrls: string[] };

export function configDir(): string {
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'plx');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'plx');
}

const file = () => join(configDir(), 'credentials.json');

export async function loadConfig(requireDeezer = true): Promise<Config> {
  let stored: Partial<Config> = {};
  try { stored = JSON.parse(await readFile(file(), 'utf8')) as Partial<Config>; } catch { /* first run */ }
  const cfg = { deezerArl: process.env.DEEZER_ARL ?? stored.deezerArl ?? '', spotifyDc: process.env.SPOTIFY_DC ?? stored.spotifyDc ?? '', recentUrls: stored.recentUrls ?? [] };
  if (requireDeezer && !cfg.deezerArl) throw new Error('Konfigurasi kurang: DEEZER_ARL');
  return cfg;
}

export async function saveRecentUrl(url: string): Promise<void> {
  const stored = await loadStored();
  const list = Array.isArray(stored.recentUrls) ? stored.recentUrls : [];
  const next = [url, ...list.filter((u) => u !== url)].slice(0, 10);
  await saveCredentials({ recentUrls: next });
}

export async function saveCredentials(values: Partial<Config>): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const current = await loadStored();
  await writeFile(file(), JSON.stringify({ ...current, ...values }, null, 2), { mode: 0o600 });
  try { await chmod(file(), 0o600); } catch { /* Windows */ }
}

async function loadStored(): Promise<Partial<Config>> { try { return JSON.parse(await readFile(file(), 'utf8')) as Partial<Config>; } catch { return {}; } }

// Semi-auto: fill credentials from a logged-in browser (pops the macOS Keychain
// "Allow" dialog on first use), persist what's found, and return the field names
// filled. By default only fills *missing* fields (env vars and stored credentials
// win); pass overwrite=true to refetch and replace whatever the browser has. Never
// throws — a denied keychain / TCC block just fills nothing, and the caller falls
// back to the manual paste prompt.
export async function tryAutoFillCredentials(cfg: Config, overwrite = false): Promise<string[]> {
  const filled: string[] = [];
  const want = overwrite || !cfg.deezerArl || !cfg.spotifyDc;
  if (!want) return filled;
  const found = fetchBrowserCredentials();
  if ((overwrite || !cfg.deezerArl) && found.arl) { cfg.deezerArl = found.arl; filled.push('deezerArl'); }
  if ((overwrite || !cfg.spotifyDc) && found.spDc) { cfg.spotifyDc = found.spDc; filled.push('spotifyDc'); }
  if (filled.length) await saveCredentials({ deezerArl: cfg.deezerArl, spotifyDc: cfg.spotifyDc });
  return filled;
}
