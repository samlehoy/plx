import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpotifyProvider } from '../src/spotify.js';
import type { Track } from '../src/types.js';

// The "My Hanni" conversion (YouTube Music → Spotify) lost tracks Spotify does carry. The fixture
// holds each track as YouTube Music read it, and what Spotify's searchTracks returned for every term
// the provider sends — recorded from the live services, trimmed to the fields searchTrack reads.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/spotify/search-my-hanni.json'), 'utf8')) as { tracks: Track[]; responses: Record<string, unknown> };
const search = (name: string) => new SpotifyProvider('token').search(fixture.tracks.find((t) => t.name === name)!);

// Answer each search by its term; a term nobody recorded fails loudly rather than getting an answer.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const term = (JSON.parse(String(init?.body)) as { variables: { searchTerm: string } }).variables.searchTerm;
    const body = fixture.responses[term];
    if (!body) throw new Error(`no recorded response for "${term}"`);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('SpotifyProvider.search, on the tracks the My Hanni conversion lost', () => {
  it('matches a track YouTube Music credits as "A & B"', async () => {
    expect(await search('APT.')).toMatchObject({ id: 'spotify:track:4wJ5Qq0jBN4ajy7ouZIV1c', method: 'exact' });
  });

  it('matches a track whose artist YouTube Music writes in Hangul', async () => {
    expect(await search('당돌한 여자')).toMatchObject({ id: 'spotify:track:7AqScxClmkJdqHZjWSkKH8', method: 'title-only' });
  });

  it('finds a short title that free text buries under the artist\'s other hits', async () => {
    expect(await search('Pop')).toMatchObject({ id: 'spotify:track:0pMUFsi8eS2bEkIW0fePtI', method: 'exact' });
  });

  it('keeps the version a parenthesised tag names, and the original stays the original', async () => {
    expect((await search('Algorithm (Eng Ver.)'))?.id).toBe('spotify:track:219BWYqAdlhbNp9wHpXUkL');
    expect((await search('Cupid (Twin Version)'))?.id).toBe('spotify:track:5pMPNxZz50iup8cXchRHxm');
    expect((await search('Algorithm'))?.id).toBe('spotify:track:2tGjh54bikVc5x3dl1pUKx');
  });

  it('still lands the matches the conversion already got right', async () => {
    expect((await search('SPAGHETTI (Member ver.)'))?.id).toBe('spotify:track:07ZkZzMHE6EEbHD50WUrgk');
    expect((await search('Dimension (AAA Ver.)'))?.id).toBe('spotify:track:6gix4NyPtppr6x1DrncDfv');
    expect((await search('options'))?.id).toBe('spotify:track:5Y0vNP5f0uFXBevq5YU6cY');
    expect((await search('라비앙로즈 (La Vie en Rose)'))?.id).toBe('spotify:track:3WfaJhCL4p2JbdffJjV6Va');
    expect((await search('NEON'))?.id).toBe('spotify:track:5PvLNQRNRj61y3CU4SFIY4');
  });
});
