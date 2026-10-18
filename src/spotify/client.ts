import { pacedFetch, paceFromEnv, RateLimitedError, type FetchLike as PacedFetchLike, type PaceOptions } from "paced-fetch";
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

/**
 * Spotify asked us to wait longer than is worth waiting (a quota block can be hours).
 * Thrown at once, and for every later request until `until`, so a tool call ends
 * in seconds instead of grinding through its requests to the harness's timeout.
 */
export class RateLimitError extends SpotifyError {
  constructor(
    readonly until: Date,
    reason: string,
  ) {
    const mins = Math.max(1, Math.round((until.getTime() - Date.now()) / 60_000));
    super(`Spotify is rate-limiting this app${reason ? ` (${reason})` : ""} until ${until.toISOString().slice(0, 16)}Z, about ${mins} min from now.`, 429);
    this.name = "RateLimitError";
  }
}

/** Rethrow a rate-limit error from a catch that would otherwise skip one item and carry on. */
export function rethrowRateLimit(err: unknown): void {
  if (err instanceof RateLimitError) throw err;
}

/**
 * Pacing for the Spotify Web API, which publishes no fixed limit (a rolling 30 s
 * window, and a daily quota in Development Mode). A 429 is waited out up to 3
 * times for its Retry-After (2 s without one); a longer Retry-After, such as a
 * quota block of hours, fails at once and blocks every later request until it
 * ends. Change with SPOTIFY_DISCOVERY_RATE, _CONCURRENCY, _MIN_GAP, _RETRIES and
 * _MAX_RETRY_WAIT.
 */
export const SPOTIFY_PACE: PaceOptions = { retries: 3, backoffMs: [2_000], maxRetryWaitMs: 60_000, timeoutMs: 30_000 };

/** Search's page size since February 2026 (Development Mode). */
export const SEARCH_LIMIT = 10;

/** Strip double quotes so a value can go inside a `field:"…"` filter. */
export const quoteSafe = (s: string) => s.replace(/["“”]/g, "").trim();

/**
 * A small Spotify Web API client: one forced token refresh on 401. Pacing and
 * retries (429, and 5xx on GET, PUT and DELETE) are paced-fetch's; see SPOTIFY_PACE.
 */
export class SpotifyClient {
  /** Requests sent to Spotify, retries included. */
  requests = 0;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly tokens: Pick<TokenSource, "token">,
    fetchImpl: FetchLike = fetch,
    private readonly base = SPOTIFY_API,
    sleep?: (ms: number) => Promise<void>,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const { pace, warnings } = paceFromEnv("SPOTIFY_DISCOVERY", SPOTIFY_PACE, env);
    // stdout is the MCP channel; stderr is where hosts show server logs.
    for (const w of warnings) console.error(w);
    const counted: FetchLike = (input, init) => {
      this.requests++;
      return fetchImpl(input, init);
    };
    // paced-fetch passes the caller's string URL through unchanged.
    this.fetchImpl = pacedFetch({ fetch: counted as PacedFetchLike, defaults: pace, sleep }) as FetchLike;
  }

  async request<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let forced = false;
    for (;;) {
      const token = await this.tokens.token(forced);
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        if (err instanceof RateLimitedError) {
          const body = safeJson(err.detail) as { error?: { reason?: string; message?: string } } | undefined;
          throw new RateLimitError(err.until, body?.error?.reason ?? body?.error?.message ?? "");
        }
        throw err;
      }
      if (res.status === 401 && !forced) {
        await res.body?.cancel();
        forced = true;
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
