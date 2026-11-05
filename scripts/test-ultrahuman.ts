// Live Ultrahuman login over an HTTPS callback. Saves only field names and types, never health values or tokens, then revokes the token.
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { authorizeUrl, callTool, exchangeCode, initialize, listTools, newPkce, registerClient, revokeToken } from "../src/ultrahuman/client.js";

if (!process.env.PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL is not set");
const redirectUri = `${process.env.PUBLIC_BASE_URL}/auth/ultrahuman/callback`;
const scope = "sleep:read cardio:read";
const clientId = await registerClient("health-data-pool-dev", redirectUri);
console.log("registered_https_redirect", redirectUri);
const { verifier, challenge, state } = newPkce();
const loginUrl = authorizeUrl({ clientId, redirectUri, scope, state, challenge });
writeFileSync("test-results/login-url.txt", loginUrl);
console.log("LOGIN_URL", loginUrl);

const shape = (v: unknown): unknown => Array.isArray(v) ? { array: v.length, item: v.length ? shape(v[0]) : null }
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url!, process.env.PUBLIC_BASE_URL);
    if (u.pathname !== "/auth/ultrahuman/callback") { res.statusCode = 404; return void res.end(); }
    const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
    res.setHeader("content-type", "text/plain");
    res.end(ok ? "Connected. You can close this tab." : "Login failed. You can close this tab.");
    server.close();
    ok ? resolve(u.searchParams.get("code")!) : reject(new Error(`callback error ${u.searchParams.get("error")}`));
  }).listen(3000);
  setTimeout(() => reject(new Error("timed out waiting for login")), 15 * 60_000).unref();
});
console.log("callback_received");
const tokens = await exchangeCode({ clientId, redirectUri, code, verifier });
console.log("token", JSON.stringify({ expires_in: tokens.expires_in, has_refresh: !!tokens.refresh_token }));
const t = tokens.access_token;
const out: Record<string, unknown> = { redirectUri, scope, serverInfo: (await initialize(t)).serverInfo };
const tools = (await listTools(t)).tools as { name: string; inputSchema?: { properties?: object; required?: string[] } }[];
out.tools = tools.map((x) => ({ name: x.name, params: Object.keys(x.inputSchema?.properties ?? {}), required: x.inputSchema?.required }));
const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10), start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
for (const name of ["get_sleep_summary", "get_hrv_trend", "get_resting_hr", "get_recovery_score", "get_body_signals"]) {
  try {
    const r = await callTool(t, name, { start_date: start, end_date: end });
    const parsed = (r.content ?? []).map((c: any) => { try { return { type: c.type, json: shape(JSON.parse(c.text)) }; } catch { return { type: c.type, textLength: c.text?.length }; } });
    out[name] = { isError: r.isError, resultKeys: Object.keys(r), structured: shape(r.structuredContent), meta: shape(r._meta ?? r.meta), content: parsed };
  } catch (e: any) { out[name] = { failed: String(e.message).slice(0, 200) }; }
}
writeFileSync("test-results/ultrahuman-shapes.json", JSON.stringify(out, null, 2));
console.log("saved_shapes", (out.tools as unknown[]).length, "tools");
console.log("revoke_status", await revokeToken(clientId, tokens.refresh_token ?? t));
process.exit(0);
