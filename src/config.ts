import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import 'dotenv/config';

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
