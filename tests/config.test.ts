import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { credential, configDir, loadConfig, saveCredential, saveRecentUrl, tryAutoFillCredentials } from '../src/config.js';

vi.mock('../src/browser.js', () => ({ fetchBrowserCredentials: vi.fn(() => ({})) }));
const { fetchBrowserCredentials } = await import('../src/browser.js');
const browserFinds = (found: Record<string, string>) => vi.mocked(fetchBrowserCredentials).mockReturnValue(found);

const ENV_KEYS = ['XDG_CONFIG_HOME', 'DEEZER_ARL', 'SPOTIFY_DC'];
let saved: Record<string, string | undefined>;

// Point the config dir at a fresh temp dir per test, and write `credentials.json` directly so each
// case starts from an exactly-known stored shape.
async function storedFile(contents: unknown): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(join(configDir(), 'credentials.json'), JSON.stringify(contents), 'utf8');
}
const readStored = async () => JSON.parse(await readFile(join(configDir(), 'credentials.json'), 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'plx-cfg-'));
  vi.mocked(fetchBrowserCredentials).mockReset(); // call history too, not just the return value
  browserFinds({});
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('provider-keyed credentials', () => {
  it('stores one opaque string per provider, under the provider name', async () => {
    const cfg = await loadConfig();
    await saveCredential(cfg, 'deezer', 'arl-value');
    await saveCredential(cfg, 'ytmusic', 'SID=x; HSID=y; SSID=z');
    expect(await readStored()).toMatchObject({ credentials: { deezer: 'arl-value', ytmusic: 'SID=x; HSID=y; SSID=z' } });
    expect(credential(await loadConfig(), 'ytmusic')).toBe('SID=x; HSID=y; SSID=z');
  });

  it('returns empty string for a provider with no credential', async () => {
    expect(credential(await loadConfig(), 'deezer')).toBe('');
  });

  it('keeps recentUrls alongside credentials', async () => {
    const cfg = await loadConfig();
    await saveCredential(cfg, 'deezer', 'arl-value');
    await saveRecentUrl('https://open.spotify.com/playlist/abc');
    const reloaded = await loadConfig();
    expect(credential(reloaded, 'deezer')).toBe('arl-value');
    expect(reloaded.recentUrls).toEqual(['https://open.spotify.com/playlist/abc']);
  });
});

describe('environment overrides', () => {
  it('lets the per-provider env var win over the stored credential', async () => {
    await storedFile({ credentials: { deezer: 'stored-arl', spotify: 'stored-dc' } });
    process.env.DEEZER_ARL = 'env-arl';
    const cfg = await loadConfig();
    expect(credential(cfg, 'deezer')).toBe('env-arl');
    expect(credential(cfg, 'spotify')).toBe('stored-dc'); // unset env leaves the stored one alone
  });

  it('supplies a credential from env with nothing stored at all', async () => {
    process.env.SPOTIFY_DC = 'env-dc';
    expect(credential(await loadConfig(), 'spotify')).toBe('env-dc');
  });
});

describe('the old two-key credential shape', () => {
  it('is flagged rather than migrated or crashed on', async () => {
    await storedFile({ deezerArl: 'old-arl', spotifyDc: 'old-dc', recentUrls: ['keep-me'] });
    const cfg = await loadConfig();
    expect(cfg.legacyCredentials).toBe(true);
    expect(credential(cfg, 'deezer')).toBe(''); // ignored, not carried over
    expect(cfg.recentUrls).toEqual(['keep-me']); // non-credential state still survives
  });

  it('is dropped from the file on the next write', async () => {
    await storedFile({ deezerArl: 'old-arl', spotifyDc: 'old-dc' });
    await saveCredential(await loadConfig(), 'deezer', 'new-arl');
    const stored = await readStored();
    expect(stored.credentials).toEqual({ deezer: 'new-arl' });
    expect(stored).not.toHaveProperty('deezerArl');
    expect(stored).not.toHaveProperty('spotifyDc');
  });

  it('is not flagged once credentials are in the new shape', async () => {
    await storedFile({ credentials: { deezer: 'arl' } });
    expect((await loadConfig()).legacyCredentials).toBe(false);
  });

  it('is not flagged on a first run with no file', async () => {
    expect((await loadConfig()).legacyCredentials).toBe(false);
  });
});

describe('browser auto-fill', () => {
  it('fills and persists only the providers that have no credential yet', async () => {
    await storedFile({ credentials: { deezer: 'stored-arl' } });
    browserFinds({ deezer: 'browser-arl', spotify: 'browser-dc' });
    const cfg = await loadConfig();
    expect(await tryAutoFillCredentials(cfg)).toEqual(['spotify']);
    expect(credential(cfg, 'deezer')).toBe('stored-arl'); // stored wins
    expect((await readStored()).credentials).toEqual({ deezer: 'stored-arl', spotify: 'browser-dc' });
  });

  it('replaces everything it finds when overwriting', async () => {
    await storedFile({ credentials: { deezer: 'stored-arl' } });
    browserFinds({ deezer: 'browser-arl' });
    const cfg = await loadConfig();
    expect(await tryAutoFillCredentials(cfg, true)).toEqual(['deezer']);
    expect(credential(cfg, 'deezer')).toBe('browser-arl');
  });

  it('does not touch the browser when every provider already has one', async () => {
    await storedFile({ credentials: { deezer: 'a', spotify: 'b' } });
    await tryAutoFillCredentials(await loadConfig());
    expect(fetchBrowserCredentials).not.toHaveBeenCalled(); // no keychain dialog for nothing
  });

  it('reports nothing filled when the browser yields nothing', async () => {
    expect(await tryAutoFillCredentials(await loadConfig())).toEqual([]);
  });
});
