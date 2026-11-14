import { writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { ReportRow } from './types.js';

const fields = ['playlist', 'source', 'target', 'title', 'artist', 'isrc', 'matched', 'target_id', 'method', 'note'] as const;
const cell = (value: unknown) => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

// Errors that mean "this directory is not ours to write", not "the disk is broken". The usual case
// is a relative default resolved against a working directory the user never chose: a terminal
// opened as administrator, or Win+R, starts in C:\Windows\system32.
const UNWRITABLE = new Set(['EPERM', 'EACCES', 'EROFS']);

// Writes the report and returns the absolute path it actually landed at. A path that cannot be
// written falls back to the home directory, then the temp directory, under the same file name —
// the report is the record of a conversion that already happened, so it is never thrown away for
// want of a writable folder.
export async function writeCsv(path: string, rows: ReportRow[], fallbackDirs: string[] = [homedir(), tmpdir()]): Promise<string> {
  const lines = [fields.join(','), ...rows.map((row) => fields.map((field) => cell(row[field])).join(','))];
  const content = `${lines.join('\n')}\n`;
  const candidates = [resolve(path), ...fallbackDirs.map((dir) => join(dir, basename(path)))];
  let first: unknown;
  for (const candidate of candidates) {
    try {
      await writeFile(candidate, content, 'utf8');
      if (first) console.log(`⚠️ Could not write the report to ${candidates[0]} (${(first as NodeJS.ErrnoException).code}); saved it to ${candidate} instead.`);
      return candidate;
    } catch (error) {
      if (!UNWRITABLE.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      first ??= error;
    }
  }
  throw first;
}
