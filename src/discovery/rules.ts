/**
 * The pick rules, as the README explains them. The model lists picks best
 * first; this keeps them in that order and drops any that would break a limit,
 * from the end. It never refuses the whole list.
 */

export interface PickInput {
  ref: string;
  /** Feed (K) or carried-over (C) items count against `max_feed_picks`. */
  fromFeed: boolean;
  /** By an artist in core_artists. */
  core: boolean;
}

export interface Limits {
  target: [number, number];
  max_feed_picks: number;
  max_core_picks: number;
  min_web_picks: number;
}

export interface RuleResult {
  kept: string[];
  dropped: { ref: string; reason: string }[];
  /** The feed limit that applied (it lifts when there are no verified web finds). */
  feedLimit: number;
  thin: boolean;
}

export function applyPickRules(picks: PickInput[], limits: Limits, verifiedWebFinds: number): RuleResult {
  const max = limits.target[1];
  const feedLimit = verifiedWebFinds === 0 ? max : Math.min(limits.max_feed_picks, max);
  // min_web_picks reserves room for web picks the model actually made; the server can't invent picks.
  const webPicked = picks.filter((p) => !p.fromFeed).length;
  const reserve = Math.min(limits.min_web_picks, webPicked, max);
  const feedRoom = Math.min(feedLimit, max - reserve);

  const kept: string[] = [];
  const dropped: RuleResult["dropped"] = [];
  let feed = 0;
  let core = 0;
  for (const p of picks) {
    if (kept.length >= max) {
      dropped.push({ ref: p.ref, reason: `over the lane maximum of ${max}` });
    } else if (p.fromFeed && feed >= feedRoom) {
      dropped.push({ ref: p.ref, reason: feedRoom < feedLimit ? `feed limit of ${feedRoom} (room kept for ${reserve} web picks)` : `feed limit of ${feedLimit}` });
    } else if (p.core && core >= limits.max_core_picks) {
      dropped.push({ ref: p.ref, reason: `core-artist limit of ${limits.max_core_picks}` });
    } else {
      kept.push(p.ref);
      if (p.fromFeed) feed++;
      if (p.core) core++;
    }
  }
  return { kept, dropped, feedLimit, thin: kept.length < limits.target[0] };
}
