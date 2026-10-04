# spotify-discovery-mcp

An MCP server that runs a Spotify discovery playlist for a scheduled agent, so the agent's model only has to judge music.

**Status: 0.1.0, built and tested, not yet deployed.** The design comes from two weeks of a [Hermes](https://github.com/NousResearch/hermes-agent) cron setup that builds a playlist each Tuesday and Friday. Six jobs, one per genre "lane", run on a local Qwen 27B model and each add tracks to that day's playlist.

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
| 1 | `discovery_begin(lane)` | code | Finds or creates today's playlist (under a lock), fetches new releases from the lane's labels and artists, drops anything already recommended, and returns the lane brief and a list with refs (`K1`, `C1`) |
| 2 | Web research | model (subagent) | Looks for artists and labels **outside** the lists the feed already covered, and hands its finds straight to `verify_tracks(lane, text)`. The server checks each one on Spotify with exact field searches, reads its real label and genre, dedups it, and gives it a ref (`W1`) |
| 3 | `discovery_review(lane)` | code | Lists everything pickable in the run from the server's own records: verified web finds with their reasons, then the feed |
| 4 | `discovery_finish(lane, picks, …)` | model picks, code does the rest | The model picks by ref, best first. The server applies the pick rules, adds tracks that aren't already in the playlist, saves all state, and returns the finished report |
| 5 | Reply | model | One line, `Done: a-dnb`. The lane job itself delivers nothing (`deliver: local`) |
| 6 | `spotify-discovery-mcp report` | code (a no-model cron job) | Prints each finished lane report once, plus a warning for a run that never finished. Hermes posts the output to Discord |

The research never passes through the main model. On 2026-10-03 the first live run had Qwen copy the subagent's reply into `verify_tracks`; it mangled the JSON escaping four times, and the run ran out of road before finishing. Now the subagent calls `verify_tracks` itself and returns only "DONE".

That's 5 turns for the main model, down from 20–57. The model never sees the history, the playlist file or other lanes, and has no file tools. [docs/design.md](docs/design.md) has the details.

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

The feed is fetched by date ("released since this lane's last run"), but **the candidates themselves are kept in a pool, which isn't date-based**. Unpicked candidates come back on later runs, marked with how often they've been passed over, until one of these happens:

- they're picked,
- the model rejects them outright,
- they've been passed over `carry_runs` times,
- they're older than `max_age_days`.

Web finds that verified but weren't picked go into the same pool. Web finds that **aren't on Spotify yet** (an album due out in three weeks, a release out that morning) are kept as *pending*. Each run checks them quietly, and they join the pool once they appear.

### The lane learns new labels

When research turns up a new label, `discovery_finish` saves it to that lane as `found`, and the next run's feed includes it. A found label is promoted once one of its tracks is picked. It's dropped after a run of quiet runs, and the report says so. Labels you list in `lanes.json` are never dropped automatically. The report only notes when one has gone quiet.

## Setup

### 1. Build

```sh
npm install
npm test
npm run build      # bundles everything into dist/cli.js; nothing to install on the host
```

### 2. Log in to Spotify

The server has its own login and refresh token, so it can't invalidate another client's (Hermes's own Spotify tools, for example). Spotify gives new Development Mode apps one client id per developer, so use the app you already have, and register its redirect URI if it isn't there yet.

```sh
SPOTIFY_DISCOVERY_AUTH=./auth.json node dist/cli.js login --client-id <your app's client id>
# headless, or when the browser can't reach 127.0.0.1:
SPOTIFY_DISCOVERY_AUTH=./auth.json node dist/cli.js login --client-id <id> --paste
```

The default redirect URI is `http://127.0.0.1:43827/spotify/callback`; change it with `--redirect-uri`. The token file is written with mode 0600. Copy it to the host, to `SPOTIFY_DISCOVERY_AUTH` or `$SPOTIFY_DISCOVERY_DIR/auth.json`.

### 3. The data directory

`SPOTIFY_DISCOVERY_DIR` holds:

- `lanes.json`: yours. Start from [hermes/lanes.example.json](hermes/lanes.example.json), which has the six lanes from the original cron prompts.
- `taste_profile.json`: optional; `core_artists` from your listening, for `max_core_picks`.
- The state the server writes: `history.json`, `days.json`, `lanes/<lane>.json`, `runs/`.

To carry over what the old jobs recommended, run `node dist/cli.js import <old dir>` once. It reads `recommendation_history.json` and `today_playlist.json`.

`node dist/cli.js status` checks the login and shows each lane.

### 4. Hermes

In `config.yaml`:

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
| `SPOTIFY_DISCOVERY_TZ` | `lanes.json`'s `timezone` | Which day "today" is |
| `SPOTIFY_DISCOVERY_METADATA` | `beatport,soundcloud` | Where to look up genre; `off` for nowhere |

## Tools

| Tool | What it does |
|---|---|
| `discovery_begin(lane)` | Today's playlist, the feed and carried-over candidates, with refs |
| `verify_tracks(lane, text)` | Called by the research subagent: checks its finds on Spotify; W refs |
| `discovery_review(lane)` | Everything pickable in the current run |
| `discovery_finish(lane, picks, …)` | Applies the rules, adds tracks, saves, returns the report |
| `discovery_status(lane?)` | Read-only overview |
| `mark_recommended(lane, tracks)` | Repair: add tracks to history |
| `forget(lane, label \| artist)` | Repair: remove a learned label or artist |

## Spotify API notes

This uses Spotify's Web API as a Development Mode app. The February 2026 changes removed several things the design would otherwise use: label fields, artist genres, related artists, recommendations and new-releases browsing. Search now returns at most 10 results per page. [docs/spotify-api.md](docs/spotify-api.md) lists what was tested and what still works. Genre, BPM and key come from other sources instead; see [docs/metadata-sources.md](docs/metadata-sources.md).

MIT licensed.
