// Must match DEFAULT_SYNC_PORT in src/sync-server.ts — an extension cannot import from the CLI.
const PLX_SYNC_URL = 'http://127.0.0.1:45678/sync';

// The extension only ships raw cookie rows for the provider domains; which cookies matter, which
// host wins when a name is set on several, and how YouTube Music's bundle is joined are all decided
// by the CLI (src/browser.ts), so there is one copy of those rules to keep current.
const PROVIDER_DOMAINS = ['spotify.com', 'deezer.com', 'youtube.com', 'google.com'];

async function collectCookies() {
  const perDomain = await Promise.all(
    PROVIDER_DOMAINS.map((domain) => chrome.cookies.getAll({ domain }).catch(() => [])),
  );
  return perDomain.flat().map(({ name, domain, value }) => ({ name, domain, value }));
}

// A preview for the badges only — the CLI makes the real call and reports what it accepted.
// YouTube Music counts only with a SAPISID variant on youtube.com itself, so a Google login with no
// YouTube session does not show as logged in.
function sessionsPresent(cookies) {
  const has = (domain, test) => cookies.some((c) => (c.domain === domain || c.domain.endsWith(`.${domain}`)) && test(c.name));
  return {
    spotify: has('spotify.com', (n) => n === 'sp_dc'),
    deezer: has('deezer.com', (n) => n === 'arl'),
    ytmusic: has('youtube.com', (n) => ['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID'].includes(n)),
  };
}

const LABELS = { spotify: 'Spotify', deezer: 'Deezer', ytmusic: 'YouTube Music' };
const HOW_TO_LISTEN = 'In your terminal, run plx and choose “Sync via Browser Extension”.';

function updateState(provider, found) {
  const el = document.getElementById(`${provider}-state`);
  el.dataset.state = found ? 'found' : 'missing';
  el.textContent = found ? 'Logged in' : 'Not logged in';
}

function showMessage(text, tone = 'info') {
  const el = document.getElementById('message');
  el.dataset.tone = tone;
  el.textContent = text;
}

function setButton(btn, label, state, disabled) {
  btn.textContent = label;
  btn.dataset.state = state;
  btn.disabled = disabled;
}

document.addEventListener('DOMContentLoaded', async () => {
  const syncBtn = document.getElementById('btn-sync');
  document.getElementById('endpoint').textContent = new URL(PLX_SYNC_URL).host;
  document.getElementById('version').textContent = chrome.runtime.getManifest().version;

  const cookies = await collectCookies();
  const present = sessionsPresent(cookies);
  for (const provider of Object.keys(LABELS)) updateState(provider, present[provider]);

  const count = Object.values(present).filter(Boolean).length;
  if (count === 0) {
    showMessage('Log in to Spotify, Deezer or YouTube Music in this browser, then reopen this popup.');
    return; // the button stays disabled: there is nothing to send
  }
  setButton(syncBtn, 'Sync to plx', 'idle', false);
  showMessage(`${HOW_TO_LISTEN} Then sync.`);

  syncBtn.addEventListener('click', async () => {
    setButton(syncBtn, 'Syncing…', 'busy', true);
    showMessage(`Connecting to plx on ${new URL(PLX_SYNC_URL).host}…`);

    let res;
    try {
      res = await fetch(PLX_SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies }),
      });
    } catch {
      showMessage(`plx isn’t listening. ${HOW_TO_LISTEN}`, 'error');
      setButton(syncBtn, 'Try again', 'idle', false);
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const names = (data.received ?? []).map((key) => LABELS[key] ?? key).join(', ');
      showMessage(`Sent ${names}. Check your terminal.`, 'success');
      setButton(syncBtn, 'Synced', 'done', true);
    } else {
      showMessage(`plx refused the sync: ${data.error ?? `HTTP ${res.status}`}.`, 'error');
      setButton(syncBtn, 'Try again', 'idle', false);
    }
  });
});
