// Test helpers: a fake Ultrahuman that behaves like the real one where it matters, and a tiny cookie-keeping browser.
import assert from "node:assert/strict";
import { GROUPS, type Group } from "../src/pool/metrics.js";
import { syntheticPerson } from "../src/pool/seed.js";
import type { RingApi } from "../src/ultrahuman/connection.js";

/**
 * Tokens expire, rotate on refresh, and stop working once replaced. Rows carry extra fields the real tools
 * send (a vendor user id, a moving average), so tests can check that only allow-listed fields are stored.
 */
export function fakeRing() {
  const live = new Set<string>();
  const calls: { tool: string; start: string; end: string }[] = [];
  const revoked: string[] = [];
  const refreshes: string[] = [];
  const knobs = { expiresIn: 3600, fail401Once: false, rateLimited: false, refreshRefused: false };
  let n = 0;
  const issue = () => {
    n++;
    live.add(`at-${n}`);
    return { access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: knobs.expiresIn };
  };
  const toolGroup = Object.fromEntries(Object.entries(GROUPS).map(([g, v]) => [v.tool, g as Group]));
  const api: RingApi = {
    register: async () => "client-1",
    authorizeUrl: a => `https://fake-ultrahuman.test/authorize?client_id=${a.clientId}&state=${a.state}`,
    exchange: async a => {
      if (a.code !== "good-code") throw new Error('token 400: {"error":"invalid_grant"}');
      return issue();
    },
    refresh: async (_c, rt) => {
      refreshes.push(rt);
      if (knobs.refreshRefused) throw new Error('token 400: {"error":"invalid_grant"}');
      for (const t of [...live]) live.delete(t); // the old access token stops working
      return issue();
    },
    revoke: async (_c, t) => { revoked.push(t); },
    rows: async (token, tool, args) => {
      if (knobs.rateLimited) throw Object.assign(new Error("rate_limited"), { status: 429, retryAfter: "30" });
      if (knobs.fail401Once || !live.has(token)) {
        knobs.fail401Once = false;
        live.delete(token);
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      }
      calls.push({ tool, start: args.start_date, end: args.end_date });
      return syntheticPerson(1, args.start_date, args.end_date)[toolGroup[tool]].map(r => ({ ...r, user_id: 98765, moving_avg_7d: 1 }));
    },
  };
  return { api, calls, revoked, refreshes, knobs, live };
}

/** Keeps cookies and does not follow redirects, so each hop of a sign-in or connect can be checked. */
export function browser(base: string) {
  const jar = new Map<string, string>();
  const go = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers: Record<string, string> = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(path.startsWith("http") ? path : base + path, { ...init, headers, redirect: "manual", body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const [k, v] = kv.split("=");
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c)) jar.delete(k); else jar.set(k, v);
    }
    return res;
  };
  /** The whole dev sign-in: start, the dev page, and the callback. Returns the final redirect. */
  const signIn = async (name: string, opts: { recheck?: boolean; returnTo?: string } = {}) => {
    const start = await go(`/api/auth/start?${opts.recheck ? "recheck=1&" : ""}return=${encodeURIComponent(opts.returnTo ?? "/home")}`);
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    return go(`/api/auth/callback?state=${state}&iss=dev:local${opts.recheck ? "" : `&dev_name=${name}`}`);
  };
  return { go, signIn, jar };
}
