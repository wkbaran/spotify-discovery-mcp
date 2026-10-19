import { isoSeconds, localDate, textKey } from "job-ledger";
import type { FetchLike } from "../auth/tokens.js";
import type { MetadataSource } from "../config.js";
import { fitsLane, genreLookup } from "../metadata/lookup.js";
import { playlistUrl, RateLimitError, type SpotifyClient, type Track } from "../spotify/client.js";
import { addDays, collectFeed, labelSources, type FeedRelease } from "./feed.js";
import { labelKey, releaseDay, splitArtists, spotifyTrackKey } from "./keys.js";
import { getLane, loadCoreArtists, loadLanes, playlistName, type Lane } from "./lanes.js";
import { renderWorkList } from "./render.js";
import { DAYS_KEPT, readDays, readHistory, readLaneState, runStore, Seen, updateDays, type Day, type LaneState, type PoolItem, type RunFile, type RunItem } from "./state.js";
import { findOnSpotify } from "./verify.js";

export interface Ctx {
  client: SpotifyClient;
  dir: string;
  /** For the Beatport, SoundCloud and Deezer lookups. */
  fetchImpl: FetchLike;
  metadata: Set<MetadataSource>;
  now?: () => Date;
}

const MAX_TRACKS_PER_RELEASE = 8;
const MAX_CARRIED = 12;
const MAX_PENDING_CHECKS = 10;
const MAX_META_LOOKUPS = 20;
/** A first run looks back this far: just inside what `tag:new` search covers, so it stays the cheap search. */
const FIRST_RUN_DAYS = 13;

/** A begin within this long of an unfinished run's start continues that run instead of starting another. */
export const RESUME_MINUTES = 90;

/** Today's playlist: the one recorded for today, or a new one, created under the days.json lock. */
export async function todaysPlaylist(ctx: Ctx, day: string, template: { name: string; description: string; public: boolean }, now: Date): Promise<Day> {
  const r = await updateDays(ctx.dir, async (d) => {
    for (const k of Object.keys(d.days).sort().slice(0, Math.max(0, Object.keys(d.days).length - DAYS_KEPT))) delete d.days[k];
    if (d.days[day]) return { value: d, result: d.days[day]! };
    const name = playlistName(template.name, day);
    const p = await ctx.client.createPlaylist(name, template.description, template.public);
    const entry: Day = { playlist_id: p.id, name: p.name ?? name, url: p.external_urls?.spotify ?? playlistUrl(p.id), created_at: isoSeconds(now), tracks: [] };
    d.days[day] = entry;
    return { value: d, result: entry };
  });
  return r.result;
}

export interface BeginOptions {
  /**
   * false: don't check the known labels and artists or the pending finds yet;
   * discovery_fill does that later, only if the web research falls short. The
   * default (true) does both now, as before 0.6.0.
   */
  feed?: boolean;
}

export async function discoveryBegin(ctx: Ctx, laneId: string, opts: BeginOptions = {}): Promise<{ run: RunFile; view: string }> {
  const now = ctx.now?.() ?? new Date();
  const requestsAtStart = ctx.client.requests;
  const lanes = await loadLanes(ctx.dir);
  const lane = getLane(lanes, laneId);
  const day = localDate(now, lanes.timezone);
  const runs = runStore(ctx.dir);

  // A second begin while a run is open continues that run. A retry after a timeout, or a research
  // subagent calling begin (as d-exp's did on 2026-10-04), would otherwise orphan its verified finds.
  const open = (await runs.latest(lane.id))?.run;
  if (open && !open.finished && open.day === day && now.getTime() - Date.parse(open.started_at) < RESUME_MINUTES * 60_000) {
    const [openState, openCore] = await Promise.all([readLaneState(ctx.dir, lane.id), loadCoreArtists(ctx.dir)]);
    const view = renderWorkList(open, lane, { labels: labelSources(lane, openState).map((s) => s.name), artists: coveredArtists(lane, openState, openCore) });
    return {
      run: open,
      view: `Continuing this lane's open run (started ${open.started_at}; nothing new was fetched). If you are the research subagent, call only verify_tracks.\n\n${view}`,
    };
  }

  const playlist = await todaysPlaylist(ctx, day, lanes.playlist, now);
  const [history, state, coreArtists] = await Promise.all([readHistory(ctx.dir), readLaneState(ctx.dir, lane.id), loadCoreArtists(ctx.dir)]);
  const seen = new Seen(history, playlist);
  const core = new Set(coreArtists.map(textKey));
  const isCore = (artists: string[]) => artists.some((a) => core.has(textKey(a)));
  const since = state.last_run ? addDays(localDate(new Date(state.last_run), lanes.timezone), -1) : addDays(day, -FIRST_RUN_DAYS);
  const notes: string[] = [];
  const effects: RunFile["effects"] = { expired: [], pending_found: [], pending_dropped: [], pending_checked: [], artist_ids: {}, searched_labels: [], active_labels: [] };
  const items: Record<string, RunItem> = {};
  const order: RunFile["order"] = { feed: [], carried: [], web: [] };

  // Carried over from earlier runs: already checked, so they cost no requests.
  const expiredBefore = addDays(day, -lane.max_age_days);
  const carried = Object.values(state.pool)
    .filter((p) => {
      if (addDays(p.first_seen, lane.carry_days) < day || releaseDay(p.released) < expiredBefore) {
        effects.expired.push(p.key);
        return false;
      }
      return !seen.find(p);
    })
    .sort((a, b) => a.passes - b.passes || releaseDay(b.released).localeCompare(releaseDay(a.released)));
  for (const [i, p] of carried.slice(0, MAX_CARRIED).entries()) {
    const ref = `C${i + 1}`;
    items[ref] = { ...p, ref, kind: "C", core: isCore(p.artists) };
    order.carried.push(ref);
  }

  const id = await runs.newId(now, lane.id);
  const run: RunFile = {
    id,
    lane: lane.id,
    started_at: isoSeconds(now),
    day,
    playlist: { id: playlist.playlist_id, name: playlist.name, url: playlist.url, tracks_before: playlist.tracks.length },
    since,
    items,
    groups: {},
    order,
    hidden: 0,
    notes,
    labels_found: [],
    effects,
    spotify_requests: 0,
    requests_by_step: {},
  };
  if (opts.feed === false) {
    // Known sources wait for discovery_fill, which looks only for as many as the run is short.
    run.deferred = true;
    await lookUpGenres(ctx, run);
  } else {
    await fillRun(ctx, run, lane, state, { seen, core });
  }
  run.spotify_requests = ctx.client.requests - requestsAtStart;
  run.requests_by_step = { ...run.requests_by_step, begin: ctx.client.requests - requestsAtStart };
  await runs.write(id, run);
  await runs.prune(lane.id);
  return { run, view: renderWorkList(run, lane, { labels: labelSources(lane, state).map((s) => s.name), artists: coveredArtists(lane, state, coreArtists) }) };
}

/** How the known-source check is sized when a run is short by `need` picks: about three candidates and ten requests per missing pick. */
export const fillBudget = (lane: Lane, need: number) => ({ maxTracks: Math.min(lane.feed_tracks, need * 3), maxRequests: Math.min(lane.feed_requests, 10 + need * 8) });

/** A pending find is looked for again at most this often. Most never turn up, so a daily search wasted requests. */
export const PENDING_RECHECK_DAYS = 7;

/**
 * Adds to an open run what the known sources have: new releases from the lane's
 * labels and artists (K refs), then, only if that found fewer than `need` new
 * tracks, the pending web finds that are now on Spotify (C refs). Without `need`,
 * the lane's own budgets apply and the pending finds are always checked (the
 * one-step begin). Writes nothing; the caller saves the run. Returns the new refs.
 */
export async function fillRun(ctx: Ctx, run: RunFile, lane: Lane, state: LaneState, o: { need?: number; seen?: Seen; core?: Set<string> } = {}): Promise<string[]> {
  const startRequests = ctx.client.requests;
  const seen = o.seen ?? new Seen(await readHistory(ctx.dir), (await readDays(ctx.dir)).days[run.day]);
  const core = o.core ?? new Set((await loadCoreArtists(ctx.dir)).map(textKey));
  const isCore = (artists: string[]) => artists.some((a) => core.has(textKey(a)));
  const taken = new Set(Object.values(run.items).map((i) => i.key));
  const effects = run.effects;
  const added: string[] = [];

  // 1. The feed: known labels and artists, longest-waiting first.
  const budget = o.need === undefined ? {} : fillBudget(lane, o.need);
  const feed = await collectFeed(ctx.client, lane, state, {
    today: run.day,
    fallbackSince: run.since,
    ...budget,
    isNew: (t) => {
      const key = spotifyTrackKey(t);
      return !seen.find({ uri: t.uri, key }) && !state.closed[key] && !state.pool[key] && !taken.has(key);
    },
  });
  run.notes.push(...feed.notes);
  if (feed.stats.checked < feed.stats.total && feed.stats.stopped !== "blocked") {
    const why = feed.stats.stopped === "tracks" ? `enough new tracks found` : `request budget used`;
    const oldest = feed.stats.oldest_waiting === "never" ? "some never checked yet" : `oldest last checked ${feed.stats.oldest_waiting}`;
    run.notes.push(`Checked ${feed.stats.checked} of ${feed.stats.total} known labels and artists (${why}); the other ${feed.stats.total - feed.stats.checked} go first next time (${oldest}).`);
  }
  Object.assign(effects.artist_ids, feed.artistIds);
  effects.searched_labels.push(...feed.searchedLabels);
  effects.active_labels.push(...feed.activeLabels);
  effects.checked = [...(effects.checked ?? []), ...feed.checked];
  run.feed = feed.stats;

  const groupRank = { promoted: 0, artist: 1, seed: 2, found: 3 } as const;
  const releases = [...feed.releases].sort(
    (a, b) => groupRank[a.via.group] - groupRank[b.via.group] || releaseDay(b.album.release_date).localeCompare(releaseDay(a.album.release_date)),
  );
  let n = run.order.feed.length;
  let newTracks = 0;
  for (const r of releases) {
    const fresh = r.tracks.filter((t) => {
      const key = spotifyTrackKey(t);
      return !taken.has(key) && !seen.find({ uri: t.uri, key }) && !state.closed[key] && !state.pool[key];
    });
    if (!fresh.length) continue;
    if (run.order.feed.length >= lane.feed_cap) {
      run.hidden++;
      continue;
    }
    n++;
    const ref = `K${n}`;
    run.order.feed.push(ref);
    added.push(ref);
    const shown = fresh.slice(0, MAX_TRACKS_PER_RELEASE);
    newTracks += shown.length;
    const make = (t: Track, itemRef: string): RunItem => {
      const pool = toPoolItem(t, { source: "feed", label: r.label, p_label: r.pLabel, via: `${r.via.kind} ${r.via.name}`, first_seen: run.day }, r);
      taken.add(pool.key);
      return { ...pool, ref: itemRef, kind: "K", core: isCore(pool.artists) };
    };
    if (shown.length === 1) {
      run.items[ref] = make(shown[0]!, ref);
    } else {
      run.groups[ref] = shown.map((t, i) => {
        const sub = `${ref}.${i + 1}`;
        run.items[sub] = make(t, sub);
        return sub;
      });
      if (fresh.length > shown.length) run.notes.push(`${ref} has ${fresh.length - shown.length} more tracks not listed.`);
    }
  }
  const feedRequests = ctx.client.requests - startRequests;

  // 2. Pending web finds, last: most never turn up. Each is looked for at most weekly, longest-unchecked first.
  if (o.need === undefined || newTracks < o.need) {
    const due = Object.values(state.pending)
      .filter((p) => !p.last_checked || addDays(p.last_checked, PENDING_RECHECK_DAYS) <= run.day)
      .sort((a, b) => (a.last_checked ?? "").localeCompare(b.last_checked ?? "") || a.first_seen.localeCompare(b.first_seen))
      .slice(0, MAX_PENDING_CHECKS);
    let c = run.order.carried.length;
    for (const p of due) {
      // "LABEL — …" entries came from label lines read as tracks before 0.3.x.
      if (addDays(p.first_seen, lane.pending_days) < run.day || /^label$/i.test(p.artist.trim())) {
        effects.pending_dropped.push(p.key);
        continue;
      }
      try {
        const v = await findOnSpotify(ctx.client, { artist: p.artist, track: p.title, release: p.release, label: p.label }, { quick: true });
        if (!v) {
          effects.pending_checked.push(p.key);
          continue;
        }
        if (seen.find({ uri: v.track.uri, key: spotifyTrackKey(v.track), isrc: v.track.external_ids?.isrc })) {
          effects.pending_dropped.push(p.key); // recommended some other way since
          continue;
        }
        effects.pending_found.push(p.key);
        const item = toPoolItem(v.track, { source: "web", label: v.label, p_label: v.pLabel, why: p.why, source_url: p.source_url, first_seen: p.first_seen });
        if (taken.has(item.key)) continue;
        taken.add(item.key);
        const ref = `C${++c}`;
        run.items[ref] = { ...item, ref, kind: "C", core: isCore(item.artists) };
        run.order.carried.push(ref);
        added.push(ref);
      } catch (err) {
        if (err instanceof RateLimitError) {
          run.notes.push(`Spotify stopped the pending check: ${err.message}`);
          break;
        }
        effects.pending_checked.push(p.key);
      }
    }
  }

  await lookUpGenres(ctx, run);
  run.requests_by_step = {
    ...run.requests_by_step,
    feed: (run.requests_by_step?.feed ?? 0) + feedRequests,
    pending: (run.requests_by_step?.pending ?? 0) + ctx.client.requests - startRequests - feedRequests,
  };
  return added;
}

/** Genre for what's shown (fail-open, a bounded number of lookups), one track per release first. */
async function lookUpGenres(ctx: Ctx, run: RunFile): Promise<void> {
  const lane = getLane(await loadLanes(ctx.dir), run.lane);
  if (ctx.metadata.has("beatport") || ctx.metadata.has("deezer")) {
    const firsts = [...run.order.feed.map((r) => (run.groups[r] ? run.groups[r]![0]! : r)), ...run.order.carried];
    const rest = Object.keys(run.items).filter((r) => !firsts.includes(r) && !r.startsWith("W"));
    const todo = [...firsts, ...rest].map((r) => run.items[r]!).filter((i) => i.meta === undefined).slice(0, MAX_META_LOOKUPS);
    await mapLimit(todo, 3, async (i) => {
      i.meta = await genreLookup(ctx.fetchImpl, ctx.metadata, i);
      i.fit = fitsLane(i.meta, lane);
    });
  }
  for (const i of Object.values(run.items)) if (i.fit === undefined && i.meta) i.fit = fitsLane(i.meta, lane);
}

/** Artists the research should skip: lane artists plus learned ones. */
function coveredArtists(lane: Lane, state: LaneState, _core: string[]): string[] {
  const out = new Map<string, string>();
  for (const a of [...lane.artists, ...Object.values(state.artists).map((x) => x.name)]) out.set(textKey(a), a);
  return [...out.values()];
}

export function toPoolItem(
  t: Track,
  o: { source: PoolItem["source"]; label?: string; p_label?: string; via?: string; why?: string; source_url?: string; first_seen: string },
  release?: FeedRelease,
): PoolItem {
  const album = release?.album ?? t.album;
  const artists = t.artists.map((a) => a.name);
  return {
    key: spotifyTrackKey(t),
    uri: t.uri,
    isrc: t.external_ids?.isrc,
    artist: artists.join(", "),
    artists,
    title: t.name,
    release: album?.name ?? "",
    release_id: album?.id,
    release_type: album?.album_type ?? "",
    released: album?.release_date ?? "",
    label: o.label,
    p_label: o.p_label,
    source: o.source,
    via: o.via,
    why: o.why,
    source_url: o.source_url,
    first_seen: o.first_seen,
    passes: 0,
  };
}

export async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

export const firstArtist = (credit: string) => splitArtists(credit)[0] ?? credit;
