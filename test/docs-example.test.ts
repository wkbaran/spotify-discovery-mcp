/**
 * Keeps docs/discovery-tools.md honest. It runs one small, made-up lane run through
 * the real tools (against test/fake-spotify.ts), using the arguments printed in the
 * doc, and checks that every generated block in the doc matches what the tools
 * return now, and that each argument table lists exactly the tool's input fields.
 *
 * After changing a tool's output: UPDATE_DOCS=1 npx vitest run test/docs-example.test.ts
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { pendingReports } from "../src/discovery/report.js";
import { createServer } from "../src/server.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { FakeSpotify } from "./fake-spotify.js";

const DOC = join(import.meta.dirname, "..", "docs", "discovery-tools.md");
const NOW = new Date("2026-10-06T13:00:00Z"); // a Tuesday, 09:00 in New York
const saved = { ...process.env };
let dir: string;

const LANES = {
  timezone: "America/New_York",
  lanes: {
    "a-dnb": {
      name: "Neurofunk and techstep",
      baseline: "Dark, technical drum & bass: neurofunk, techstep and halftime.",
      research: "Releases are sparse; two great fits beat six average ones.",
      target: [3, 6],
      labels: ["Obsidian Audio", "Ironclad Music"],
      artists: ["Kestrel"],
    },
  },
};

beforeEach(async () => {
  process.env.SPOTIFY_DISCOVERY_METADATA = "off";
  delete process.env.SPOTIFY_DISCOVERY_TZ;
  dir = await mkdtemp(join(tmpdir(), "discovery-"));
  await writeFile(join(dir, "lanes.json"), JSON.stringify(LANES, null, 2));
  await writeFile(join(dir, "taste_profile.json"), JSON.stringify({ core_artists: ["Kestrel", "Vanta"] }));
  await writeFile(join(dir, "history.json"), JSON.stringify({ tracks: [{ artist: "Hollow Point", title: "Static Bloom", key: "hollow point|static bloom", lane: "a-dnb", date: "2026-09-18" }] }));
});
afterEach(() => {
  process.env = { ...saved };
});

function fakeSpotify(): FakeSpotify {
  const s = new FakeSpotify();
  s.addRelease({ artist: "Mara Voss", title: "Pressure Front", tracks: ["Pressure Front", "Undertow"], label: "Obsidian Audio", date: "2026-09-30" });
  s.addRelease({ artist: "Dekker", title: "Night Shift", tracks: ["Night Shift", "Rivet", "Coldline"], label: "Ironclad Music", date: "2026-09-27" });
  s.addRelease({ artist: "Kestrel", title: "Hollow Ground", tracks: ["Hollow Ground"], label: "Ferrous Records", date: "2026-10-01" });
  s.addRelease({ artist: "Old Guard", title: "Archive", tracks: ["Archive"], label: "Obsidian Audio", date: "2024-03-01" });
  s.addRelease({ artist: "Vanta", title: "Signal Loss", tracks: ["Signal Loss", "Signal Loss - VIP"], label: "Sublevel Recordings", date: "2026-10-02" });
  s.addRelease({ artist: "Lumen Drift", title: "Glass Engine", tracks: ["Glass Engine"], label: "Sublevel Recordings", date: "2026-09-29" });
  s.addRelease({ artist: "Hollow Point", title: "Static Bloom", tracks: ["Static Bloom"], label: "Ironclad Music", date: "2025-06-01" });
  return s;
}

async function connect(spotify: FakeSpotify) {
  const client = new SpotifyClient({ token: async () => "t" }, spotify.fetch, "https://api.spotify.com/v1", async () => {});
  const server = createServer({ dir, client, fetchImpl: spotify.fetch, now: () => NOW });
  const c = new Client({ name: "docs", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}

// ---- reading and writing the doc ----

/** `<!-- example: name -->` or `<!-- generated: name -->` followed by a fenced block. */
function blocks(doc: string): Map<string, { full: string; body: string }> {
  const out = new Map<string, { full: string; body: string }>();
  for (const m of doc.matchAll(/<!-- (example|generated): ([\w-]+) -->\n(````?)(\w*)\n((?:(?!\3\n).*\n)*)\3\n/g)) out.set(`${m[1]}:${m[2]}`, { full: m[0], body: m[5]!.replace(/\n$/, "") });
  return out;
}

/** Field names in the table under `<!-- args: tool -->`. */
function argTable(doc: string, tool: string): string[] {
  const at = doc.indexOf(`<!-- args: ${tool} -->`);
  if (at < 0) throw new Error(`no args table for ${tool}`);
  const rows = doc.slice(at).split("\n").slice(1);
  const table = rows.slice(0, rows.findIndex((l, n) => n > 0 && !l.startsWith("|")));
  return table.slice(2).map((l) => /^\| `(\w+)`/.exec(l)?.[1] ?? l);
}

it("docs/discovery-tools.md matches what the discovery tools do", async () => {
  let doc = await readFile(DOC, "utf8");
  const found = blocks(doc);
  const args = (name: string) => {
    const b = found.get(`example:${name}`);
    if (!b) throw new Error(`docs/discovery-tools.md has no "<!-- example: ${name} -->" block`);
    return JSON.parse(b.body) as Record<string, unknown>;
  };

  const spotify = fakeSpotify();
  const client = await connect(spotify);
  const call = async (name: string, a: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: a });
    const t = (r.content as Array<{ text: string }>)[0]!.text;
    if (r.isError) throw new Error(`${name} failed: ${t}`);
    return t;
  };
  const generated: Record<string, string> = {};
  generated.discovery_begin = await call("discovery_begin", args("discovery_begin"));
  generated.verify_tracks = await call("verify_tracks", args("verify_tracks"));
  generated.discovery_review = await call("discovery_review", args("discovery_review"));
  generated.discovery_finish = await call("discovery_finish", args("discovery_finish"));
  generated.report = await pendingReports(dir, { stallMinutes: 90, windowHours: 24, now: new Date(NOW.getTime() + 5 * 60_000) });
  generated.discovery_status = (await call("discovery_status", args("discovery_status"))).replaceAll(dir, "/data/spotify_discovery");

  if (process.env.UPDATE_DOCS) {
    for (const [name, text] of Object.entries(generated)) {
      const b = found.get(`generated:${name}`);
      if (!b) throw new Error(`docs/discovery-tools.md has no "<!-- generated: ${name} -->" block`);
      const fence = text.includes("```") ? "````" : "```";
      doc = doc.replace(b.full, `<!-- generated: ${name} -->\n${fence}text\n${text}\n${fence}\n`);
    }
    await writeFile(DOC, doc);
  }

  expect(spotify.playlistUris("pl1").length, "tracks in today's playlist").toBeGreaterThan(0);

  // Argument tables list exactly the tool's input fields.
  const { tools } = await client.listTools();
  for (const tool of ["discovery_begin", "verify_tracks", "discovery_review", "discovery_finish", "discovery_status", "mark_recommended", "forget"]) {
    const schema = tools.find((t) => t.name === tool)!.inputSchema as { properties?: Record<string, unknown> };
    expect(argTable(doc, tool).sort(), `argument table for ${tool}`).toEqual(Object.keys(schema.properties ?? {}).sort());
  }

  if (!process.env.UPDATE_DOCS) {
    for (const [name, text] of Object.entries(generated)) {
      expect(found.get(`generated:${name}`)?.body, `generated block "${name}" is stale; run UPDATE_DOCS=1 npx vitest run test/docs-example.test.ts`).toBe(text);
    }
  }
});
