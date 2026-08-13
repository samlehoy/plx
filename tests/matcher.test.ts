import { describe, expect, it } from 'vitest';
import { firstArtist, matchCandidates, matchDurationMs, normalize, stripFeat } from '../src/matcher.js';

describe('matcher', () => {
  it('normalizes titles and accents', () => {
    expect(normalize('Song (Remastered 2021)')).toBe('song');
    expect(normalize('Café Éclair')).toBe('cafe eclair');
    expect(normalize('Artist [feat. Someone]')).toBe('artist someone');
  });
  it('handles artist features and duration units', () => {
    expect(firstArtist('Taylor Swift, Post Malone')).toBe('Taylor Swift');
    expect(stripFeat('Fortnight (feat. Post Malone)')).toBe('Fortnight');
    expect(matchDurationMs(320000, 320)).toBe(true);
    expect(matchDurationMs(320000, 320000)).toBe(false);
  });
  it('matches the correct tier', () => {
    const result = matchCandidates('Fortnight (feat. Post Malone)', 'Taylor Swift, Post Malone', 228965, [
      { id: '1002', title: 'Fortnight', artist: 'Taylor Swift', duration: 220 },
    ]);
    expect(result?.id).toBe('1002');
    expect(result?.method).toBe('fuzzy-duration');
  });
  it('ignores whitespace in artist names', () => {
    const result = matchCandidates('당돌한 여자', 'JIHYO', 185000, [
      { id: '673998072', title: '당돌한 여자', artist: 'Ji Hyo', duration: 185 },
    ]);
    expect(result?.id).toBe('673998072');
  });
});
