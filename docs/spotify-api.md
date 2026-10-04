# Spotify Web API: what this server can use

Tested 2026-10-03 against a Development Mode app, using a user token with the playlist, library and playback scopes. Spotify changed Development Mode on 2026-02-11 for new apps, and moved existing apps over by 2026-03-09. See the [migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and [announcement](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security). Re-test anything here before relying on it; Spotify has changed this API twice in two years.

## What works

| Need | Call | Notes |
|---|---|---|
| A label's recent releases | `GET /search?type=album&q=label:"Critical Music" tag:new` | `tag:new` means released in the last two weeks. That's enough for runs every 3–4 days. Returned 4 Critical releases from 2026-10-02 |
| A label's releases for a period | `q=label:"Critical Music" year:2026` (or `year:2025-2026`) | Results are **not** sorted by date; page through them all and filter on `release_date`. 49 results for Critical in 2026 |
| An artist's releases | `GET /artists/{id}/albums?include_groups=album,single` | Has `release_date` and `release_date_precision`. Resolve the artist id once by search, then cache it |
| A release's tracks | `GET /albums/{id}/tracks` | |
| One album, with its label | `GET /albums/{id}` | `label` was removed, but `copyrights` is still there and its ℗ line usually names the label ("2026 Arrival Archetype") |
| Exact track lookup | `q=track:"Chatter" artist:"Sully"` (type `track`) | Precise. `album:"…"` and `label:"…"` narrow it further. Found "Minimalist — Reborn", which a plain search had missed the day before |
| Create a playlist | `POST /me/playlists` | Replaces `POST /users/{id}/playlists` |
| Read or add playlist items | `GET` / `POST /playlists/{id}/items` | Replaces `/tracks`, which now returns 403. Items come back under `item`, not `track` |
| The user's playlists | `GET /me/playlists` | |

## What's gone

| Removed | Effect on the design |
|---|---|
| `GET /browse/new-releases` (403) | No genre-wide "what's new"; the feed has to go label by label and artist by artist |
| `GET /artists/{id}/related-artists` (403) and `/recommendations` (404) | No "similar artists" from Spotify; that stays with the web research |
| `GET /artists/{id}/top-tracks` (403) | Not needed |
| `genres` on artists (absent) and `genre:` search (always empty) | Core artists can't be sorted into lanes by genre. Lanes list their artists in `lanes.json` and learn more from picks |
| `label` on albums | Use `label:` in search, or the ℗ line in `copyrights` |
| `popularity` and `followers` | Can't rank by how underground something is |
| Batch `GET /tracks`, `/albums`, `/artists` | One request per item; still fine at this scale |
| `external_ids` on tracks (ISRC) | Dedup can't use ISRC. Use the URI plus a normalized artist and title key |

## Limits

- **Search `limit` is at most 10** (the default is now 5). `limit=11` returns `400 Invalid limit`. Page with `offset`; `limit + offset` must stay at or below 1000.
- `total` on the first page can be wrong: it reported 10 at offset 0, then 49 on later pages. Page until a page comes back short; don't trust `total`.
- **The app owner needs Spotify Premium.** New apps get 1 client ID per developer and 5 users per app.
- No rate-limit headers appeared during testing. Handle `429` with `Retry-After` anyway.

## Picking the right version of a track

`track:"TWOSTEP" artist:"Riordan"` returns the original single and four compilations that include it (EDC Las Vegas 2025, "Best Of Insomniac Records: 2025", and so on). Prefer, in order:

1. a matching `album:` if the source named the release,
2. `album_type` single or album over compilation,
3. the earliest `release_date`.

Spotify may also relink a track when it's added to a playlist, so the URI in the playlist can differ from the one added (seen 2026-10-02 with Galaxians, "Worlds Apart"). When checking whether a track is already in the playlist, compare normalized artist and title as well as the URI.

## Auth

PKCE with a loopback redirect, as Hermes's own Spotify login does. Because of the one-client-ID limit, this server will probably have to use **the same client ID** as Hermes. It would still get **its own grant and refresh token**, stored in its own file, so neither client's refreshes can invalidate the other's. The redirect URI has to be registered on the app; Hermes's is `http://127.0.0.1:43827/spotify/callback`.

Unverified: whether a second grant for the same app and user leaves the first refresh token working. Spotify normally allows several. Check after the first login that Hermes's Spotify tools still work.
