import { readJson } from "job-ledger";
import { z } from "zod";
import { discoveryTimezone } from "../config.js";

const limits = {
  target: z.tuple([z.number().int().min(0), z.number().int().min(1).max(20)]),
  max_feed_picks: z.number().int().min(0).max(20),
  max_core_picks: z.number().int().min(0).max(20),
  min_web_picks: z.number().int().min(0).max(20),
  feed_cap: z.number().int().min(1).max(60),
  carry_days: z.number().int().min(1).max(365),
  max_age_days: z.number().int().min(7).max(3650),
  pending_days: z.number().int().min(1).max(180),
  quiet_runs: z.number().int().min(2).max(100),
  feed_requests: z.number().int().min(5).max(1000),
  feed_tracks: z.number().int().min(1).max(200),
};

export const DEFAULTS = {
  target: [3, 6] as [number, number],
  max_feed_picks: 3,
  max_core_picks: 2,
  min_web_picks: 0,
  feed_cap: 25,
  carry_days: 21,
  max_age_days: 365,
  pending_days: 42,
  quiet_runs: 8,
  feed_requests: 60,
  feed_tracks: 18,
};

const laneSchema = z.object({
  name: z.string().min(1),
  baseline: z.string().min(1),
  research: z.string().optional(),
  exclude: z.string().optional(),
  labels: z.array(z.string().min(1)).default([]),
  artists: z.array(z.string().min(1)).default([]),
  genres: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
  ...Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v.optional()])),
});

const fileSchema = z.object({
  /** No longer used (0.4.0): the time zone comes from SPOTIFY_DISCOVERY_TZ or TZ. Accepted so older files still load. */
  timezone: z.string().optional(),
  playlist: z
    .object({
      name: z.string().default("{YYMMDD}"),
      description: z.string().default("Discovery playlist auto-curated from your listening profile"),
      public: z.boolean().default(false),
    })
    .default({ name: "{YYMMDD}", description: "Discovery playlist auto-curated from your listening profile", public: false }),
  defaults: z.object(Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v.optional()]))).default({}),
  lanes: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "lane ids are lowercase letters, digits, - and _"), laneSchema),
});

export interface Lane {
  id: string;
  name: string;
  baseline: string;
  research?: string;
  exclude?: string;
  labels: string[];
  artists: string[];
  genres: string[];
  tags: string[];
  target: [number, number];
  max_feed_picks: number;
  max_core_picks: number;
  min_web_picks: number;
  feed_cap: number;
  /** Days an unpicked track stays in the pool (counted from when it was first shown), however often the lane runs. */
  carry_days: number;
  max_age_days: number;
  pending_days: number;
  quiet_runs: number;
  /** Spotify requests the known-source check may use per run; sources left over wait for a later run. */
  feed_requests: number;
  /** New tracks after which the known-source check stops early. */
  feed_tracks: number;
}

export interface LanesFile {
  timezone: string;
  playlist: { name: string; description: string; public: boolean };
  lanes: Record<string, Lane>;
}

/** Read and check lanes.json. Errors name the field, so they can be fixed by hand. */
export async function loadLanes(dir: string): Promise<LanesFile> {
  const loaded = await readJson(dir, "lanes.json", (v) => v);
  if (loaded.status === "missing") throw new Error(`No lanes.json in ${dir}. Copy hermes/lanes.example.json there and edit it.`);
  if (loaded.status === "corrupt") throw new Error(`lanes.json: ${loaded.warning}`);
  const parsed = fileSchema.safeParse(loaded.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`lanes.json: ${issue.path.join(".")}: ${issue.message}`);
  }
  const f = parsed.data;
  const lanes: Record<string, Lane> = {};
  for (const [id, raw] of Object.entries(f.lanes)) {
    const merged = { ...DEFAULTS, ...stripUndefined(f.defaults), ...stripUndefined(raw) } as Omit<Lane, "id">;
    if (merged.target[0] > merged.target[1]) throw new Error(`lanes.json: lanes.${id}.target: minimum is above maximum.`);
    lanes[id] = { ...merged, id };
  }
  const tz = discoveryTimezone();
  // stdout is the MCP channel; stderr is where hosts show server logs.
  if (tz.warning) console.error(tz.warning);
  // carry_runs (before 0.5.0) counted runs, so its meaning changed with the schedule; carry_days replaced it.
  const raw = loaded.value as { defaults?: object; lanes?: Record<string, object> };
  if ([raw.defaults, ...Object.values(raw.lanes ?? {})].some((o) => o && "carry_runs" in o)) console.error(`lanes.json: "carry_runs" is ignored since 0.5.0; use "carry_days" (default ${DEFAULTS.carry_days}).`);
  if (f.timezone && f.timezone !== tz.timeZone) console.error(`lanes.json's "timezone" (${f.timezone}) is ignored; set SPOTIFY_DISCOVERY_TZ or TZ instead. Using ${tz.timeZone}.`);
  return { timezone: tz.timeZone, playlist: f.playlist, lanes };
}

export function getLane(file: LanesFile, id: string): Lane {
  const lane = file.lanes[id.trim().toLowerCase()];
  if (!lane) throw new Error(`No lane "${id}" in lanes.json. Lanes: ${Object.keys(file.lanes).join(", ")}.`);
  return lane;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** core_artists from the taste job's file, if it's there. */
export async function loadCoreArtists(dir: string): Promise<string[]> {
  const loaded = await readJson(dir, "taste_profile.json", (v) => {
    const a = (v as { core_artists?: unknown })?.core_artists;
    return Array.isArray(a) ? a.map(String) : null;
  });
  return loaded.status === "ok" ? loaded.value : [];
}

/** A name template with today's date: {YYMMDD} (sorts by date and fits app titles), {YYYYMMDD} or {YYYY-MM-DD}. */
export function playlistName(template: string, day: string): string {
  const compact = day.replace(/-/g, "");
  return template.replace("{YYYYMMDD}", compact).replace("{YYMMDD}", compact.slice(2)).replace("{YYYY-MM-DD}", day);
}
