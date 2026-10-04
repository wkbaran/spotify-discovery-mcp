import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AuthError } from "./auth/tokens.js";
import { discoveryBegin, type Ctx } from "./discovery/begin.js";
import { discoveryFinish, discoveryStatus, forget, markRecommended, verifyTracks } from "./discovery/finish.js";

export function text(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }] };
}

export function errorText(t: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: t }] };
}

/** Run a tool body, turning a thrown error into one plain line. */
export async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorText(err instanceof AuthError ? `Spotify login needed: ${message} Report this in your reply; don't retry.` : `Error: ${message}`);
  }
}

/** Accept a JSON string where an array or object is expected; weaker models send them that way. */
function lenient<T extends z.ZodType>(schema: T, splitStrings = true) {
  return z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const s = v.trim();
    if (!s) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return splitStrings ? s.split(/[\s,]+/).filter(Boolean) : v;
    }
  }, schema);
}

const lane = z.string().min(1).describe('The lane id from lanes.json, e.g. "a-dnb".');
const local = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

export function registerTools(server: McpServer, ctx: () => Promise<Ctx>, dir: string): void {
  server.registerTool(
    "discovery_begin",
    {
      title: "Start a lane run",
      description:
        "Step 1 of a lane run. Finds or creates today's playlist, fetches new releases from the lane's known labels and artists, drops anything already recommended, " +
        "and returns the lane brief plus a list with refs: K (new from known sources) and C (carried over). Call once per run.",
      inputSchema: { lane },
      annotations: { ...local, idempotentHint: false },
    },
    (args) => run(async () => text((await discoveryBegin(await ctx(), args.lane)).view)),
  );

  server.registerTool(
    "verify_tracks",
    {
      title: "Check web finds on Spotify",
      description:
        "Step 2. Checks the research's tracks on Spotify (exact artist and title, the right release, the real label), drops ones already recommended, " +
        "and gives each a W ref. Pass the research reply unchanged as `text`; don't retype it. Lines look like: artist | track | release | label | date | why | URL. " +
        "Lines starting `LABEL |` record newly found labels.",
      inputSchema: {
        lane,
        text: z.string().optional().describe("The research subagent's reply, unchanged."),
        candidates: lenient(
          z.array(
            z.object({
              artist: z.string(),
              track: z.string(),
              release: z.string().optional(),
              label: z.string().optional(),
              released: z.string().optional(),
              why: z.string().optional(),
              source_url: z.string().optional(),
            }),
          ),
          false,
        )
          .optional()
          .describe("Alternative to text: the same fields as objects."),
      },
      annotations: { ...local, idempotentHint: true },
    },
    (args) => run(async () => text(await verifyTracks(await ctx(), args.lane, { text: args.text, candidates: args.candidates }))),
  );

  server.registerTool(
    "discovery_finish",
    {
      title: "Finish a lane run",
      description:
        "Step 3. Give your picks as refs (K, C or W), best first. The server applies the lane's limits (dropping from the end of your list), adds the tracks to today's playlist, " +
        "saves all state, and returns the report. Reply with exactly the text after the ===== REPORT line. Safe to repeat: a second call changes nothing.",
      inputSchema: {
        lane,
        picks: lenient(z.array(z.string()).max(30)).default([]).describe("Refs, best first, e.g. [\"W2\", \"K1\", \"W5\"]."),
        why: lenient(z.record(z.string(), z.string()), false)
          .optional()
          .describe('Optional short reasons for K/C picks, quoted or attributed to a text source: {"K1": "Critical: \'acid-tipped breakbeats\'"}. W picks already have theirs.'),
        reject: lenient(z.array(z.string())).default([]).describe("Refs that don't fit this lane at all; they won't be offered again."),
        thin: z.boolean().default(false).describe("True if the research came back limited."),
        dry_run: z.boolean().default(false).describe("Show the report without adding or saving anything."),
      },
      annotations: { ...local, idempotentHint: true },
    },
    (args) =>
      run(async () => {
        const r = await discoveryFinish(await ctx(), args.lane, args);
        return r.ok ? text(r.text) : errorText(r.text);
      }),
  );

  server.registerTool(
    "discovery_status",
    {
      title: "Discovery status",
      description: "Read-only: today's playlist, each lane's last run, pool, pending finds and learned labels, and core artists in no lane.",
      inputSchema: { lane: z.string().optional().describe("Just this lane.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(async () => text(await discoveryStatus(dir, args.lane))),
  );

  server.registerTool(
    "mark_recommended",
    {
      title: "Mark tracks as recommended",
      description: "Repair tool: add tracks to the history so they're never suggested. Only use when asked.",
      inputSchema: {
        lane,
        tracks: lenient(z.array(z.string()).min(1).max(100), false).describe('"Artist — Title" or Spotify track links.'),
      },
      annotations: { ...local, idempotentHint: true },
    },
    (args) => run(async () => text(await markRecommended(await ctx(), args.lane, args.tracks))),
  );

  server.registerTool(
    "forget",
    {
      title: "Forget a learned label or artist",
      description: "Repair tool: remove a label or artist the lane learned. Seed labels and artists are edited in lanes.json instead. Only use when asked.",
      inputSchema: { lane, label: z.string().optional(), artist: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(async () => text(await forget(dir, args.lane, args))),
  );
}
