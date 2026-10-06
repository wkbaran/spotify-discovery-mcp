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
  /** Artist ids looked up this run, to cache. */
  artistIds: Record<string, string | null>;
  notes: string[];
}

/** `tag:new` covers the last two weeks; older gaps use `year:` and a date filter. */
const TAG_NEW_DAYS = 13;
const MAX_LABELS = 20;
const MAX_ARTISTS = 20;
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
  return out.slice(0, MAX_LABELS);
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
  return out.slice(0, MAX_ARTISTS);
}

/**
 * New releases since `since` (a day, `YYYY-MM-DD`) from the lane's labels and
 * artists. Failures are noted and skipped; the feed never throws.
 */
export async function collectFeed(client: SpotifyClient, lane: Lane, state: LaneState, since: string, today: string): Promise<FeedResult> {
  const notes: string[] = [];
  const albums = new Map<string, FeedRelease>();
  const activeLabels = new Set<string>();
  const artistIds: Record<string, string | null> = {};
  const recentEnough = daysBetween(since, today) <= TAG_NEW_DAYS;
  const fresh = (a: Album) => releaseDay(a.release_date) >= since && releaseDay(a.release_date) <= today;

  for (const src of labelSources(lane, state)) {
    const q = recentEnough ? `label:"${quoteSafe(src.name)}" tag:new` : `label:"${quoteSafe(src.name)}" year:${since.slice(0, 4)}-${today.slice(0, 4)}`;
    try {
      const found = (await client.searchAlbums(q, recentEnough ? 2 : 5)).filter(fresh);
      if (found.length) activeLabels.add(labelKey(src.name));
      for (const a of found) if (!albums.has(a.id)) albums.set(a.id, { album: a, label: src.name, via: { kind: "label", name: src.name, group: src.group, spotifyName: src.spotifyName }, tracks: [] });
    } catch (err) {
      rethrowRateLimit(err);
      notes.push(`Label ${src.name}: search failed (${short(err)}).`);
    }
  }

  for (const name of artistSources(lane, state)) {
    const k = textKey(name);
    let id = state.artist_ids[k];
    try {
      if (id === undefined) {
        const hits = await client.searchArtists(name);
        id = hits.find((a) => textKey(a.name) === k)?.id ?? null;
        artistIds[k] = id;
      }
      if (!id) continue;
      for (const a of (await client.artistAlbums(id, 10)).filter(fresh)) {
        if (!albums.has(a.id)) albums.set(a.id, { album: a, via: { kind: "artist", name, group: "artist" }, tracks: [] });
      }
    } catch (err) {
      rethrowRateLimit(err);
      notes.push(`Artist ${name}: lookup failed (${short(err)}).`);
    }
  }

  const releases = [...albums.values()].sort((a, b) => releaseDay(b.album.release_date).localeCompare(releaseDay(a.album.release_date))).slice(0, MAX_RELEASES);
  const kept: FeedRelease[] = [];
  const matched = new Set<string>();
  for (const r of releases) {
    try {
      // The ℗ line names the real label. Artist-found releases come with no
      // label at all, and `label:` search is loose ("Vision" also finds
      // Visionary Sounds), so a label-found release must really be on it.
      const actual = labelFromCopyrights((await client.album(r.album.id)).copyrights);
      if (r.via.kind === "label" && !onLabel(actual, r.via)) continue;
      r.label = actual ?? r.label;
      r.pLabel = actual;
      r.tracks = await client.albumTracks(r.album.id);
      if (r.via.kind === "label") matched.add(labelKey(r.via.name));
      kept.push(r);
    } catch (err) {
      rethrowRateLimit(err);
      notes.push(`${r.album.name}: couldn't read its tracks (${short(err)}).`);
    }
  }
  // A label only counts as active if a release really on it turned up.
  for (const k of [...activeLabels]) if (!matched.has(k)) activeLabels.delete(k);
  return { releases: kept.filter((r) => r.tracks.length > 0), activeLabels, artistIds, notes };
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
