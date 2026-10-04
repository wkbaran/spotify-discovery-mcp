# Agent notes

Common mistakes and confusion points in this project. Add to this list when something surprises you.

- **Status: design only.** README.md and docs/ describe the server; the code isn't written yet. Keep the docs and the code in agreement as it's built, especially the pick rules in the README, which the user asked to have explained clearly.
- **The user is the reader of the README; a weak local model (Qwen 27B on Ollama) is the reader of tool results and descriptions.** Write tool results as short plain text with refs. Never return JSON or raw Spotify objects.
- **Read docs/spotify-api.md before calling Spotify.** Development Mode lost a lot in February 2026: search `limit` is at most 10, `/playlists/{id}/tracks` is 403 (use `/items`, whose entries are under `item`), and album `label`, artist `genres`, `popularity`, related artists, recommendations and new releases are gone. `label:` and `tag:new` search filters still work.
- **Spotify auth is this server's own** (its own grant and refresh token, in its own file). Never read or refresh Hermes's `/opt/data/auth.json`, so the two can't invalidate each other's tokens.
- **Testing against the real account:** creating playlists and adding tracks changes the user's Spotify. Use a clearly named test playlist and delete it afterwards, or ask first. Reads are fine.
- **job-ledger is a local dependency** (`file:../job-ledger`). Hermes deploys copy only `dist/`, `package.json` and `package-lock.json`, so the build must bundle job-ledger into `dist/` (esbuild) before the first deploy; the plain `tsc` build won't work on Hermes.
- **MCP over stdio:** stdout is the protocol channel in server mode. Use `console.error` for logs.
- **Hermes specifics** (from medium-reader-mcp's notes): Hermes pauses an MCP server for 60 s after 3 consecutive error results, so be lenient (fix what you can, warn, and only error when nothing sensible can be done). The MCP tool timeout is 300 s. Array arguments should also accept a JSON string, because weaker models send them that way.
- TypeScript is 7.x, the native compiler. If vitest fails with `Cannot find native binding` (rolldown), delete `node_modules` and `package-lock.json` and run `npm install` again.
