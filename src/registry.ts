import { DeezerClient, resolveDeezerPlaylistId } from './deezer.js';
import { SpotifyProvider, anonymousToken, authenticatedToken, parsePlaylistId, playlistName } from './spotify.js';
import { validateSession } from './ytmusic.js';
import type { Provider } from './types.js';

// Everything the CLI needs to know about a provider that is not part of converting: what to call it,
// which links belong to it, how to ask for its credential, and how to build it from one.
//
// This is the single list the interactive menu and the command line both drive off, which is why
// neither grows an entry when a provider is added — adding one means adding a ProviderSpec here.
export type ProviderSpec = {
  key: string;
  label: string;
  // Link hosts and URI prefixes that identify this provider, for inferring a source from a link.
  matches: string[];
  credentialLabel: string;
  credentialHint: string;
  loginSite: string;
  // Whether this provider can read a playlist with no credential at all (so a dry run needs none).
  anonymousRead: boolean;
  // Whether this provider can take part in a conversion yet. A provider whose credential works but
  // whose read/write side is not built is offered in Credentials and hidden from Convert, so it is
  // never picked as a direction that cannot run. Drop the flag once every provider is convertible.
  convertible: boolean;
  // Prove the stored credential against the live service, resolving to something to show the user
  // (an account name, say). Throws with a specific message when the session is expired or rejected.
  validate(credential: string): Promise<string>;
  // A pasted link, URI, or bare id → the id this provider's own methods take.
  parseRef(ref: string): Promise<string>;
  // Display name for a playlist known only by id. Not every provider can resolve one cheaply.
  playlistName(id: string): Promise<string>;
  // Build the provider. `credential` is '' when none is stored; providers that cannot read
  // anonymously are never asked to build without one.
  create(credential: string): Promise<Provider>;
};

const spotify: ProviderSpec = {
  key: 'spotify',
  label: 'Spotify',
  matches: ['open.spotify.com', 'spotify:playlist:'],
  credentialLabel: 'Spotify sp_dc',
  credentialHint: 'login open.spotify.com → F12 → Application → Cookies → sp_dc → copy value',
  loginSite: 'Spotify (open.spotify.com)',
  anonymousRead: true,
  convertible: true,
  parseRef: async (ref) => parsePlaylistId(ref),
  playlistName,
  // An sp_dc mints a full search+write token; without one the anonymous token still reads public
  // playlists, which is what makes a credential-free dry run possible.
  create: async (cred) => new SpotifyProvider(cred ? await authenticatedToken(cred) : await anonymousToken()),
  validate: async (cred) => { await authenticatedToken(cred); return 'session accepted'; },
};

const deezer: ProviderSpec = {
  key: 'deezer',
  label: 'Deezer',
  matches: ['deezer.com', 'link.deezer.com'],
  credentialLabel: 'Deezer ARL',
  credentialHint: 'login deezer.com → F12 → Application → Cookies → arl → copy value',
  loginSite: 'Deezer (deezer.com)',
  // Deezer's search is public, but reading a *playlist* goes through the authenticated GraphQL API.
  anonymousRead: false,
  convertible: true,
  parseRef: resolveDeezerPlaylistId,
  playlistName: async (id) => id,
  validate: async (cred) => `account ${(await new DeezerClient(cred).getMe()).id}`,
  create: async (cred) => {
    const client = new DeezerClient(cred);
    // Fail fast on an expired ARL rather than midway through a conversion. With no credential at
    // all this is a search-only client — enough for a dry run, since Deezer's search is public.
    if (cred) await client.getMe();
    return client;
  },
};

const ytmusic: ProviderSpec = {
  key: 'ytmusic',
  label: 'YouTube Music',
  // A YouTube Music playlist id *is* a YouTube playlist id, so both hosts name the same thing.
  matches: ['music.youtube.com', 'youtube.com'],
  credentialLabel: 'YouTube Music cookies',
  credentialHint: 'login music.youtube.com → F12 → Network → any request → Request Headers → copy the whole "cookie:" value',
  loginSite: 'YouTube Music (music.youtube.com)',
  anonymousRead: false,
  // Reading and writing land in #7 and #8; this release only proves the credential works.
  convertible: false,
  parseRef: async (ref) => new URL(ref, 'https://music.youtube.com').searchParams.get('list') ?? ref.trim(),
  playlistName: async (id) => id,
  create: () => { throw new Error('Converting with YouTube Music is not built yet.'); },
  validate: validateSession,
};

export const PROVIDERS: ProviderSpec[] = [spotify, deezer, ytmusic];

// The providers that can actually take part in a conversion right now.
export const convertibleProviders = (): ProviderSpec[] => PROVIDERS.filter((p) => p.convertible);

export function providerFor(key: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.key === key.toLowerCase());
}

// The keys valid after --to. Only providers that can actually be written into are offered.
export const targetKeys = (): string[] => convertibleProviders().map((p) => p.key);

// Which provider a playlist link belongs to. The link already names its service, so a command line
// that gives one never has to restate the source.
export function inferSource(link: string): ProviderSpec | undefined {
  const ref = link.trim().toLowerCase();
  return PROVIDERS.find((p) => p.matches.some((m) => ref.includes(m)));
}
