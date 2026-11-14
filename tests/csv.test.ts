import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReportRow } from '../src/types.js';

// The real writeFile, except into one directory that answers like C:\Windows\system32 does.
const blocked = { dir: '' };
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      if (blocked.dir && String(args[0]).startsWith(blocked.dir)) throw Object.assign(new Error(`EPERM: operation not permitted, open '${String(args[0])}'`), { code: 'EPERM' });
      return actual.writeFile(...args);
    }),
  };
});

const { writeCsv } = await import('../src/csv.js');
const row: ReportRow = { playlist: 'P', title: 'Song', artist: 'Artist', isrc: null, matched: true, target_id: '1', method: 'exact', note: null, source: 'Spotify', target: 'Deezer' };

afterEach(() => { blocked.dir = ''; vi.restoreAllMocks(); });

describe('writeCsv into an unwritable directory', () => {
  it('writes where asked when it can, and says where', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plx-'));
    const path = join(dir, 'conversion_report.csv');
    expect(await writeCsv(path, [row], [])).toBe(resolve(path));
  });

  it('falls back to the next writable directory under the same name', async () => {
    const denied = await mkdtemp(join(tmpdir(), 'plx-denied-'));
    const home = await mkdtemp(join(tmpdir(), 'plx-home-'));
    blocked.dir = denied;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const landed = await writeCsv(join(denied, 'conversion_report.csv'), [row], [home]);
    expect(landed).toBe(join(home, 'conversion_report.csv'));
    expect(await readFile(landed, 'utf8')).toContain('P,Spotify,Deezer,Song,Artist,,true,1,exact,');
    expect(log.mock.calls[0][0]).toContain('EPERM');
  });

  it('rethrows the original error when no directory is writable', async () => {
    const denied = await mkdtemp(join(tmpdir(), 'plx-denied-'));
    blocked.dir = denied;
    await expect(writeCsv(join(denied, 'r.csv'), [row], [join(denied, 'sub')])).rejects.toMatchObject({ code: 'EPERM' });
  });
});
