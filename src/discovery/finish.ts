import { cleanRef, isoSeconds, laterIso, localDate, resolveRefs, textKey } from "job-ledger";
import { fitsLane, beatportLookup, soundcloudLookup } from "../metadata/lookup.js";
import { rethrowRateLimit } from "../spotify/client.js";
import { addDays } from "./feed.js";
import { labelKey, spotifyTrackKey, trackKey } from "./keys.js";
import { getLane, loadCoreArtists, loadLanes, type Lane } from "./lanes.js";
import { REPORT_MARKER, renderReport, renderReview, renderVerifyLines } from "./render.js";
import { applyPickRules } from "./rules.js";
import { readDays, readHistory, readLaneState, runStore, Seen, updateDays, updateHistory, updateLaneState, type RunFile, type RunItem } from "./state.js";
import { findOnSpotify, parseCandidatesText, type Candidate, type FoundLabel } from "./verify.js";
import { toPoolItem, type Ctx } from "./begin.js";

const MAX_CANDIDATES = 25;
const MAX_POOL = 200;
const MAX_PENDING = 30;

async function openRun(dir: string, lane: string): Promise<RunFile> {
  const latest = await runStore(dir).latest(lane);
  if (!latest) throw new Error(`No run for lane ${lane} yet. Call discovery_begin first.`);
  return latest.run;
}

/** verify_tracks: check web finds on Spotify, give them W refs. */
export async function verifyTracks(ctx: Ctx, laneId: string, input: { candidates?: Candidate[]; text?: string }): Promise<string> {
  const lanes = await loadLanes(ctx.dir);
  const lane = getLane(lanes, laneId);
  const run = await openRun(ctx.dir, lane.id);
  if (run.finished) return `Lane ${lane.id}'s latest run is already finished. Call discovery_begin to start a new one.`;

  const parsed = input.text ? parseCandidatesText(input.text) : { candidates: [], labels: [] as FoundLabel[] };
  const candidates = [...(input.candidates ?? []), ...parsed.candidates].slice(0, MAX_CANDIDATES);
  if (!candidates.length) return "No candidates found. Pass the research reply as `text` (one per line: artist | track | release | label | date | why | URL), or as `candidates`.";

  const [history, days, state, coreArtists] = await Promise.all([readHistory(ctx.dir), readDays(ctx.dir), readLaneState(ctx.dir, lane.id), loadCoreArtists(ctx.dir)]);
  const seen = new Seen(history, days.days[run.day]);
  const core = new Set(coreArtists.map(textKey));
  const byKey = new Map(Object.values(run.items).map((i) => [i.key, i]));
  let n = run.order.web.length;
  const out: RunItem[] = [];

  for (const c of candidates) {
    const guessKey = trackKey(c.artist, c.track);
    const existing = byKey.get(guessKey);
    if (existing?.kind === "W") {
      out.push(existing);
      continue;
    }
    n++;
    const ref = `W${n}`;
    const base = { why: c.why, source_url: c.source_url, first_seen: run.day };
    let item: RunItem;
    try {
      const v = await findOnSpotify(ctx.client, c);
      if (!v) {
        item = {
          ...{ key: guessKey, uri: "", artist: c.artist, artists: [c.artist], title: c.track, release: c.release ?? "", release_type: "", released: c.released ?? "", label: c.label, source: "web" as const, passes: 0, ...base },
          ref,
          kind: "W",
          core: false,
          status: "pending",
          status_note: "not on Spotify (yet); re-checked each run",
        };
      } else {
        const pool = toPoolItem(v.track, { source: "web", label: v.label, ...base });
        const dup = seen.find(pool);
        const inRun = byKey.get(pool.key);
        item = { ...pool, ref, kind: "W", core: pool.artists.some((a) => core.has(textKey(a))), status: "ok", label_note: v.labelNote };
        if (dup) Object.assign(item, { status: "dup", status_note: `recommended ${"date" in dup ? dup.date : "before"}${"lane" in dup && dup.lane ? ` (${dup.lane})` : ""}` });
        else if (inRun) Object.assign(item, { status: "dup", status_note: `already listed as ${inRun.ref}; pick ${inRun.ref}` });
        else if (state.closed[pool.key]?.status === "rejected") Object.assign(item, { status: "dup", status_note: `rejected for this lane on ${state.closed[pool.key]!.date}` });
      }
    } catch (err) {
      rethrowRateLimit(err);
      item = {
        ...{ key: guessKey, uri: "", artist: c.artist, artists: [c.artist], title: c.track, release: c.release ?? "", release_type: "", released: c.released ?? "", label: c.label, source: "web" as const, passes: 0, ...base },
        ref,
        kind: "W",
        core: false,
        status: "notfound",
        status_note: `lookup failed: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
      };
    }
    if (item.status === "ok") {
      const sc = ctx.metadata.has("soundcloud") && c.source_url ? await soundcloudLookup(ctx.fetchImpl, c.source_url).catch(() => null) : null;
      item.meta = sc ?? (ctx.metadata.has("beatport") ? await beatportLookup(ctx.fetchImpl, { artist: item.artist, artists: item.artists, title: item.title, label: item.label }).catch(() => null) : null);
      item.fit = fitsLane(item.meta, lane);
    }
    run.items[ref] = item;
    run.order.web.push(ref);
    byKey.set(item.key, item);
    out.push(item);
  }
  run.labels_found.push(...parsed.labels);
  await runStore(ctx.dir).write(run.id, run);
  const extra = parsed.labels.length ? [`Labels noted for this lane: ${parsed.labels.map((l) => l.name).join(", ")}`] : [];
  return renderVerifyLines(out, extra);
}

/** discovery_review: everything pickable in the current run, from the server's copy. */
export async function discoveryReview(dir: string, laneId: string): Promise<string> {
  const lanes = await loadLanes(dir);
  const lane = getLane(lanes, laneId);
  const run = await openRun(dir, lane.id);
  if (run.finished) return `Lane ${lane.id}'s latest run is already finished. Its report:\n${REPORT_MARKER}\n${run.finished.report}`;
  const web = run.order.web.map((r) => run.items[r]!);
  return renderReview(run, lane, web);
}

export interface FinishArgs {
  picks: string[];
  why?: Record<string, string>;
  reject?: string[];
  new_labels?: FoundLabel[];
  thin?: boolean;
  dry_run?: boolean;
}

/** discovery_finish: apply the rules, add to the playlist, save everything, return the report. */
export async function discoveryFinish(ctx: Ctx, laneId: string, args: FinishArgs): Promise<{ ok: boolean; text: string }> {
  const lanes = await loadLanes(ctx.dir);
  const lane = getLane(lanes, laneId);
  const run = await openRun(ctx.dir, lane.id);
  if (run.finished) return { ok: true, text: `This run was already finished; nothing changed. Reply with one line: Done: ${run.lane}\n${REPORT_MARKER}\n${run.finished.report}` };

  // Refs: a multi-track release ref means its first track.
  const notes: string[] = [];
  const lookup = (ref: string): RunItem | undefined => {
    if (run.items[ref]) return run.items[ref];
    const group = run.groups[ref];
    if (group?.length) {
      notes.push(`${ref} is a release; took its first track, ${group[0]}.`);
      return run.items[group[0]!];
    }
    return undefined;
  };
  const resolved = resolveRefs(args.picks, lookup);
  if (resolved.unknown.length) {
    return { ok: false, text: `Unknown refs: ${resolved.unknown.join(", ")}. Use refs from this run's discovery_begin (K, C) or verify_tracks (W). Nothing was saved.` };
  }
  const unusable = resolved.found.filter((f) => f.item.kind === "W" && f.item.status !== "ok");
  for (const u of unusable) notes.push(`${u.ref} can't be added (${u.item.status}: ${u.item.status_note ?? ""}).`);
  // "K1" (a release) and "K1.1" (its first track) are the same pick; keep the first.
  const seenKeys = new Set<string>();
  const picks = resolved.found.filter((f) => {
    if (f.item.kind === "W" && f.item.status !== "ok") return false;
    if (seenKeys.has(f.item.key)) return false;
    seenKeys.add(f.item.key);
    return true;
  });
  const verifiedWeb = Object.values(run.items).filter((i) => i.kind === "W" && i.status === "ok").length;
  const rules = applyPickRules(picks.map((p) => ({ ref: p.item.ref, fromFeed: p.item.kind !== "W", core: p.item.core })), lane, verifiedWeb);
  const kept = rules.kept.map((r) => run.items[r]!);
  const dropped = rules.dropped.map((d) => ({ item: run.items[d.ref]!, reason: d.reason }));
  const why: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.why ?? {})) {
    const ref = cleanRef(k);
    if (ref && v) why[ref] = v;
  }
  const rejected = resolveRefs(args.reject ?? [], lookup).found.map((f) => f.item);
  const webItems = run.order.web.map((r) => run.items[r]!);
  const dups = webItems.filter((i) => i.status === "dup");
  const pending = webItems.filter((i) => i.status === "pending");

  if (args.dry_run) {
    const report = renderReport({ lane, run, added: kept, alreadyThere: [], why, dropped, dups, pending, newLabels: [], droppedLabels: [], quietSeeds: [], thin: rules.thin, researchThin: !!args.thin });
    return { ok: true, text: `Dry run: nothing added or saved.${notes.length ? "\n" + notes.join("\n") : ""}\n${REPORT_MARKER}\n${report}` };
  }

  // 1. The playlist, checked live so a repeated call adds nothing twice.
  const now = new Date(ctx.now?.() ?? new Date());
  const day = run.day;
  const { result: playlistResult } = await updateDays(ctx.dir, async (d) => {
    const entry = d.days[day];
    if (!entry) throw new Error(`days.json has no playlist for ${day}; call discovery_begin again.`);
    const live = await ctx.client.playlistTracks(entry.playlist_id);
    const liveUris = new Set(live.map((t) => t.uri));
    const liveKeys = new Set(live.map((t) => spotifyTrackKey(t)));
    const toAdd = kept.filter((i) => !liveUris.has(i.uri) && !liveKeys.has(i.key));
    const already = kept.filter((i) => !toAdd.includes(i));
    if (toAdd.length) await ctx.client.addToPlaylist(entry.playlist_id, toAdd.map((i) => i.uri));
    for (const i of toAdd) entry.tracks.push({ uri: i.uri, key: i.key, artist: i.artist, title: i.title, lane: lane.id, added_at: isoSeconds(now) });
    return { value: d, result: { added: toAdd, already } };
  });

  // 2. History.
  await updateHistory(ctx.dir, (h) => {
    const have = new Set(h.tracks.map((t) => t.key));
    for (const i of kept) if (!have.has(i.key)) h.tracks.push({ uri: i.uri, isrc: i.isrc, artist: i.artist, title: i.title, key: i.key, lane: lane.id, date: day });
    return { value: h, result: null };
  });

  // 3. The lane's own state.
  const labelOutcome = await updateLaneState(ctx.dir, lane.id, (s) => applyToLane(s, { lane, run, kept, rejected, newLabels: [...run.labels_found, ...(args.new_labels ?? [])] }));

  const report = renderReport({
    lane,
    run,
    added: playlistResult.added,
    alreadyThere: playlistResult.already,
    why,
    dropped,
    dups,
    pending,
    newLabels: labelOutcome.result.added,
    droppedLabels: labelOutcome.result.dropped,
    quietSeeds: labelOutcome.result.quietSeeds,
    thin: rules.thin,
    researchThin: !!args.thin,
  });
  run.finished = { at: isoSeconds(now), report };
  await runStore(ctx.dir).write(run.id, run);
  const head = [`Saved. Added ${playlistResult.added.length} track(s) to ${run.playlist.name}.`, ...notes, ...labelOutcome.warnings, `Reply with one line: Done: ${run.lane}`].join("\n");
  return { ok: true, text: `${head}\n${REPORT_MARKER}\n${report}` };
}

interface LaneChange {
  lane: Lane;
  run: RunFile;
  kept: RunItem[];
  rejected: RunItem[];
  newLabels: FoundLabel[];
}

/** Everything a finished run changes in lanes/<lane>.json. Exported for tests. */
export function applyToLane(s: import("./state.js").LaneState, c: LaneChange) {
  const { lane, run } = c;
  const day = run.day;
  const result = { added: [] as string[], dropped: [] as string[], quietSeeds: [] as string[] };
  if (s.last_finished_run === run.id) return { value: s, result };

  const keptKeys = new Set(c.kept.map((i) => i.key));
  const rejectedKeys = new Set(c.rejected.map((i) => i.key));
  const seedLabels = new Set(lane.labels.map(labelKey));
  const seedArtists = new Set(lane.artists.map(textKey));

  // Labels the research found. Added before the picks are counted, so a label
  // found and picked in the same run is credited (and promoted) straight away.
  for (const l of c.newLabels) {
    const k = labelKey(l.name);
    if (!k || seedLabels.has(k) || s.labels[k]) continue;
    s.labels[k] = { name: l.name.trim(), origin: "found", first_seen: day, source_url: l.source_url, note: l.note, picks: 0, quiet_runs: 0 };
    result.added.push(l.name.trim());
  }

  // Picks and rejections are done with.
  for (const i of c.kept) {
    s.closed[i.key] = { status: "picked", date: day };
    delete s.pool[i.key];
    delete s.pending[i.key];
    const a = i.artists[0];
    if (a && !seedArtists.has(textKey(a))) {
      const k = textKey(a);
      s.artists[k] = { name: a, picks: (s.artists[k]?.picks ?? 0) + 1, first_seen: s.artists[k]?.first_seen ?? day };
    }
    if (i.label) {
      const lk = labelKey(i.label);
      const learned = s.labels[lk];
      if (learned) {
        learned.picks++;
        if (learned.origin === "found") learned.origin = "promoted";
      }
    }
  }
  for (const i of c.rejected) {
    s.closed[i.key] = { status: "rejected", date: day };
    delete s.pool[i.key];
  }

  // Everything shown and not chosen carries over, one more pass.
  for (const i of Object.values(run.items)) {
    if (keptKeys.has(i.key) || rejectedKeys.has(i.key)) continue;
    if (i.kind === "W" && i.status === "pending") {
      if (!s.pending[i.key] && !s.closed[i.key]) {
        s.pending[i.key] = { key: i.key, artist: i.artist, title: i.title, release: i.release || undefined, label: i.label, released: i.released || undefined, why: i.why, source_url: i.source_url, first_seen: day, checks: 0 };
      }
      continue;
    }
    if (i.kind === "W" && i.status !== "ok") continue;
    if (s.closed[i.key]) continue;
    const { ref: _r, kind: _k, core: _c, status: _s, status_note: _n, label_note: _l, fit: _f, ...pool } = i;
    s.pool[i.key] = { ...pool, passes: (s.pool[i.key]?.passes ?? i.passes) + 1 };
  }

  // What begin found out.
  const e = run.effects;
  for (const k of e.expired) {
    delete s.pool[k];
    s.closed[k] ??= { status: "expired", date: day };
  }
  for (const k of [...e.pending_found, ...e.pending_dropped]) delete s.pending[k];
  for (const k of e.pending_checked) if (s.pending[k]) s.pending[k]!.checks++;
  Object.assign(s.artist_ids, e.artist_ids);

  // Labels: quiet counts, drops, new ones.
  const active = new Set(e.active_labels);
  for (const k of e.searched_labels) {
    const learned = s.labels[k];
    if (learned) {
      learned.quiet_runs = active.has(k) ? 0 : learned.quiet_runs + 1;
      if (active.has(k)) learned.last_release = day;
      if (learned.origin === "found" && learned.picks === 0 && learned.quiet_runs >= lane.quiet_runs) {
        result.dropped.push(learned.name);
        delete s.labels[k];
      }
    } else if (seedLabels.has(k)) {
      s.seed_quiet[k] = active.has(k) ? 0 : (s.seed_quiet[k] ?? 0) + 1;
      if (s.seed_quiet[k] === lane.quiet_runs) result.quietSeeds.push(lane.labels.find((l) => labelKey(l) === k) ?? k);
    }
  }

  // Bounds.
  trim(s.pool, MAX_POOL, (p) => p.first_seen);
  trim(s.pending, MAX_PENDING, (p) => p.first_seen);
  const cutoff = addDays(day, -400);
  for (const [k, v] of Object.entries(s.closed)) if (v.date < cutoff) delete s.closed[k];

  s.last_run = laterIso(s.last_run, run.started_at);
  s.last_finished_run = run.id;
  return { value: s, result };
}

function trim<T>(rec: Record<string, T>, max: number, age: (t: T) => string): void {
  const keys = Object.keys(rec);
  if (keys.length <= max) return;
  keys.sort((a, b) => age(rec[a]!).localeCompare(age(rec[b]!)));
  for (const k of keys.slice(0, keys.length - max)) delete rec[k];
}

/** discovery_status: state at a glance. */
export async function discoveryStatus(dir: string, laneId?: string, now = new Date()): Promise<string> {
  const lanes = await loadLanes(dir);
  const [days, history, core] = await Promise.all([readDays(dir), readHistory(dir), loadCoreArtists(dir)]);
  const L: string[] = [];
  const today = localDate(now, lanes.timezone);
  const d = days.days[today];
  L.push(d ? `Today (${today}): ${d.name}, ${d.tracks.length} tracks <${d.url}>` : `Today (${today}): no playlist yet.`);
  L.push(`History: ${history.tracks.length} tracks recommended.`);
  const assigned = new Set<string>();
  for (const lane of Object.values(lanes.lanes)) {
    if (laneId && lane.id !== laneId) continue;
    const s = await readLaneState(dir, lane.id);
    for (const a of [...lane.artists, ...Object.values(s.artists).map((x) => x.name)]) assigned.add(textKey(a));
    const learned = Object.values(s.labels);
    L.push("");
    L.push(`${lane.id} — ${lane.name}`);
    L.push(`  last run: ${s.last_run ?? "never"} · pool ${Object.keys(s.pool).length} · pending ${Object.keys(s.pending).length}`);
    L.push(`  seed labels: ${lane.labels.join(", ") || "none"}`);
    if (learned.length) L.push(`  learned labels: ${learned.map((l) => `${l.name} (${l.origin}, ${l.picks} picks, quiet ${l.quiet_runs})`).join("; ")}`);
    const quiet = Object.entries(s.seed_quiet).filter(([, n]) => n >= lane.quiet_runs);
    if (quiet.length) L.push(`  quiet seed labels: ${quiet.map(([k, n]) => `${k} (${n} runs)`).join(", ")}`);
    if (Object.keys(s.artists).length) L.push(`  learned artists: ${Object.values(s.artists).map((a) => a.name).join(", ")}`);
    if (Object.keys(s.pending).length) L.push(`  pending: ${Object.values(s.pending).map((p) => `${p.artist} — ${p.title} (since ${p.first_seen})`).join("; ")}`);
  }
  if (!laneId && core.length) {
    const unassigned = core.filter((a) => !assigned.has(textKey(a)));
    if (unassigned.length) L.push("", `Core artists in no lane (add them to a lane's "artists" in lanes.json to follow their releases): ${unassigned.join(", ")}`);
  }
  const recent = await runStore(dir).list(laneId);
  if (recent.length) L.push("", `Recent runs: ${recent.slice(-6).join(", ")}`);
  return L.join("\n");
}

/** mark_recommended: add tracks to history by hand so they're never suggested. */
export async function markRecommended(ctx: Ctx, laneId: string, tracks: string[]): Promise<string> {
  const lanes = await loadLanes(ctx.dir);
  const lane = getLane(lanes, laneId);
  const day = localDate(new Date(), lanes.timezone);
  const entries: { uri?: string; artist: string; title: string; key: string }[] = [];
  const bad: string[] = [];
  for (const raw of tracks) {
    const id = raw.match(/(?:spotify:track:|open\.spotify\.com\/track\/)([A-Za-z0-9]{22})/)?.[1];
    if (id) {
      const t = await ctx.client.request<import("../spotify/client.js").Track>("GET", `/tracks/${id}`);
      entries.push({ uri: t.uri, artist: t.artists.map((a) => a.name).join(", "), title: t.name, key: spotifyTrackKey(t) });
      continue;
    }
    const m = raw.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    if (m) entries.push({ artist: m[1]!.trim(), title: m[2]!.trim(), key: trackKey(m[1]!, m[2]!) });
    else bad.push(raw);
  }
  const r = await updateHistory(ctx.dir, (h) => {
    const have = new Set(h.tracks.map((t) => t.key));
    let added = 0;
    for (const e of entries) if (!have.has(e.key)) {
      h.tracks.push({ ...e, lane: lane.id, date: day });
      have.add(e.key);
      added++;
    }
    return { value: h, result: added };
  });
  return `Added ${r.result} of ${entries.length} to history.${bad.length ? ` Couldn't read: ${bad.join("; ")} (use "Artist — Title" or a Spotify track link).` : ""}`;
}

/** forget: remove a learned label or artist from a lane. */
export async function forget(dir: string, laneId: string, what: { label?: string; artist?: string }): Promise<string> {
  const lanes = await loadLanes(dir);
  const lane = getLane(lanes, laneId);
  const r = await updateLaneState(dir, lane.id, (s) => {
    const done: string[] = [];
    if (what.label && s.labels[labelKey(what.label)]) {
      done.push(`label ${s.labels[labelKey(what.label)]!.name}`);
      delete s.labels[labelKey(what.label)];
    }
    if (what.artist && s.artists[textKey(what.artist)]) {
      done.push(`artist ${s.artists[textKey(what.artist)]!.name}`);
      delete s.artists[textKey(what.artist)];
      delete s.artist_ids[textKey(what.artist)];
    }
    return { value: s, result: done };
  });
  return r.result.length ? `Forgot ${r.result.join(" and ")} for ${lane.id}.` : `Nothing learned by that name in ${lane.id}. Seed labels and artists are edited in lanes.json.`;
}
