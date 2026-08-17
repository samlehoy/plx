# Reordering is an optional provider capability

Providers disagree about playlist ordering. Deezer reorders by track id. YouTube Music reorders by an opaque per-item handle (`setVideoId`), which is not the track id — the same song added twice has two handles. Spotify exposes no reorder primitive at all through the endpoints plx uses; it can only append to the bottom.

We model reorder as an **optional capability** keyed on track id: a provider that can reorder implements it and does its own internal handle lookup, and a conversion whose target cannot reorder simply skips the order sync. The rejected alternative was to make every provider expose `{ trackId, handle }` pairs and always reorder by handle. That would be uniform, but it enlarges the model for all three providers to accommodate one, and Spotify still could not reorder — so the uniformity buys nothing today.

The consequence to know about: converting into a Spotify target is dedupe-and-append, not a 1:1 order sync, and this is deliberate rather than an oversight. If Spotify ever gains a usable reorder primitive, it implements the same optional method and the behaviour changes with no interface change.
