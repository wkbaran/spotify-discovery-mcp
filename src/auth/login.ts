import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { SCOPES, SPOTIFY_ACCOUNTS, SPOTIFY_API } from "../config.js";
import { saveAuth, tokenRequest, type AuthFile, type FetchLike } from "./tokens.js";

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(64));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    code_challenge_method: "S256",
    code_challenge: opts.challenge,
    state: opts.state,
    scope: SCOPES.join(" "),
  });
  return `${SPOTIFY_ACCOUNTS}/authorize?${q}`;
}

/** Pull `code` out of the URL Spotify redirected to, checking `state`. */
export function codeFromRedirect(url: string, state: string): string {
  const u = new URL(url.trim());
  const err = u.searchParams.get("error");
  if (err) throw new Error(`Spotify login was refused: ${err}`);
  if (u.searchParams.get("state") !== state) throw new Error("The redirect's state doesn't match this login attempt; start again.");
  const code = u.searchParams.get("code");
  if (!code) throw new Error("No ?code= in that URL.");
  return code;
}

/** Wait for Spotify to redirect the browser to the loopback URI. */
function waitForRedirect(redirectUri: string, state: string, timeoutMs: number): Promise<string> {
  const target = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== target.pathname) {
        res.writeHead(404).end();
        return;
      }
      try {
        const code = codeFromRedirect(url.toString(), state);
        res.writeHead(200, { "Content-Type": "text/plain" }).end("Logged in. You can close this tab.");
        clearTimeout(timer);
        server.close();
        resolve(code);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err));
        clearTimeout(timer);
        server.close();
        reject(err);
      }
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the browser. Try again, or use --paste."));
    }, timeoutMs);
    server.on("error", reject);
    server.listen(Number(target.port || 80), target.hostname);
  });
}

export interface LoginOptions {
  clientId: string;
  redirectUri: string;
  authPath: string;
  /** Paste the redirected URL instead of running a loopback server (headless hosts). */
  paste: boolean;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export async function login(opts: LoginOptions): Promise<AuthFile> {
  const f = opts.fetchImpl ?? fetch;
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));
  const url = authorizeUrl({ clientId: opts.clientId, redirectUri: opts.redirectUri, state, challenge });
  console.error(`Open this URL in a browser and approve access:\n\n  ${url}\n`);

  let code: string;
  if (opts.paste) {
    console.error("After approving, the browser goes to a page that won't load. Copy that page's full URL from the address bar and paste it here.");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      code = codeFromRedirect(await rl.question("Redirected URL: "), state);
    } finally {
      rl.close();
    }
  } else {
    console.error(`Waiting for the redirect to ${opts.redirectUri} …`);
    code = await waitForRedirect(opts.redirectUri, state, opts.timeoutMs);
  }

  const t = await tokenRequest(f, { grant_type: "authorization_code", code, redirect_uri: opts.redirectUri, client_id: opts.clientId, code_verifier: verifier });
  if (!t.refresh_token) throw new Error("Spotify didn't return a refresh token.");
  const me = await f(`${SPOTIFY_API}/me`, { headers: { Authorization: `Bearer ${t.access_token}` } })
    .then((r) => (r.ok ? (r.json() as Promise<{ id: string; display_name?: string }>) : null))
    .catch(() => null);
  const now = Date.now();
  const auth: AuthFile = {
    version: 1,
    client_id: opts.clientId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(now + t.expires_in * 1000).toISOString(),
    scope: t.scope ?? SCOPES.join(" "),
    saved_at: new Date(now).toISOString(),
    user: me ? { id: me.id, display_name: me.display_name } : undefined,
  };
  await saveAuth(opts.authPath, auth);
  return auth;
}
