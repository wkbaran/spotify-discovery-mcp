import { isoSeconds, localDate, textKey } from "job-ledger";
import type { FetchLike } from "../auth/tokens.js";
import type { MetadataSource } from "../config.js";
import { fitsLane, genreLookup } from "../metadata/lookup.js";
import { playlistUrl, rethrowRateLimit, type SpotifyClient, type Track } from "../spotify/client.js";
import { addDays, collectFeed, labelSources, type FeedRelease } from "./feed.js";
import { labelKey, releaseDay, splitArtists, spotifyTrackKey } from "./keys.js";
import { getLane, loadCoreArtists, loadLanes, playlistName, type Lane } from "./lanes.js";
import { renderWorkList } from "./render.js";
import { DAYS_KEPT, readHistory, readLaneState, runStore, Seen, updateDays, type Day, type LaneState, type PoolItem, type RunFile, type RunItem } from "./state.js";
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

export async function discoveryBegin(ctx: Ctx, laneId: string): Promise<{ run: RunFile; view: string }> {
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
  const taken = new Set<string>(); // keys already given a ref in this run

  // 1. Pending web finds: on Spotify yet?
  const pendingNow: PoolItem[] = [];
  for (const p of Object.values(state.pending).slice(0, MAX_PENDING_CHECKS)) {
    if (addDays(p.first_seen, lane.pending_days) < day) {
      effects.pending_dropped.push(p.key);
      continue;
    }
    try {
      const v = await findOnSpotify(ctx.client, { artist: p.artist, track: p.title, release: p.release, label: p.label });
      if (!v) {
        effects.pending_checked.push(p.key);
        continue;
      }
      if (seen.find({ uri: v.track.uri, key: spotifyTrackKey(v.track), isrc: v.track.external_ids?.isrc })) {
        effects.pending_dropped.push(p.key); // recommended some other way since
        continue;
      }
      effects.pending_found.push(p.key);
      pendingNow.push({ ...toPoolItem(v.track, { source: "web", label: v.label, p_label: v.pLabel, why: p.why, source_url: p.source_url, first_seen: p.first_seen }), passes: 0 });
    } catch (err) {
      rethrowRateLimit(err);
      effects.pending_checked.push(p.key);
    }
  }

  // 2. The feed.
  const feed = await collectFeed(ctx.client, lane, state, since, day);
  notes.push(...feed.notes);
  effects.artist_ids = feed.artistIds;
  effects.searched_labels = labelSources(lane, state).map((s) => labelKey(s.name));
  effects.active_labels = [...feed.activeLabels];

  const items: Record<string, RunItem> = {};
  const groups: Record<string, string[]> = {};
  const order: RunFile["order"] = { feed: [], carried: [], web: [] };
  const groupRank = { promoted: 0, artist: 1, seed: 2, found: 3 } as const;
  const releases = [...feed.releases].sort(
    (a, b) => groupRank[a.via.group] - groupRank[b.via.group] || releaseDay(b.album.release_date).localeCompare(releaseDay(a.album.release_date)),
  );

  let n = 0;
  let hidden = 0;
  for (const r of releases) {
    const fresh = r.tracks.filter((t) => {
      const key = spotifyTrackKey(t);
      return !taken.has(key) && !seen.find({ uri: t.uri, key }) && !state.closed[key] && !state.pool[key];
    });
    if (!fresh.length) continue;
    if (order.feed.length >= lane.feed_cap) {
      hidden++;
      continue;
    }
    n++;
    const ref = `K${n}`;
    order.feed.push(ref);
    const shown = fresh.slice(0, MAX_TRACKS_PER_RELEASE);
    const make = (t: Track, itemRef: string): RunItem => {
      const pool = toPoolItem(t, { source: "feed", label: r.label, p_label: r.pLabel, via: `${r.via.kind} ${r.via.name}`, first_seen: day }, r);
      taken.add(pool.key);
      return { ...pool, ref: itemRef, kind: "K", core: isCore(pool.artists) };
    };
    if (shown.length === 1) {
      items[ref] = make(shown[0]!, ref);
    } else {
      groups[ref] = shown.map((t, i) => {
        const sub = `${ref}.${i + 1}`;
        items[sub] = make(t, sub);
        return sub;
      });
      if (fresh.length > shown.length) notes.push(`${ref} has ${fresh.length - shown.length} more tracks not listed.`);
    }
  }

  // 3. Carried over from earlier runs, and pending finds now on Spotify.
  let c = 0;
  const expiredBefore = addDays(day, -lane.max_age_days);
  const carried = Object.values(state.pool)
    .filter((p) => {
      if (p.passes >= lane.carry_runs || releaseDay(p.released) < expiredBefore) {
        effects.expired.push(p.key);
        return false;
      }
      return !taken.has(p.key) && !seen.find(p);
    })
    .sort((a, b) => a.passes - b.passes || releaseDay(b.released).localeCompare(releaseDay(a.released)));
  for (const p of [...pendingNow, ...carried].slice(0, MAX_CARRIED)) {
    c++;
    const ref = `C${c}`;
    taken.add(p.key);
    items[ref] = { ...p, ref, kind: "C", core: isCore(p.artists) };
    order.carried.push(ref);
  }

  // 4. Genre for what's shown (fail-open, a bounded number of lookups).
  if (ctx.metadata.has("beatport") || ctx.metadata.has("deezer")) {
    // One track per release first, so every release gets a genre line; then the rest.
    const firsts = [...order.feed.map((r) => (groups[r] ? groups[r]![0]! : r)), ...order.carried];
    const rest = Object.keys(items).filter((r) => !firsts.includes(r));
    const todo = [...firsts, ...rest].map((r) => items[r]!).filter((i) => i.meta === undefined).slice(0, MAX_META_LOOKUPS);
    await mapLimit(todo, 3, async (i) => {
      i.meta = await genreLookup(ctx.fetchImpl, ctx.metadata, i);
      i.fit = fitsLane(i.meta, lane);
    });
  }
  for (const i of Object.values(items)) if (i.fit === undefined && i.meta) i.fit = fitsLane(i.meta, lane);

  const id = await runs.newId(now, lane.id);
  const run: RunFile = {
    id,
    lane: lane.id,
    started_at: isoSeconds(now),
    day,
    playlist: { id: playlist.playlist_id, name: playlist.name, url: playlist.url, tracks_before: playlist.tracks.length },
    since,
    items,
    groups,
    order,
    hidden,
    notes,
    labels_found: [],
    effects,
    spotify_requests: ctx.client.requests - requestsAtStart,
  };
  await runs.write(id, run);
  await runs.prune(lane.id);
  return { run, view: renderWorkList(run, lane, { labels: labelSources(lane, state).map((s) => s.name), artists: coveredArtists(lane, state, coreArtists) }) };
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
