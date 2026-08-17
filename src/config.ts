import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import 'dotenv/config';
import { fetchBrowserCredentials } from './browser.js';

// One opaque string per provider, keyed by provider name. This layer never parses a credential —
// what it holds is a cookie for one provider and a whole cookie header for another, and only the
// provider that owns it knows which.
export type Config = { credentials: Record<string, string>; recentUrls: string[]; legacyCredentials: boolean };

// The env override for each provider. The variable name is historical per provider; the value it
// carries is still opaque here.
const ENV_VAR: Record<string, string> = { deezer: 'DEEZER_ARL', spotify: 'SPOTIFY_DC', ytmusic: 'YTMUSIC_COOKIE' };

// The pre-provider-keyed shape stored one named field per cookie. These are deliberately not
// migrated (see #1): they are ignored, dropped on the next write, and the user re-fetches or
// re-pastes — which costs one browser dialog.
const LEGACY_KEYS = ['deezerArl', 'spotifyDc'];

type Stored = { credentials?: Record<string, string>; recentUrls?: string[] } & Record<string, unknown>;

export function configDir(): string {
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'plx');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'plx');
}

const file = () => join(configDir(), 'credentials.json');

async function loadStored(): Promise<Stored> { try { return JSON.parse(await readFile(file(), 'utf8')) as Stored; } catch { return {}; } }

export async function loadConfig(): Promise<Config> {
  const stored = await loadStored();
  const credentials = { ...(stored.credentials ?? {}) };
  for (const [provider, envVar] of Object.entries(ENV_VAR)) {
    const value = process.env[envVar];
    if (value) credentials[provider] = value;
  }
  const legacyCredentials = !stored.credentials && LEGACY_KEYS.some((key) => typeof stored[key] === 'string' && stored[key]);
  return { credentials, recentUrls: stored.recentUrls ?? [], legacyCredentials };
}

// The credential for one provider, or '' when there is none. Callers decide whether they need it.
export function credential(cfg: Config, provider: string): string { return cfg.credentials[provider] ?? ''; }

export async function saveCredential(cfg: Config, provider: string, value: string): Promise<void> {
  cfg.credentials[provider] = value;
  await write({ credentials: cfg.credentials });
}

export async function saveRecentUrl(url: string): Promise<void> {
  const stored = await loadStored();
  const list = Array.isArray(stored.recentUrls) ? stored.recentUrls : [];
  await write({ recentUrls: [url, ...list.filter((u) => u !== url)].slice(0, 10) });
}

async function write(patch: Partial<Stored>): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const current = await loadStored();
  for (const key of LEGACY_KEYS) delete current[key]; // clean the old shape out on first write
  await writeFile(file(), JSON.stringify({ ...current, ...patch }, null, 2), { mode: 0o600 });
  try { await chmod(file(), 0o600); } catch { /* Windows */ }
}

// Semi-auto: fill credentials from a logged-in browser (pops the macOS Keychain "Allow" dialog on
// first use), persist what's found, and return the provider names filled. By default only fills
// providers with no credential yet (env vars and stored credentials win); pass overwrite=true to
// refetch and replace. Never throws — a denied keychain / TCC block just fills nothing, and the
// caller falls back to the manual paste prompt.
export async function tryAutoFillCredentials(cfg: Config, overwrite = false): Promise<string[]> {
  if (!overwrite && Object.keys(ENV_VAR).every((provider) => cfg.credentials[provider])) return [];
  const filled: string[] = [];
  for (const [provider, value] of Object.entries(fetchBrowserCredentials())) {
    if (!value || (!overwrite && cfg.credentials[provider])) continue;
    cfg.credentials[provider] = value;
    filled.push(provider);
  }
  if (filled.length) await write({ credentials: cfg.credentials });
  return filled;
}
