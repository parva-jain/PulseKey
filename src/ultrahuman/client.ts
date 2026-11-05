import { createHash, randomBytes } from "node:crypto";

const API = "https://api.ultrahuman.com";
const AUTHORIZE = "https://vision.ultrahuman.com/oauth/mcp/authorize";
export const MCP_URL = `${API}/mcp`;
const b64url = (b: Buffer) => b.toString("base64url");

export function newPkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()), state: b64url(randomBytes(24)) };
}

export async function registerClient(name: string, redirectUri: string): Promise<string> {
  const r = await fetch(`${API}/api/mcp/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  if (!r.ok) throw new Error(`register ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return ((await r.json()) as { client_id: string }).client_id;
}

export function authorizeUrl(a: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string }) {
  const u = new URL(AUTHORIZE);
  for (const [k, v] of Object.entries({ client_id: a.clientId, redirect_uri: a.redirectUri, response_type: "code", scope: a.scope, state: a.state, code_challenge: a.challenge, code_challenge_method: "S256", resource: MCP_URL })) u.searchParams.set(k, v);
  return u.toString();
}

export type Tokens = { access_token: string; refresh_token?: string; expires_in: number };

async function tokenRequest(fields: Record<string, string>): Promise<Tokens> {
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, resource: MCP_URL }) });
  if (!r.ok) throw new Error(`token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as Tokens;
}
export const exchangeCode = (a: { clientId: string; redirectUri: string; code: string; verifier: string }) =>
  tokenRequest({ grant_type: "authorization_code", client_id: a.clientId, redirect_uri: a.redirectUri, code: a.code, code_verifier: a.verifier });
export const refreshTokens = (clientId: string, refreshToken: string) =>
  tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
export async function revokeToken(clientId: string, token: string) {
  const r = await fetch(`${API}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, token }) });
  return r.status;
}

let rpcId = 0;
async function rpc(accessToken: string, method: string, params: unknown) {
  const r = await fetch(MCP_URL, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const text = await r.text();
  if (r.status === 429) throw Object.assign(new Error("rate_limited"), { retryAfter: r.headers.get("retry-after") });
  if (!r.ok) throw new Error(`mcp ${r.status}: ${text.slice(0, 200)}`);
  const json = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
  const msg = JSON.parse(json);
  if (msg.error) throw new Error(`mcp error: ${JSON.stringify(msg.error).slice(0, 200)}`);
  return msg.result;
}
export const initialize = (t: string) => rpc(t, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health-data-pool", version: "0.1.0" } });
export const listTools = (t: string) => rpc(t, "tools/list", {});
export const callTool = (t: string, name: string, args: Record<string, unknown>) => rpc(t, "tools/call", { name, arguments: args });

// Verified live: rows are a JSON array in the second text item, and `_meta` holds the timezone, which must not be stored.
export function rowsOf<T = Record<string, unknown>>(result: { isError?: boolean; content?: { type: string; text?: string }[] }): T[] {
  if (result.isError) throw new Error("tool_error");
  for (const c of result.content ?? []) {
    if (c.type !== "text" || !c.text) continue;
    try {
      const parsed = JSON.parse(c.text);
      if (Array.isArray(parsed)) return parsed as T[];
    } catch {
      // The first text item is a plain summary, which we never store.
    }
  }
  return [];
}

// Allow-lists: only these fields survive ingest, so notes, statuses and vendor IDs are dropped.
export const TOOL_FIELDS = {
  get_sleep_summary: ["total_sleep_minutes", "deep_sleep_minutes", "rem_sleep_minutes", "light_sleep_minutes", "awake_minutes", "sleep_efficiency", "sleep_score", "toss_turn_count"],
  get_hrv_trend: ["hrv_rmssd_ms"],
  get_resting_hr: ["bpm"],
  get_recovery_score: ["recovery_score"],
  get_body_signals: ["temperature_deviation_score"],
} as const;

export function pickFields(row: Record<string, unknown>, fields: readonly string[]) {
  const out: Record<string, number> = {};
  for (const f of fields) if (typeof row[f] === "number") out[f] = row[f] as number;
  return { date: String(row.date), values: out };
}
