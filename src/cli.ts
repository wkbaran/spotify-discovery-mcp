#!/usr/bin/env node
import { readAuth, TokenSource } from "./auth/tokens.js";
import { login } from "./auth/login.js";
import { authPath, DEFAULT_REDIRECT_URI, discoveryDir } from "./config.js";
import { discoveryStatus } from "./discovery/finish.js";
import { importLegacy } from "./discovery/import.js";
import { pendingReports } from "./discovery/report.js";
import { serve } from "./server.js";
import { SpotifyClient } from "./spotify/client.js";
import { VERSION } from "./version.js";

const HELP = `spotify-discovery-mcp ${VERSION} — runs genre lanes of a Spotify discovery playlist for an agent

Usage:
  spotify-discovery-mcp                       Run the MCP server over stdio
  spotify-discovery-mcp login                 Log in to Spotify (PKCE) and save tokens
      --client-id <id>                        Spotify app client id (or SPOTIFY_DISCOVERY_CLIENT_ID)
      --redirect-uri <uri>                    Must be registered on the app (default ${DEFAULT_REDIRECT_URI})
      --paste                                 Paste the redirected URL instead of running a local listener
  spotify-discovery-mcp status                Check the login and show each lane's state
  spotify-discovery-mcp import <legacy-dir>   Seed history.json from recommendation_history.json and today_playlist.json
  spotify-discovery-mcp report                Print finished lane reports not printed yet, and runs that never finished
      --stall-minutes <n>                     When an unfinished run counts as stalled (default 90)
      --mark-only                             Mark what's due as printed, without printing it

Environment:
  SPOTIFY_DISCOVERY_DIR    Data directory (lanes.json and the state files). Required for the tools.
  SPOTIFY_DISCOVERY_AUTH   Token file (default: $SPOTIFY_DISCOVERY_DIR/auth.json)
  SPOTIFY_DISCOVERY_TZ     Overrides lanes.json's timezone
  SPOTIFY_DISCOVERY_METADATA  off (default), or any of beatport, soundcloud, deezer
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? (rest[i + 1] && !rest[i + 1]!.startsWith("--") ? rest[i + 1] : "true") : undefined;
  };
  switch (cmd) {
    case undefined:
    case "serve":
      await serve();
      return -1;
    case "login": {
      const existing = await readAuth(authPath());
      const clientId = flag("client-id") ?? process.env.SPOTIFY_DISCOVERY_CLIENT_ID ?? existing?.client_id;
      if (!clientId) {
        console.error("Give the Spotify app's client id with --client-id (or SPOTIFY_DISCOVERY_CLIENT_ID).");
        return 2;
      }
      const auth = await login({
        clientId,
        redirectUri: flag("redirect-uri") ?? process.env.SPOTIFY_DISCOVERY_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
        authPath: authPath(),
        paste: flag("paste") === "true",
        timeoutMs: 300_000,
      });
      console.error(`Logged in${auth.user ? ` as ${auth.user.display_name ?? auth.user.id}` : ""}. Saved ${authPath()}.`);
      return 0;
    }
    case "status": {
      try {
        const client = new SpotifyClient(new TokenSource(authPath()));
        const me = await client.request<{ id: string; display_name?: string }>("GET", "/me");
        console.log(`Spotify: logged in as ${me.display_name ?? me.id} (${authPath()})`);
      } catch (err) {
        console.log(`Spotify: ${err instanceof Error ? err.message : String(err)}`);
      }
      const dir = discoveryDir();
      console.log(dir ? await discoveryStatus(dir) : "SPOTIFY_DISCOVERY_DIR isn't set.");
      return 0;
    }
    case "import": {
      const dir = discoveryDir();
      if (!dir || !rest[0]) {
        console.error("Usage: SPOTIFY_DISCOVERY_DIR=… spotify-discovery-mcp import <dir with recommendation_history.json>");
        return 2;
      }
      console.log(await importLegacy(dir, rest[0]));
      return 0;
    }
    case "report": {
      const dir = discoveryDir();
      if (!dir) {
        console.error("SPOTIFY_DISCOVERY_DIR isn't set.");
        return 2;
      }
      const out = await pendingReports(dir, { stallMinutes: Number(flag("stall-minutes") ?? 90), windowHours: 24, markOnly: flag("mark-only") === "true" });
      if (out) console.log(out);
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
