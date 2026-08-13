import { describe, expect, it } from 'vitest';
import { parsePlaylistId } from '../src/spotify.js';

describe('parsePlaylistId', () => {
  it('extracts id from URL, URI, and raw', () => {
    expect(parsePlaylistId('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe('37i9dQZF1DXcBWIGoYBM5M');
    expect(parsePlaylistId('spotify:playlist:abc123')).toBe('abc123');
    expect(parsePlaylistId('abc123')).toBe('abc123');
  });
});
