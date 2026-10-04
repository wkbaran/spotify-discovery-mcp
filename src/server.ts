import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TokenSource, type FetchLike } from "./auth/tokens.js";
import { authPath, discoveryDir, metadataSources } from "./config.js";
import type { Ctx } from "./discovery/begin.js";
import { httpsGet } from "./metadata/lookup.js";
import { SpotifyClient } from "./spotify/client.js";
import { registerTools, text } from "./tools.js";
import { VERSION } from "./version.js";

/**
 * `fetchImpl` is for Spotify; `pageFetch` is for the metadata pages (Beatport,
 * SoundCloud), which need plain node:https requests.
 */
export function createServer(opts: { dir?: string; fetchImpl?: FetchLike; pageFetch?: FetchLike; client?: SpotifyClient; now?: () => Date } = {}): McpServer {
  const dir = opts.dir ?? discoveryDir();
  const server = new McpServer(
    { name: "spotify-discovery", version: VERSION },
    {
      instructions: dir
        ? "Runs one genre lane of a Spotify discovery playlist. A run is: discovery_begin(lane), web research by a subagent, verify_tracks(lane, text = the research reply unchanged), " +
          "then discovery_finish(lane, picks = refs best first). Reply with exactly the text after discovery_finish's ===== REPORT line. You never handle URIs, files or the playlist yourself."
        : "SPOTIFY_DISCOVERY_DIR isn't set, so the discovery tools are off.",
    },
  );
  if (!dir) {
    server.registerTool("discovery_status", { description: "Explains why the discovery tools are missing." }, () => text("SPOTIFY_DISCOVERY_DIR isn't set in this server's environment."));
    return server;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let client = opts.client;
  const ctx = async (): Promise<Ctx> => {
    client ??= new SpotifyClient(new TokenSource(authPath(), fetchImpl), fetchImpl);
    return { client, dir, fetchImpl: opts.pageFetch ?? httpsGet, metadata: metadataSources(), now: opts.now };
  };
  registerTools(server, ctx, dir);
  return server;
}

export async function serve(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
