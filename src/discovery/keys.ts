import { textKey } from "job-ledger";
import type { Copyright } from "../spotify/client.js";

/**
 * Version words that don't make a different track. "VIP", "Remix" and named
 * mixes do, so they stay in the key.
 */
const SAME_TRACK_SUFFIX =
  /\s*(?:[-–—]\s*|[([]\s*)(?:radio edit|original mix|extended mix|extended version|extended|club mix|edit|single version|remaster(?:ed)?(?: \d{4})?|\d{4} remaster(?:ed)?)\s*[)\]]?\s*$/i;

/** A title's comparison key, with "- Radio Edit", "(Original Mix)" and the like removed. */
export function titleKey(title: string): string {
  let t = title.trim();
  for (let i = 0; i < 3; i++) {
    const next = t.replace(SAME_TRACK_SUFFIX, "");
    if (next === t) break;
    t = next;
  }
  return textKey(t);
}

/** Split a credit like "Ho Gosh, Macarite feat. X & Y" into names. */
export function splitArtists(credit: string): string[] {
  return credit
    .split(/\s*(?:,|;|\/|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+x\s+|\s+&\s+|\s+and\s+|\s+vs\.?\s+|\s+with\s+)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The track key used for dedup: first artist plus title. */
export function trackKey(artist: string, title: string): string {
  const first = splitArtists(artist)[0] ?? artist;
  return `${textKey(first)}|${titleKey(title)}`;
}

/** Track key for a Spotify track, from its first credited artist. */
export function spotifyTrackKey(t: { name: string; artists: { name: string }[] }): string {
  return `${textKey(t.artists[0]?.name ?? "")}|${titleKey(t.name)}`;
}

/**
 * Does a credit from a web source ("Sulphur, Ho Gosh & Macarite") match
 * Spotify's artists? True if the whole credit, or any name in it, matches any
 * of Spotify's names. "Cottam (UK)" matches "Cottam".
 */
export function artistMatches(credit: string, spotifyNames: string[]): boolean {
  const strip = (s: string) => textKey(s.replace(/\s*\((?:uk|us|nl|de|fr|au|ca|\d+)\)\s*$/i, ""));
  const theirs = new Set(spotifyNames.map(strip));
  if (theirs.has(strip(credit))) return true;
  const joined = strip(spotifyNames.join(" "));
  if (joined && joined === strip(credit)) return true;
  return splitArtists(credit).some((n) => theirs.has(strip(n)));
}

const OTHER_VERSION = /\b(remix|vip|rework|bootleg|flip|mix|version|dub|live|acoustic|instrumental)\b/;
const CREDIT_ONLY = /^\s*(feat|ft|featuring|with)\b/;

/**
 * Do two titles name the same track? Equal keys, or Spotify's title adds
 * something that isn't a different version ("Kraken (feat. Absu_NTQL)"), or
 * the source's title adds only a credit. A remix or VIP is a different track.
 */
export function titleMatches(candidate: string, spotify: string): boolean {
  const a = titleKey(candidate);
  const b = titleKey(spotify);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.startsWith(a + " ")) return !OTHER_VERSION.test(b.slice(a.length));
  if (a.startsWith(b + " ")) return CREDIT_ONLY.test(a.slice(b.length));
  return false;
}

const LABEL_NOISE = /\b(records?|recordings?|music|label|labels|ltd|limited|inc|llc|audio|group|digital|entertainment|productions?|rec)\b/g;

/** A label's comparison key: "Critical Music", "Critical" and "CRITICAL MUSIC LTD" are the same. */
export function labelKey(name: string): string {
  const k = textKey(name).replace(LABEL_NOISE, " ").replace(/\s+/g, " ").trim();
  return k || textKey(name);
}

/**
 * Is `actual` (a ℗ line's label) the label that was searched for? Every word
 * of the searched label's key must be a word of the actual one: ".707 BLACKOUT
 * MUSIC" is Blackout Music, but "Visionary Sounds Recordings" isn't Vision
 * Recordings and "Criticals Music LLC" isn't Critical Music.
 */
export function labelContains(actual: string, searched: string): boolean {
  const have = new Set(labelKey(actual).split(" "));
  const want = labelKey(searched).split(" ").filter(Boolean);
  return want.length > 0 && want.every((w) => have.has(w));
}

export function sameLabel(a: string, b: string): boolean {
  const ka = labelKey(a);
  const kb = labelKey(b);
  return !!ka && !!kb && (ka === kb || ka.startsWith(kb + " ") || kb.startsWith(ka + " "));
}

/**
 * The label from an album's copyright lines. The ℗ (P) line names the label
 * more often than the © one. "2026 Some Label under exclusive license to
 * Bigger Label" gives "Bigger Label".
 */
export function labelFromCopyrights(copyrights: Copyright[] | undefined): string | undefined {
  if (!copyrights?.length) return undefined;
  const line = copyrights.find((c) => c.type === "P") ?? copyrights[0]!;
  let t = line.text.trim();
  const licensed = t.match(/under (?:exclusive )?licen[cs]e to (.+)$/i);
  if (licensed) t = licensed[1]!;
  // Markers: "(P)", "(C)", "℗", "©", or a bare P/C only when a year follows.
  const marker = /^(?:\([pc]\)|[℗©]|[pc](?=\s*\d{4}))\s*/i;
  t = t
    .replace(marker, "")
    .replace(/^\d{4}(?:\s*[-,]\s*\d{4})?\s*/, "")
    .replace(marker, "")
    .replace(/[.,;]?\s*all rights reserved\.?$/i, "")
    .replace(/,?\s*a division of .+$/i, "")
    .replace(/[\s.,;]+$/, "")
    .trim();
  return t || undefined;
}

/** "2026", "2026-09" or "2026-09-11" as a comparable day string (earliest day it could be). */
export function releaseDay(date: string | undefined): string {
  if (!date) return "0000-01-01";
  if (/^\d{4}$/.test(date)) return `${date}-01-01`;
  if (/^\d{4}-\d{2}$/.test(date)) return `${date}-01`;
  return date.slice(0, 10);
}
