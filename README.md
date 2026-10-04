# spotify-discovery-mcp

An MCP server that runs a Spotify discovery playlist for a scheduled agent, so the agent's model only has to judge music.

**Status: design.** The docs describe what will be built; the code isn't written yet. The design comes from two weeks of a [Hermes](https://github.com/NousResearch/hermes-agent) cron setup that builds a playlist each Tuesday and Friday. Six jobs, one per genre "lane", run on a local Qwen 27B model and each add tracks to that day's playlist.

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
| 1 | `discovery_begin(lane)` | code | Finds or creates today's playlist (under a lock), fetches new releases from the lane's labels and artists, drops anything already recommended, and returns a short list with refs (`K1`, `C1`) |
| 2 | Web research | model (subagent) | Looks for artists and labels **outside** the lists the feed already covered |
| 3 | `verify_tracks(lane, candidates)` | code | Checks each web find on Spotify with exact field searches, dedups it, and gives it a ref (`W1`) |
| 4 | Judge | model | Picks the best fits by ref, in order of preference |
| 5 | `discovery_finish(lane, picks, …)` | code | Applies the pick rules, adds tracks that aren't already in the playlist, saves all state, and returns the finished report |
| 6 | Reply | model | Sends the report unchanged |

That's about 6 turns for the main model, down from 20–57. The model never sees the history, the playlist file or other lanes, and has no file tools. [docs/design.md](docs/design.md) has the details.

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

Not available yet; see [docs/design.md](docs/design.md#setup) for the plan. In outline:

- **Its own Spotify login.** `spotify-discovery-mcp login` runs a PKCE login and saves tokens to the server's own file. It never shares a refresh token with another client.
- **A data directory, `SPOTIFY_DISCOVERY_DIR`.** It holds `lanes.json` (yours to edit) and the state the server writes.
- **The Hermes cron jobs** get the `spotify-discovery` toolset instead of `file` and `spotify`.

## Spotify API notes

This uses Spotify's Web API as a Development Mode app. The February 2026 changes removed several things the design would otherwise use: label fields, artist genres, related artists, recommendations and new-releases browsing. Search now returns at most 10 results per page. [docs/spotify-api.md](docs/spotify-api.md) lists what was tested and what still works.

MIT licensed.
