import { describe, expect, it } from 'vitest';
import { fieldQuery, firstArtist, matchByDuration, matchByTitle, matchCandidates, matchDurationMs, normalize, songForVideo, stripFeat } from '../src/matcher.js';

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
  it('compares co-credited artists by the lead artist, on both sides', () => {
    // YouTube Music's one-string credit for a collaboration, against Spotify's lead artist alone...
    expect(matchCandidates('APT.', 'ROSÉ & Bruno Mars', 170000, [{ id: 's1', title: 'APT.', artist: 'ROSÉ', duration: 170 }])?.method).toBe('exact');
    // ...while a duo whose own name holds an ampersand still matches itself.
    expect(matchCandidates('Blind Faith', 'Chase & Status', 230000, [{ id: 's2', title: 'Blind Faith', artist: 'Chase & Status', duration: 230 }])?.method).toBe('exact');
  });
  it('prefers the candidate whose version tag survives, wherever it ranks', () => {
    const result = matchCandidates('Algorithm (Eng Ver.)', 'HeeJin', 188000, [
      { id: 'original', title: 'Algorithm', artist: 'HeeJin', duration: 188 },
      { id: 'english', title: 'Algorithm - Eng Ver.', artist: 'HeeJin', duration: 188 },
    ]);
    expect(result?.id).toBe('english');
  });
});

// Candidates below are from Spotify's real search for "지효 당돌한 여자".
describe('matchByTitle', () => {
  const jihyo = { id: 'spotify:track:7AqScxClmkJdqHZjWSkKH8', title: '당돌한 여자', artist: 'JIHYO', duration: 186 };
  const others = [
    { id: 'spotify:track:5BcoXaP58gi3zkW5I0SHkw', title: '당돌한 여자', artist: '서주경', duration: 220 },
    { id: 'spotify:track:4Fusm6QUe0sL0df2qmlVPy', title: '당돌한 여자', artist: '가수연맹', duration: 217 },
  ];
  it('matches the one same-titled recording at that length, whatever the artist is called', () => {
    expect(matchByTitle('당돌한 여자', '지효, 채영, 쯔위 & 나연', 186000, [jihyo, ...others])).toMatchObject({ id: jihyo.id, method: 'title-only' });
    expect(matchByTitle('당돌한 여자', '지효, 채영, 쯔위 & 나연', 186000, [jihyo, jihyo])?.id).toBe(jihyo.id); // found by two queries, still one
  });
  it('refuses a tie, a source with no duration, and a title that is only contained', () => {
    expect(matchByTitle('당돌한 여자', '지효, 채영, 쯔위 & 나연', 186000, [jihyo, { ...jihyo, id: 'twin', artist: 'Someone Else' }])).toBeNull();
    expect(matchByTitle('당돌한 여자', '지효', null, [jihyo])).toBeNull();
    expect(matchByTitle('당돌한', '지효', 186000, [jihyo])).toBeNull();
  });
  it('applies only across scripts, and takes one recording released twice', () => {
    // Two Latin names that differ are two artists: "Intro" by A is not "Intro" by B.
    expect(matchByTitle('Intro', 'Artist A', 62000, [{ id: 'b', title: 'Intro', artist: 'Artist B', duration: 61 }])).toBeNull();
    // A single and its album release: two ids, one artist.
    expect(matchByTitle('당돌한 여자', '지효', 186000, [jihyo, { ...jihyo, id: 'album' }])?.id).toBe(jihyo.id);
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

// The song a music video carries. The real cases are pinned against recorded YouTube Music searches
// in ytmusic-provider.test.ts; these pin the guards.
describe('songForVideo', () => {
  const song = (title: string, artist: string, duration: number) => ({ id: `${artist}/${title}`, title, artist, duration });
  it('wants the song title as whole words of the video title', () => {
    expect(songForVideo('ILLIT - Poppin (Official MV)', 'ILLIT', [song('Pop', 'ILLIT', 144)])).toBeNull();
    expect(songForVideo('NOT CUTE ANYMORE', 'ILLIT', [song('NOT CUTE ANYMORE (Sped up)', 'ILLIT', 103), song('NOT CUTE ANYMORE', 'ILLIT', 132)])?.id).toBe('ILLIT/NOT CUTE ANYMORE');
  });
  it('wants a lead artist the video title or channel names', () => {
    expect(songForVideo('Dark Arts (Lyrics)', 'LyricsHub', [song('Dark Arts', 'Bad Wires', 185)])).toBeNull();
    expect(songForVideo('aespa - Dark Arts (Lyrics)', 'LyricsHub', [song('Dark Arts', 'aespa', 182)])?.id).toBe('aespa/Dark Arts');
  });
  it('never takes a version tag or a guest for the song\'s other name', () => {
    expect(songForVideo('ILLIT - Magnetic (Sped Up)', 'ILLIT', [song('NOT CUTE ANYMORE (Sped up)', 'ILLIT', 103)])).toBeNull();
    expect(songForVideo('TsunamiCat - Cruel Summer (feat. Dangle)', 'TsunamiCat', [song('APT. (feat. Dangle)', 'TsunamiCat', 164)])).toBeNull();
    expect(songForVideo('La Vie en Rose', 'IZ*ONE', [song('라비앙로즈 (La Vie en Rose)', 'IZ*ONE (아이즈원)', 219)])?.id).toBe('IZ*ONE (아이즈원)/라비앙로즈 (La Vie en Rose)');
  });
  it('wants the artist as whole words, not inside another word', () => {
    expect(songForVideo('Love Me Again (Live)', 'Some Singer', [song('Love Me Again', 'V', 197), song('Love Me Again', 'IVE', 190)])).toBeNull();
    expect(songForVideo('V - Love Me Again', 'HYBE LABELS', [song('Love Me Again', 'V', 197)])?.id).toBe('V/Love Me Again');
  });
});

describe('fieldQuery', () => {
  it('drops the quotes that would end a field early, and an artist field with nothing in it', () => {
    expect(fieldQuery('The "Real" Thing', 'Band')).toBe('track:"The Real Thing" artist:"Band"');
    expect(fieldQuery('Pop', '')).toBe('track:"Pop"');
    expect(fieldQuery('APT.', 'ROSÉ & Bruno Mars')).toBe('track:"APT." artist:"ROSÉ & Bruno Mars"');
  });
});
