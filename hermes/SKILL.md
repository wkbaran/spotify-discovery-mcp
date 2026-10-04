---
name: spotify-discovery
description: Add one genre lane's tracks to today's Spotify discovery playlist. The spotify-discovery MCP server fetches, verifies, dedups, adds and saves; you research and judge.
version: 1.0.0
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
The server does everything that isn't judgment. It creates or finds today's playlist, fetches new releases from the lane's known labels and artists, checks your web finds on Spotify, drops anything already recommended, applies the lane's pick limits, adds the tracks, saves all state, and writes the report. You run the web research through one subagent, choose the best tracks, and send the report.

## Tools
- spotify-discovery MCP tools: `discovery_begin`, `verify_tracks`, `discovery_finish`. They may be listed with an `mcp_spotify_discovery_` prefix. `discovery_status` is only for debugging.
- `delegate_task` for the web research. The subagent uses `web_search` and `web_extract`.
- No file tools and no Spotify tools. Don't use `read_file`, `write_file`, `patch`, `terminal`, `execute_code` or `spotify_*`. You never handle track URIs, playlist ids or state files.
- Call the MCP tools one per `tool_call`. A batch of several calls is rejected and the retry wastes a turn.

## Procedure

### 1. Begin
Call `discovery_begin` with `lane` set to the lane id from the job prompt.
- If it fails with "Spotify login needed", reply only: "🎧 Spotify lane [the lane id] skipped — the spotify-discovery-mcp login has expired. Run `spotify-discovery-mcp login` and copy auth.json to the Hermes host." Then stop.
- If it fails for another reason, call it once more. If that fails too, reply only: "🎧 Spotify lane [the lane id] failed: [the error]". Then stop.

The result has the lane brief (name, baseline, research note, exclusions, pick limits), then candidates with refs:
- `K` refs are new releases from the lane's known labels and artists. A release with several tracks is listed as `K2` with tracks `K2.1`, `K2.2` and so on. Pick the track refs.
- `C` refs are carried over from earlier runs.
- A `Beatport:` or `SoundCloud:` line gives genre and tempo. "⚠ genre outside this lane" means that genre doesn't fit; pick such a track only if the brief clearly supports it.

It ends with the covered labels and artists. Keep the whole result for step 2.

### 2. Research (one subagent, always)
Always do this step, even when the K list is long: it's how the lane finds anything new.

Call `delegate_task` with exactly one task. Its goal is the text below, with the four bracketed parts filled in from the begin result. Copy them; don't summarize.

> Find recent tracks for this music lane, from artists and labels NOT in the covered lists below.
> Lane: [the lane name]
> Baseline: [the Baseline line]
> Notes: [the Research note and Exclude lines, or "none"]
> Covered labels and artists (search elsewhere): [the two Covered lines]
>
> Search label pages, Bandcamp, SoundCloud, Beatport, blogs, Reddit and artist pages. Prefix discovery searches with `!music` (for example `!music neurofunk new releases 2026`); fall back to a plain query when that returns nothing useful. Prefer releases from the last 6–12 months and smaller artists. Use at most 30 searches. Stop when you have 8–12 good candidates.
>
> Base every reason on text from a label, Bandcamp or SoundCloud description, artist statement or reputable blog, and attribute it ("Hanzom: 'a three-track assault'"). Never write "sounds like", "on listen" or "has a vibe".
>
> Reply with only these lines, one track per line, fields separated by " | ", nothing else:
> artist | track | release | label | release date | why it fits (attributed) | source URL
> Then one line per relevant label you found that isn't in the covered list:
> LABEL | label name | URL | one-line description

If the subagent errors or times out, retry once with the same goal. If it comes back with fewer than 3 track lines, retry once and say in the goal to try different searches. Don't research yourself.

### 3. Verify
Call `verify_tracks` with `lane` and `text` set to the subagent's reply, **unchanged**. Don't retype, reorder, renumber or reformat it; the server reads it as it is.

Each result line is one find with a `W` ref:
- `✓`: on Spotify and new. Pickable.
- `dup`: already recommended, or already listed as a K ref (pick that ref instead). Not pickable.
- `pending`: not on Spotify yet. The server keeps checking it. Not pickable.
- `⚠ label is X, not Y as the source said`: the source got the label wrong. The track is still fine to pick if it fits.

### 4. Choose
Pick the tracks that best fit the baseline, from the ✓ W refs and the K and C refs. List them **best first**, because the server keeps your order and drops from the end to meet the lane's limits (shown in the begin result). Fewer than the target is fine: don't pad with weak fits.

Optional:
- `reject`: K or C refs that clearly don't belong in this lane, so they aren't offered again.
- `why`: a short attributed reason for a K or C pick, if you have one.

### 5. Finish
Call `discovery_finish` with `lane`, `picks` (the refs, best first), and optionally `reject`, `why` and `thin: true` if the research came back limited.
- "Unknown refs": you used a ref that isn't in this run. Fix the list and call it again.
- Any other error: call it once more. It's safe to repeat.

### 6. Reply
Your reply is the text after the `===== REPORT` line, exactly as given. Start with its first line. Add nothing before or after it: no summary, no "here's the report", no notes about the steps. The report is never `[SILENT]`.
