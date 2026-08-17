import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { PROVIDERS, inferSource, providerFor, providerKeys } from '../src/registry.js';

describe('parseArgs', () => {
  it('takes a link plus an explicit target provider', () => {
    const options = parseArgs(['--url', 'https://open.spotify.com/playlist/abc', '--to', 'deezer']);
    expect(options.urls).toEqual(['https://open.spotify.com/playlist/abc']);
    expect(options.target).toBe('deezer');
    expect(options.dryRun).toBe(false);
  });

  it('accepts the short and inline forms', () => {
    expect(parseArgs(['-u', 'abc', '-t', 'spotify']).target).toBe('spotify');
    expect(parseArgs(['--url=abc', '--to=deezer']).target).toBe('deezer');
    expect(parseArgs(['--dry-run', '-d']).dryRun).toBe(true);
  });

  it('leaves the target unset when none is given, rather than defaulting to one', () => {
    expect(parseArgs(['--url', 'abc']).target).toBeNull();
  });

  it('collects repeated links and keeps the output path', () => {
    const options = parseArgs(['-u', 'one', '-u', 'two', '-o', 'out.csv']);
    expect(options.urls).toEqual(['one', 'two']);
    expect(options.output).toBe('out.csv');
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown flag/);
  });
});

describe('inferSource', () => {
  it.each([
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'spotify'],
    ['spotify:playlist:abc123', 'spotify'],
    ['https://www.deezer.com/en/playlist/1234567890', 'deezer'],
    ['https://link.deezer.com/s/abc', 'deezer'],
    ['HTTPS://OPEN.SPOTIFY.COM/playlist/abc', 'spotify'],
  ])('reads the provider off %s', (link, key) => {
    expect(inferSource(link)?.key).toBe(key);
  });

  it('returns nothing for a link it cannot place, so the caller can say so', () => {
    expect(inferSource('https://music.example.com/playlist/1')).toBeUndefined();
    expect(inferSource('just-a-bare-id')).toBeUndefined();
  });
});

describe('the provider registry', () => {
  it('looks a provider up by key, case-insensitively', () => {
    expect(providerFor('deezer')?.label).toBe('Deezer');
    expect(providerFor('Spotify')?.label).toBe('Spotify');
    expect(providerFor('napster')).toBeUndefined();
  });

  it('names its valid targets for the error message', () => {
    expect(providerKeys()).toEqual(['spotify', 'deezer']);
  });

  // Every direction is source × target minus the identity pairs: 2 providers → 2, 3 → 6.
  it('offers every ordered pair of distinct providers as a direction', () => {
    const directions = PROVIDERS.flatMap((s) => PROVIDERS.filter((t) => t !== s).map((t) => `${s.key}->${t.key}`));
    expect(directions).toEqual(['spotify->deezer', 'deezer->spotify']);
    expect(directions).toHaveLength(PROVIDERS.length * (PROVIDERS.length - 1));
  });

  it('gives every provider the fields the menu and command line read', () => {
    for (const p of PROVIDERS) {
      expect(p.key).toMatch(/^[a-z]+$/);
      expect(p.label).toBeTruthy();
      expect(p.matches.length).toBeGreaterThan(0);
      expect(p.credentialLabel).toBeTruthy();
      expect(p.credentialHint).toBeTruthy();
    }
  });
});
