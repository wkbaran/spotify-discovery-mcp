import { homedir } from "node:os";
import { join } from "node:path";

export const SPOTIFY_API = "https://api.spotify.com/v1";
export const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com";
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:43827/spotify/callback";
/** Only what the server uses: read and write the user's own playlists. */
export const SCOPES = ["playlist-read-private", "playlist-read-collaborative", "playlist-modify-private", "playlist-modify-public"];

/**
 * The User-Agent for metadata pages. An honest one: Cloudflare in front of
 * Beatport challenges a browser UA that doesn't come with a browser's TLS
 * fingerprint, and lets this through (tested 2026-10-03 from the Hermes host).
 */
export const METADATA_UA = "spotify-discovery-mcp/0.1 (+https://github.com/wkbaran/spotify-discovery-mcp)";

/** The data directory. The discovery tools exist only when this is set. */
export function discoveryDir(): string | undefined {
  return process.env.SPOTIFY_DISCOVERY_DIR || undefined;
}

/** Where `login` saves tokens: SPOTIFY_DISCOVERY_AUTH, else the data directory, else ~/.config. */
export function authPath(): string {
  if (process.env.SPOTIFY_DISCOVERY_AUTH) return process.env.SPOTIFY_DISCOVERY_AUTH;
  const dir = discoveryDir();
  return dir ? join(dir, "auth.json") : join(homedir(), ".config", "spotify-discovery-mcp", "auth.json");
}

/** Overrides lanes.json's `timezone`. */
export function timezoneOverride(): string | undefined {
  return process.env.SPOTIFY_DISCOVERY_TZ || undefined;
}

export type MetadataSource = "beatport" | "soundcloud" | "deezer";

/**
 * Which metadata sources to look up genre in: any of "beatport", "soundcloud"
 * and "deezer". Off by default. Beatport and SoundCloud have no open API, so
 * those lookups scrape their pages, which their terms don't allow; turning
 * them on is the operator's call. Keep the honest User-Agent, and never try to
 * get past a block. Deezer has an official API that needs no key; its genres
 * are coarse, so it's the fallback when Beatport finds nothing.
 */
export function metadataSources(): Set<MetadataSource> {
  const raw = (process.env.SPOTIFY_DISCOVERY_METADATA ?? "off").toLowerCase();
  const out = new Set<MetadataSource>();
  if (raw === "off" || raw === "none") return out;
  for (const s of raw.split(/[\s,]+/)) if (s === "beatport" || s === "soundcloud" || s === "deezer") out.add(s);
  return out;
}

/** A fixed access token, for testing only. Skips auth.json and never refreshes. */
export function staticAccessToken(): string | undefined {
  return process.env.SPOTIFY_DISCOVERY_ACCESS_TOKEN || undefined;
}
