import { writeFile } from 'node:fs/promises';
import type { ReportRow } from './types.js';

const fields = ['playlist', 'source', 'target', 'title', 'artist', 'isrc', 'matched', 'target_id', 'method', 'note'] as const;
const cell = (value: unknown) => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export async function writeCsv(path: string, rows: ReportRow[]): Promise<void> {
  const lines = [fields.join(','), ...rows.map((row) => fields.map((field) => cell(row[field])).join(','))];
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}
