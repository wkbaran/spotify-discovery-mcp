import { mkdir } from "node:fs/promises";
import { insideDir, readJson, RunStore, updateJson } from "job-ledger";

/** Genre and tempo from Beatport or SoundCloud. */
export interface Meta {
  from: "beatport" | "soundcloud";
  genre?: string;
  bpm?: number;
  key?: string;
  label?: string;
  tags?: string[];
  url?: string;
}

/** A candidate track the lane has seen and not finished with. */
export interface PoolItem {
  key: string;
  uri: string;
  isrc?: string;
  /** Display credit, e.g. "Sulphur, Ho Gosh, Macarite". */
  artist: string;
  artists: string[];
  title: string;
  release: string;
  release_id?: string;
  release_type: string;
  released: string;
  label?: string;
  source: "feed" | "web";
  /** How the feed found it: "label Critical Music", "artist Omneum". */
  via?: string;
  why?: string;
  source_url?: string;
  first_seen: string;
  passes: number;
  meta?: Meta | null;
}

/** A web find that wasn't on Spotify yet; re-checked each run until `pending_days`. */
export interface PendingItem {
  key: string;
  artist: string;
  title: string;
  release?: string;
  label?: string;
  released?: string;
  why?: string;
  source_url?: string;
  first_seen: string;
  checks: number;
}

export interface LearnedLabel {
  name: string;
  origin: "found" | "promoted";
  first_seen: string;
  source_url?: string;
  note?: string;
  picks: number;
  /** Runs in a row where this label's feed had nothing new. */
  quiet_runs: number;
  last_release?: string;
}

export interface LearnedArtist {
  name: string;
  picks: number;
  first_seen: string;
}

export interface LaneState {
  last_run?: string;
  last_finished_run?: string;
  labels: Record<string, LearnedLabel>;
  /** Quiet-run counts for the seed labels in lanes.json (never dropped, only reported). */
  seed_quiet: Record<string, number>;
  artists: Record<string, LearnedArtist>;
  /** Spotify artist ids by name key (null: searched, not found). */
  artist_ids: Record<string, string | null>;
  pool: Record<string, PoolItem>;
  pending: Record<string, PendingItem>;
  /** Keys that are done with: picked, rejected or expired, and when. */
  closed: Record<string, { status: "picked" | "rejected" | "expired"; date: string }>;
}

export const emptyLaneState = (): LaneState => ({ labels: {}, seed_quiet: {}, artists: {}, artist_ids: {}, pool: {}, pending: {}, closed: {} });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function validLaneState(v: unknown): LaneState | null {
  if (!isObj(v)) return null;
  const s = { ...emptyLaneState(), ...v } as LaneState;
  for (const k of ["labels", "seed_quiet", "artists", "artist_ids", "pool", "pending", "closed"] as const) if (!isObj(s[k])) return null;
  return s;
}

export interface HistoryEntry {
  uri?: string;
  isrc?: string;
  artist: string;
  title: string;
  key: string;
  lane?: string;
  date: string;
}

export interface History {
  tracks: HistoryEntry[];
}

export const validHistory = (v: unknown): History | null => (isObj(v) && Array.isArray(v.tracks) ? (v as unknown as History) : null);

export interface DayTrack {
  uri: string;
  key: string;
  artist: string;
  title: string;
  lane: string;
  added_at: string;
}

export interface Day {
  playlist_id: string;
  name: string;
  url: string;
  created_at: string;
  tracks: DayTrack[];
}

export interface Days {
  days: Record<string, Day>;
}

export const validDays = (v: unknown): Days | null => (isObj(v) && isObj(v.days) ? (v as unknown as Days) : null);

export const DAYS_KEPT = 30;

/** An item in a run: a pool item with its ref and what the run found out about it. */
export interface RunItem extends PoolItem {
  ref: string;
  kind: "K" | "C" | "W";
  core: boolean;
  /** Web finds only. */
  status?: "ok" | "dup" | "pending" | "notfound";
  status_note?: string;
  /** The ℗ label differs from the label the source claimed. */
  label_note?: string;
  /** False when the genre found is outside the lane's genres/tags. */
  fit?: boolean;
}

export interface RunFile {
  id: string;
  lane: string;
  started_at: string;
  day: string;
  playlist: { id: string; name: string; url: string; tracks_before: number };
  since: string;
  items: Record<string, RunItem>;
  /** Refs of multi-track releases → their track refs. */
  groups: Record<string, string[]>;
  order: { feed: string[]; carried: string[]; web: string[] };
  /** Feed items left out of the work list by `feed_cap`. */
  hidden: number;
  notes: string[];
  labels_found: { name: string; source_url?: string; note?: string }[];
  /**
   * What `begin` found that changes the lane's state. `begin` writes only the
   * run file (and today's playlist); `finish` applies these, so a run that
   * never finishes changes nothing.
   */
  effects: {
    expired: string[];
    pending_found: string[];
    pending_dropped: string[];
    pending_checked: string[];
    artist_ids: Record<string, string | null>;
    searched_labels: string[];
    active_labels: string[];
  };
  finished?: { at: string; report: string };
  /** Spotify API requests made for this run so far (begin, verify_tracks, finish). */
  spotify_requests?: number;
}

/** Lane-specific state files live under lanes/. */
export async function laneStateName(dir: string, lane: string): Promise<string> {
  await mkdir(await insideDir(dir, "lanes"), { recursive: true });
  return `lanes/${lane}.json`;
}

export async function readLaneState(dir: string, lane: string): Promise<LaneState> {
  const r = await readJson(dir, await laneStateName(dir, lane), validLaneState);
  return r.status === "ok" ? r.value : emptyLaneState();
}

export async function updateLaneState<R>(dir: string, lane: string, change: (s: LaneState) => { value: LaneState; result: R } | Promise<{ value: LaneState; result: R }>) {
  return updateJson(dir, await laneStateName(dir, lane), { validate: validLaneState, initial: emptyLaneState }, change);
}

export async function readHistory(dir: string): Promise<History> {
  const r = await readJson(dir, "history.json", validHistory);
  return r.status === "ok" ? r.value : { tracks: [] };
}

export async function readDays(dir: string): Promise<Days> {
  const r = await readJson(dir, "days.json", validDays);
  return r.status === "ok" ? r.value : { days: {} };
}

/** Today's playlist is created inside this lock, so allow for a slow Spotify call. */
export const DAYS_LOCK = { waitMs: 90_000, staleMs: 120_000 };

export function updateDays<R>(dir: string, change: (d: Days) => { value: Days; result: R } | Promise<{ value: Days; result: R }>) {
  return updateJson(dir, "days.json", { validate: validDays, initial: () => ({ days: {} }), lock: DAYS_LOCK }, change);
}

export function updateHistory<R>(dir: string, change: (h: History) => { value: History; result: R }) {
  return updateJson(dir, "history.json", { validate: validHistory, initial: () => ({ tracks: [] }) }, change);
}

export const runStore = (dir: string) => new RunStore<RunFile>({ dir, keep: 14 });

/** Lookups for "has this been recommended before?" */
export class Seen {
  readonly uris = new Set<string>();
  readonly keys = new Map<string, HistoryEntry>();
  readonly isrcs = new Set<string>();

  constructor(history: History, day?: Day) {
    for (const t of history.tracks) {
      if (t.uri) this.uris.add(t.uri);
      if (t.isrc) this.isrcs.add(t.isrc.toUpperCase());
      if (t.key) this.keys.set(t.key, t);
    }
    for (const t of day?.tracks ?? []) {
      this.uris.add(t.uri);
      if (!this.keys.has(t.key)) this.keys.set(t.key, { artist: t.artist, title: t.title, key: t.key, lane: t.lane, date: t.added_at.slice(0, 10) });
    }
  }

  find(t: { uri?: string; key: string; isrc?: string }): HistoryEntry | { date: string; lane?: string } | null {
    if (t.key && this.keys.has(t.key)) return this.keys.get(t.key)!;
    if (t.uri && this.uris.has(t.uri)) return { date: "earlier" };
    if (t.isrc && this.isrcs.has(t.isrc.toUpperCase())) return { date: "earlier" };
    return null;
  }
}
