import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import 'dotenv/config';

export type Config = { spotifyClientId?: string; spotifySecret?: string; deezerArl: string; outputCsv: string };

export function configDir(): string {
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'plx');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'plx');
}

const file = () => join(configDir(), 'credentials.json');

export async function loadConfig(requireSpotify = true): Promise<Config> {
  let stored: Partial<Config> = {};
  try { stored = JSON.parse(await readFile(file(), 'utf8')) as Partial<Config>; } catch { /* first run */ }
  const cfg = {
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID ?? stored.spotifyClientId,
    spotifySecret: process.env.SPOTIFY_CLIENT_SECRET ?? stored.spotifySecret,
    deezerArl: process.env.DEEZER_ARL ?? stored.deezerArl ?? '',
    outputCsv: 'conversion_report.csv',
  };
  const missing = [!cfg.deezerArl && 'DEEZER_ARL', requireSpotify && !cfg.spotifyClientId && 'SPOTIFY_CLIENT_ID', requireSpotify && !cfg.spotifySecret && 'SPOTIFY_CLIENT_SECRET'].filter(Boolean);
  if (missing.length) throw new Error(`Konfigurasi kurang: ${missing.join(', ')}`);
  return cfg;
}

export async function saveCredentials(values: Partial<Config>): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const current = await loadStored();
  await writeFile(file(), JSON.stringify({ ...current, ...values }, null, 2), { mode: 0o600 });
  try { await chmod(file(), 0o600); } catch { /* Windows */ }
}

async function loadStored(): Promise<Partial<Config>> { try { return JSON.parse(await readFile(file(), 'utf8')) as Partial<Config>; } catch { return {}; } }
