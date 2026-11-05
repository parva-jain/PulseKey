// Live World test. Open PUBLIC_BASE_URL in a browser and follow the links. Saves acr, amr and timing, and only a hash of sub.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { Blocked, finishCheck, newAttempt, startCheck, worldConfig, type Attempt } from "../src/world/oidc.js";

const BASE = process.env.PUBLIC_BASE_URL!;
const redirectUri = `${BASE}/auth/world/callback`;
const config = await worldConfig();
console.log("issuer", config.serverMetadata().issuer);
const results: any = { issuer: config.serverMetadata().issuer, redirectUri, runs: [] };
const save = () => writeFileSync("test-results/world.json", JSON.stringify(results, null, 2));
const pending = new Map<string, { scenario: string; attempt: Attempt }>();
let account: { sub: string; iss: string } | null = null;
const hash = (s?: string) => s ? createHash("sha256").update(s).digest("hex").slice(0, 12) : null;
const page = (body: string) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><body style="font:16px system-ui;max-width:640px;margin:24px auto;padding:0 16px">${body}<p><a href="/">Back to test list</a></p>`;
const record = (scenario: string, outcome: string, claims?: any, extra?: object) => {
  results.runs.push({ scenario, outcome, acr: claims?.acr, amr: claims?.amr, ageS: claims?.ageS, sub: hash(claims?.sub), at: new Date().toISOString(), ...extra });
  save(); console.log(scenario, outcome, JSON.stringify({ acr: claims?.acr, amr: claims?.amr, ageS: claims?.ageS }));
};

createServer(async (req, res) => {
  const u = new URL(req.url!, BASE);
  res.setHeader("content-type", "text/html");
  try {
    if (u.pathname === "/") return void res.end(page(`<h2>World test</h2><p>Signed up: ${account ? "yes" : "no"}</p><ol>
      <li><a href="/start/signup">Sign up</a>: complete the check</li>
      <li><a href="/start/fresh">Fresh check</a>: complete it again; a new proof is required</li>
      <li><a href="/start/cancel">Cancel at World</a>: reject or cancel on World's screen, then come back here</li>
      <li><a href="/start/ourcancel">Our Cancel button</a>: leave World's page open, then press cancel on the next page</li>
      <li><a href="/start/expire">Expiry</a>: wait over 60 seconds before completing the check</li></ol>
      <p>Attempts still pending: ${[...pending.values()].map((p) => p.scenario).join(", ") || "none"}</p>`));
    if (u.pathname.startsWith("/start/")) {
      const scenario = u.pathname.split("/")[2];
      const attempt = newAttempt({ fresh: true, expectedSub: scenario === "signup" ? null : account?.sub ?? null, expectedIss: account?.iss ?? null });
      if (scenario === "expire") attempt.createdAt -= 540; // expires 60 seconds from now
      pending.set(attempt.state, { scenario, attempt });
      const url = await startCheck(config, redirectUri, attempt);
      if (scenario === "ourcancel") return void res.end(page(`<p><a target=_blank href="${url}">Open World in a new tab</a>, then <a href="/cancel/${attempt.state}">press Cancel</a>. Going back and finishing at World afterwards must fail.</p>`));
      res.statusCode = 302; res.setHeader("location", url); return void res.end();
    }
    if (u.pathname.startsWith("/cancel/")) {
      const state = u.pathname.split("/")[2], p = pending.get(state);
      if (p) { pending.delete(state); record(p.scenario, "cancelled_by_app"); }
      return void res.end(page("<p>Cancelled. The protected action did not run.</p>"));
    }
    if (u.pathname === "/auth/world/callback") {
      const state = u.searchParams.get("state") ?? "", p = pending.get(state);
      if (!p) { record("unknown", "blocked_no_pending_attempt", undefined, { error: u.searchParams.get("error") }); return void res.end(page("<p>Blocked: no pending attempt, which is correct after a cancel.</p>")); }
      pending.delete(state);
      try {
        const claims = await finishCheck(config, u, p.attempt);
        if (p.scenario === "signup") account = { sub: claims.sub!, iss: claims.iss! };
        record(p.scenario, "passed", claims);
        return void res.end(page(`<p>Passed: ${p.scenario}. The protected action would run now.</p><pre>${JSON.stringify({ acr: claims.acr, amr: claims.amr, ageS: claims.ageS })}</pre>`));
      } catch (e: any) {
        record(p.scenario, `blocked: ${e instanceof Blocked ? e.message : String(e.message).slice(0, 200)}`, e.claims, { error: u.searchParams.get("error"), description: u.searchParams.get("error_description")?.slice(0, 200) });
        return void res.end(page(`<p>Blocked: ${p.scenario}. The protected action did not run. Reason: ${e.message}</p>`));
      }
    }
    res.statusCode = 404; res.end();
  } catch (e: any) { res.statusCode = 500; res.end(page(`<p>Error: ${String(e.message).slice(0, 200)}</p>`)); }
}).listen(3000, () => console.log("ready"));
