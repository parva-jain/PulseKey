// Ring connect and sync over HTTP against a fake Ultrahuman: OAuth hops, sealed tokens, granted tools only,
// allow-listed fields only, refresh and 401 handling, rate limits, sample data, and revocation on the way out.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

process.env.MIN_GROUP = "3"; // small pools, so the synthetic share of an answer can be checked exactly
const { openDb } = await import("../src/db/index.js");
const { createContributorApi } = await import("../src/api/contributor.js");
const { devIdentity } = await import("../src/identity/index.js");
const { openRecord } = await import("../src/pool/crypto.js");
const { seedPool } = await import("../src/pool/seed.js");
const { addDays, iso, personKey, today } = await import("../src/pool/store.js");
const q = await import("../src/pool/query.js");
const { syncDue } = await import("../src/ultrahuman/sync.js");
const { browser: makeBrowser, fakeRing } = await import("./helpers.js");

const kek = randomBytes(32);
const db = await openDb();
const ring = fakeRing();
const app = express();
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const chain = { createAccount: async () => ({ accountId: "0.0.1", tx: "t" }), sendUsdc: async () => ({ tx: "t" }) };
app.use("/api", createContributorApi(db, kek, { identity: devIdentity(base), chain, ring: ring.api, baseUrl: base }));
after(() => server.close());

const idOf = async (b: ReturnType<typeof makeBrowser>) => {
  const token = b.jar.get("pk_session")!;
  const { createHash } = await import("node:crypto");
  return (await db.query<{ contributor_id: string }>("SELECT contributor_id FROM sessions WHERE token_hash = $1", [createHash("sha256").update(token).digest("hex")])).rows[0].contributor_id;
};

/** Signs in, shares sleep and HRV for 60 days, and connects the fake ring through the full OAuth hop. */
async function connected(name: string) {
  const b = makeBrowser(base);
  await b.signIn(name);
  await b.go("/api/me/grant", { method: "PUT", json: { groups: ["sleep", "hrv"], historyDays: 60, validDays: 30 } });
  const start = await b.go("/api/ring/connect?return=/connect");
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get("location")!);
  assert.equal(to.host, "fake-ultrahuman.test");
  const cb = await b.go(`/api/ring/callback?state=${to.searchParams.get("state")}&code=good-code`);
  return { b, cb, id: await idOf(b) };
}

test("connect: OAuth hop, sealed tokens, first sync of granted tools only, allow-listed fields only", async () => {
  ring.calls.length = 0;
  const { b, cb, id } = await connected("ring-1");
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), `${base}/connect?ring=connected`);

  const conn = (await db.query<{ tokens_blob: Uint8Array }>("SELECT tokens_blob FROM connections WHERE contributor_id = $1", [id])).rows[0];
  assert.ok(!Buffer.from(conn.tokens_blob).toString("latin1").includes("at-"), "tokens are sealed, not stored in plain text");

  assert.deepEqual([...new Set(ring.calls.map(c => c.tool))].sort(), ["get_hrv_trend", "get_sleep_summary"], "resting HR and recovery were not granted");
  const status = await (await b.go("/api/ring")).json();
  assert.equal(status.connection.source, "ultrahuman");
  assert.ok(status.stored.sleep.days > 40 && status.stored.hrv.days > 40);
  assert.equal(status.stored.resting_hr, undefined);
  assert.equal(status.stored.sleep.first >= addDays(today(), -60), true, "nothing before the grant's history window");

  const key = await personKey(db, kek, id);
  const rec = (await db.query<{ day: Date; iv: Uint8Array; blob: Uint8Array }>("SELECT day, iv, blob FROM records WHERE contributor_id = $1 AND grp = 'hrv' LIMIT 1", [id])).rows[0];
  assert.deepEqual(Object.keys(openRecord(key, id, iso(rec.day), "hrv", rec.iv, rec.blob)), ["hrv_rmssd_ms"], "vendor user id and extras dropped");
});

test("connect refuses another browser's callback, reuse, and a denied consent", async () => {
  const b = makeBrowser(base);
  await b.signIn("ring-2");
  const start = await b.go("/api/ring/connect");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const other = makeBrowser(base);
  await other.signIn("ring-2-other");
  assert.equal((await other.go(`/api/ring/callback?state=${state}&code=good-code`)).status, 400);
  const denied = await b.go(`/api/ring/callback?state=${state}&error=access_denied`);
  assert.equal(new URL(denied.headers.get("location")!).searchParams.get("ring"), "denied");
  b.jar.set("pk_ring", state);
  assert.equal((await b.go(`/api/ring/callback?state=${state}&code=good-code`)).status, 400, "single use");

  const s2 = new URL((await b.go("/api/ring/connect")).headers.get("location")!).searchParams.get("state")!;
  const mixed = await b.go(`/api/ring/callback?state=${s2}&code=good-code&iss=https://evil.example`);
  assert.equal(new URL(mixed.headers.get("location")!).searchParams.get("ring"), "error", "a code from another issuer is not redeemed");
  assert.equal((await (await b.go("/api/ring")).json()).connection, null);
});

test("sync now: cooldown, re-reads only recent days, refreshes near expiry and after a 401", async () => {
  const { b, id } = await connected("ring-3");
  assert.equal((await b.go("/api/ring/sync", { method: "POST", json: {} })).status, 429, "cooldown right after the first sync");
  await db.query("UPDATE connections SET last_sync_at = now() - interval '1 hour' WHERE contributor_id = $1", [id]);

  ring.calls.length = 0;
  const refreshes0 = ring.refreshes.length;
  ring.knobs.fail401Once = true;
  const s = await b.go("/api/ring/sync", { method: "POST", json: {} });
  assert.equal(s.status, 200);
  assert.equal(ring.calls.length, 2, "one call per granted group");
  assert.ok(ring.calls.every(c => c.start >= addDays(today(), -10)), "only the last few days are pulled again");
  assert.equal(ring.refreshes.length, refreshes0 + 1, "the 401 led to one refresh and a retry");

  const refreshesBefore = ring.refreshes.length;
  await db.query("UPDATE connections SET expires_at = now() + interval '1 minute', last_sync_at = now() - interval '1 hour' WHERE contributor_id = $1", [id]);
  assert.equal((await b.go("/api/ring/sync", { method: "POST", json: {} })).status, 200);
  assert.equal(ring.refreshes.length, refreshesBefore + 1, "refreshed before expiry, once for the whole sync");
});

test("rate limits surface as 429, and a refused refresh asks the person to reconnect", async () => {
  const { b, id } = await connected("ring-4");
  await db.query("UPDATE connections SET last_sync_at = now() - interval '1 hour' WHERE contributor_id = $1", [id]);
  ring.knobs.rateLimited = true;
  const limited = await b.go("/api/ring/sync", { method: "POST", json: {} });
  ring.knobs.rateLimited = false;
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "ring_rate_limited");

  ring.knobs.refreshRefused = true;
  await db.query("UPDATE connections SET expires_at = now(), last_sync_at = now() - interval '1 hour' WHERE contributor_id = $1", [id]);
  const r = await b.go("/api/ring/sync", { method: "POST", json: {} });
  ring.knobs.refreshRefused = false;
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "ring_needs_reconnect");
  assert.equal((await (await b.go("/api/ring")).json()).connection.status, "needs_reconnect");
  const due = await syncDue(db, kek, ring.api, 0);
  assert.equal(due[id], undefined, "the scheduler skips connections that need reconnecting");
});

test("sample data goes through the same path and counts as synthetic in answers", async () => {
  const pool = await openDb();
  const app2 = express();
  const s2 = app2.listen(0);
  const base2 = `http://localhost:${(s2.address() as AddressInfo).port}`;
  app2.use("/api", createContributorApi(pool, kek, { identity: devIdentity(base2), chain, ring: fakeRing().api, baseUrl: base2 }));
  try {
    await seedPool(pool, kek, { people: 3, days: 60, on: today() });
    const sample = makeBrowser(base2);
    await sample.signIn("sampler");
    await sample.go("/api/me/grant", { method: "PUT", json: { groups: ["sleep"], historyDays: 60, validDays: 30 } });
    const res = await (await sample.go("/api/ring/sample", { method: "POST", json: {} })).json();
    assert.equal(res.source, "sample");
    assert.ok(res.synced.sleep.stored > 40);

    const spec = q.parseSpec({ metric: "sleep_minutes", stat: "mean", from: addDays(today(), -30), to: addDays(today(), -1) });
    const answer = await q.runQuery(pool, kek, (await q.quote(pool, spec)).quoteId, null);
    assert.equal(answer.syntheticShare, 1, "3 seed people plus 1 sample person: all synthetic");
  } finally {
    s2.close();
  }
});

test("withdraw and disconnect revoke the ring token", async () => {
  const { b, id } = await connected("ring-5");
  const before = ring.revoked.length;
  assert.equal((await b.go("/api/me/withdraw", { method: "POST", json: { confirm: true } })).status, 200);
  assert.equal(ring.revoked.length, before + 1);
  assert.equal((await db.query("SELECT 1 FROM connections WHERE contributor_id = $1", [id])).rows.length, 0);

  const c = await connected("ring-6");
  assert.equal((await c.b.go("/api/ring", { method: "DELETE", json: {} })).status, 200);
  assert.equal(ring.revoked.length, before + 2);
  assert.equal((await (await c.b.go("/api/ring")).json()).connection, null);
});
