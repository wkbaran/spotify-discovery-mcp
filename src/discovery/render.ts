import { clip } from "job-ledger";
import { metaLine } from "../metadata/lookup.js";
import type { Lane } from "./lanes.js";
import type { RunFile, RunItem } from "./state.js";

/** The line marking where the reply starts in discovery_finish's result. */
export const REPORT_MARKER = "===== REPORT (reply with everything below this line, unchanged) =====";

const MAX_CHARS = 38_000;

const year = (d: string) => (d ? d.slice(0, 10) : "date unknown");

function itemLine(i: RunItem, opts: { indent?: boolean; showRelease?: boolean } = {}): string {
  const bits = [
    `${opts.indent ? "    " : ""}${i.ref}  ${i.artist} — ${i.title}`,
    opts.showRelease === false ? "" : ` · ${i.release && i.release !== i.title ? `${i.release}, ` : ""}${i.release_type || "release"}, ${year(i.released)}`,
    i.label ? ` · ${i.label}` : "",
  ].join("");
  const tags = [i.core ? "core artist" : "", i.passes ? `passed ${i.passes}×` : "", i.kind === "C" && i.source === "web" ? "web find" : ""].filter(Boolean);
  const meta = metaLine(i.meta);
  return [bits, tags.length ? ` [${tags.join(", ")}]` : "", meta ? `\n${opts.indent ? "      " : "    "}${meta}${i.fit === false ? "  ⚠ genre outside this lane" : ""}` : ""].join("");
}

/** discovery_begin's result: the lane brief, the feed with refs, and what research should skip. */
export function renderWorkList(run: RunFile, lane: Lane, covered: { labels: string[]; artists: string[] }): string {
  const L: string[] = [];
  L.push(`Lane ${lane.id}: ${lane.name}`);
  L.push(`Today's playlist: ${run.playlist.name} (${run.playlist.tracks_before} tracks so far)`);
  L.push(`Baseline: ${lane.baseline}`);
  if (lane.research) L.push(`Research note: ${lane.research}`);
  if (lane.exclude) L.push(`Exclude: ${lane.exclude}`);
  L.push(rulesLine(lane));
  L.push("");
  if (run.order.feed.length) {
    L.push(`New from known labels and artists (since ${run.since}):`);
    for (const ref of run.order.feed) {
      const group = run.groups[ref];
      if (!group) {
        L.push(itemLine(run.items[ref]!));
        continue;
      }
      const first = run.items[group[0]!]!;
      L.push(`${ref}  ${first.release} (${first.release_type}, ${year(first.released)}${first.label ? `, ${first.label}` : ""}) · ${group.length} tracks:`);
      for (const sub of group) L.push(itemLine(run.items[sub]!, { indent: true, showRelease: false }));
    }
    if (run.hidden) L.push(`(+${run.hidden} more releases not listed; they come back next run)`);
  } else {
    L.push(`New from known labels and artists (since ${run.since}): nothing.`);
  }
  if (run.order.carried.length) {
    L.push("");
    L.push("Carried over from earlier runs (still eligible):");
    for (const ref of run.order.carried) L.push(itemLine(run.items[ref]!));
  }
  if (run.notes.length) {
    L.push("");
    for (const n of run.notes) L.push(`Note: ${n}`);
  }
  L.push("");
  L.push(`Covered labels (research should look elsewhere): ${covered.labels.join(", ") || "none yet"}`);
  L.push(`Covered artists: ${covered.artists.join(", ") || "none yet"}`);
  return fit(L.join("\n"));
}

export function rulesLine(lane: Lane): string {
  const [min, max] = lane.target;
  return `Pick up to ${max} (aim for ${min}–${max}; fewer is fine if nothing else fits). At most ${lane.max_feed_picks} from K/C refs unless no web find verifies. At most ${lane.max_core_picks} by core artists.${lane.min_web_picks ? ` At least ${lane.min_web_picks} web picks when you have them.` : ""}`;
}

/** verify_tracks' result: one line per candidate. */
export function renderVerifyLines(items: RunItem[], extra: string[]): string {
  const L: string[] = [];
  for (const i of items) {
    const head = `${i.ref} ${statusMark(i)} ${i.artist} — ${i.title}`;
    if (i.status === "ok") {
      L.push(`${head} · ${i.release && i.release !== i.title ? `${i.release}, ` : ""}${year(i.released)}${i.label ? ` · ${i.label}` : ""}${i.core ? " [core artist]" : ""}`);
      if (i.label_note) L.push(`    ⚠ ${i.label_note}`);
      const meta = metaLine(i.meta);
      if (meta) L.push(`    ${meta}${i.fit === false ? "  ⚠ genre outside this lane" : ""}`);
    } else {
      L.push(`${head} · ${i.status_note ?? ""}`);
    }
  }
  L.push(...extra);
  const ok = items.filter((i) => i.status === "ok").length;
  L.push("", `${ok} of ${items.length} verified. Pick by ref (W, K or C) in discovery_finish, best first.`);
  return fit(L.join("\n"));
}

const statusMark = (i: RunItem) => ({ ok: "✓", dup: "dup", pending: "pending", notfound: "✗" })[i.status ?? "ok"];

export interface ReportInput {
  lane: Lane;
  run: RunFile;
  added: RunItem[];
  alreadyThere: RunItem[];
  why: Record<string, string>;
  dropped: { item: RunItem; reason: string }[];
  dups: RunItem[];
  pending: RunItem[];
  newLabels: string[];
  droppedLabels: string[];
  quietSeeds: string[];
  thin: boolean;
  researchThin: boolean;
}

/** The message the agent sends unchanged. */
export function renderReport(r: ReportInput): string {
  const L: string[] = [];
  L.push(`**Lane:** ${r.lane.name}`);
  L.push(`**Playlist:** ${r.run.playlist.name} — <${r.run.playlist.url}>`);
  L.push("");
  const all = [...r.added, ...r.alreadyThere];
  if (all.length) {
    L.push(`**Added (${r.added.length}):**`);
    for (const i of all) {
      const facts = [i.label, i.released ? i.released.slice(0, 10) : ""].filter(Boolean).join(", ");
      const meta = metaLine(i.meta);
      const why = r.why[i.ref] || i.why || "";
      const src = i.source_url ? ` <${i.source_url}>` : "";
      const notes = [i.core ? "*core artist*" : "", r.alreadyThere.includes(i) ? "*was already in the playlist*" : ""].filter(Boolean).join(" · ");
      L.push(`- **${i.artist} — ${i.title}**${facts ? ` (${facts})` : ""}${why ? `. ${clip(why, 300)}` : ""}${src}${meta ? ` · ${meta}` : ""}${notes ? ` · ${notes}` : ""}`);
    }
  } else {
    L.push("**Added:** nothing this run.");
  }
  const extra: string[] = [];
  if (r.dropped.length) extra.push(`Dropped by limits: ${r.dropped.map((d) => `${d.item.artist} — ${d.item.title} (${d.reason})`).join("; ")}`);
  if (r.dups.length) extra.push(`Already recommended: ${r.dups.map((d) => `${d.artist} — ${d.title}`).join("; ")}`);
  if (r.pending.length) extra.push(`Not on Spotify yet (re-checking each run): ${r.pending.map((p) => `${p.artist} — ${p.title}${p.source_url ? ` <${p.source_url}>` : ""}`).join("; ")}`);
  if (r.newLabels.length) extra.push(`New labels for this lane: ${r.newLabels.join(", ")}`);
  if (r.droppedLabels.length) extra.push(`Gone quiet, dropped: ${r.droppedLabels.join(", ")}`);
  if (r.quietSeeds.length) extra.push(`Seed labels with nothing new for a while: ${r.quietSeeds.join(", ")}`);
  if (r.thin || r.researchThin) extra.push("Results were limited this run.");
  if (extra.length) L.push("", ...extra);
  return L.join("\n");
}

/** Keep a result under Hermes's limit, cutting from the end. */
function fit(s: string): string {
  return s.length <= MAX_CHARS ? s : s.slice(0, MAX_CHARS - 60) + "\n… (cut to fit; the rest is in the run file)";
}
