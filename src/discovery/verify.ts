import { textKey } from "job-ledger";
import { quoteSafe, type SpotifyClient, type Track } from "../spotify/client.js";
import { artistMatches, labelFromCopyrights, releaseDay, sameLabel, splitArtists, titleKey, titleMatches } from "./keys.js";

/** A track the web research proposed. */
export interface Candidate {
  artist: string;
  track: string;
  release?: string;
  label?: string;
  released?: string;
  why?: string;
  source_url?: string;
}

export interface FoundLabel {
  name: string;
  source_url?: string;
  note?: string;
}

const URL_RE = /^https?:\/\/\S+$/i;
const DATE_RE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

/**
 * Parse the research subagent's reply, so the main model can pass it on
 * unchanged instead of retyping it. One candidate per line:
 *
 *   artist | track | release | label | release date | why it fits | source URL
 *
 * Bullets and numbering are ignored, a field that's a URL is the source
 * wherever it is, and a date-looking field is the release date. Lines starting
 * `LABEL |` are newly found labels: `LABEL | name | url | note`.
 */
export function parseCandidatesText(text: string): { candidates: Candidate[]; labels: FoundLabel[] } {
  const candidates: Candidate[] = [];
  const labels: FoundLabel[] = [];
  for (const raw of candidateLines(text)) {
    const line = raw
      .trim()
      .replace(/^(?:[-*•]|\d+[.)])\s*/, "")
      .replace(/\*\*/g, "")
      .replace(/^["'`]+|["'`]+,?$/g, "")
      .trim();
    if (!line.includes("|")) continue;
    const fields = line.split("|").map((f) => f.trim());
    if (/^labels?$/i.test(fields[0] ?? "")) {
      const name = fields[1];
      if (name) labels.push({ name, source_url: fields.find((f) => URL_RE.test(f)), note: fields.slice(2).find((f) => f && !URL_RE.test(f)) });
      continue;
    }
    if (/^artist$/i.test(fields[0] ?? "")) continue; // a header row
    const url = fields.find((f) => URL_RE.test(f));
    const rest = fields.filter((f) => !URL_RE.test(f));
    const date = rest.findIndex((f, i) => i >= 2 && DATE_RE.test(f));
    const released = date >= 0 ? rest.splice(date, 1)[0] : undefined;
    const [artist, track, release, label, ...why] = rest;
    if (!artist || !track) continue;
    candidates.push({
      artist,
      track,
      release: blank(release),
      label: blank(label),
      released,
      why: blank(why.join(" | ")),
      source_url: url,
    });
  }
  return { candidates, labels };
}

/**
 * The lines of a research reply. Models sometimes wrap the pipe lines in JSON
 * (`{"tracks": ["a | b | …"]}`) or a code fence; the strings inside are what
 * matter, so a JSON reply is flattened to its strings first.
 */
export function candidateLines(text: string): string[] {
  const unfenced = text.replace(/```[a-z]*\n?/gi, "");
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") strings.push(...v.split(/\r?\n/));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  const start = unfenced.search(/[[{]/);
  if (start >= 0) {
    try {
      walk(JSON.parse(unfenced.slice(start, Math.max(unfenced.lastIndexOf("}"), unfenced.lastIndexOf("]")) + 1)));
      if (strings.some((l) => l.includes("|"))) return strings;
    } catch {
      // Not JSON; read it as lines.
    }
  }
  return unfenced.split(/\r?\n/).map((l) => l.replace(/\\"/g, '"'));
}

const blank = (s: string | undefined) => (s && !/^(-|n\/?a|unknown|none|\?)$/i.test(s) ? s : undefined);

export interface Verified {
  track: Track;
  label?: string;
  /** Set when the ℗ label differs from the one the source gave. */
  labelNote?: string;
}

/** The search queries to try, most exact first. */
export function searchLadder(c: Candidate): string[] {
  const artist = quoteSafe(splitArtists(c.artist)[0] ?? c.artist);
  const title = quoteSafe(c.track.replace(/\s*[(\[](?:feat|ft)\.?[^)\]]*[)\]]/i, ""));
  const base = `track:"${title}" artist:"${artist}"`;
  const out = [base];
  if (c.release && titleKey(c.release) !== titleKey(c.track)) out.push(`${base} album:"${quoteSafe(c.release)}"`);
  if (c.label) out.push(`track:"${title}" label:"${quoteSafe(c.label)}"`);
  out.push(`${artist} ${title}`);
  return out;
}

/** Choose among matching tracks: the named release, then not a compilation, then the earliest. */
export function bestMatch(matches: Track[], c: Candidate): Track | undefined {
  const score = (t: Track) => [
    c.release && t.album && titleKey(t.album.name) === titleKey(c.release) ? 0 : 1,
    t.album?.album_type === "compilation" ? 1 : 0,
    releaseDay(t.album?.release_date),
  ];
  return [...matches].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! < sb[i]! ? -1 : 1;
    return 0;
  })[0];
}

/** Find a candidate on Spotify. Null when no search turns up the same artist and title. */
export async function findOnSpotify(client: SpotifyClient, c: Candidate): Promise<Verified | null> {
  let matches: Track[] = [];
  for (const q of searchLadder(c)) {
    const tracks = await client.searchTracks(q);
    matches = tracks.filter((t) => artistMatches(c.artist, t.artists.map((a) => a.name)) && titleMatches(c.track, t.name));
    if (matches.length) break;
  }
  const best = bestMatch(matches, c);
  if (!best) return null;
  let label: string | undefined;
  try {
    if (best.album?.id) label = labelFromCopyrights((await client.album(best.album.id)).copyrights);
  } catch {
    // The label is a nice-to-have.
  }
  const labelNote = c.label && label && !sameLabel(c.label, label) ? `label is ${label}, not ${c.label} as the source said` : undefined;
  return { track: best, label: label ?? c.label, labelNote };
}

/** A display credit for a Spotify track: "A, B & C" style is left to Spotify's names joined by commas. */
export const credit = (t: Track) => t.artists.map((a) => a.name).join(", ");

export const candidateKeyArtist = (c: Candidate) => textKey(splitArtists(c.artist)[0] ?? c.artist);
