# Providers own search; the matcher owns the match rules

Each provider implements `search(track) → Match | null` and owns its own search strategy: Deezer cascades free-text, then field syntax, then an artist-album crawl; YouTube Music searches songs before falling back to music videos. The shared matcher owns the rules that decide whether a candidate *is* the track — normalization, the tier ladder, duration tolerance. Providers call into the matcher; it never calls them.

The rejected alternative was for providers to return raw candidates and let a single shared conversion loop do all the matching. That is more uniform, but the per-provider cascades are *search strategies*, not *match rules* — forcing them into a generic loop would either flatten them away or make the loop know about each provider by name. Splitting on "how do I find candidates" versus "is this candidate the track" keeps the provider-specific half behind the provider's own interface and the half that must stay consistent, and that `tests/matcher.test.ts` pins, in one place.

The consequence: a provider can produce a match tier no other provider produces — YouTube Music's video tier is the first. The tier vocabulary is open, not a closed enum shared by all providers.
