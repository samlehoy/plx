import { fetchJson } from './http.js';

const LATEST_URL = 'https://registry.npmjs.org/plx-converter/latest';

// True when `latest` is a higher x.y.z than `current`. Anything else (a prerelease tag, a malformed
// answer) is not an update, so a bad registry reply can never nag.
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// One line telling the user a newer plx is on npm, or null. Never throws and never waits longer
// than `timeoutMs`: offline, a slow registry or an opt-out all mean silence, not an error.
export async function updateNotice(current: string, timeoutMs = 1500): Promise<string | null> {
  if (process.env.NO_UPDATE_NOTIFIER || !process.stdout.isTTY) return null;
  try {
    const { version } = await fetchJson<{ version: string }>(LATEST_URL, {}, timeoutMs);
    return isNewer(version, current) ? `⬆️ plx ${version} is available (you have ${current}). Update: npm i -g plx-converter@latest` : null;
  } catch {
    return null;
  }
}
