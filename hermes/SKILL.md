---
name: spotify-discovery
description: Add one genre lane's tracks to today's Spotify discovery playlist. The spotify-discovery MCP server fetches, verifies, dedups, adds and saves; you research and judge.
version: 1.3.0
platforms: [linux]
metadata:
  hermes:
    tags: [spotify, music, playlist, discovery]
    category: media
---

# Spotify Discovery Lane

## When to Use
Scheduled (cron). The job prompt names the lane, for example "Run the spotify-discovery skill for lane a-dnb."

## How it works
The server does everything that isn't judgment. It creates or finds today's playlist, fetches new releases from the lane's known labels and artists, checks web finds on Spotify, drops anything already recommended, applies the lane's pick limits, adds the tracks, saves all state, and writes the report. A research subagent searches the web and hands its finds straight to the server. You choose the best tracks. The report goes to Discord through a separate no-model job.

**Until your one-line reply in step 5, every message you write must be a tool call.** A message without a tool call ends the run on the spot, with nothing added and a broken message sent. If you want to think out loud, do it in the same message as the next tool call.

## Tools
- spotify-discovery MCP tools: `discovery_begin`, `discovery_review`, `discovery_finish` (yours), and `verify_tracks` (the subagent's). They may be listed with an `mcp__spotify_discovery__` prefix. `discovery_status` is only for debugging.
- `delegate_task` for the web research. The subagent inherits the spotify-discovery tools and uses `web_search` and `web_extract`.
- No file tools and no Spotify tools. Don't use `read_file`, `write_file`, `patch`, `terminal`, `execute_code` or `spotify_*`. You never handle track URIs, playlist ids or state files, and you never copy the subagent's finds anywhere.
- Call the MCP tools one per `tool_call`, with `calls` as a real list, not a string. A batch of several calls is rejected and the retry wastes a turn.

## Procedure

### 1. Begin
Call `discovery_begin` with `lane` set to the lane id from the job prompt.
- If it fails with "Spotify login needed", reply only: "🎧 Spotify lane [the lane id] skipped — the spotify-discovery-mcp login has expired. Run spotify-discovery-mcp login and copy auth.json to the Hermes host." Then stop.
- If it fails for another reason, call it once more. If that fails too, reply only: "🎧 Spotify lane [the lane id] failed: [the error]". Then stop.

The result is the lane brief (name, baseline, notes, pick limits) and the tracks from the lane's known labels and artists, with refs. It ends with the covered labels and artists. Go straight on to step 2.

### 2. Research (one subagent, always)
Always do this step, even when the begin result has plenty: it's how the lane finds anything new.

Call `delegate_task` with `tasks` as a list holding exactly one task. Its goal is the text below with the bracketed parts filled in from the begin result. Copy those parts as they are; leave out quote marks and backticks.

> Find 6 to 12 recent tracks for the music lane below, from artists and labels that are NOT in the covered lists, and hand them to the server with verify_tracks.
> Lane id: [the lane id]
> Lane: [the lane name]
> Baseline: [the Baseline line]
> Notes: [the Research note and Exclude lines, or none]
> Covered labels and artists, search elsewhere: [the two Covered lines]
>
> Search label pages, Bandcamp, SoundCloud, Beatport, blogs, Reddit and artist pages with web_search and web_extract. Start discovery searches with !music, for example !music neurofunk new releases 2026, and fall back to a plain query when that finds nothing. Prefer releases from the last 6 to 12 months and smaller artists. Use at most 25 searches.
>
> Base every reason on text from a label, Bandcamp or SoundCloud description, artist statement or reputable blog, and say whose text it is. Never write sounds like, on listen or has a vibe.
>
> Each time you have a few tracks, call verify_tracks with lane set to the lane id and text set to plain lines, one track per line, fields separated by a pipe:
> artist | track | release | label | release date | why it fits, attributed | source URL
> Add one line per relevant new label: LABEL | label name | URL | one-line description
> No JSON, no numbering, no code fences. Call verify_tracks as many times as you need; each call adds to the run.
>
> Use only verify_tracks from the spotify-discovery tools. Never call discovery_begin, discovery_review, discovery_finish or discovery_status: choosing the tracks is not your job, and calling them ends the lane early.
>
> When you're done, reply with one line only: DONE, then how many tracks verify_tracks marked with a check mark.

If the subagent errors, times out, or says DONE with fewer than 3, retry once with the same goal plus: Try different searches from last time. Don't research yourself.

### 3. Review
Call `discovery_review` with `lane`. It lists everything you can pick, from the server's own records: verified web finds (W refs, with their reasons), then the known-source tracks (K and C refs), and the pick limits. A `Beatport:` or `SoundCloud:` line gives genre and tempo; "⚠ genre outside this lane" means that genre doesn't fit, so pick it only if the brief clearly supports it.

### 4. Finish
Choose the tracks that best fit the baseline. Then call `discovery_finish` with:
- `lane`;
- `picks`: the refs, **best first**. The server keeps your order and drops from the end to meet the lane's limits. Fewer than the target is fine: don't pad with weak fits.
- optionally `reject` (K or C refs that clearly don't belong in this lane), `why` (a short attributed reason for a K or C pick), and `thin: true` if the research came back limited.

If it says "Unknown refs", fix the list and call it again. On any other error, call it once more; it's safe to repeat.

### 5. Reply
Reply with one line: `Done: [the lane id]`. Nothing else: the report is posted to Discord by a separate job (`spotify-discovery-report`), straight from the server, so you never copy it. Don't repeat or summarize it.
