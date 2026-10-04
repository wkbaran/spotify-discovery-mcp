import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pendingReports } from "../src/discovery/report.js";
import { runStore, type RunFile } from "../src/discovery/state.js";

let dir: string;
const run = (lane: string, started: string, report?: string): RunFile => ({
  id: "",
  lane,
  started_at: started,
  day: started.slice(0, 10),
  playlist: { id: "p", name: "n", url: "u", tracks_before: 0 },
  since: "2026-09-29",
  items: {},
  groups: {},
  order: { feed: [], carried: [], web: [] },
  hidden: 0,
  notes: [],
  labels_found: [],
  effects: { expired: [], pending_found: [], pending_dropped: [], pending_checked: [], artist_ids: {}, searched_labels: [], active_labels: [] },
  ...(report ? { finished: { at: started, report } } : {}),
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "report-"));
  await writeFile(join(dir, "lanes.json"), JSON.stringify({ lanes: { "a-dnb": { name: "DnB", baseline: "x" }, "b-ukg": { name: "UKG", baseline: "y" } } }));
  const runs = runStore(dir);
  const put = async (r: RunFile) => {
    const id = await runs.newId(new Date(r.started_at), r.lane);
    await runs.write(id, { ...r, id });
  };
  await put(run("a-dnb", "2026-10-06T15:00:00Z", "**Lane:** DnB report"));
  await put(run("b-ukg", "2026-10-06T15:35:00Z"));
  await put(run("a-dnb", "2026-10-01T15:00:00Z", "old report"));
});

describe("report", () => {
  it("prints each finished report once, flags a stalled run once, and ignores old runs", async () => {
    const opts = { stallMinutes: 90, windowHours: 24 };
    expect(await pendingReports(dir, { ...opts, now: new Date("2026-10-06T16:00:00Z") })).toBe("**Lane:** DnB report");
    expect(await pendingReports(dir, { ...opts, now: new Date("2026-10-06T16:05:00Z") })).toBe("");
    const later = await pendingReports(dir, { ...opts, now: new Date("2026-10-06T17:10:00Z") });
    expect(later).toMatch(/⚠ \*\*UKG\*\*: the run that started 2026-10-06T15:35:00Z never finished/);
    expect(await pendingReports(dir, { ...opts, now: new Date("2026-10-06T17:15:00Z") })).toBe("");
  });

  it("can mark everything as printed without printing", async () => {
    const r = await pendingReports(dir, { stallMinutes: 0, windowHours: 24, markOnly: true, now: new Date("2026-10-06T16:00:00Z") });
    expect(r).toMatch(/^Marked 2 as printed/);
    expect(await pendingReports(dir, { stallMinutes: 0, windowHours: 24, now: new Date("2026-10-06T16:01:00Z") })).toBe("");
  });
});
