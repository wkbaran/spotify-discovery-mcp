# Track metadata beyond Spotify

Spotify gives a track's label (from the album's ℗ line) and ISRC, but no genre, BPM or key. See [spotify-api.md](spotify-api.md). These are the other sources, tested 2026-10-03 from the Hermes host on six tracks from the 2026-10-02 playlist:

- Sully — Chatter
- Riordan — TWOSTEP
- Galaxians — Worlds Apart
- Neonlight — Leaving Wonderland
- Skrimor — Kraken
- Zero — Take It Underground

## Summary

| Source | Access | Found | Genre detail | Also gives | Verdict |
|---|---|---|---|---|---|
| **Beatport** | Search page; the data is in `__NEXT_DATA__` JSON. No public API | 4 of 4 tried | Beatport genre ("Drum & Bass", "UK Garage / Bassline"), sometimes a sub-genre | BPM, key, label, release date, mix name | **Best for genre**; scraped, so fragile |
| **SoundCloud** | Track page; the data is in `window.__sc_hydration` JSON. API registration is closed | 3 of 3 URLs (from SearXNG) | Uploader's genre plus free tags ("neurofunk", "Jungle Breaks acid") | Label, ℗ line, **ISRC**, description, upload date | **Good**; the ISRC ties it to Spotify exactly. Needs the track's URL |
| **Discogs** | Official API. Works without a key at 25 requests/min; a free token allows 60/min | 4 of 8 releases | Genres plus styles ("Drum n Bass, Jungle", "UK Street Soul, Disco, Boogie, House") | Labels, formats, year | **Good, when it has the release**; new digital-only releases are often missing |
| **Bandcamp** | Album and track pages; tags are `<a class="tag">`. **Search is behind a JavaScript challenge** | 2 of 2 known URLs | Artist's or label's own tags ("glitch hop", "halftime", "street soul") | Description, location | **Good when the research already has the URL**; it can't be searched |
| **Deezer** | Official API, no key; `GET /track/isrc:<ISRC>` | 5 of 6 | Album genres are coarse and sometimes wrong (TWOSTEP: "Alternative, Indie Rock, Dance") | Label (correct for all 5); BPM is always 0 | Label backup only |
| **MusicBrainz** | Official API; ISRC lookup | 1 of 6 | None for that one | — | Not useful for new electronic releases |
| **SearXNG `!music`** | Hermes's own search | — | No genre fields | SoundCloud results bring the label's account, upload date and **the label's own description**; Genius lyric hits are mostly noise; the Bandcamp engine returned nothing; the Deezer engine is disabled but works with `engines=deezer` | Useful for finding SoundCloud URLs and text sources, not for genre |

### Examples

| Track | Beatport | SoundCloud | Discogs |
|---|---|---|---|
| Sully — Chatter | Drum & Bass, 83 BPM*, G min, Critical Music | Drum & Bass; Jungle Breaks acid | Drum n Bass, Jungle |
| Riordan — TWOSTEP | UK Garage / Bassline, 132 BPM, F min | — | House |
| Skrimor — Kraken | Drum & Bass, 87 BPM*, Hanzom Music | Drum & Bass; dnb, neurofunk | not found |
| Neonlight — Leaving Wonderland | Drum & Bass, 87 BPM*, Eatbrain | — | Drum n Bass |
| Galaxians — Worlds Apart | — | Electronic; "Indie Dance / Nu Disco" | UK Street Soul, Disco, Boogie, House |

\* Beatport lists drum and bass at half tempo (83–87 for tracks around 170). Double anything under 100 in a DnB genre before comparing.

## Using it in `verify_tracks`

Genre becomes a **check, not a filter**. It works like the label check:

1. Each lane in `lanes.json` gets `genres`: the Beatport genres that fit it, plus Discogs styles and tag words to accept. For example:
   - a-dnb: `["Drum & Bass"]`, tags `["neurofunk", "techstep", "halftime"]`
   - b-ukg: `["UK Garage / Bassline"]`
   - c-bass: `["Bass House", "Tech House"]`
2. For a verified track, look up Beatport by artist and title. Accept a result only if the artist and the ℗ label match Spotify's. If there's no match, try SoundCloud (when the research gave a URL), then Discogs.
3. The result line shows what was found: `W3 ✓ … · Beatport: Drum & Bass, 174 BPM`. When it doesn't fit the lane, it shows `genre: Hip-Hop on Beatport — check fit`. The model still decides.
4. The report can show genre and BPM for each pick. That's factual metadata, not a "sounds like" claim.

Feed items (K) can use the same lookup, which would give every feed pick a sourced line ("Beatport: Drum & Bass · Critical Music"). Together with the label's own SoundCloud description, found through SearXNG, that may settle the design's open question about fit notes for feed picks.

## Cautions

- **Beatport, SoundCloud and Bandcamp are scraped.** None has an open API: Beatport's API needs partner access, and SoundCloud has stopped registering apps. Page formats change without notice, and heavy use could get the Hermes host blocked. Keep it light: about one lookup per verified track, twice a week. Cache results by ISRC, and fail open (no genre line) when a page doesn't parse.
- Beatport search ranking is loose (searching "Sully Chatter" returned a 2009 hip-hop "Sully" first), so the artist and label check matters.
- Discogs asks API clients for a descriptive User-Agent, and a token is free. Use one.
