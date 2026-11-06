// connection: a person's data source (their Ultrahuman ring, or labelled sample data) and the ring's OAuth tokens.
// Tokens are sealed with the person's key, refreshed under a per-person lock, and written before they are used,
// because Ultrahuman rotates refresh tokens and a lost new one means reconnecting.
import type { Db } from "../db/index.js";
import { openTokens, sealTokens } from "../pool/crypto.js";
import { Refused } from "../pool/query.js";
import { personKey } from "../pool/store.js";
import { authorizeUrl, callTool, exchangeCode, refreshTokens, registerClient, revokeToken, rowsOf, type Tokens } from "./client.js";

export const RING_SCOPE = "sleep:read cardio:read";
const REFRESH_EARLY_MS = 5 * 60_000;

/** Everything the app needs from Ultrahuman. The real client in production, a fake in tests. */
export type RingApi = {
  register(redirectUri: string): Promise<string>;
  authorizeUrl(a: { clientId: string; redirectUri: string; state: string; challenge: string }): string;
  exchange(a: { clientId: string; redirectUri: string; code: string; verifier: string }): Promise<Tokens>;
  refresh(clientId: string, refreshToken: string): Promise<Tokens>;
  revoke(clientId: string, token: string): Promise<void>;
  /** One tool call's rows. Throws errors with status 401 or 429 (and retryAfter) from the MCP server. */
  rows(accessToken: string, tool: string, args: { start_date: string; end_date: string }): Promise<Record<string, unknown>[]>;
};

export const ultrahuman: RingApi = {
  register: redirectUri => registerClient("PulseKey", redirectUri),
  authorizeUrl: a => authorizeUrl({ ...a, scope: RING_SCOPE }),
  exchange: exchangeCode,
  refresh: refreshTokens,
  revoke: async (clientId, token) => { await revokeToken(clientId, token); },
  rows: async (token, tool, args) => rowsOf(await callTool(token, tool, args)),
};

/** One public client per redirect URI, registered once and kept across restarts. */
export async function ringClientId(db: Db, api: RingApi, redirectUri: string) {
  const key = `ultrahuman_client:${redirectUri}`;
  const { rows } = await db.query<{ value: string }>("SELECT value FROM app_config WHERE key = $1", [key]);
  if (rows[0]) return rows[0].value;
  const id = await api.register(redirectUri);
  await db.query("INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [key, id]);
  return id;
}

export type Connection = { source: "ultrahuman" | "sample"; status: "active" | "needs_reconnect"; clientId: string | null; lastSyncAt: Date | null; lastSync: unknown };

export async function getConnection(db: Db, personId: string): Promise<Connection | null> {
  const { rows } = await db.query<{ source: Connection["source"]; status: Connection["status"]; client_id: string | null; last_sync_at: Date | null; last_sync: unknown }>(
    "SELECT source, status, client_id, last_sync_at, last_sync FROM connections WHERE contributor_id = $1", [personId]);
  const r = rows[0];
  return r ? { source: r.source, status: r.status, clientId: r.client_id, lastSyncAt: r.last_sync_at, lastSync: r.last_sync } : null;
}

type Stored = { access_token: string; refresh_token?: string };

async function writeTokens(db: Db, kek: Buffer, personId: string, clientId: string, t: Tokens, keepRefresh?: string) {
  const key = await personKey(db, kek, personId);
  const stored: Stored = { access_token: t.access_token, refresh_token: t.refresh_token ?? keepRefresh };
  const { iv, blob } = sealTokens(key, personId, stored);
  await db.query(
    `INSERT INTO connections (contributor_id, source, client_id, tokens_iv, tokens_blob, expires_at, status)
     VALUES ($1, 'ultrahuman', $2, $3, $4, now() + make_interval(secs => $5), 'active')
     ON CONFLICT (contributor_id) DO UPDATE SET source = 'ultrahuman', client_id = $2, tokens_iv = $3, tokens_blob = $4,
       expires_at = now() + make_interval(secs => $5), status = 'active'`,
    [personId, clientId, iv, blob, t.expires_in]);
}

async function readTokens(db: Db, kek: Buffer, personId: string) {
  const { rows } = await db.query<{ client_id: string; tokens_iv: Uint8Array; tokens_blob: Uint8Array; expires_at: Date; status: string }>(
    "SELECT client_id, tokens_iv, tokens_blob, expires_at, status FROM connections WHERE contributor_id = $1 AND source = 'ultrahuman'", [personId]);
  const r = rows[0];
  if (!r) return null;
  const t = openTokens<Stored>(await personKey(db, kek, personId), personId, r.tokens_iv, r.tokens_blob);
  return { ...t, clientId: r.client_id, expiresAt: r.expires_at, status: r.status };
}

/** Replaces any earlier source. A replaced ring connection has its old token revoked. */
export async function connectRing(db: Db, kek: Buffer, api: RingApi, personId: string, clientId: string, tokens: Tokens) {
  const old = await readTokens(db, kek, personId).catch(() => null);
  await writeTokens(db, kek, personId, clientId, tokens);
  if (old?.refresh_token || old?.access_token) await api.revoke(old.clientId, (old.refresh_token ?? old.access_token)!).catch(() => {});
}

/** Sample data is a source like the ring, so it goes through the same grant checks and the same storage. */
export async function connectSample(db: Db, kek: Buffer, api: RingApi, personId: string) {
  await disconnect(db, kek, api, personId);
  await db.query("INSERT INTO connections (contributor_id, source) VALUES ($1, 'sample')", [personId]);
}

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(id: string, f: () => Promise<T>): Promise<T> {
  const run = (locks.get(id) ?? Promise.resolve()).then(f, f);
  locks.set(id, run.catch(() => {}));
  return run;
}

/**
 * A usable access token: refreshed when it is near expiry, or when forced after a 401. A refused refresh
 * marks the connection needs_reconnect, and syncing stops until the person connects again.
 */
export function accessToken(db: Db, kek: Buffer, api: RingApi, personId: string, opts: { force?: boolean; stale?: string } = {}) {
  return withLock(personId, async () => {
    const t = await readTokens(db, kek, personId);
    if (!t) throw new Refused("not_connected", 409);
    if (t.status === "needs_reconnect") throw new Refused("ring_needs_reconnect", 409);
    // Another caller may have refreshed while this one waited: only a token still equal to the stale one needs a new refresh.
    const forced = opts.force && (!opts.stale || opts.stale === t.access_token);
    if (!forced && t.expiresAt.getTime() - Date.now() > REFRESH_EARLY_MS) return t.access_token;
    if (!t.refresh_token) {
      await db.query("UPDATE connections SET status = 'needs_reconnect' WHERE contributor_id = $1", [personId]);
      throw new Refused("ring_needs_reconnect", 409);
    }
    let fresh: Tokens;
    try {
      fresh = await api.refresh(t.clientId, t.refresh_token);
    } catch (e) {
      if (/invalid_grant|invalid_token|400|401/.test(String((e as Error)?.message))) {
        await db.query("UPDATE connections SET status = 'needs_reconnect' WHERE contributor_id = $1", [personId]);
        throw new Refused("ring_needs_reconnect", 409);
      }
      throw e;
    }
    await writeTokens(db, kek, personId, t.clientId, fresh, t.refresh_token);
    return fresh.access_token;
  });
}

/** Revokes at Ultrahuman (best effort) and forgets the source. Records stay; the grant decides their use. */
export async function disconnect(db: Db, kek: Buffer, api: RingApi, personId: string) {
  const t = await readTokens(db, kek, personId).catch(() => null);
  if (t) await api.revoke(t.clientId, (t.refresh_token ?? t.access_token)).catch(() => {});
  await db.query("DELETE FROM connections WHERE contributor_id = $1", [personId]);
  return !!t;
}
