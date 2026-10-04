# Design

The README explains how a lane run works and how picks are mixed. This page covers the tools, the files, and the behaviour behind them. [discovery-tools.md](discovery-tools.md) follows one run with a diagram, each tool's arguments and real output.

## Principles

These are the same as the digest servers', from [job-ledger](https://github.com/wkbaran/job-ledger/blob/main/docs/design.md):

- **The model judges; the server does the rest.** The server fetches, verifies, dedups, keeps limits, changes the playlist, saves state and lays out the report.
- **Refs, not data.** The model points at candidates with `K3` and `W2`. It never copies a URI, title or playlist id.
- **State is saved before the report is returned.** A run that stops after its last message loses nothing.
- **Side effects are idempotent.** Adding checks the live playlist, and creating today's playlist happens under a lock.
- **Results are plain text under 40,000 characters**, never JSON.

## Tools

All tools are registered only when `SPOTIFY_DISCOVERY_DIR` is set. Every path comes from the environment, never from tool arguments.

### `discovery_begin(lane)`

1. **Finds or creates today's playlist.** It takes `days.json.lock`; if today has no playlist, it creates `hermes<YYYYMMDD>` (private) with `POST /me/playlists` and records it. "Today" uses `SPOTIFY_DISCOVERY_TZ` (default `America/Denver`).
2. **Re-checks pending items** with exact searches; any that are now on Spotify join the pool.
3. **Fetches the feed** for this lane since its `last_run`:
   - each label (seed, found and promoted): `label:"…" tag:new` album search, paged; if `last_run` is more than 13 days ago, `label:"…" year:…` filtered by `release_date`;
   - each lane artist: `/artists/{id}/albums`, filtered by `release_date`;
   - each release's tracks, grouped by release;
   - for releases found through an artist, the label from the album's ℗ line. That's one extra request per release, so the work list can show the label for every item.
4. **Adds new candidates to the lane's pool**, skipping anything recommended before (history, by URI or by normalized key) or already picked, rejected or expired.
5. **Writes a run file** with refs, and returns the work list. `begin` changes nothing else; what it learned (expired items, pending re-checks, artist ids, active labels) is applied by `finish`.

[discovery-tools.md](discovery-tools.md#1-discovery_begin) shows a real result for a made-up lane.

The list is capped at `feed_cap` entries (default 25). Ordering is fixed: promoted labels, then lane artists, then seed labels, then found labels, then carried-over items, each group newest first. The rest are counted ("+9 more not shown") and stay in the pool.

### `verify_tracks(lane, text | candidates)`

`text`: the research subagent's reply, unchanged. The server parses it: one track per line, `artist | track | release | label | date | why | URL`, in any decoration (bullets, numbering, bold), with URLs and dates found wherever they sit, and `LABEL | name | URL | note` lines for new labels. The model doesn't have to retype anything, so it can't renumber or mangle the finds. `candidates`, the same fields as objects, is also accepted.

For each candidate the server:

1. tries exact searches in order, stopping at the first that matches:
   1. `track:"T" artist:"A"`
   2. adding `album:"R"`
   3. adding `label:"L"`
   4. a plain `A T` search, accepting only a strict artist match
2. checks the match: the artist key must contain the candidate's primary artist key, and the title keys must agree once edit and mix suffixes are removed;
3. picks the right version (see [spotify-api.md](spotify-api.md#picking-the-right-version-of-a-track));
4. reads the release's label from its ℗ copyright line and compares it with the label the source claimed. A mismatch doesn't block the track, but its line says so (`label: Hanzom Music, not Hospital as claimed`), and the report uses the real label;
5. dedups against history, today's playlist and the pool, by URI, by ISRC while Spotify still returns it, and by key;
6. saves `why` and `source_url` against a new `W` ref in the run file.

One line each; [discovery-tools.md](discovery-tools.md#2-web-research-and-verify_tracks) shows a real result and the four outcomes.

It can be called more than once in a run, for example after a retried research task. Refs keep counting up.

### `discovery_review(lane)`

Read-only. Lists everything pickable in the current run from the run file: verified web finds with their reasons, then the K and C tracks, the items that can't be picked (pending, dup) and the pick limits. The main model calls it after the research, so it never needs the subagent's text.

### `discovery_finish(lane, picks, why?, reject?, thin?, dry_run?)`

- `picks`: refs, best first.
- `why`: notes for picked K or C items that don't have a sourced reason (`{"K2": "Critical: 'acid-tipped breakbeats…'"}`). W items already have theirs.
- `reject`: refs the model saw and judged wrong for this lane; they don't carry over.
- New labels come from the research reply's `LABEL |` lines, which `verify_tracks` already recorded.
- `thin`: whether the research came back limited.

Steps, in order:

1. Resolve refs (tolerantly). Unknown refs are the only error, and nothing is written when there are any.
2. Apply the pick rules from the README: keep preference order, drop from the end to meet `target`, `max_feed_picks` (lifted if the run has no ✓ W items), `max_core_picks` and `min_web_picks`.
3. Under the lock: re-read the live playlist, add only tracks not already in it (compared by URI and by key), then update `days.json`.
4. Update `history.json`, the lane's pool (picks, rejections, passes, expiry), its labels and artists, and its `last_run` (server clock at `begin`, never moving backwards).
5. Return the report.

Calling it again on a finished run re-renders the same report and writes nothing.

[discovery-tools.md](discovery-tools.md#4-discovery_finish) shows a real report.

### `discovery_status(lane?)` and repairs

- `discovery_status` shows each lane's last run, pool size, pending items, labels with their status, today's playlist, and core artists not assigned to any lane.
- `mark_recommended(lane, uris | "artist — title")` adds tracks to history by hand.
- `forget(lane, label | artist)` removes a learned label or artist.

## Files

All files are in `SPOTIFY_DISCOVERY_DIR`. The server writes them, except `lanes.json`.

| File | Written by | Contents |
|---|---|---|
| `lanes.json` | **you** | Lane definitions: name, baseline, target and limits, seed labels and artists. The server only reads it |
| `lanes/<lane>.json` | server | What the lane has learned: found and promoted labels with counts, artists from picks with cached Spotify ids, the pool, pending items, `last_run` |
| `history.json` | server | Every track ever added: URI, artist, title, key, lane, date |
| `days.json` | server | Recent days: playlist id, name and the tracks added (last 30 days) |
| `taste_profile.json` | taste job | Read only; `core_artists` (see below) |
| `runs/<lane>-<time>.json` | server | Each run: feed, verified finds, refs, picks, report. Newest 14 per lane |

Your settings and the learned state are separate files on purpose. You can edit `lanes.json` at any time, and the server never overwrites your edits. A lane's effective label list is its seeds from `lanes.json` plus its found and promoted labels from `lanes/<lane>.json`.

### `lanes.json`

```jsonc
{
  "timezone": "America/Denver",
  "playlist": { "name": "hermes{YYYYMMDD}", "description": "Discovery playlist auto-curated from your listening profile" },
  "defaults": { "target": [3, 6], "max_feed_picks": 3, "max_core_picks": 2, "min_web_picks": 0,
                "feed_cap": 25, "carry_runs": 4, "max_age_days": 365, "pending_days": 42, "quiet_runs": 8 },
  "lanes": {
    "a-dnb": {
      "name": "Neurofunk, techstep, and experimental DnB",
      "baseline": "Dark/technical DnB, neurofunk, techstep, experimental DnB, and exceptional halftime — the Noisia, Vision, Blackout and Critical lineage.",
      "research": "Releases less often: 1–3 excellent current fits beat padding with generic or liquid DnB.",
      "target": [3, 6],
      "labels": ["Eatbrain", "Blackout Music", "Critical Music", "Vision Recordings", "MethLab", "Bad Taste", "Neuropunk", "Overview Music", "Invisible Recordings"],
      "artists": ["Omneum", "Sam Binga", "Skrimor"]
    }
  }
}
```

### Core artists and lanes

Spotify no longer exposes genres, so the server can't decide which lane a liked artist belongs to. Instead:

- `lanes.json` lists artists per lane;
- an artist picked in a lane is learned for that lane;
- core artists from `taste_profile.json` that aren't in any lane are shown by `discovery_status`. When one has a new release, every lane's `begin` mentions it in one line ("unassigned core artist; picking it assigns it here"). The first lane to pick it gets it.

`max_core_picks` counts picks by any artist in `core_artists`, wherever the pick came from.

## Keys and dedup

- **Track key**: the `textKey` of the primary artist, plus the `textKey` of the title with edit and mix suffixes removed: "Radio Edit", "Original Mix", "Extended Mix", "Edit", "Remastered". "VIP" and named remixes are different tracks and stay.
- A track counts as already recommended if its URI **or** its key is in history. That catches Spotify relinking, and the five duplicate pairs in the old history file.
- **Label key**: the `textKey` with "records", "recordings", "music", "label", "ltd" and "audio" removed, so "Critical" and "Critical Music" match.

## Failure handling

| What fails | What happens |
|---|---|
| Spotify auth | `begin` returns one clear line: run `spotify-discovery-mcp login`. The skill tells the model to report it, not retry |
| Spotify rate limit (a 429 with a Retry-After over 60 s, such as `QUOTA_EXCEEDED`) | The tool fails at once with one line naming when the block ends, and every later request in that server process fails without calling Spotify until then. Nothing is added or saved. Shorter Retry-Afters are waited out, up to three times per request |
| Feed fetch (one label or artist) | It's skipped and listed in the work list; the run continues |
| Feed fetch (all) | The work list says so; the lane runs on web finds alone |
| Run ends before `finish` | Nothing is added or saved. The next run covers the same period; the pool still has everything |
| Playlist add fails | `finish` saves nothing and returns the error. The run file keeps the picks, so calling `finish` again retries |
| Two lanes at once | `begin` and `finish` take a lock on `days.json`; the waiting lane continues after a few seconds |

## Setup

The planned setup steps:

1. On the Spotify app, register the redirect URI (probably the one Hermes already uses).
2. `spotify-discovery-mcp login`: PKCE in a browser, which saves `auth.json` to `SPOTIFY_DISCOVERY_AUTH` (default `$SPOTIFY_DISCOVERY_DIR/auth.json`, mode 0600). On a headless host, log in locally and copy the file over.
3. Write `lanes.json`. A one-off import can build it from the six existing cron prompts, and seed `history.json` from the old `recommendation_history.json` and `today_playlist.json`.
4. Hermes: add the server under `mcp_servers` with `SPOTIFY_DISCOVERY_DIR` in its `env`, and change each lane job:
   - set `enabled_toolsets` to `["delegation", "web", "spotify-discovery"]`, which drops `file`, `spotify` and `no_mcp`;
   - replace the prompt with the shared skill plus `lane: a-dnb`.
5. Deploy like the digest servers: build (bundling job-ledger into `dist/`), copy `dist/`, `package.json` and `package-lock.json`, then restart Hermes.

## Open questions

- Is a minimum number of web picks (`min_web_picks`) worth having, or is the feed limit enough? Start at 0 and decide from the reports.
- Should the research subagent get the K list, so it can find text sources for feed picks? It costs context; the alternative is a short label-and-date note ("Critical Music single, 2026-09-11"), which is factual without a quote.
- Should `discovery_begin` ever skip a label whose search returns compilations only?
