import { describe, expect, it } from "vitest";
import { artistMatches, labelFromCopyrights, labelKey, sameLabel, titleKey, titleMatches, trackKey, spotifyTrackKey } from "../src/discovery/keys.js";
import { applyPickRules, type PickInput } from "../src/discovery/rules.js";
import { bestMatch, parseCandidatesText, searchLadder } from "../src/discovery/verify.js";
import { beatportMeta, deezerLookup, fitsLane, genreLookup, metaLine, parseBeatport, parseSoundcloud, scTags } from "../src/metadata/lookup.js";
import type { Track } from "../src/spotify/client.js";

describe("keys", () => {
  it("treats edits and mixes of the same track as one, but not remixes or VIPs", () => {
    expect(titleKey("Big Darg - Radio Edit")).toBe(titleKey("Big Darg"));
    expect(titleKey("TWOSTEP (Extended Mix)")).toBe(titleKey("TWOSTEP"));
    expect(titleKey("Alert VIP")).not.toBe(titleKey("Alert"));
    expect(titleMatches("Big Darg", "Big Darg - Radio Edit")).toBe(true);
    expect(titleMatches("Block Party (Unglued Remix)", "Block Party - Unglued Remix")).toBe(true);
    expect(titleMatches("Kraken", "Kraken - VIP")).toBe(false);
    expect(titleMatches("Kraken", "Kraken (feat. Absu_NTQL)")).toBe(true);
    expect(titleMatches("Kraken (feat. Absu_NTQL)", "Kraken")).toBe(true);
    expect(titleMatches("Kraken", "Kraken (Teddy Killerz Remix)")).toBe(false);
  });

  it("matches credits from web sources against Spotify's artists", () => {
    expect(artistMatches("n4tee, Cottam (UK)", ["n4tee", "Cottam"])).toBe(true);
    expect(artistMatches("Łaszewo", ["Laszewo"])).toBe(true);
    expect(artistMatches("UNiiQU3", ["UNIIQU3"])).toBe(true);
    expect(artistMatches("Sulphur, Ho Gosh & Macarite", ["Sulphur", "Ho Gosh", "Macarite"])).toBe(true);
    expect(artistMatches("Cephas Azariah & Kidnap", ["Cephas Azariah", "Kidnap"])).toBe(true);
    expect(artistMatches("Chase & Status", ["Chase & Status"])).toBe(true);
    expect(artistMatches("Minimalist", ["Minimal Effort"])).toBe(false);
  });

  it("keys a track by its first artist and title", () => {
    expect(trackKey("Sulphur, Ho Gosh, Macarite", "Rizla")).toBe(spotifyTrackKey({ name: "Rizla", artists: [{ name: "Sulphur" }, { name: "Ho Gosh" }] }));
    expect(trackKey("Sam Binga", "Big Darg")).toBe(spotifyTrackKey({ name: "Big Darg - Radio Edit", artists: [{ name: "Sam Binga" }] }));
  });

  it("reads the label from copyright lines", () => {
    expect(labelFromCopyrights([{ type: "C", text: "2026 Critical Music" }, { type: "P", text: "2026 Critical Music" }])).toBe("Critical Music");
    expect(labelFromCopyrights([{ type: "C", text: "(C) 2026 Galaxians" }, { type: "P", text: "(P) 2026 Some Pulp Recordings" }])).toBe("Some Pulp Recordings");
    expect(labelFromCopyrights([{ type: "P", text: "℗ 2025 Artist under exclusive license to Hospital Records Ltd" }])).toBe("Hospital Records Ltd");
    expect(labelFromCopyrights([])).toBeUndefined();
  });

  it("compares labels loosely", () => {
    expect(sameLabel("Critical", "Critical Music")).toBe(true);
    expect(sameLabel("Hospital Records", "HOSPITAL RECORDS LTD")).toBe(true);
    expect(sameLabel("Hospital Records", "Hanzom Music")).toBe(false);
    expect(labelKey("Eatbrain")).toBe("eatbrain");
  });
});

describe("pick rules (the README's examples)", () => {
  const limits = { target: [3, 6] as [number, number], max_feed_picks: 3, max_core_picks: 2, min_web_picks: 0 };
  const K = (n: number, core = false): PickInput => ({ ref: `K${n}`, fromFeed: true, core });
  const W = (n: number, core = false): PickInput => ({ ref: `W${n}`, fromFeed: false, core });

  it("A: no verified web finds lifts the feed limit", () => {
    const r = applyPickRules([K(1), K(2), K(3), K(4), K(5)], limits, 0);
    expect(r.kept).toEqual(["K1", "K2", "K3", "K4", "K5"]);
    expect(r.feedLimit).toBe(6);
  });

  it("B: with web finds, at most 3 feed picks; extras dropped from the end", () => {
    const r = applyPickRules([W(1), K(1), K(2), W(2), K(3), K(4)], limits, 7);
    expect(r.kept).toEqual(["W1", "K1", "K2", "W2", "K3"]);
    expect(r.dropped).toEqual([{ ref: "K4", reason: "feed limit of 3" }]);
  });

  it("B: six web picks and no feed picks is fine", () => {
    expect(applyPickRules([1, 2, 3, 4, 5, 6].map((n) => W(n)), limits, 7).kept).toHaveLength(6);
  });

  it("caps the total", () => {
    const r = applyPickRules([1, 2, 3, 4, 5, 6, 7].map((n) => W(n)), limits, 7);
    expect(r.kept).toHaveLength(6);
    expect(r.dropped[0]!.reason).toMatch(/maximum of 6/);
  });

  it("C: two picks is thin but kept", () => {
    const r = applyPickRules([W(1), W(2)], limits, 2);
    expect(r.kept).toEqual(["W1", "W2"]);
    expect(r.thin).toBe(true);
  });

  it("D: core artists capped at 2 in the model's order", () => {
    const r = applyPickRules([W(1, true), K(1, true), W(2, true), W(3)], limits, 3);
    expect(r.kept).toEqual(["W1", "K1", "W3"]);
    expect(r.dropped).toEqual([{ ref: "W2", reason: "core-artist limit of 2" }]);
  });

  it("min_web_picks keeps room for web picks listed later", () => {
    const r = applyPickRules([K(1), K(2), K(3), W(1), W(2)], { ...limits, target: [3, 4], min_web_picks: 2 }, 2);
    expect(r.kept).toEqual(["K1", "K2", "W1", "W2"]);
    expect(r.dropped[0]!.reason).toMatch(/room kept for 2 web picks/);
  });
});

describe("parsing the research reply", () => {
  it("reads pipe lines in any decoration, finds URLs and dates wherever they are", () => {
    const text = [
      "Here are the candidates:",
      "artist | track | release | label | date | why | url",
      "1. **Neonlight** | LEAVING WONDERLAND | Leaving Wonderland | Eatbrain | 2026-08-10 | Eatbrain: \"legendary pioneer of neurofunk\" | https://eatbrain.bandcamp.com/track/leaving-wonderland",
      "- Gridlok | Fever | Symptoms of the Chaos Mind | n/a | https://gridlok.bandcamp.com | album due Oct 23 | 2026-10-23",
      "- Just prose with no pipes",
      "LABEL | DnB Doctor | https://dnbdoctor.com | Neurofunk & Drum and Bass. Dark. Surgical.",
    ].join("\n");
    const r = parseCandidatesText(text);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]).toEqual({
      artist: "Neonlight",
      track: "LEAVING WONDERLAND",
      release: "Leaving Wonderland",
      label: "Eatbrain",
      released: "2026-08-10",
      why: 'Eatbrain: "legendary pioneer of neurofunk"',
      source_url: "https://eatbrain.bandcamp.com/track/leaving-wonderland",
    });
    expect(r.candidates[1]).toMatchObject({ artist: "Gridlok", label: undefined, released: "2026-10-23", source_url: "https://gridlok.bandcamp.com" });
    expect(r.labels).toEqual([{ name: "DnB Doctor", source_url: "https://dnbdoctor.com", note: "Neurofunk & Drum and Bass. Dark. Surgical." }]);
  });

  it("tries the exact field search first", () => {
    expect(searchLadder({ artist: "Sully", track: "Chatter", release: "Flux / Chatter", label: "Critical Music" })).toEqual([
      'track:"Chatter" artist:"Sully"',
      'track:"Chatter" artist:"Sully" album:"Flux / Chatter"',
      'track:"Chatter" label:"Critical Music"',
      "Sully Chatter",
    ]);
  });

  it("prefers the named release, then an original over a compilation, then the earliest", () => {
    const t = (id: string, album: string, type: string, date: string): Track => ({ id, uri: `spotify:track:${id}`, name: "TWOSTEP", artists: [{ id: "r", name: "Riordan" }], album: { id: album, name: album, album_type: type, release_date: date, artists: [] } });
    const matches = [t("a", "EDC Las Vegas 2025", "compilation", "2025-05-09"), t("b", "TWOSTEP", "single", "2025-04-25"), t("c", "Best Of 2025", "compilation", "2025-12-19")];
    expect(bestMatch(matches, { artist: "Riordan", track: "TWOSTEP" })!.id).toBe("b");
    expect(bestMatch(matches, { artist: "Riordan", track: "TWOSTEP", release: "Best Of 2025" })!.id).toBe("c");
  });
});

describe("metadata parsing", () => {
  it("reads Beatport's embedded data and doubles half-time DnB tempos", () => {
    const data = { props: { pageProps: { dehydratedState: { queries: [{ state: { data: { data: [{ track_name: "Chatter", artists: [{ artist_name: "Sully (UK)" }], genre: [{ genre_name: "Drum & Bass" }], bpm: 83, key_name: "G Minor", label: { label_name: "Critical Music" } }] } } }] } } } };
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
    const [t] = parseBeatport(html);
    expect(beatportMeta(t!)).toEqual({ from: "beatport", genre: "Drum & Bass", bpm: 166, key: "G Minor", label: "Critical Music" });
    expect(parseBeatport("<html>nothing</html>")).toEqual([]);
  });

  it("reads SoundCloud's hydration and tags", () => {
    const html = `<script>window.__sc_hydration = [{"hydratable":"user","data":{}},{"hydratable":"sound","data":{"genre":"Drum & Bass","tag_list":"dnb drumandbass neurofunk \\"critical music\\"","label_name":"Hanzom Music"}}];</script>`;
    expect(parseSoundcloud(html)).toMatchObject({ genre: "Drum & Bass", label_name: "Hanzom Music" });
    expect(scTags('dnb neurofunk "critical music"')).toEqual(["dnb", "neurofunk", "critical music"]);
  });

  it("judges lane fit from genre or tags, and says nothing without either", () => {
    const lane = { genres: ["Drum & Bass"], tags: ["neurofunk", "techstep"] };
    expect(fitsLane({ from: "beatport", genre: "Drum & Bass" }, lane)).toBe(true);
    expect(fitsLane({ from: "soundcloud", genre: "Electronic", tags: ["neurofunk"] }, lane)).toBe(true);
    expect(fitsLane({ from: "beatport", genre: "Hip-Hop" }, lane)).toBe(false);
    expect(fitsLane({ from: "beatport", genre: "Hip-Hop" }, { genres: [], tags: [] })).toBeUndefined();
    expect(fitsLane(null, lane)).toBeUndefined();
    expect(metaLine({ from: "beatport", genre: "Drum & Bass", bpm: 174, key: "G Minor" })).toBe("Beatport: Drum & Bass · 174 BPM · G Minor");
  });
});

/** A stand-in for api.deezer.com: JSON by path. Unknown paths get Deezer's 200-with-error body. */
function deezerFake(routes: Record<string, unknown>, calls: string[] = []) {
  return async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    if (u.hostname !== "api.deezer.com") return new Response("not found", { status: 404 });
    const hit = routes[u.pathname === "/search" ? `search:${u.searchParams.get("q")}` : u.pathname];
    return Response.json(hit ?? { error: { type: "DataException", message: "no data", code: 800 } });
  };
}

const FITTS = { artist: "Lily Fitts, Michael Marcagi", artists: ["Lily Fitts", "Michael Marcagi"], title: "Take Me Down (feat. Michael Marcagi)", label: "Mom+Pop", isrc: "USQE92600217" };
const FOLK_ALBUM = { label: "Mom+Pop Music", genres: { data: [{ id: 84, name: "Folk" }] } };

describe("Deezer lookup", () => {
  it("reads an album's genres by ISRC", async () => {
    const calls: string[] = [];
    const f = deezerFake({ "/track/isrc:USQE92600217": { title: "Take Me Down", album: { id: 7 } }, "/album/7": FOLK_ALBUM }, calls);
    expect(await deezerLookup(f, FITTS)).toEqual({ from: "deezer", genre: "Folk", genres: ["Folk"], label: "Mom+Pop Music" });
    expect(calls).toEqual(["/track/isrc:USQE92600217", "/album/7"]);
  });

  it("falls back to searching, and wants the artist, title and label to agree", async () => {
    const noIsrc = { ...FITTS, isrc: undefined };
    const hit = { title: "Take Me Down", artist: { name: "Lily Fitts" }, album: { id: 7 } };
    const other = { title: "Take Me Down", artist: { name: "Someone Else" }, album: { id: 9 } };
    const q = "search:Lily Fitts Take Me Down (feat. Michael Marcagi)";
    expect(await deezerLookup(deezerFake({ [q]: { data: [other, hit] }, "/album/7": FOLK_ALBUM, "/album/9": FOLK_ALBUM }), noIsrc)).toMatchObject({ genres: ["Folk"] });
    expect(await deezerLookup(deezerFake({ [q]: { data: [other] }, "/album/9": FOLK_ALBUM }), noIsrc)).toBeNull();
    // a same-named act on another label is not this track
    expect(await deezerLookup(deezerFake({ [q]: { data: [hit] }, "/album/7": { ...FOLK_ALBUM, label: "Other Records" } }), noIsrc)).toBeNull();
  });

  it("keeps every genre, drops Deezer's placeholders, and fails open", async () => {
    const album = { label: "L", genres: { data: [{ name: "Alternative" }, { name: "Indie Rock" }, { name: "All" }, { name: "Alternative" }] } };
    const f = deezerFake({ "/track/isrc:X1": { album: { id: 1 } }, "/album/1": album, "/track/isrc:X2": { album: { id: 2 } }, "/album/2": { label: "L", genres: { data: [{ name: "All" }] } } });
    expect(await deezerLookup(f, { ...FITTS, isrc: "X1" })).toMatchObject({ genre: "Alternative", genres: ["Alternative", "Indie Rock"] });
    expect(await deezerLookup(f, { ...FITTS, isrc: "X2" })).toBeNull();
    expect(await deezerLookup(async () => { throw new Error("down"); }, FITTS).catch(() => "threw")).toBeNull();
    expect(await deezerLookup(async () => new Response("<html>", { status: 200 }), { ...FITTS, isrc: undefined })).toBeNull();
  });

  it("is only tried when Beatport is off or finds nothing", async () => {
    const calls: string[] = [];
    const f = deezerFake({ "/track/isrc:USQE92600217": { album: { id: 7 } }, "/album/7": FOLK_ALBUM }, calls);
    const beatportMiss = async (url: string | URL | Request, init?: RequestInit) => (String(url).includes("beatport.com") ? new Response("<html></html>", { status: 200 }) : f(url, init));
    expect((await genreLookup(beatportMiss, new Set(["beatport", "deezer"]), FITTS))?.from).toBe("deezer");
    expect(await genreLookup(beatportMiss, new Set(["beatport"]), FITTS)).toBeNull();
    expect((await genreLookup(f, new Set(["deezer"]), FITTS))?.from).toBe("deezer");
    expect(await genreLookup(f, new Set(), FITTS)).toBeNull();
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { dehydratedState: { queries: [{ state: { data: { data: [{ track_name: "Take Me Down", artists: [{ artist_name: "Lily Fitts" }], genre: [{ genre_name: "Indie Dance" }] }] } } }] } } } })}</script>`;
    calls.length = 0;
    const beatportHit = async (url: string | URL | Request, init?: RequestInit) => (String(url).includes("beatport.com") ? new Response(html, { status: 200 }) : f(url, init));
    expect((await genreLookup(beatportHit, new Set(["beatport", "deezer"]), FITTS))?.from).toBe("beatport");
    expect(calls).toEqual([]);
  });

  it("flags only genres that can't be electronic", () => {
    const lane = { genres: ["Indie Dance", "Electronica", "Dance / Pop"], tags: ["indie", "synth-pop"] };
    const d = (...genres: string[]) => ({ from: "deezer" as const, genre: genres[0], genres });
    expect(fitsLane(d("Folk"), lane)).toBe(false);
    expect(fitsLane(d("Folk", "Rock"), lane)).toBe(false);
    expect(fitsLane(d("Electro"), lane)).toBe(true); // "Electronica" starts with "Electro"
    expect(fitsLane(d("Dance"), lane)).toBe(true);
    expect(fitsLane(d("Alternative", "Indie Rock"), lane)).toBe(true); // lane tag "indie"
    expect(fitsLane(d("Pop"), lane)).toBeUndefined(); // could be synth-pop; the model decides
    expect(fitsLane(d("Folk", "Pop"), lane)).toBeUndefined();
    expect(fitsLane(d("Electro"), { genres: ["Drum & Bass"], tags: ["neurofunk"] })).toBeUndefined();
    expect(fitsLane(d("Jazz"), { genres: ["Drum & Bass"], tags: ["neurofunk"] })).toBe(false);
  });

  it("shows up to three genres", () => {
    expect(metaLine({ from: "deezer", genre: "Folk", genres: ["Folk"] })).toBe("Deezer: Folk");
    expect(metaLine({ from: "deezer", genre: "A", genres: ["A", "B", "C", "D"] })).toBe("Deezer: A, B, C");
  });
});

describe("metadata tidying", () => {
  it("doesn't repeat a sub-genre already in the genre, and trims label punctuation", () => {
    expect(beatportMeta({ genre: [{ genre_name: "UK Garage / Bassline" }], sub_genre: { sub_genre_name: "UK Garage" }, label: { label_name: "DnB Doctor." } })).toMatchObject({ genre: "UK Garage / Bassline", label: "DnB Doctor" });
    expect(beatportMeta({ genre: [{ genre_name: "Trance (Raw / Deep / Hypnotic)" }], sub_genre: { sub_genre_name: "Deep Trance" } }).genre).toBe("Trance (Raw / Deep / Hypnotic) / Deep Trance");
    expect(labelFromCopyrights([{ type: "P", text: "2026 DnB Doctor." }])).toBe("DnB Doctor");
  });
});

describe("label matching for the feed", () => {
  it("needs every word of the searched label", async () => {
    const { labelContains } = await import("../src/discovery/keys.js");
    expect(labelContains(".707 BLACKOUT MUSIC", "Blackout Music")).toBe(true);
    expect(labelContains("Critical Music", "Critical Music")).toBe(true);
    expect(labelContains("Visionary Sounds Recordings", "Vision Recordings")).toBe(false);
    expect(labelContains("Criticals Music LLC", "Critical Music")).toBe(false);
    expect(labelContains("Bergundy", "Bad Taste")).toBe(false);
    const { onLabel } = await import("../src/discovery/feed.js");
    expect(onLabel("Bubble beats bollywood", { name: "Bubble" })).toBe(true);
    expect(onLabel("Bubble beats bollywood", { name: "Bubble", spotifyName: "Bubble" })).toBe(false);
    expect(onLabel("Bubble Records", { name: "Bubble", spotifyName: "Bubble" })).toBe(true);
    expect(onLabel(undefined, { name: "Bubble" })).toBe(true);
    expect(onLabel(undefined, { name: "Bubble", spotifyName: "Bubble" })).toBe(false);
  });
});

describe("research replies wrapped in JSON", () => {
  it("reads pipe lines inside JSON strings and code fences", () => {
    const reply = 'Here is the output:\n\n```json\n{\n  "labels": ["LABEL | NeuroPlague Music | https://www.beatport.com/label/neuroplague-music/178934 | DnB label"],\n  "tracks": [\n    "Current Value | What It Be | The Incubation, Vol. 1 | NeuroPlague Music | 2026-03-13 | NeuroPlague: \\"uncompromising neurofunk\\" | https://www.beatport.com/release/x/1"\n  ]\n}\n```';
    const r = parseCandidatesText(reply);
    expect(r.candidates).toEqual([{ artist: "Current Value", track: "What It Be", release: "The Incubation, Vol. 1", label: "NeuroPlague Music", released: "2026-03-13", why: 'NeuroPlague: "uncompromising neurofunk"', source_url: "https://www.beatport.com/release/x/1" }]);
    expect(r.labels[0]!.name).toBe("NeuroPlague Music");
  });

  it("reads quoted lines with trailing commas when the JSON is broken", () => {
    const r = parseCandidatesText('"tracks": [\n  "Skrimor | Kraken | Kraken EP | Hanzom Music | 2026-10-02 | Hanzom: assault | https://x.y/z",\n');
    expect(r.candidates[0]).toMatchObject({ artist: "Skrimor", track: "Kraken", source_url: "https://x.y/z" });
  });
});
