import type { Candidate } from './types.js';

// Parsing for YouTube Music's InnerTube responses, split out from transport so it can be pinned by
// fixtures recorded from the real service. The renderer nesting is ~6 levels deep and is not a
// contract: everything here reads defensively and returns nothing rather than throwing.

// A playlist entry or search result, in this provider's own terms.
export type YtItem = {
  videoId: string;
  // The opaque per-item handle a reorder moves. The same song added twice has two of them, which is
  // why it can never key the conversion interface (ADR 0002). Present only on playlist reads.
  setVideoId?: string;
  title: string;
  // For a song this is the artist; for a music video it is the uploading channel, which is exactly
  // why a music video's metadata is not trusted.
  artist: string;
  durationSec: number | null;
  isSong: boolean;
};

// Only a catalog release (ATV) counts as a song. Everything else — an official music video, an
// official-source upload, a user upload, a podcast — is a video whose stated artist is the channel.
// An entry with no type at all is an unavailable/removed track and is treated the same way.
const SONG_TYPE = 'MUSIC_VIDEO_TYPE_ATV';

type Runs = { runs?: Array<{ text?: string }> };
const runsText = (t: Runs | undefined) => t?.runs?.map((r) => r.text ?? '').join('') ?? '';

// "3:49" → 229, "1:02:03" → 3723. Anything that is not a clock reading is null, *not* zero — a
// playlist read has a duration column and a search result does not, and callers tell the two apart
// by null. Returning 0 for an empty column silently swallows the fallback.
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(:[0-5]?\d)+$/.test(trimmed)) return null;
  return trimmed.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
}

type Renderer = {
  flexColumns?: Array<{ musicResponsiveListItemFlexColumnRenderer?: { text?: Runs } }>;
  fixedColumns?: Array<{ musicResponsiveListItemFixedColumnRenderer?: { text?: Runs } }>;
  playlistItemData?: { videoId?: string; playlistSetVideoId?: string };
  overlay?: { musicItemThumbnailOverlayRenderer?: { content?: { musicPlayButtonRenderer?: { playNavigationEndpoint?: WatchEndpoint } } } };
};
type WatchEndpoint = { watchEndpoint?: { videoId?: string; watchEndpointMusicSupportedConfigs?: { watchEndpointMusicConfig?: { musicVideoType?: string } } } };

// Every musicResponsiveListItemRenderer anywhere in the response. The path to them differs between
// a playlist browse, a search, and a continuation, and none of those paths is stable, so this walks.
export function renderers(node: unknown, found: Renderer[] = []): Renderer[] {
  if (!node || typeof node !== 'object') return found;
  const record = node as Record<string, unknown>;
  if (record.musicResponsiveListItemRenderer) found.push(record.musicResponsiveListItemRenderer as Renderer);
  for (const child of Object.values(record)) renderers(child, found);
  return found;
}

// The continuation token for the next page, if the response has one.
export function continuationToken(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  const token = (record.continuationItemRenderer as { continuationEndpoint?: { continuationCommand?: { token?: string } } } | undefined)
    ?.continuationEndpoint?.continuationCommand?.token;
  if (token) return token;
  for (const child of Object.values(record)) {
    const found = continuationToken(child);
    if (found) return found;
  }
  return null;
}

export function playlistTitle(response: unknown): string {
  const micro = (response as { microformat?: { microformatDataRenderer?: { title?: string } } })?.microformat;
  return micro?.microformatDataRenderer?.title ?? '';
}

function parseItem(renderer: Renderer): YtItem | null {
  const watch = renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint;
  const videoId = renderer.playlistItemData?.videoId ?? watch?.videoId;
  if (!videoId) return null;
  const columns = renderer.flexColumns?.map((c) => runsText(c.musicResponsiveListItemFlexColumnRenderer?.text)) ?? [];
  const title = columns[0] ?? '';
  if (!title) return null;

  // A playlist read puts the duration in its own fixed column. A search result has no fixed column
  // and instead trails it on the subtitle line: "Artist • Album • 3:49" (song), or
  // "Channel • 178M views • 4:10" (video). Either way the duration is the last •-separated part.
  const fixed = runsText(renderer.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text);
  const subtitleParts = (columns[1] ?? '').split('•').map((s) => s.trim()).filter(Boolean);
  const trailing = subtitleParts.length > 1 ? subtitleParts[subtitleParts.length - 1] : '';
  const durationSec = parseDuration(fixed) ?? parseDuration(trailing);

  return {
    videoId,
    setVideoId: renderer.playlistItemData?.playlistSetVideoId,
    title,
    artist: subtitleParts[0] ?? '',
    durationSec,
    isSong: watch?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType === SONG_TYPE,
  };
}

export function parseItems(response: unknown): YtItem[] {
  return renderers(response).flatMap((r) => parseItem(r) ?? []);
}

export const toCandidate = (item: YtItem): Candidate => ({ id: item.videoId, title: item.title, artist: item.artist, duration: item.durationSec });
