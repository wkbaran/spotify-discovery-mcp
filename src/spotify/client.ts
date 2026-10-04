import { SPOTIFY_API } from "../config.js";
import { AuthError, type FetchLike, type TokenSource } from "../auth/tokens.js";

export interface Artist {
  id: string;
  name: string;
}

export interface Album {
  id: string;
  name: string;
  album_type: string; // album | single | compilation
  release_date: string;
  release_date_precision?: "year" | "month" | "day";
  total_tracks?: number;
  artists: Artist[];
  uri?: string;
}

export interface Track {
  id: string;
  uri: string;
  name: string;
  artists: Artist[];
  album?: Album;
  external_ids?: { isrc?: string };
  track_number?: number;
  duration_ms?: number;
}

export interface Copyright {
  text: string;
  type: string; // C | P
}

export interface FullAlbum extends Album {
  copyrights?: Copyright[];
}

export interface Playlist {
  id: string;
  name: string;
  uri: string;
  external_urls?: { spotify?: string };
}

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SpotifyError";
  }
}

/** Search's page size since February 2026 (Development Mode). */
export const SEARCH_LIMIT = 10;

/** Strip double quotes so a value can go inside a `field:"…"` filter. */
export const quoteSafe = (s: string) => s.replace(/["“”]/g, "").trim();

/**
 * A small Spotify Web API client: one forced token refresh on 401, waits on
 * 429 (Retry-After, up to 3 times), one retry on 5xx.
 */
export class SpotifyClient {
  requests = 0;

  constructor(
    private readonly tokens: Pick<TokenSource, "token">,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly base = SPOTIFY_API,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async request<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let forced = false;
    let waits = 0;
    let serverRetries = 0;
    for (;;) {
      const token = await this.tokens.token(forced);
      this.requests++;
      const res = await this.fetchImpl(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 401 && !forced) {
        forced = true;
        continue;
      }
      if (res.status === 429 && waits < 3) {
        waits++;
        const after = Number(res.headers.get("retry-after") ?? "2");
        await this.sleep(Math.min(30, Number.isFinite(after) ? after : 2) * 1000);
        continue;
      }
      if (res.status >= 500 && serverRetries < 1) {
        serverRetries++;
        await this.sleep(1000);
        continue;
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      const body = text ? safeJson(text) : undefined;
      if (!res.ok) {
        const msg = (body as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 200);
        if (res.status === 401) throw new AuthError(`Spotify rejected the access token (${msg}).`);
        throw new SpotifyError(`Spotify ${method} ${path} failed: ${res.status} ${msg}`, res.status);
      }
      return body as T;
    }
  }

  /** Albums matching a search, paging until a short page or `maxPages`. */
  async searchAlbums(q: string, maxPages = 3): Promise<Album[]> {
    const out: Album[] = [];
    for (let page = 0; page < maxPages; page++) {
      const r = await this.request<{ albums?: { items: (Album | null)[] } }>("GET", "/search", { query: { q, type: "album", limit: SEARCH_LIMIT, offset: page * SEARCH_LIMIT } });
      const items = (r.albums?.items ?? []).filter((a): a is Album => !!a);
      out.push(...items);
      if (items.length < SEARCH_LIMIT) break;
    }
    return out;
  }

  async searchTracks(q: string): Promise<Track[]> {
    const r = await this.request<{ tracks?: { items: (Track | null)[] } }>("GET", "/search", { query: { q, type: "track", limit: SEARCH_LIMIT } });
    return (r.tracks?.items ?? []).filter((t): t is Track => !!t);
  }

  async searchArtists(name: string): Promise<Artist[]> {
    const r = await this.request<{ artists?: { items: (Artist | null)[] } }>("GET", "/search", { query: { q: `artist:"${quoteSafe(name)}"`, type: "artist", limit: 5 } });
    return (r.artists?.items ?? []).filter((a): a is Artist => !!a);
  }

  /** An artist's albums and singles, newest first as Spotify returns them, up to `max`. */
  async artistAlbums(id: string, max = 20): Promise<Album[]> {
    const out: Album[] = [];
    for (let offset = 0; offset < max; offset += 10) {
      const r = await this.request<{ items: Album[]; next: string | null }>("GET", `/artists/${id}/albums`, { query: { include_groups: "album,single", limit: 10, offset } });
      out.push(...r.items);
      if (!r.next) break;
    }
    return out;
  }

  async albumTracks(id: string): Promise<Track[]> {
    const out: Track[] = [];
    for (let offset = 0; offset < 200; offset += 50) {
      const r = await this.request<{ items: Track[]; next: string | null }>("GET", `/albums/${id}/tracks`, { query: { limit: 50, offset } });
      out.push(...r.items);
      if (!r.next) break;
    }
    return out;
  }

  async album(id: string): Promise<FullAlbum> {
    return this.request<FullAlbum>("GET", `/albums/${id}`);
  }

  async createPlaylist(name: string, description: string, isPublic: boolean): Promise<Playlist> {
    return this.request<Playlist>("POST", "/me/playlists", { body: { name, description, public: isPublic } });
  }

  /** Every item in a playlist. Since February 2026 entries are under `item`, not `track`. */
  async playlistTracks(id: string): Promise<Track[]> {
    const out: Track[] = [];
    for (let offset = 0; offset < 2000; offset += 50) {
      const r = await this.request<{ items: { item?: Track | null; track?: Track | null }[]; next: string | null }>("GET", `/playlists/${id}/items`, { query: { limit: 50, offset } });
      for (const i of r.items) {
        const t = i.item ?? i.track;
        if (t?.uri) out.push(t);
      }
      if (!r.next) break;
    }
    return out;
  }

  async addToPlaylist(id: string, uris: string[]): Promise<void> {
    for (let i = 0; i < uris.length; i += 100) {
      await this.request("POST", `/playlists/${id}/items`, { body: { uris: uris.slice(i, i + 100) } });
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The playlist's web link. */
export const playlistUrl = (id: string) => `https://open.spotify.com/playlist/${id}`;
