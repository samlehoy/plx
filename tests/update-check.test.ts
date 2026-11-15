import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNewer, updateNotice } from '../src/update-check.js';

describe('isNewer', () => {
  it.each([
    ['0.2.1', '0.2.0', true],
    ['0.10.0', '0.9.9', true],
    ['1.0.0', '0.99.99', true],
    ['0.2.0', '0.2.0', false],
    ['0.1.9', '0.2.0', false],
    ['1.0.0-rc.1', '0.2.0', false],
    ['garbage', '0.2.0', false],
  ])('%s over %s → %s', (latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected);
  });
});

describe('updateNotice', () => {
  const realTTY = process.stdout.isTTY;
  const tty = (value: boolean) => Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); tty(realTTY); });

  const registry = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));

  it('names the newer version and how to install it', async () => {
    tty(true);
    registry({ version: '0.3.0' });
    expect(await updateNotice('0.2.0')).toContain('plx 0.3.0 is available (you have 0.2.0)');
  });

  it('stays silent when up to date, offline, opted out, or not on a terminal', async () => {
    tty(true);
    registry({ version: '0.2.0' });
    expect(await updateNotice('0.2.0')).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await updateNotice('0.2.0')).toBeNull();

    registry({ version: '9.9.9' });
    vi.stubEnv('NO_UPDATE_NOTIFIER', '1');
    expect(await updateNotice('0.2.0')).toBeNull();
    vi.unstubAllEnvs();

    tty(false);
    expect(await updateNotice('0.2.0')).toBeNull();
  });
});
