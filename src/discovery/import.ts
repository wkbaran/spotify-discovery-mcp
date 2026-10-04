import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { localDate } from "job-ledger";
import { trackKey } from "./keys.js";
import { updateHistory } from "./state.js";

/**
 * Seed history.json from the files the old prompt-driven jobs kept:
 * recommendation_history.json (`{tracks: [{artist, track}]}`) and
 * today_playlist.json (`{date, playlist_id, tracks: [{artist, track, uri}]}`).
 * Safe to run twice: entries are matched by key.
 */
export async function importLegacy(dir: string, legacyDir: string): Promise<string> {
  const read = async (name: string) => {
    try {
      return JSON.parse(await readFile(join(legacyDir, name), "utf8")) as { date?: string; tracks?: { artist?: string; track?: string; uri?: string }[] };
    } catch {
      return null;
    }
  };
  const hist = await read("recommendation_history.json");
  const today = await read("today_playlist.json");
  const uris = new Map<string, string>();
  for (const t of today?.tracks ?? []) if (t.artist && t.track && t.uri) uris.set(trackKey(t.artist, t.track), t.uri);
  const rows = [...(hist?.tracks ?? []), ...(today?.tracks ?? [])].filter((t) => t.artist && t.track);
  const date = today?.date ?? localDate(new Date(), "UTC");
  const r = await updateHistory(dir, (h) => {
    const have = new Set(h.tracks.map((t) => t.key));
    let added = 0;
    for (const t of rows) {
      const key = trackKey(t.artist!, t.track!);
      if (have.has(key)) continue;
      have.add(key);
      h.tracks.push({ uri: uris.get(key), artist: t.artist!, title: t.track!, key, lane: "legacy", date: "before " + date });
      added++;
    }
    return { value: h, result: added };
  });
  return `Imported ${r.result} tracks into history.json (${rows.length} read, duplicates skipped).`;
}
