import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withLock, writeAtomic } from "job-ledger";
import { SPOTIFY_ACCOUNTS, staticAccessToken } from "../config.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** What `login` saves. Mode 0600; never shared with another Spotify client. */
export interface AuthFile {
  version: 1;
  client_id: string;
  access_token: string;
  refresh_token: string;
  /** ISO time the access token expires. */
  expires_at: string;
  scope: string;
  saved_at: string;
  user?: { id: string; display_name?: string };
}

export class AuthError extends Error {
  constructor(message: string) {
    super(`${message} Run \`spotify-discovery-mcp login\` in a terminal.`);
    this.name = "AuthError";
  }
}

export async function readAuth(path: string): Promise<AuthFile | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as AuthFile;
    return value?.refresh_token && value.client_id ? value : null;
  } catch {
    return null;
  }
}

export async function saveAuth(path: string, auth: AuthFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeAtomic(path, JSON.stringify(auth, null, 2) + "\n", 0o600);
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

/** POST to Spotify's token endpoint (PKCE: no client secret). */
export async function tokenRequest(fetchImpl: FetchLike, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchImpl(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    const why = body.error_description || body.error || `HTTP ${res.status}`;
    if (body.error === "invalid_grant" || body.error === "invalid_client") throw new AuthError(`Spotify refused the saved login (${why}).`);
    throw new Error(`Spotify token request failed: ${why}`);
  }
  return body as TokenResponse;
}

/**
 * Hands out a valid access token, refreshing it when it's within a minute of
 * expiring. The refresh happens under a lock and re-reads the file first, so
 * two processes never both spend the same refresh token. A rotated refresh
 * token is saved; otherwise the old one is kept.
 */
export class TokenSource {
  private cached: AuthFile | null = null;

  constructor(
    private readonly path: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async token(force = false): Promise<string> {
    const fixed = staticAccessToken();
    if (fixed) return fixed;
    const fresh = (a: AuthFile | null) => a && Date.parse(a.expires_at) - 60_000 > this.now();
    if (!force && fresh(this.cached)) return this.cached!.access_token;
    let auth = await readAuth(this.path);
    if (!auth) throw new AuthError("Not logged in to Spotify.");
    if (!force && fresh(auth)) {
      this.cached = auth;
      return auth.access_token;
    }
    const seen = auth.access_token;
    auth = await withLock(this.path + ".lock", async () => {
      const current = await readAuth(this.path);
      if (!current) throw new AuthError("Not logged in to Spotify.");
      // Another process refreshed while we waited.
      if (current.access_token !== seen && fresh(current)) return current;
      const t = await tokenRequest(this.fetchImpl, { grant_type: "refresh_token", refresh_token: current.refresh_token, client_id: current.client_id });
      const next: AuthFile = {
        ...current,
        access_token: t.access_token,
        refresh_token: t.refresh_token || current.refresh_token,
        expires_at: new Date(this.now() + t.expires_in * 1000).toISOString(),
        scope: t.scope ?? current.scope,
        saved_at: new Date(this.now()).toISOString(),
      };
      await saveAuth(this.path, next);
      return next;
    }, { waitMs: 30_000 });
    this.cached = auth;
    return auth.access_token;
  }
}
