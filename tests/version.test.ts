import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const { version } = json('package.json') as { version: string };

// The npm CLI, the Companion extension and the website ship as one version: root package.json's.
// release-please bumps it and the extension manifest together (release-please-config.json); this is
// what notices when a manual edit or a new config entry let them drift.
describe('one project version', () => {
  it('is carried by the extension manifest', () => {
    expect(json('extension/manifest.json').version).toBe(version);
  });

  it('is never duplicated into the website package, which reads the root one at build time', () => {
    expect(json('web/package.json').version).toBeUndefined();
  });

  it('is what `plx --version` prints', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], { encoding: 'utf8' });
    expect(out.trim()).toBe(version);
  });
});
