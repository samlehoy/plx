# plx

plx converts playlists between music services using the user's own logged-in browser session, never a developer account or an official API.

## Providers

**Provider**:
A music service plx can both read playlists from and write playlists to. Every provider is a peer — any provider can be the source of a conversion and any can be the target.
_Avoid_: service, platform, backend

**Source**:
The provider a conversion reads its playlist from.

**Target**:
The provider a conversion writes into, either as a new playlist or an existing one.

**Direction**:
An ordered pair of providers, source → target. Three providers means six directions.
_Avoid_: forward, reverse, flow

## Tracks and matching

**Track**:
One entry of a source playlist as read — title, artist, duration. Carries no provider id; a track is what plx searches *for*.

**Candidate**:
An entry returned by a target provider's search, under consideration as the match for a track.

**Match**:
The candidate accepted for a track, together with the tier that accepted it.

**Match tier**:
How strictly a candidate matched, from exact title+artist+duration down to looser fallbacks. Recorded on every match so a report reader can judge how much to trust it.
_Avoid_: method, strategy

**Song**:
An entry in a provider's music catalog — the canonical release of a recording.

**Music video**:
A YouTube Music entry backed by a video rather than a catalog release: official videos, live sets, covers, user uploads. In a source playlist it converts as the song it carries: the catalog song its title spells out, by an artist its title or channel names. A music video whose song the playlist also holds as a song is left out, and the song keeps its place. One that carries no catalog song is skipped. As a target candidate it is accepted only when no song matches, and always flagged.
_Avoid_: video, clip, UGC

## Credentials

**Browser session credential**:
The cookie or cookies plx reads from the user's already-logged-in browser in order to act as them on a provider. Never a developer API key, and never an OAuth client the user has to register.
_Avoid_: token, API key, auth
