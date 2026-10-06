import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { History, LaneState } from "../src/discovery/state.js";
import { createServer } from "../src/server.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { FakeSpotify } from "./fake-spotify.js";

let dir: string;
let spotify: FakeSpotify;
let now: Date;
const saved = { ...process.env };

const LANES = {
  timezone: "America/Denver",
  lanes: {
    "a-dnb": {
      name: "Neurofunk, techstep, and experimental DnB",
      baseline: "Dark, technical DnB.",
      target: [3, 6],
      labels: ["Critical Music", "Eatbrain"],
      artists: ["Omneum"],
      genres: ["Drum & Bass"],
    },
    "b-ukg": { name: "UK garage", baseline: "Garage.", target: [5, 8], labels: ["Hardline Sounds"] },
  },
};

async function connect() {
  const server = createServer({ dir, client: new SpotifyClient({ token: async () => "t" }, spotify.fetch, "https://api.spotify.com/v1", async () => {}), fetchImpl: spotify.fetch, now: () => now });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0]!.text, isError: !!r.isError };
}

const readJson = async <T>(name: string) => JSON.parse(await readFile(join(dir, name), "utf8")) as T;

/** The report of a lane's latest finished run, as the report job reads it. */
async function lastReport(lane: string): Promise<string> {
  const ids = (await readdir(join(dir, "runs"))).filter((f) => f.startsWith(`${lane}-`)).sort();
  return (await readJson<{ finished: { report: string } }>(`runs/${ids.at(-1)}`)).finished.report;
}

beforeEach(async () => {
  process.env.SPOTIFY_DISCOVERY_METADATA = "off";
  dir = await mkdtemp(join(tmpdir(), "discovery-"));
  await writeFile(join(dir, "lanes.json"), JSON.stringify(LANES));
  await writeFile(join(dir, "taste_profile.json"), JSON.stringify({ core_artists: ["Omneum", "Skrimor"] }));
  await writeFile(join(dir, "history.json"), JSON.stringify({ tracks: [{ artist: "Sulphur", title: "Dat Luv", key: "sulphur|dat luv", lane: "legacy", date: "2026-09-18" }] }));
  now = new Date("2026-10-02T15:00:00Z"); // 09:00 in Denver
  spotify = new FakeSpotify();
  spotify.addRelease({ artist: "Sully", title: "Flux / Chatter", tracks: ["Flux", "Chatter"], label: "Critical Music", date: "2026-09-26" });
  spotify.addRelease({ artist: "Neonlight", title: "Leaving Wonderland", tracks: ["LEAVING WONDERLAND"], label: "Eatbrain", date: "2026-09-25" });
  spotify.addRelease({ artist: "Omneum", title: "Entropy", tracks: ["Entropy"], label: "Counter Records", date: "2026-09-30" });
  spotify.addRelease({ artist: "Old Act", title: "Ancient", tracks: ["Ancient"], label: "Critical Music", date: "2024-01-01" });
  spotify.addRelease({ artist: "Skrimor", title: "Kraken EP", tracks: ["Kraken", "Kraken - VIP"], label: "Hanzom Music", date: "2026-10-02" });
  spotify.addRelease({ artist: "Sulphur", title: "Dat Luv", tracks: ["Dat Luv"], label: "Locked On", date: "2025-06-01" });
});

afterEach(() => {
  process.env = { ...saved };
});

const RESEARCH = [
  "artist | track | release | label | date | why | url",
  "Skrimor | Kraken | Kraken EP | Hospital Records | 2026-10-02 | Hanzom: 'a three-track assault' | https://soundcloud.com/hanzommusic/skrimor-kraken",
  "Gridlok | Fever | Symptoms of the Chaos Mind | Gridlok | 2026-10-23 | album due Oct 23 | https://gridlok.bandcamp.com",
  "Sulphur | Dat Luv | Dat Luv | Locked On | 2025 | already had it | https://example.com/x",
  "LABEL | DnB Doctor | https://dnbdoctor.com | Neurofunk label",
].join("\n");

describe("a lane run", () => {
  it("begins, verifies, finishes, and carries leftovers into the next run", async () => {
    const client = await connect();

    // begin: creates today's playlist, lists fresh feed releases with refs
    const begin = await call(client, "discovery_begin", { lane: "a-dnb" });
    expect(begin.isError).toBe(false);
    expect(spotify.created).toBe(1);
    expect(begin.text).toContain("Today's playlist: hermes20261002 (0 tracks so far)");
    expect(begin.text).toMatch(/K\d+ {2}Flux \/ Chatter \(single, 2026-09-26, Critical Music\) · 2 tracks:/);
    expect(begin.text).toMatch(/K\d+\.2 {2}Sully — Chatter/);
    expect(begin.text).toMatch(/Omneum — Entropy .*Counter Records \[core artist\]/);
    expect(begin.text).not.toContain("Ancient");
    expect(begin.text).toContain("Covered labels (research should look elsewhere): Critical Music, Eatbrain");
    expect(spotify.log.some((l) => l.includes("/tracks?") && l.includes("/playlists/"))).toBe(false);

    // verify: exact search, real label, dup, pending, labels
    const verify = await call(client, "verify_tracks", { lane: "a-dnb", text: RESEARCH });
    expect(verify.text).toMatch(/W1 ✓ Skrimor — Kraken · Kraken EP, 2026-10-02 · Hanzom Music \[core artist\]/);
    expect(verify.text).toContain("⚠ label is Hanzom Music, not Hospital Records as the source said");
    expect(verify.text).toMatch(/W2 pending Gridlok — Fever/);
    expect(verify.text).toMatch(/W3 dup Sulphur — Dat Luv · recommended 2026-09-18 \(legacy\)/);
    expect(verify.text).toContain("Labels noted for this lane: DnB Doctor");

    // review: the server's own list of what can be picked
    const review = await call(client, "discovery_review", { lane: "a-dnb" });
    expect(review.text).toMatch(/Web finds, verified on Spotify \(1\):\nW1 {2}Skrimor — Kraken/);
    expect(review.text).toContain("why: Hanzom: 'a three-track assault'");
    expect(review.text).toContain("Not pickable: W2 Gridlok — Fever (pending); W3 Sulphur — Dat Luv (dup)");
    expect(review.text).toMatch(/Sully — Chatter/);

    // finish: picks best first; feed limit 3 because one web find verified; core limit 2
    const refs = (s: string) => [...begin.text.matchAll(new RegExp(`(K\\d+(?:\\.\\d+)?) {2}${s}`, "g"))].map((m) => m[1]!);
    const chatter = refs("Sully — Chatter")[0]!;
    const neon = refs("Neonlight — LEAVING WONDERLAND")[0]!;
    const omneum = refs("Omneum — Entropy")[0]!;
    const finish = await call(client, "discovery_finish", { lane: "a-dnb", picks: ["W1", chatter, neon, omneum, "W2"], why: { [chatter]: "Critical: 'acid-tipped breakbeats'" } });
    expect(finish.isError).toBe(false);
    expect(finish.text).toContain("W2 can't be added (pending");
    expect(finish.text).toMatch(/^Saved\. Added 4 track\(s\) to hermes20261002: Skrimor — Kraken; Sully — Chatter; /);
    expect(finish.text).toMatch(/Reply with one line: Done: a-dnb$/);
    expect(finish.text).not.toContain("**Lane:**");
    const runId = (await readdir(join(dir, "runs"))).find((f) => f.startsWith("a-dnb-"))!.replace(/\.json$/, "");
    const run = await readJson<{ finished: { report: string }; spotify_requests: number }>(`runs/${runId}.json`);
    expect(run.spotify_requests).toBeGreaterThan(5);
    const report = run.finished.report;
    expect(report).toMatch(/^\*\*Lane:\*\* Neurofunk/);
    expect(report).toContain("**Added (4):**");
    expect(report).toContain("**Sully — Chatter** (Critical Music, 2026-09-26). Critical: 'acid-tipped breakbeats'");
    expect(report).toContain("Not on Spotify yet (re-checking each run): Gridlok — Fever");
    expect(report).toContain("Already recommended: Sulphur — Dat Luv");
    expect(report).toContain("New labels for this lane: DnB Doctor");
    expect(spotify.playlistUris("pl1")).toHaveLength(4);

    const history = await readJson<History>("history.json");
    expect(history.tracks.map((t) => t.title)).toEqual(["Dat Luv", "Kraken", "Chatter", "LEAVING WONDERLAND", "Entropy"]);
    const state = await readJson<LaneState>("lanes/a-dnb.json");
    expect(Object.values(state.pool).map((p) => [p.title, p.passes])).toEqual([["Flux", 1]]);
    expect(Object.keys(state.pending)).toEqual(["gridlok|fever"]);
    expect(state.labels["dnb doctor"]).toMatchObject({ origin: "found", picks: 0 });
    expect(state.last_run).toBe("2026-10-02T15:00:00Z");

    // finishing twice changes nothing
    const again = await call(client, "discovery_finish", { lane: "a-dnb", picks: ["W1"] });
    expect(again.text).toContain("already finished; nothing changed");
    expect(spotify.playlistUris("pl1")).toHaveLength(4);

    // next run, four days later: Flux carried over; Gridlok's album is out
    now = new Date("2026-10-06T15:00:00Z");
    spotify.addRelease({ artist: "Gridlok", title: "Symptoms of the Chaos Mind", tracks: ["Fever", "Other"], label: "Gridlok", date: "2026-10-05" });
    const next = await call(client, "discovery_begin", { lane: "a-dnb" });
    expect(spotify.created).toBe(2);
    expect(next.text).toContain("hermes20261006");
    expect(next.text).toMatch(/C\d+ {2}Gridlok — Fever .*\[web find\]/);
    expect(next.text).toMatch(/C\d+ {2}Sully — Flux .*\[passed 1×\]/);
    expect(next.text).not.toContain("Sully — Chatter");
    expect(next.text).toMatch(/K\d+ {2}Skrimor — Kraken - VIP/); // Skrimor was learned from the pick
  });

  it("drops picks over the limits from the end and says so", async () => {
    const client = await connect();
    const begin = await call(client, "discovery_begin", { lane: "a-dnb" });
    const all = [...begin.text.matchAll(/^\s*(K\d+(?:\.\d+)?) {2}/gm)].map((m) => m[1]!);
    expect(all.length).toBeGreaterThanOrEqual(4);
    await call(client, "verify_tracks", { lane: "a-dnb", text: RESEARCH });
    await call(client, "discovery_review", { lane: "a-dnb" });
    const r = await call(client, "discovery_finish", { lane: "a-dnb", picks: all });
    expect(await lastReport("a-dnb")).toMatch(/Dropped by limits: .*\(feed limit of 3\)/);
    expect(spotify.playlistUris("pl1")).toHaveLength(3);
  });

  it("counts a release ref and its first track as one pick", async () => {
    const client = await connect();
    const begin = await call(client, "discovery_begin", { lane: "a-dnb" });
    const group = begin.text.match(/(K\d+) {2}Flux \/ Chatter/)![1]!;
    await call(client, "discovery_review", { lane: "a-dnb" });
    const r = await call(client, "discovery_finish", { lane: "a-dnb", picks: [group, `${group}.1`] });
    expect(r.text).toMatch(/^Saved\. Added 1 track\(s\)/);
    expect(await lastReport("a-dnb")).toContain("**Added (1):**");
    expect(spotify.playlistUris("pl1")).toHaveLength(1);
  });

  it("drops label-search hits that aren't really on the label", async () => {
    spotify.addRelease({ artist: "Some Band", title: "Criticalities", tracks: ["Noise"], label: "Criticals Music LLC", date: "2026-09-30" });
    const client = await connect();
    const begin = await call(client, "discovery_begin", { lane: "a-dnb" });
    expect(begin.text).not.toContain("Some Band");
  });

  it("refuses unknown refs and saves nothing", async () => {
    const client = await connect();
    await call(client, "discovery_begin", { lane: "a-dnb" });
    await call(client, "discovery_review", { lane: "a-dnb" });
    const r = await call(client, "discovery_finish", { lane: "a-dnb", picks: ["K99"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Unknown refs: K99");
    expect(spotify.playlistUris("pl1")).toHaveLength(0);
  });

  it("creates one playlist when two lanes start at once", async () => {
    const [c1, c2] = await Promise.all([connect(), connect()]);
    const [a, b] = await Promise.all([call(c1, "discovery_begin", { lane: "a-dnb" }), call(c2, "discovery_begin", { lane: "b-ukg" })]);
    expect(a.isError || b.isError).toBe(false);
    expect(spotify.created).toBe(1);
    expect(b.text).toContain("hermes20261002");
  });

  it("two lanes finishing at once with the same track add it once", async () => {
    const both = { ...LANES, lanes: { ...LANES.lanes, "b-ukg": { ...LANES.lanes["b-ukg"], labels: ["Critical Music"] } } };
    await writeFile(join(dir, "lanes.json"), JSON.stringify(both));
    const [c1, c2] = await Promise.all([connect(), connect()]);
    const [a, b] = await Promise.all([call(c1, "discovery_begin", { lane: "a-dnb" }), call(c2, "discovery_begin", { lane: "b-ukg" })]);
    const ref = (t: string) => t.match(/(K\d+\.\d+) {2}Sully — Chatter/)![1]!;
    await Promise.all([call(c1, "discovery_review", { lane: "a-dnb" }), call(c2, "discovery_review", { lane: "b-ukg" })]);
    const [fa, fb] = await Promise.all([
      call(c1, "discovery_finish", { lane: "a-dnb", picks: [ref(a.text)] }),
      call(c2, "discovery_finish", { lane: "b-ukg", picks: [ref(b.text)] }),
    ]);
    expect(spotify.playlistUris("pl1")).toHaveLength(1);
    expect([fa.text, fb.text].filter((t) => t.includes("Already in the playlist: Sully — Chatter"))).toHaveLength(1);
    expect([await lastReport("a-dnb"), await lastReport("b-ukg")].filter((t) => t.includes("*was already in the playlist*"))).toHaveLength(1);
    const history = await readJson<History>("history.json");
    expect(history.tracks.filter((t) => t.title === "Chatter")).toHaveLength(1);
  });

  it("keeps at most 3 rejections; the rest carry over", async () => {
    spotify.addRelease({ artist: "Phase Two", title: "Grid", tracks: ["Grid", "Lattice"], label: "Eatbrain", date: "2026-09-29" });
    const client = await connect();
    const begin = await call(client, "discovery_begin", { lane: "a-dnb" });
    const all = [...begin.text.matchAll(/^\s*(K\d+\.\d+|K\d+) {2}(?!.* · \d+ tracks:)/gm)].map((m) => m[1]!);
    expect(all.length).toBeGreaterThanOrEqual(5);
    await call(client, "discovery_review", { lane: "a-dnb" });
    const r = await call(client, "discovery_finish", { lane: "a-dnb", picks: [all[0]], reject: all.slice(1) });
    expect(r.text).toContain(`Kept the first 3 rejections; ${all.slice(4).join(", ")} carry over instead.`);
    const state = await readJson<LaneState>("lanes/a-dnb.json");
    expect(Object.values(state.closed).filter((c) => c.status === "rejected")).toHaveLength(3);
  });

  it("credits a label found and picked in the same run", async () => {
    const client = await connect();
    await call(client, "discovery_begin", { lane: "a-dnb" });
    await call(client, "verify_tracks", { lane: "a-dnb", text: `${RESEARCH}\nLABEL | Hanzom Music | https://example.com/hanzom | Neurofunk label` });
    await call(client, "discovery_review", { lane: "a-dnb" });
    const r = await call(client, "discovery_finish", { lane: "a-dnb", picks: ["W1"] });
    expect(await lastReport("a-dnb")).toContain("New labels for this lane: DnB Doctor, Hanzom Music");
    expect(r.text).toContain("Reply with one line: Done: a-dnb");
    const state = await readJson<LaneState>("lanes/a-dnb.json");
    expect(state.labels[Object.keys(state.labels).find((k) => state.labels[k]!.name === "Hanzom Music")!]).toMatchObject({ origin: "promoted", picks: 1 });
    expect(state.labels["dnb doctor"]).toMatchObject({ origin: "found", picks: 0 });
  });

  it("learns a found label's ℗ name and then ignores look-alike labels in the feed", async () => {
    spotify.addRelease({ artist: "DJ Perception", title: "As We Enter", tracks: ["As We Enter"], label: "Bubble", date: "2026-10-01" });
    const client = await connect();
    await call(client, "discovery_begin", { lane: "b-ukg" });
    await call(client, "verify_tracks", { lane: "b-ukg", text: "DJ Perception | As We Enter | As We Enter | Bubble | 2026-10-01 | Bubble: 'a 4x4 stomper' | https://bubbleukg.bandcamp.com/album/as-we-enter\nLABEL | Bubble | https://bubbleukg.bandcamp.com/ | Underground garage label" });
    await call(client, "discovery_review", { lane: "b-ukg" });
    await call(client, "discovery_finish", { lane: "b-ukg", picks: ["W1"] });
    expect((await readJson<LaneState>("lanes/b-ukg.json")).labels["bubble"]).toMatchObject({ origin: "promoted", spotify_name: "Bubble" });

    // `label:"Bubble"` also finds Bubble beats bollywood; only the real label's release is listed.
    spotify.addRelease({ artist: "Viksa Udesh", title: "SHIVAJI O SHIVAJI", tracks: ["SHIVAJI O SHIVAJI"], label: "Bubble beats bollywood", date: "2026-10-04" });
    spotify.addRelease({ artist: "Silva Bumpa", title: "Bubble Up", tracks: ["Bubble Up"], label: "Bubble", date: "2026-10-04" });
    now = new Date("2026-10-06T15:00:00Z");
    const begin = await call(client, "discovery_begin", { lane: "b-ukg" });
    expect(begin.text).toContain("Silva Bumpa — Bubble Up");
    expect(begin.text).not.toContain("Viksa Udesh");
  });

  it("keeps word matching for a label without a confirmed ℗ name", async () => {
    spotify.addRelease({ artist: "Viksa Udesh", title: "SHIVAJI O SHIVAJI", tracks: ["SHIVAJI O SHIVAJI"], label: "Hardline Sounds Bollywood", date: "2026-09-30" });
    const client = await connect();
    const begin = await call(client, "discovery_begin", { lane: "b-ukg" });
    expect(begin.text).toContain("Viksa Udesh");
  });

  it("stops at once when Spotify's quota is exceeded, and saves nothing", async () => {
    const client = await connect();
    spotify.quotaRetryAfter = 11991;
    const begin = await call(client, "discovery_begin", { lane: "a-dnb" });
    expect(begin.isError).toBe(true);
    expect(begin.text).toMatch(/^Spotify rate limit: Spotify is rate-limiting this app \(QUOTA_EXCEEDED\) until .*Z, about 200 min from now\. Nothing was added or saved\. Stop/);
    // One request, then every later one fails without calling Spotify.
    expect(spotify.log).toHaveLength(1);
    const again = await call(client, "discovery_begin", { lane: "a-dnb" });
    expect(again.text).toContain("QUOTA_EXCEEDED");
    expect(spotify.log).toHaveLength(1);
    expect(spotify.created).toBe(0);
  });

  it("refuses to finish before discovery_review, so a research subagent can't end the lane", async () => {
    const client = await connect();
    await call(client, "discovery_begin", { lane: "a-dnb" });
    await call(client, "verify_tracks", { lane: "a-dnb", text: RESEARCH });
    const early = await call(client, "discovery_finish", { lane: "a-dnb", picks: ["W1"] });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/^Call discovery_review for lane a-dnb first/);
    expect(spotify.playlistUris("pl1")).toHaveLength(0);
    await call(client, "discovery_review", { lane: "a-dnb" });
    expect((await call(client, "discovery_finish", { lane: "a-dnb", picks: ["W1"] })).text).toMatch(/^Saved\. Added 1 track/);
  });

  it("continues the open run when discovery_begin is called again, keeping its web finds", async () => {
    const client = await connect();
    const first = await call(client, "discovery_begin", { lane: "a-dnb" });
    await call(client, "verify_tracks", { lane: "a-dnb", text: RESEARCH });
    const requests = spotify.log.length;
    const second = await call(client, "discovery_begin", { lane: "a-dnb" });
    expect(second.text).toMatch(/^Continuing this lane's open run \(started 2026-10-02T15:00:00Z; nothing new was fetched\)\. If you are the research subagent, call only verify_tracks\./);
    expect(second.text).toContain(first.text.split("\n")[0]);
    expect(spotify.log.length).toBe(requests);
    expect((await readdir(join(dir, "runs"))).filter((f) => f.startsWith("a-dnb-"))).toHaveLength(1);
    expect((await call(client, "discovery_review", { lane: "a-dnb" })).text).toContain("W1  Skrimor — Kraken");
    // Long after, a new begin starts a fresh run.
    now = new Date(now.getTime() + 2 * 3_600_000);
    await call(client, "discovery_begin", { lane: "a-dnb" });
    expect((await readdir(join(dir, "runs"))).filter((f) => f.startsWith("a-dnb-"))).toHaveLength(2);
  });

  it("accepts why as a plain sentence instead of failing", async () => {
    const client = await connect();
    await call(client, "discovery_begin", { lane: "a-dnb" });
    await call(client, "verify_tracks", { lane: "a-dnb", text: RESEARCH });
    await call(client, "discovery_review", { lane: "a-dnb" });
    const r = await call(client, "discovery_finish", { lane: "a-dnb", picks: ["W1"], why: "Hanzom calls it an assault; fits the lane." });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Added 1 track(s)");
  });

  it("accepts picks as a JSON string and a dry run saves nothing", async () => {
    const client = await connect();
    await call(client, "discovery_begin", { lane: "a-dnb" });
    await call(client, "verify_tracks", { lane: "a-dnb", text: RESEARCH });
    const r = await call(client, "discovery_finish", { lane: "a-dnb", picks: '["W1"]', dry_run: true });
    expect(r.text).toContain("Dry run");
    expect(r.text).toContain("**Skrimor — Kraken**");
    expect(spotify.playlistUris("pl1")).toHaveLength(0);
  });
});
