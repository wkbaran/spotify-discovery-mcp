import { textKey } from "job-ledger";
import { quoteSafe, rethrowRateLimit, type Album, type SpotifyClient, type Track } from "../spotify/client.js";
import { labelContains, labelFromCopyrights, labelKey, releaseDay } from "./keys.js";
import type { Lane } from "./lanes.js";
import type { LaneState } from "./state.js";

/** A release found by the feed, with its tracks. */
export interface FeedRelease {
  album: Album;
  label?: string;
  /** The label from the album's ℗ line, when it has one. */
  pLabel?: string;
  via: { kind: "label" | "artist"; name: string; group: "promoted" | "artist" | "seed" | "found"; spotifyName?: string };
  tracks: Track[];
}

export interface FeedResult {
  releases: FeedRelease[];
  /** Label keys whose search found something new (for quiet-run counting). */
  activeLabels: Set<string>;
  /** Label keys actually searched this run. */
  searchedLabels: string[];
  /** Artist ids looked up this run, to cache. */
  artistIds: Record<string, string | null>;
  /** Source keys checked this run, for LaneState.checked. */
  checked: string[];
  /** Sources checked of all, why the check stopped, and the oldest last check among those left waiting. */
  stats: { checked: number; total: number; stopped: "done" | "tracks" | "requests"; oldest_waiting?: string };
  notes: string[];
}

/** `tag:new` covers the last two weeks; older gaps use `year:` and a date filter. */
const TAG_NEW_DAYS = 13;
/** A source that has waited longer than this looks back only this far. */
const MAX_LOOKBACK_DAYS = 30;
const MAX_RELEASES = 60;

export interface FeedSource {
  name: string;
  group: FeedRelease["via"]["group"];
  /** The label's confirmed ℗ name (learned labels only). */
  spotifyName?: string;
}

/** The labels to search: promoted, then seeds from lanes.json, then found. One entry per label key. */
export function labelSources(lane: Lane, state: LaneState): FeedSource[] {
  const out: FeedSource[] = [];
  const seen = new Set<string>();
  const add = (name: string, group: FeedSource["group"], spotifyName?: string) => {
    const k = labelKey(name);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(spotifyName ? { name, group, spotifyName } : { name, group });
  };
  for (const l of Object.values(state.labels)) if (l.origin === "promoted") add(l.name, "promoted", l.spotify_name);
  for (const name of lane.labels) add(name, "seed");
  for (const l of Object.values(state.labels)) if (l.origin === "found") add(l.name, "found", l.spotify_name);
  return out;
}

/** Lane artists: from lanes.json, then learned from picks. */
export function artistSources(lane: Lane, state: LaneState): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...lane.artists, ...Object.values(state.artists).sort((a, b) => b.picks - a.picks).map((a) => a.name)]) {
    const k = textKey(name);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(name);
    }
  }
  return out;
}

export interface QueuedSource extends FeedSource {
  kind: "label" | "artist";
  /** `label:<key>` or `artist:<key>`, as in LaneState.checked. */
  key: string;
  /** The day it was last checked, if ever. */
  last?: string;
}

/**
 * Every known label and artist, longest-waiting first: never-checked ones lead,
 * and ties keep the usual order (promoted, seed and found labels, then artists
 * by picks). A source left out of a run is near the front of the next one.
 */
export function sourceQueue(lane: Lane, state: LaneState): QueuedSource[] {
  const all: QueuedSource[] = [
    ...labelSources(lane, state).map((s) => ({ ...s, kind: "label" as const, key: `label:${labelKey(s.name)}` })),
    ...artistSources(lane, state).map((name) => ({ name, group: "artist" as const, kind: "artist" as const, key: `artist:${textKey(name)}` })),
  ].map((s) => {
    const last = state.checked[s.key];
    return last ? { ...s, last } : s;
  });
  return all
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.last ?? "").localeCompare(b.s.last ?? "") || a.i - b.i)
    .map((x) => x.s);
}

export interface FeedOptions {
  today: string;
  /** The window for a source never checked: the lane's last run, or the first-run lookback. */
  fallbackSince: string;
  /** True for a track the lane hasn't seen, recommended, closed or pooled; only these count toward feed_tracks. */
  isNew: (t: Track) => boolean;
}

/**
 * New releases from the lane's labels and artists, each source looking back to
 * its own last check. It works down sourceQueue() and stops once it has
 * `lane.feed_tracks` new tracks or has used `lane.feed_requests` requests; the
 * sources left over go first next run. Failures are noted and skipped (a failed
 * source isn't marked checked); the feed never throws, except on a rate limit.
 */
export async function collectFeed(client: SpotifyClient, lane: Lane, state: LaneState, opts: FeedOptions): Promise<FeedResult> {
  const { today } = opts;
  const notes: string[] = [];
  const albums = new Map<string, FeedRelease>();
  const kept: FeedRelease[] = [];
  const activeLabels = new Set<string>();
  const searchedLabels: string[] = [];
  const artistIds: Record<string, string | null> = {};
  const checked: string[] = [];
  const queue = sourceQueue(lane, state);
  const start = client.requests;
  const floor = addDays(today, -MAX_LOOKBACK_DAYS);
  let newTracks = 0;
  let stopped: FeedResult["stats"]["stopped"] = "done";
  let i = 0;

  for (; i < queue.length; i++) {
    if (newTracks >= lane.feed_tracks) {
      stopped = "tracks";
      break;
    }
    if (client.requests - start >= lane.feed_requests) {
      stopped = "requests";
      break;
    }
    const src = queue[i]!;
    const own = src.last ? addDays(src.last, -1) : opts.fallbackSince;
    const since = own < floor ? floor : own;
    const fresh = (a: Album) => releaseDay(a.release_date) >= since && releaseDay(a.release_date) <= today;
    try {
      let found: FeedRelease[];
      if (src.kind === "label") {
        const recentEnough = daysBetween(since, today) <= TAG_NEW_DAYS;
        const q = recentEnough ? `label:"${quoteSafe(src.name)}" tag:new` : `label:"${quoteSafe(src.name)}" year:${since.slice(0, 4)}-${today.slice(0, 4)}`;
        found = (await client.searchAlbums(q, recentEnough ? 2 : 5)).filter(fresh).map((a) => ({ album: a, label: src.name, via: { kind: "label", name: src.name, group: src.group, spotifyName: src.spotifyName }, tracks: [] }));
        searchedLabels.push(labelKey(src.name));
      } else {
        const k = textKey(src.name);
        let id = state.artist_ids[k];
        if (id === undefined) {
          const hits = await client.searchArtists(src.name);
          id = hits.find((a) => textKey(a.name) === k)?.id ?? null;
          artistIds[k] = id;
        }
        found = id ? (await client.artistAlbums(id, 10)).filter(fresh).map((a) => ({ album: a, via: { kind: "artist", name: src.name, group: "artist" }, tracks: [] })) : [];
      }
      for (const r of found) {
        if (albums.has(r.album.id) || albums.size >= MAX_RELEASES) continue;
        albums.set(r.album.id, r);
        if (await readRelease(client, r, notes)) {
          if (r.via.kind === "label") activeLabels.add(labelKey(r.via.name));
          kept.push(r);
          newTracks += r.tracks.filter(opts.isNew).length;
        }
      }
      checked.push(src.key);
    } catch (err) {
      rethrowRateLimit(err);
      notes.push(src.kind === "label" ? `Label ${src.name}: search failed (${short(err)}).` : `Artist ${src.name}: lookup failed (${short(err)}).`);
    }
  }

  const waiting = queue.slice(i);
  const oldest = waiting.map((s) => s.last ?? "").sort()[0];
  const stats: FeedResult["stats"] = { checked: i, total: queue.length, stopped, ...(waiting.length ? { oldest_waiting: oldest || "never" } : {}) };
  kept.sort((a, b) => releaseDay(b.album.release_date).localeCompare(releaseDay(a.album.release_date)));
  return { releases: kept.filter((r) => r.tracks.length > 0), activeLabels, searchedLabels, artistIds, checked, stats, notes };
}

/**
 * Read a release's ℗ line and tracks. False when a label-found release isn't
 * really on the label, or the album couldn't be read. The album response
 * carries its first page of tracks, so most releases cost one request.
 */
async function readRelease(client: SpotifyClient, r: FeedRelease, notes: string[]): Promise<boolean> {
  try {
    // The ℗ line names the real label. Artist-found releases come with no
    // label at all, and `label:` search is loose ("Vision" also finds
    // Visionary Sounds), so a label-found release must really be on it.
    const full = await client.album(r.album.id);
    const actual = labelFromCopyrights(full.copyrights);
    if (r.via.kind === "label" && !onLabel(actual, r.via)) return false;
    r.label = actual ?? r.label;
    r.pLabel = actual;
    r.tracks = full.tracks && !full.tracks.next ? full.tracks.items : await client.albumTracks(r.album.id);
    return true;
  } catch (err) {
    rethrowRateLimit(err);
    notes.push(`${r.album.name}: couldn't read its tracks (${short(err)}).`);
    return false;
  }
}

/**
 * Is a release found by searching for a label really on it? With the label's
 * confirmed ℗ name, only that name counts ("Bubble" isn't "Bubble beats
 * bollywood"); without one, every word of the label's name must be in the ℗
 * label, and a release with no ℗ line is given the benefit of the doubt.
 */
export function onLabel(actual: string | undefined, via: { name: string; spotifyName?: string }): boolean {
  if (via.spotifyName) return !!actual && labelKey(actual) === labelKey(via.spotifyName);
  return !actual || labelContains(actual, via.name);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

const short = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 120);
