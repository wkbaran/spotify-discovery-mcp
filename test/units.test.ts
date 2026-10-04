import { describe, expect, it } from "vitest";
import { artistMatches, labelFromCopyrights, labelKey, sameLabel, titleKey, titleMatches, trackKey, spotifyTrackKey } from "../src/discovery/keys.js";
import { applyPickRules, type PickInput } from "../src/discovery/rules.js";
import { bestMatch, parseCandidatesText, searchLadder } from "../src/discovery/verify.js";
import { beatportMeta, fitsLane, metaLine, parseBeatport, parseSoundcloud, scTags } from "../src/metadata/lookup.js";
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
