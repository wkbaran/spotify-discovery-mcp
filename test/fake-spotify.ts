import { textKey } from "job-ledger";
import type { FetchLike } from "../src/auth/tokens.js";
import { sameLabel, titleKey } from "../src/discovery/keys.js";
import type { Album, Track } from "../src/spotify/client.js";

interface FakeAlbum {
  album: Album;
  tracks: Track[];
  label: string;
}

/**
 * Just enough of the Spotify Web API (as it behaves for Development Mode apps
 * since February 2026) for the discovery tools: search with field filters and
 * a page size of 10, artist albums, album tracks and copyrights, and playlists
 * read and written through /items.
 */
export class FakeSpotify {
  albums = new Map<string, FakeAlbum>();
  artists = new Map<string, string>(); // id -> name
  playlists = new Map<string, { name: string; uris: string[] }>();
  created = 0;
  log: string[] = [];
  /** Set to answer every request with a quota 429 and this Retry-After, in seconds. */
  quotaRetryAfter?: number;
  private n = 0;

  addRelease(o: { artist: string; title: string; tracks: string[]; label: string; date: string; type?: string; extraArtists?: string[] }): Track[] {
    const id = `alb${++this.n}`;
    const artistId = this.artistId(o.artist);
    const artists = [{ id: artistId, name: o.artist }, ...(o.extraArtists ?? []).map((a) => ({ id: this.artistId(a), name: a }))];
    const album: Album = { id, name: o.title, album_type: o.type ?? (o.tracks.length > 3 ? "album" : "single"), release_date: o.date, release_date_precision: "day", total_tracks: o.tracks.length, artists };
    const tracks = o.tracks.map((name, i): Track => ({ id: `${id}t${i + 1}`, uri: `spotify:track:${id}t${i + 1}`, name, artists, album, external_ids: { isrc: `XX${id}${i}` }, track_number: i + 1 }));
    this.albums.set(id, { album, tracks, label: o.label });
    return tracks;
  }

  private artistId(name: string): string {
    for (const [id, n] of this.artists) if (n === name) return id;
    const id = `art${this.artists.size + 1}`;
    this.artists.set(id, name);
    return id;
  }

  playlistUris(id: string): string[] {
    return this.playlists.get(id)?.uris ?? [];
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (!u.hostname.endsWith("spotify.com")) return new Response("no", { status: 404 });
    const path = u.pathname.replace(/^\/v1/, "");
    this.log.push(`${method} ${path}${u.search}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (this.quotaRetryAfter !== undefined) {
      return new Response(JSON.stringify({ error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" } }), { status: 429, headers: { "retry-after": String(this.quotaRetryAfter) } });
    }
    const limit = Number(u.searchParams.get("limit") ?? 5);
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const page = <T>(items: T[]) => ({ items: items.slice(offset, offset + limit), next: offset + limit < items.length ? "more" : null, total: items.length });
    let m: RegExpMatchArray | null;

    if (path === "/search") {
      if (limit > 10) return json({ error: { status: 400, message: "Invalid limit" } }, 400);
      const q = u.searchParams.get("q") ?? "";
      const field = (f: string) => q.match(new RegExp(`${f}:"([^"]+)"`))?.[1];
      const type = u.searchParams.get("type");
      if (type === "artist") {
        const name = field("artist") ?? q;
        return json({ artists: page([...this.artists].filter(([, n]) => textKey(n) === textKey(name)).map(([id, n]) => ({ id, name: n }))) });
      }
      const all = [...this.albums.values()];
      if (type === "album") {
        const label = field("label");
        return json({ albums: page(all.filter((a) => label && sameLabel(a.label, label)).map((a) => a.album)) });
      }
      const track = field("track");
      const artist = field("artist");
      const label = field("label");
      const tracks = all.flatMap((a) => a.tracks.map((t) => ({ t, a })));
      const hits = tracks.filter(({ t, a }) => {
        if (track || artist || label) {
          return (!track || titleKey(t.name).startsWith(titleKey(track))) && (!artist || t.artists.some((x) => textKey(x.name) === textKey(artist))) && (!label || sameLabel(a.label, label));
        }
        const words = textKey(q).split(" ");
        const hay = textKey(`${t.artists.map((x) => x.name).join(" ")} ${t.name}`);
        return words.every((w) => hay.includes(w));
      });
      return json({ tracks: page(hits.map((h) => h.t)) });
    }
    if ((m = path.match(/^\/artists\/([^/]+)\/albums$/))) {
      if (limit > 10) return json({ error: { status: 400, message: "Invalid limit" } }, 400);
      const id = m[1]!;
      const albums = [...this.albums.values()].filter((a) => a.album.artists[0]?.id === id).map((a) => a.album).sort((a, b) => b.release_date.localeCompare(a.release_date));
      return json(page(albums));
    }
    if ((m = path.match(/^\/albums\/([^/]+)\/tracks$/))) {
      const a = this.albums.get(m[1]!);
      return a ? json(page(a.tracks.map(({ album: _a, external_ids: _e, ...t }) => t))) : json({ error: { status: 404, message: "Resource not found" } }, 404);
    }
    if ((m = path.match(/^\/albums\/([^/]+)$/))) {
      const a = this.albums.get(m[1]!);
      return a ? json({ ...a.album, copyrights: [{ type: "C", text: `2026 ${a.label}` }, { type: "P", text: `2026 ${a.label}` }], genres: [] }) : json({}, 404);
    }
    if (path === "/me/playlists" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      const id = `pl${++this.created}`;
      this.playlists.set(id, { name: body.name, uris: [] });
      await new Promise((r) => setTimeout(r, 20)); // slow enough for two lanes to race
      return json({ id, name: body.name, uri: `spotify:playlist:${id}`, external_urls: { spotify: `https://open.spotify.com/playlist/${id}` } }, 201);
    }
    if ((m = path.match(/^\/playlists\/([^/]+)\/items$/))) {
      const pl = this.playlists.get(m[1]!);
      if (!pl) return json({ error: { status: 404, message: "Not found" } }, 404);
      if (method === "POST") {
        pl.uris.push(...JSON.parse(String(init?.body)).uris);
        return json({ snapshot_id: "x" }, 201);
      }
      const byUri = new Map([...this.albums.values()].flatMap((a) => a.tracks.map((t) => [t.uri, t] as const)));
      return json(page(pl.uris.map((uri) => ({ item: byUri.get(uri) }))));
    }
    if ((m = path.match(/^\/playlists\/([^/]+)\/tracks$/))) return json({ error: { status: 403, message: "Forbidden" } }, 403);
    return json({ error: { status: 404, message: `fake: no route ${method} ${path}` } }, 404);
  };
}
