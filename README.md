<div align="center">

# Spotify Discovery MCP

**A Spotify discovery playlist run by a scheduled agent, where the model only has to judge the music.**

![npm](https://img.shields.io/npm/v/spotify-discovery-mcp) ![Node 26+](https://img.shields.io/badge/node-26%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![Tools](https://img.shields.io/badge/tools-7-informational)
![Spotify](https://img.shields.io/badge/Spotify-Web%20API-1DB954?logo=spotify&logoColor=white)
![Hermes Agent](https://img.shields.io/badge/Hermes%20Agent-skill%20included-orange)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Why](#why) · [How a lane run works](#how-a-lane-run-works) · [Pick rules](#where-picks-come-from-and-how-theyre-mixed) · [Setup](#setup) · [Tools](#tools) · [Spotify API notes](#spotify-api-notes)

</div>

An MCP server that runs a Spotify discovery playlist for a scheduled agent. Fetching, verifying, deduplicating and saving state are all code, so the agent's model only has to judge music.

**Status: in daily use.** The design comes from two weeks of a [Hermes](https://github.com/NousResearch/hermes-agent) cron setup that built a playlist each Tuesday and Friday: six jobs, one per genre "lane", on a local Qwen 27B model, each adding tracks to that day's playlist. It ran on Hermes from 2026-10-03. Since 2026-10-18 it runs from [spotify-discovery](https://github.com/wkbaran/spotify-discovery), a plain scheduled job that drives this server over MCP, does the research in a bounded tool loop and posts the reports to Discord. The six lanes there take about 20 minutes in all instead of most of a morning, and the feed's request budget (below) keeps them inside Spotify's daily quota, so it can build a playlist every day. The Hermes setup below still works.

## Why

Those six jobs work, but a model does all their bookkeeping. In twelve runs (2026-09-29 to 10-02):

- **Every full rewrite of the shared playlist file was refused (18 of 18)**, so the model fell back to hand-written patches. One patch inserted a duplicate block, which the model then had to repair.
- **One job added the same six tracks twice**, which left 5 duplicates in the playlist. Two earlier days each got more than one playlist.
- **The history file holds duplicates** the model's dedup missed. The model reads the whole file, about 16k characters and growing, every run.
- **About 536k characters of raw Spotify search JSON** went into the model's context, one search per turn.
- **A web-research subagent used all 50 of its searches and returned nothing 5 times.** That's about 10 minutes lost each time.
- **One track reported "not on Spotify" was there.** A plain search missed it, but a `track:"…" artist:"…"` search finds it.

A run took 20 to 57 messages, and most of those messages were bookkeeping. This server takes the bookkeeping over, using [job-ledger](https://github.com/wkbaran/job-ledger), which comes from the same work on medium-reader-mcp and substack-reader-mcp.

## How a lane run works

Each step is done either by **code** (this server) or by the **model**.

| # | Step | Who | What happens |
|---|---|---|---|
| 1 | `discovery_begin(lane)` | code | Finds or creates today's playlist (under a lock), fetches new releases from the lane's labels and artists (longest-waiting first, within a request budget; see [below](#staying-inside-spotifys-quota)), drops anything already recommended, and returns the lane brief and a list with refs (`K1`, `C1`) |
| 2 | Web research | model (subagent) | Looks for artists and labels **outside** the lists the feed already covered, and hands its finds straight to `verify_tracks(lane, text)`. The server checks each one on Spotify with exact field searches, reads its real label and genre, dedups it, and gives it a ref (`W1`) |
| 3 | `discovery_review(lane)` | code | Lists everything pickable in the run from the server's own records: verified web finds with their reasons, then the feed |
| 4 | `discovery_finish(lane, picks, …)` | model picks, code does the rest | The model picks by ref, best first. The server applies the pick rules, adds tracks that aren't already in the playlist, saves all state and the report, and returns a one-line summary of what was added |
| 5 | Reply | model | One line, `Done: a-dnb`. The lane run itself delivers nothing (in Hermes, `deliver: local`) |
| 6 | `spotify-discovery-mcp report` | code (a no-model cron job) | Prints each finished lane report once, plus a warning for a run that never finished. The scheduler posts the output (to Discord, say) |

The research never passes through the main model. On 2026-10-03 the first live run had Qwen copy the subagent's reply into `verify_tracks`; it mangled the JSON escaping four times, and the run ran out of road before finishing. Now the subagent calls `verify_tracks` itself and returns only "DONE".

That's 5 turns for the main model, down from 20–57. The model never sees the history, the playlist file or other lanes, and has no file tools. [docs/design.md](docs/design.md) has the details, and [docs/discovery-tools.md](docs/discovery-tools.md) follows one run with a diagram, each tool's arguments and real output.

## Where picks come from, and how they're mixed

There are two sources of candidates, and the mix between them is the main thing to tune.

**The feed (`K` and `C` refs)** is new releases from labels and artists this lane already knows. It's fetched from Spotify by code, so every item exists, has a release date, and hasn't been recommended before. The feed is reliable, but it can only find what you already know about.

**Web finds (`W` refs)** come from the research subagent: blogs, Bandcamp, label pages, Reddit. They're how the lane discovers new names. They're checked on Spotify before the model can pick them.

**Web research always runs**, even when the feed has plenty. It's the only way the lane finds anything new, so the model doesn't get to skip it.

### The rules

Each lane has a target (for example 3–6 tracks) and limits, set in `lanes.json`:

| Setting | Example | Meaning |
|---|---|---|
| `target` | `[3, 6]` | Pick up to 6. Fewer than 3 is allowed, and the report says the lane came back thin |
| `max_feed_picks` | `3` | At most 3 picks from the feed, **unless the run has no verified web finds** |
| `max_core_picks` | `2` | At most 2 picks by artists you already listen to, from either source |
| `min_web_picks` | `0` | Optional: at least this many web picks, when that many verified ones exist |

**The model decides quality; the server enforces quantities.** The model lists its picks best first. `discovery_finish` keeps them in that order and drops any that would break a limit, starting from the end of the list. The report says what was dropped and why. It never refuses the whole call, because a model stuck resending a list one item too long would stall the job.

### Examples

Take a lane with `target: [3, 6]`, `max_feed_picks: 3`, `max_core_picks: 2`. The feed offers 10 tracks.

**A. The web research finds nothing usable** (nothing verified on Spotify).
The feed limit lifts, because there's nothing to save room for. The model picks the best 3–6 of the 10. Unpicked feed tracks carry over to the next run.

**B. The web research finds 10, and 7 are verified on Spotify.**
The model picks up to 6, with at most 3 from the feed. Any of these is fine:

- 6 web picks, no feed picks
- 3 web picks and 3 feed picks
- 2 web picks, 1 feed pick, and stop at 3, because nothing else fits well

If the model sends 4 feed picks, `finish` keeps its top 3 feed picks and reports the 4th as dropped. Unpicked tracks from both sources carry over.

**C. The feed is empty, and the web research finds 2.**
The model picks what fits, perhaps both. The report says the lane came back thin.

**D. Half the picks are by artists you already like.**
With `max_core_picks: 2`, only the first 2 of those (in the model's order) are kept. It's good to surface a new release by an artist you like, but a discovery playlist shouldn't be mostly them.

### Nothing good is lost

The feed is fetched by date ("released since this source was last checked"), but **the candidates themselves are kept in a pool, which isn't date-based**. Unpicked candidates come back on later runs, marked with how often they've been passed over, until one of these happens:

- they're picked,
- the model rejects them outright (at most 3 per run, so a model that rejects everything it didn't pick can't empty the pool),
- they've been in the pool `carry_days` days (default 21, counted from when they were first shown, so it means the same however often the lanes run; before 0.5.0 it was `carry_runs`, a number of runs),
- they're older than `max_age_days`.

Web finds that verified but weren't picked go into the same pool. Web finds that **aren't on Spotify yet** (an album due out in three weeks, a release out that morning) are kept as *pending*. Each run checks them quietly, and they join the pool once they appear.

### Staying inside Spotify's quota

Development Mode apps get daily request quotas that Spotify doesn't publish. Since July 2026 they're counted per developer account, not per app, and endpoints are grouped into quota buckets that each have their own limit ([Spotify: quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)). Past a bucket's limit, its requests fail with `429 QUOTA_EXCEEDED` until 24 hours after the window's first request. The others keep working. On 2026-10-19 `/artists/{id}/albums` was blocked after about 76 calls in a day, while `/search` (about 400 that day) and `/albums/{id}` still answered. Before 0.6.0 the feed used that endpoint for every lane artist, so the fifth and sixth lanes ran out on 10-16, 10-18 and 10-19.

Since 0.6.0:

- **Artists are found by search** (`artist:"…" tag:new`, keeping only releases that name the artist), like labels, so `/artists/{id}/albums` isn't used at all.
- **A block ends only what used that endpoint.** The client remembers blocks per endpoint, and a block during the feed or the pending check ends that step with what it found; the run goes on.
- **Web first, known sources only if short** (`discovery_begin {feed: false}` then `discovery_fill`; see [discovery-tools.md](docs/discovery-tools.md#web-first-discovery_fill)). The known sources are checked for only as many tracks as the run is short, and pending web finds last, at most once a week each.
- **An album is read once per process**, so a compilation's tracks cost one album request, not one each.

Within its budget, the feed checks the lane's known labels and artists **longest-waiting first**, and stops once it has `feed_tracks` new tracks (enough for the model to choose from) or has used `feed_requests` requests (the ceiling on a quiet day, when most sources have nothing new). The sources it didn't reach go first next run. Each source looks back to **its own** last check, at most 30 days, so a source left out of a run loses nothing; its releases arrive a run later. No source is starved by its place in the list. Before 0.5.0 the feed took the first 20 labels and 20 artists in a fixed order, so the ones after that were never checked.

| Setting | Default | Meaning |
|---|---|---|
| `feed_requests` | `60` | Spotify requests the feed may use per run |
| `feed_tracks` | `18` | New tracks after which the feed stops early (3× a pick target of 6) |

Set them in `lanes.json`, under `defaults` or per lane. A run that doesn't finish marks nothing as checked. Each release costs one request, since the album response carries its tracks. The work list says when sources were left over, and each run file records Spotify requests by step (`requests_by_step`: pending checks, feed, verify, finish), so you can see where a lane's quota goes.

### The lane learns new labels

When research turns up a new label, `discovery_finish` saves it to that lane as `found`, and the next run's feed includes it. Spotify has no label IDs, and searching by label name also finds labels with similar names, so the first time a release on the label turns up, the server saves the label's exact name from the release's ℗ line. After that, the feed only takes releases whose ℗ line names that label. A found label is promoted once one of its tracks is picked. It's dropped after a run of quiet runs, and the report says so. Labels you list in `lanes.json` are never dropped automatically. The report only notes when one has gone quiet.

## Setup

### 1. Install

```sh
npm install -g spotify-discovery-mcp   # one bundled file, no dependencies
```

From source instead: clone the repo, then `npm install && npm test && npm run build` (it bundles everything into `dist/cli.js`), and use `node dist/cli.js` in place of `spotify-discovery-mcp`.

### 2. Log in to Spotify

The server has its own login and refresh token, so it can't invalidate another client's (Hermes's own Spotify tools, if you use them). Spotify gives new Development Mode apps one client id per developer, so use the app you already have, and register its redirect URI if it isn't there yet.

```sh
SPOTIFY_DISCOVERY_AUTH=./auth.json spotify-discovery-mcp login --client-id <your app's client id>
# headless, or when the browser can't reach 127.0.0.1:
SPOTIFY_DISCOVERY_AUTH=./auth.json spotify-discovery-mcp login --client-id <id> --paste
```

The default redirect URI is `http://127.0.0.1:43827/spotify/callback`; change it with `--redirect-uri`. The token file is written with mode 0600. Copy it to the host, to `SPOTIFY_DISCOVERY_AUTH` or `$SPOTIFY_DISCOVERY_DIR/auth.json`.

### 3. The data directory

`SPOTIFY_DISCOVERY_DIR` holds:

- `lanes.json`: yours. Start from [hermes/lanes.example.json](hermes/lanes.example.json), which has the six lanes from the original cron prompts. `playlist.name` names each day's playlist: `{YYMMDD}` (the default since 0.5.0, such as `261018`), `{YYYYMMDD}` or `{YYYY-MM-DD}`, with any text around it. Keep it short: Spotify's apps don't scroll long titles, so a name like `hermes20261018` gets cut off, and a name that starts with the date sorts by date.
- `taste_profile.json`: optional; `core_artists` from your listening, for `max_core_picks`.
- The state the server writes: `history.json`, `days.json`, `lanes/<lane>.json`, `runs/`.

To carry over what the old jobs recommended, run `spotify-discovery-mcp import <old dir>` once. It reads `recommendation_history.json` and `today_playlist.json`.

`spotify-discovery-mcp status` checks the login and shows each lane.

### 4. Running the lanes

[spotify-discovery](https://github.com/wkbaran/spotify-discovery) is a standalone scheduled job that runs the lanes against this server; its README covers setup. That's how I run it.

To run the lanes on [Hermes Agent](https://github.com/NousResearch/hermes-agent) instead, add the server to `config.yaml`:

```yaml
mcp_servers:
  spotify-discovery:
    command: node
    args: [/opt/data/mcp/spotify-discovery-mcp/dist/cli.js]
    env:
      SPOTIFY_DISCOVERY_DIR: /opt/data/sandbox/spotify_discovery
      SPOTIFY_DISCOVERY_AUTH: /opt/data/mcp/spotify-discovery-home/auth.json
```

Install [hermes/SKILL.md](hermes/SKILL.md) as the `spotify-discovery` skill. Then for each lane job:

- set `enabled_toolsets` to `["delegation", "web", "spotify-discovery"]`;
- set skills to `["spotify-discovery", "searxng-search"]`;
- set the prompt to "Run the spotify-discovery skill for lane a-dnb." (with that job's lane);
- set `deliver` to `local`.

The reports reach Discord through a no-model job instead, because copying a long report is where a weak model fails. In the second live run, Qwen got a perfect report back from `discovery_finish`, thought for 13 minutes, then sent its persona prompt instead. Copy [hermes/spotify_discovery_report.sh](hermes/spotify_discovery_report.sh) to Hermes's `scripts/` and create a `no_agent` job that runs it every 5 minutes during the lanes' window, delivering to the channel the lanes used. Empty output is a silent run.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `SPOTIFY_DISCOVERY_DIR` | (required) | The data directory |
| `SPOTIFY_DISCOVERY_AUTH` | `$SPOTIFY_DISCOVERY_DIR/auth.json` | The token file |
| `SPOTIFY_DISCOVERY_TZ` | `TZ`, else UTC | Which day "today" is, for the playlist name and the day's bookkeeping. `lanes.json`'s old `timezone` field is ignored |
| `SPOTIFY_DISCOVERY_METADATA` | `off` | Where to look up genre: any of `beatport`, `soundcloud` and `deezer`, comma-separated. Off by default. Beatport and SoundCloud are scraped pages, not open APIs, and their terms don't allow it; if you turn them on, keep it light, and let a blocked lookup fail. Deezer is an official API that needs no key. It is tried only when Beatport is off or finds nothing, and its genres are coarse (`Folk`, `Alternative`, `Electro`), so it flags a track as outside the lane only when none of its genres could be electronic |
| `SPOTIFY_DISCOVERY_RATE`, `_CONCURRENCY`, `_MIN_GAP` | none | Pacing of requests to the Spotify API, e.g. `60/min`, `2`, `250ms`. See [paced-fetch](https://github.com/wkbaran/paced-fetch) |
| `SPOTIFY_DISCOVERY_RETRIES`, `_MAX_RETRY_WAIT` | `3`, `60s` | Retries after a 429 (or a 5xx on GET, PUT and DELETE; a POST such as adding tracks isn't sent twice), waiting Spotify's `Retry-After`; a longer `Retry-After` (a quota block) fails at once and blocks later requests to the same endpoint until it ends |
| `SPOTIFY_DISCOVERY_METADATA_RATE`, `_CONCURRENCY`, `_MIN_GAP`, `_RETRIES`, `_MAX_RETRY_WAIT` | none, `2`, `250ms`, `1`, `10s` | The same for Beatport, SoundCloud and Deezer pages. Deezer is also held to its documented 50 requests per 5 s |

## Tools

| Tool | What it does |
|---|---|
| `discovery_begin(lane, feed?)` | Today's playlist, the feed and carried-over candidates, with refs; `feed: false` leaves the feed for `discovery_fill` |
| `discovery_fill(lane, picks)` | Web first: after choosing from the web finds, checks the known sources (then pending finds) for only as many as the run is short |
| `verify_tracks(lane, text)` | Called by the research subagent: checks its finds on Spotify; W refs |
| `discovery_review(lane)` | Everything pickable in the current run |
| `discovery_finish(lane, picks, …)` | Applies the rules, adds tracks, saves, returns the report |
| `discovery_status(lane?)` | Read-only overview |
| `mark_recommended(lane, tracks)` | Repair: add tracks to history |
| `forget(lane, label \| artist)` | Repair: remove a learned label or artist |

## Spotify API notes

This uses Spotify's Web API as a Development Mode app. The February 2026 changes removed several things the design would otherwise use: label fields, artist genres, related artists, recommendations and new-releases browsing. Search now returns at most 10 results per page. Development Mode also has an unpublished daily quota; see [Staying inside Spotify's quota](#staying-inside-spotifys-quota). [docs/spotify-api.md](docs/spotify-api.md) lists what was tested and what still works. Genre, BPM and key come from other sources instead; see [docs/metadata-sources.md](docs/metadata-sources.md).

MIT licensed.
