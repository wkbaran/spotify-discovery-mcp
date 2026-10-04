import { request } from "node:https";
import { METADATA_UA } from "../config.js";
import type { FetchLike } from "../auth/tokens.js";
import { artistMatches, sameLabel, titleMatches } from "../discovery/keys.js";
import type { Meta } from "../discovery/state.js";

/**
 * Genre, BPM and key from Beatport's search page or a SoundCloud track page.
 * Both embed their data as JSON in the HTML; there's no open API. Everything
 * here fails open: any error, timeout or unexpected shape means "no metadata".
 * See docs/metadata-sources.md.
 */

const TIMEOUT_MS = 10_000;

async function getHtml(fetchImpl: FetchLike, url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": METADATA_UA, Accept: "*/*", "Accept-Encoding": "identity" }, signal: ctrl.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A minimal GET over node:https, shaped like fetch. Node's own fetch adds
 * browser-style headers (sec-fetch-mode, accept-language: *) that Beatport's
 * Cloudflare rules challenge; this sends only what it's given. Follows up to
 * three redirects.
 */
export const httpsGet: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const go = (target: string, hops: number) => {
      const req = request(target, { method: "GET", headers: init?.headers as Record<string, string>, signal: init?.signal ?? undefined }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location && hops < 3) {
          res.resume();
          go(new URL(res.headers.location, target).toString(), hops + 1);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: status || 500 })));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    };
    go(url, 0);
  });

interface BeatportTrack {
  track_name?: string;
  mix_name?: string;
  artists?: { artist_name?: string }[];
  genre?: { genre_name?: string }[] | { genre_name?: string };
  sub_genre?: { sub_genre_name?: string } | null;
  bpm?: number;
  key_name?: string;
  label?: { label_name?: string };
  release_date?: string;
  publish_date?: string;
}

/** Beatport lists drum and bass (and some 140) at half tempo. */
const HALF_TIME = /drum & bass|dubstep|140|halftime/i;

export function parseBeatport(html: string): BeatportTrack[] {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  try {
    const d = JSON.parse(m[1]!);
    const out: BeatportTrack[] = [];
    for (const q of d?.props?.pageProps?.dehydratedState?.queries ?? []) {
      const data = q?.state?.data?.data;
      if (Array.isArray(data)) out.push(...data);
    }
    return out;
  } catch {
    return [];
  }
}

export function beatportMeta(t: BeatportTrack): Meta {
  const genres = Array.isArray(t.genre) ? t.genre : t.genre ? [t.genre] : [];
  const genre = genres.map((g) => g.genre_name).filter(Boolean)[0];
  const sub = t.sub_genre?.sub_genre_name;
  let bpm = typeof t.bpm === "number" && t.bpm > 0 ? t.bpm : undefined;
  if (bpm && bpm < 100 && genre && HALF_TIME.test(genre)) bpm *= 2;
  const withSub = sub && genre && !genre.toLowerCase().includes(sub.toLowerCase()) ? `${genre} / ${sub}` : genre;
  return { from: "beatport", genre: withSub, bpm, key: t.key_name, label: t.label?.label_name?.replace(/[\s.,;]+$/, "") };
}

/** Look a track up on Beatport. Accepts a result only if the artist and title match, preferring one whose label matches too. */
export async function beatportLookup(fetchImpl: FetchLike, q: { artist: string; artists: string[]; title: string; label?: string }): Promise<Meta | null> {
  const html = await getHtml(fetchImpl, `https://www.beatport.com/search/tracks?q=${encodeURIComponent(`${q.artists[0] ?? q.artist} ${q.title}`)}`);
  if (!html) return null;
  const hits = parseBeatport(html).filter((t) => {
    const names = (t.artists ?? []).map((a) => a.artist_name ?? "").filter(Boolean);
    return names.length > 0 && t.track_name && (artistMatches(q.artist, names) || q.artists.some((a) => artistMatches(a, names))) && titleMatches(t.track_name, q.title.replace(/\s*[-–]\s*.*(?:edit|mix)$/i, ""));
  });
  if (!hits.length) return null;
  const best = (q.label && hits.find((t) => t.label?.label_name && sameLabel(t.label.label_name, q.label!))) || hits[0]!;
  return beatportMeta(best);
}

interface ScSound {
  genre?: string;
  tag_list?: string;
  label_name?: string;
  publisher_metadata?: { isrc?: string; p_line?: string } | null;
}

/** SoundCloud's free tags: words, or "quoted phrases". */
export function scTags(list: string | undefined): string[] {
  if (!list) return [];
  const out: string[] = [];
  for (const m of list.matchAll(/"([^"]+)"|(\S+)/g)) out.push((m[1] ?? m[2]!).trim());
  return out.filter(Boolean);
}

export function parseSoundcloud(html: string): ScSound | null {
  const m = html.match(/window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);<\/script>/);
  if (!m) return null;
  try {
    const items = JSON.parse(m[1]!) as { hydratable?: string; data?: ScSound }[];
    return items.find((h) => h.hydratable === "sound")?.data ?? null;
  } catch {
    return null;
  }
}

/** Genre and tags from a SoundCloud track URL (only track pages; sets and profiles give nothing). */
export async function soundcloudLookup(fetchImpl: FetchLike, url: string): Promise<Meta | null> {
  if (!/^https:\/\/(?:www\.|m\.)?soundcloud\.com\/[^/]+\/(?!sets\/)[^/?#]+/.test(url)) return null;
  const html = await getHtml(fetchImpl, url);
  const s = html ? parseSoundcloud(html) : null;
  if (!s) return null;
  return { from: "soundcloud", genre: s.genre || undefined, tags: scTags(s.tag_list), label: s.label_name || undefined, url };
}

/** Does this metadata put the track in the lane? Undefined when the lane lists no genres or tags, or there's nothing to judge by. */
export function fitsLane(meta: Meta | null | undefined, lane: { genres: string[]; tags: string[] }): boolean | undefined {
  if (!meta || (!lane.genres.length && !lane.tags.length)) return undefined;
  const words = [meta.genre ?? "", ...(meta.tags ?? [])].join(" ").toLowerCase();
  if (!words.trim()) return undefined;
  if (meta.genre && lane.genres.some((g) => meta.genre!.toLowerCase().startsWith(g.toLowerCase()))) return true;
  if (lane.tags.some((t) => words.includes(t.toLowerCase()))) return true;
  return false;
}

/** "Beatport: Drum & Bass · 174 BPM · G Minor" */
export function metaLine(meta: Meta | null | undefined): string {
  if (!meta) return "";
  const src = meta.from === "beatport" ? "Beatport" : "SoundCloud";
  const parts = [meta.genre, meta.bpm ? `${Math.round(meta.bpm)} BPM` : undefined, meta.key, meta.tags?.length ? `tags: ${meta.tags.slice(0, 5).join(", ")}` : undefined].filter(Boolean);
  return parts.length ? `${src}: ${parts.join(" · ")}` : "";
}
