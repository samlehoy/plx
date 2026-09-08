import { describe, expect, it } from 'vitest';
import { firstArtist, matchByDuration, matchCandidates, matchDurationMs, normalize, stripFeat } from '../src/matcher.js';

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

// Candidate lists below are real Deezer /search responses for the Mandarin tracks that used to fail.
describe('matchByDuration', () => {
  it('matches a track the catalog lists under a translated title', () => {
    const result = matchByDuration('红线', '邹沛沛', 207000, [
      { id: '3792185551', title: '沉溺（你让我的心不再结冰）', artist: '邹沛沛', duration: 193 },
      { id: '3805061122', title: 'RED LINE', artist: '邹沛沛', duration: 206 },
      { id: '3714412171', title: '梦臆', artist: '邹沛沛', duration: 177 },
      { id: '3600296421', title: '惦念你', artist: '邹沛沛', duration: 163 },
    ]);
    expect(result?.title).toBe('RED LINE');
    expect(result?.method).toBe('duration-only');
  });
  it('accepts an artist name the target carries without its CJK suffix', () => {
    const result = matchByDuration('Jumping Machine (跳楼机)', 'LBI利比', 202000, [
      { id: '3348449311', title: 'Jumping Machine (跳楼机)', artist: 'LBI', duration: 201 },
      { id: '3348449321', title: 'Jumping Machine (跳楼机)', artist: 'LBI', duration: 185 },
    ]);
    expect(result?.id).toBe('3348449311');
  });
  it('drops a version-marked candidate so its plain twin stays unambiguous', () => {
    const candidates = [
      { id: '2001', title: 'estrangement', artist: 'yihuik', duration: 152 },
      { id: '2002', title: 'estrangement(Instrumental)', artist: 'yihuik', duration: 152 },
    ];
    expect(matchByDuration('都不懂', 'Yihuik苡慧', 153000, candidates)?.id).toBe('2001');
    // ...but a source that is itself a version keeps them both, and the tie is refused.
    expect(matchByDuration('都不懂 (Instrumental)', 'Yihuik苡慧', 153000, candidates)).toBeNull();
  });
  it('refuses a tie and refuses a source with no duration', () => {
    const twins = [
      { id: '3001', title: 'A', artist: '邹沛沛', duration: 206 },
      { id: '3002', title: 'B', artist: '邹沛沛', duration: 207 },
    ];
    expect(matchByDuration('红线', '邹沛沛', 207000, twins)).toBeNull();
    expect(matchByDuration('红线', '邹沛沛', null, [twins[0]])).toBeNull();
  });
  it('counts the same id found by two queries once', () => {
    const hit = { id: '3805061122', title: 'RED LINE', artist: '邹沛沛', duration: 206 };
    expect(matchByDuration('红线', '邹沛沛', 207000, [hit, hit])?.id).toBe('3805061122');
  });
  it('holds the 2s line that is all this tier has left', () => {
    const near = [{ id: '4001', title: 'RED LINE', artist: '邹沛沛', duration: 204 }];
    expect(matchByDuration('红线', '邹沛沛', 207000, near)).toBeNull();
  });
});
