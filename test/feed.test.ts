import { describe, expect, it } from "vitest";
import { collectFeed, sourceQueue } from "../src/discovery/feed.js";
import { DEFAULTS, type Lane } from "../src/discovery/lanes.js";
import { emptyLaneState, type LaneState } from "../src/discovery/state.js";
import { SpotifyClient } from "../src/spotify/client.js";
import { FakeSpotify } from "./fake-spotify.js";

const lane = (over: Partial<Lane> = {}): Lane => ({
  ...DEFAULTS,
  id: "lane-a",
  name: "Lane A",
  baseline: "b",
  labels: ["Alpha Records", "Beta Audio", "Gamma Music"],
  artists: ["Delta"],
  genres: [],
  tags: [],
  ...over,
});

function setup() {
  const spotify = new FakeSpotify();
  spotify.addRelease({ artist: "One", title: "A1", tracks: ["A1"], label: "Alpha Records", date: "2026-10-17" });
  spotify.addRelease({ artist: "Two", title: "B1", tracks: ["B1", "B2"], label: "Beta Audio", date: "2026-10-16" });
  spotify.addRelease({ artist: "Three", title: "G1", tracks: ["G1"], label: "Gamma Music", date: "2026-10-09" });
  spotify.addRelease({ artist: "Delta", title: "D1", tracks: ["D1"], label: "Elsewhere", date: "2026-10-17" });
  const client = new SpotifyClient({ token: async () => "t" }, spotify.fetch, "https://api.spotify.com/v1", async () => {});
  return { spotify, client };
}

const opts = { today: "2026-10-18", fallbackSince: "2026-10-15", isNew: () => true };

describe("sourceQueue", () => {
  it("puts never-checked sources first, then the longest-waiting, keeping the usual order for ties", () => {
    const state: LaneState = { ...emptyLaneState(), checked: { "label:alpha": "2026-10-17", "label:beta": "2026-10-10" } };
    expect(sourceQueue(lane(), state).map((s) => s.key)).toEqual(["label:gamma", "artist:delta", "label:beta", "label:alpha"]);
  });
});

describe("collectFeed", () => {
  it("checks everything when the budget allows, and reads each release in one request", async () => {
    const { spotify, client } = setup();
    const r = await collectFeed(client, lane(), emptyLaneState(), opts);
    expect(r.stats).toEqual({ checked: 4, total: 4, stopped: "done" });
    expect(r.checked).toEqual(["label:alpha", "label:beta", "label:gamma", "artist:delta"]);
    // Gamma's release is older than the window for a never-checked source.
    expect(r.releases.map((x) => x.album.name)).toEqual(["A1", "D1", "B1"]);
    expect(spotify.log.filter((l) => l.includes("/tracks"))).toEqual([]);
  });

  it("stops at feed_tracks and leaves the rest for later", async () => {
    const { client } = setup();
    const r = await collectFeed(client, lane({ feed_tracks: 2 }), emptyLaneState(), opts);
    // Alpha gives 1 new track, Beta 2 more: stop before Gamma.
    expect(r.stats).toEqual({ checked: 2, total: 4, stopped: "tracks", oldest_waiting: "never" });
    expect(r.checked).toEqual(["label:alpha", "label:beta"]);
  });

  it("only counts new tracks toward feed_tracks", async () => {
    const { client } = setup();
    const r = await collectFeed(client, lane({ feed_tracks: 2 }), emptyLaneState(), { ...opts, isNew: (t) => t.name !== "B1" && t.name !== "B2" });
    expect(r.stats.stopped).toBe("done");
  });

  it("stops at feed_requests; the next run starts with what was left and finds nothing missed", async () => {
    const { client } = setup();
    const first = await collectFeed(client, lane({ feed_requests: 5 }), emptyLaneState(), opts);
    expect(first.stats.stopped).toBe("requests");
    const done = new Set(first.checked);
    const state: LaneState = { ...emptyLaneState(), checked: Object.fromEntries(first.checked.map((k) => [k, "2026-10-18"])) };
    const second = await collectFeed(client, lane(), state, { ...opts, today: "2026-10-19", fallbackSince: "2026-10-17" });
    // The sources skipped first go first now.
    expect(second.checked.slice(0, 4 - done.size).every((k) => !done.has(k))).toBe(true);
  });

  it("looks back to each source's own last check, not the lane's last run", async () => {
    const { client } = setup();
    // Gamma was last checked 2026-10-05: its 2026-10-09 release is still news, though the lane ran yesterday.
    const state: LaneState = { ...emptyLaneState(), checked: { "label:gamma": "2026-10-05" } };
    const r = await collectFeed(client, lane(), state, { ...opts, fallbackSince: "2026-10-17" });
    expect(r.releases.map((x) => x.album.name)).toContain("G1");
  });
});
