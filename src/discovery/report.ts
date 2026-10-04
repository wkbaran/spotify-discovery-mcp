import { isoSeconds, readJson, updateJson } from "job-ledger";
import { loadLanes } from "./lanes.js";
import { runStore, type RunFile } from "./state.js";

/**
 * Which run reports have been printed, so each goes out once. Kept apart from
 * the run files so a report tick never races a lane's own writes.
 */
interface Sent {
  sent: Record<string, string>;
  stalled: Record<string, string>;
}

const validSent = (v: unknown): Sent | null => {
  const s = v as Sent;
  return s && typeof s.sent === "object" && typeof s.stalled === "object" ? s : null;
};

export interface ReportOptions {
  /** A run that started this long ago and hasn't finished is reported as stalled. */
  stallMinutes: number;
  /** Only runs started within this many hours are considered. */
  windowHours: number;
  /** Mark everything due as printed without printing it (for a first deploy). */
  markOnly?: boolean;
  now?: Date;
}

/**
 * The `report` command, for a scheduled no_agent job: prints each finished
 * lane report that hasn't been printed yet, and a one-line warning for a run
 * that started but never finished. Prints nothing when there's nothing new,
 * which Hermes treats as a silent run.
 */
export async function pendingReports(dir: string, opts: ReportOptions): Promise<string> {
  const now = opts.now ?? new Date();
  const lanes = await loadLanes(dir);
  const runs = runStore(dir);
  const since = now.getTime() - opts.windowHours * 3_600_000;
  const due: { run: RunFile; kind: "report" | "stalled" }[] = [];
  const loaded = await readJson(dir, "reports.json", validSent);
  const sent: Sent = loaded.status === "ok" ? loaded.value : { sent: {}, stalled: {} };

  for (const lane of Object.keys(lanes.lanes)) {
    for (const id of await runs.list(lane)) {
      const run = await runs.read(id);
      if (!run || Date.parse(run.started_at) < since) continue;
      if (run.finished) {
        if (!sent.sent[id]) due.push({ run, kind: "report" });
      } else if (!sent.stalled[id] && now.getTime() - Date.parse(run.started_at) > opts.stallMinutes * 60_000) {
        // Only the lane's latest run can still finish; an older unfinished one was abandoned.
        due.push({ run, kind: "stalled" });
      }
    }
  }
  if (!due.length) return "";
  due.sort((a, b) => a.run.started_at.localeCompare(b.run.started_at));

  await updateJson<Sent, null>(dir, "reports.json", { validate: validSent, initial: () => ({ sent: {}, stalled: {} }) }, (s) => {
    for (const d of due) (d.kind === "report" ? s.sent : s.stalled)[d.run.id] = isoSeconds(now);
    // Forget entries older than two weeks.
    const cutoff = isoSeconds(new Date(now.getTime() - 14 * 86_400_000));
    for (const book of [s.sent, s.stalled]) for (const [k, v] of Object.entries(book)) if (v < cutoff) delete book[k];
    return { value: s, result: null };
  });
  if (opts.markOnly) return `Marked ${due.length} as printed: ${due.map((d) => d.run.id).join(", ")}`;

  return due
    .map((d) => {
      if (d.kind === "report") return d.run.finished!.report;
      const name = lanes.lanes[d.run.lane]?.name ?? d.run.lane;
      return `⚠ **${name}**: the run that started ${d.run.started_at} never finished, so nothing was added for this lane. Its candidates come back next run.`;
    })
    .join("\n\n———\n\n");
}
