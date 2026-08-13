// Spike: find an authenticated Spotify token that can WRITE playlists.
// Usage: node scripts/spike-spotify-write.mjs
// Reads SPOTIFY_DC from the environment (do NOT paste the cookie into chat).
import 'dotenv/config';

const DC = process.env.SPOTIFY_DC;
if (!DC) {
  console.error('Set SPOTIFY_DC first. Windows: $env:SPOTIFY_DC="<cookie>"');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

async function main() {
  // Path A: get_access_token (was 403-blocked in testing — confirm it still is).
  const tok = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
    headers: { Cookie: `sp_dc=${DC}`, 'User-Agent': UA, Referer: 'https://open.spotify.com/' },
  });
  console.log('Path A (get_access_token):', tok.status, tok.headers.get('content-type') ?? '');
  if (tok.headers.get('content-type')?.includes('json')) {
    const d = await tok.json();
    console.log('  accessToken:', d.accessToken ? `ok (isAnonymous=${d.isAnonymous})` : 'MISSING');
  } else {
    console.log('  (non-JSON -> blocked)');
  }

  // Path B: embed page __NEXT_DATA__ session, with the sp_dc cookie attached.
  // If the session is the logged-in user, isAnonymous=false and the token can write.
  const embed = await fetch('https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC', {
    headers: { Cookie: `sp_dc=${DC}`, 'User-Agent': UA },
  });
  const html = await embed.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  console.log('Path B (embed __NEXT_DATA__):', embed.status, m ? 'found' : 'no __NEXT_DATA__');
  if (m) {
    const session = JSON.parse(m[1]).props?.pageProps?.state?.settings?.session;
    console.log('  isAnonymous:', session?.isAnonymous, '| accessToken len:', session?.accessToken?.length ?? 0);
    if (session?.isAnonymous === false) console.log('  -> AUTHENTICATED token found. Write path is viable.');
    else console.log('  -> still anonymous. Embed ignores the cookie; need DevTools capture (see README note).');
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
