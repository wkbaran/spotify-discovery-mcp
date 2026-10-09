import { afterEach, describe, expect, it } from "vitest";
import { metadataSources } from "../src/config.js";

describe("metadataSources", () => {
  const saved = process.env.SPOTIFY_DISCOVERY_METADATA;
  afterEach(() => {
    if (saved === undefined) delete process.env.SPOTIFY_DISCOVERY_METADATA;
    else process.env.SPOTIFY_DISCOVERY_METADATA = saved;
  });

  it("is off unless the operator turns it on", () => {
    delete process.env.SPOTIFY_DISCOVERY_METADATA;
    expect([...metadataSources()]).toEqual([]);
  });

  it("accepts a list of sources", () => {
    process.env.SPOTIFY_DISCOVERY_METADATA = "beatport, soundcloud";
    expect([...metadataSources()].sort()).toEqual(["beatport", "soundcloud"]);
  });

  it("accepts Deezer, and ignores names it doesn't know", () => {
    process.env.SPOTIFY_DISCOVERY_METADATA = "beatport,deezer,musicbrainz";
    expect([...metadataSources()].sort()).toEqual(["beatport", "deezer"]);
  });
});
