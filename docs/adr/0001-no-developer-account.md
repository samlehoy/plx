# No developer account for any provider

plx reads and writes every provider through its unofficial web endpoints, authenticated by a browser session credential taken from the user's already-logged-in browser. It never uses an official API that requires the user to register a developer application — not a Spotify Client ID/Secret, and not a Google Cloud OAuth client for YouTube Music.

The trade-off is deliberate. Official APIs are more stable and better documented, and YouTube Music in particular has a supported path via the YouTube Data API. We reject it because registering a developer application is friction a personal tool cannot justify, and because it makes the tool's reach depend on quota and app-review policy rather than on what the user can already see in their own browser. The costs we accept: unversioned endpoints that change without notice, per-provider auth quirks (Spotify's rotating TOTP secret, Google's `SAPISIDHASH` over a cookie bundle), and session cookies that expire far sooner than an OAuth refresh token would.

This is a property of every provider, present and future — a service that cannot be driven from a browser session does not get added.
