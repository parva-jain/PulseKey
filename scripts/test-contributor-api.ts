// Contributor API over HTTP with the dev identity stand-in and a fake chain: sign-in, sessions, fresh-check
// gating, sharing, activity, earnings, claim and withdrawal. The World provider plugs into the same seam.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { PrivateKey } from "@hiero-ledger/sdk";
import { openDb } from "../src/db/index.js";
import { createContributorApi } from "../src/api/contributor.js";
import { devIdentity } from "../src/identity/index.js";
import { seedPool, syntheticPerson } from "../src/pool/seed.js";
import { addDays, storeRows, today } from "../src/pool/store.js";
import * as q from "../src/pool/query.js";
import type { PayoutChain } from "../src/pool/payouts.js";
import { browser as makeBrowser, fakeRing } from "./helpers.js";
import { offModel } from "../src/ai/model.js";

const kek = randomBytes(32);
const db = await openDb();
await seedPool(db, kek, { people: 30, days: 60, on: today() });
const sent: bigint[] = [];
const chain: PayoutChain = {
  createAccount: async () => ({ accountId: "0.0.777", tx: "0.0.1@1.1" }),
  sendUsdc: async (_to, micro) => (sent.push(micro), { tx: "0.0.1@2.2" }),
};
const app = express();
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
app.use("/api", createContributorApi(db, kek, { identity: devIdentity(base), chain, ring: fakeRing().api, model: offModel, baseUrl: base }));
after(() => server.close());

const browser = () => makeBrowser(base);

const ALL = ["sleep", "hrv", "resting_hr", "recovery"];

test("sign-in creates one person per name, and the same name comes back to the same person", async () => {
  const a = browser();
  const cb = await a.signIn("asha");
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), `${base}/home`);
  const me = await (await a.go("/api/me")).json();
  assert.deepEqual(me.identity, { provider: "dev", verifiedHuman: false });
  assert.equal(me.grant, null);

  const before = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contributors WHERE kind = 'real'")).rows[0].n;
  await browser().signIn("asha");
  await browser().signIn("ravi");
  const afterN = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contributors WHERE kind = 'real'")).rows[0].n;
  assert.equal(afterN - before, 1, "asha again is the same person; ravi is new");
});

test("sign-in refuses callbacks from another browser, reused attempts, and outside return paths", async () => {
  const a = browser();
  const start = await a.go("/api/auth/start?return=//evil.example/x");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const other = browser();
  assert.equal((await other.go(`/api/auth/callback?state=${state}&iss=dev:local&dev_name=x`)).status, 400, "login CSRF");
  const ok = await a.go(`/api/auth/callback?state=${state}&iss=dev:local&dev_name=mallory`);
  assert.equal(ok.headers.get("location"), `${base}/`, "open redirect squashed to /");
  a.jar.set("pk_attempt", state);
  assert.equal((await a.go(`/api/auth/callback?state=${state}&iss=dev:local&dev_name=mallory`)).status, 400, "attempt is single use");
  assert.equal((await browser().go("/api/me")).status, 401);
  assert.equal((await a.go("/api/me/withdraw", { method: "POST", body: "confirm=true" })).status, 415, "form posts are refused");
});

test("sharing: widening needs a fresh check, narrowing never does", async () => {
  const a = browser();
  await a.signIn("meera");
  const put = (json: unknown) => a.go("/api/me/grant", { method: "PUT", json });
  const g1 = await put({ groups: ["sleep"], historyDays: 30, validDays: 30 });
  assert.equal(g1.status, 200);
  assert.equal((await g1.json()).neededFreshCheck, true);

  await db.query("UPDATE sessions SET checked_at = now() - interval '1 hour'");
  const wide = await put({ groups: ["sleep", "hrv"], historyDays: 30, validDays: 30 });
  assert.equal(wide.status, 428);
  assert.equal((await wide.json()).recheck, "/api/auth/start?recheck=1");
  const narrow = await put({ groups: ["sleep"], historyDays: 10, validDays: 20 });
  assert.equal(narrow.status, 200, "sharing less is always allowed");

  const re = await a.signIn("", { recheck: true });
  assert.equal(re.status, 302);
  assert.equal((await put({ groups: ["sleep", "hrv"], historyDays: 30, validDays: 30 })).status, 200);
  assert.deepEqual((await (await a.go("/api/me/grant")).json()).grant.groups, ["sleep", "hrv"]);
  assert.equal((await put({ groups: ["sleep", "weight"], historyDays: 30, validDays: 30 })).status, 400);
  assert.equal((await a.go("/api/me/grant", { method: "DELETE", json: {} })).status, 200);
  assert.equal((await (await a.go("/api/me")).json()).grant, null);
});

test("activity, earnings and claim: the person sees where their data went and gets paid once", async () => {
  const a = browser();
  await a.signIn("asha-2");
  await a.go("/api/me/grant", { method: "PUT", json: { groups: ALL, historyDays: 60, validDays: 30 } });
  const id = (await db.query<{ contributor_id: string }>("SELECT contributor_id FROM sessions ORDER BY created_at DESC LIMIT 1")).rows[0].contributor_id;
  const rows = syntheticPerson(99, addDays(today(), -60), addDays(today(), -1));
  for (const grp of ALL as ("sleep")[]) await storeRows(db, kek, id, grp, rows[grp]);

  const spec = q.parseSpec({ metric: "sleep_minutes", stat: "mean", from: addDays(today(), -30), to: addDays(today(), -1) });
  const res = await q.runQuery(db, kek, (await q.quote(db, spec)).quoteId, "pid-x");
  await q.settleQuery(db, res.queryId, { tx: "0.0.9@1.1" });

  const act = await (await a.go("/api/me/activity")).json();
  assert.equal(act.items.length, 1);
  assert.equal(act.items[0].metric, "sleep_minutes");
  assert.ok(BigInt(act.items[0].earnedMicro) > 0n);
  const earn = await (await a.go("/api/me/earnings")).json();
  assert.equal(earn.balanceMicro, act.items[0].earnedMicro);

  const key = PrivateKey.generateECDSA().publicKey.toStringDer();
  await db.query("UPDATE sessions SET checked_at = now() - interval '1 hour'");
  assert.equal((await a.go("/api/me/claim", { method: "POST", json: { publicKey: key } })).status, 428, "money moves only after a fresh check");
  await a.signIn("", { recheck: true });
  const c = await a.go("/api/me/claim", { method: "POST", json: { publicKey: key } });
  assert.equal(c.status, 200);
  const body = await c.json();
  assert.equal(body.micro, earn.balanceMicro);
  assert.deepEqual(sent, [BigInt(earn.balanceMicro)]);
  assert.equal((await a.go("/api/me/claim", { method: "POST", json: { publicKey: PrivateKey.generateECDSA().publicKey.toStringDer() } })).status, 409);
  const after = await (await a.go("/api/me/earnings")).json();
  assert.equal(after.balanceMicro, "0");
  assert.equal(after.claims[0].status, "paid");
});

test("withdraw needs only a confirm, keeps the session for claiming, and blocks new sharing", async () => {
  const a = browser();
  await a.signIn("leaver");
  await a.go("/api/me/grant", { method: "PUT", json: { groups: ["sleep"], historyDays: 30, validDays: 30 } });
  await db.query("UPDATE sessions SET checked_at = now() - interval '1 hour'");
  assert.equal((await a.go("/api/me/withdraw", { method: "POST", json: {} })).status, 400);
  const w = await a.go("/api/me/withdraw", { method: "POST", json: { confirm: true } });
  assert.equal(w.status, 200, "no re-check needed to leave");
  const me = await (await a.go("/api/me")).json();
  assert.equal(me.withdrawn, true);
  assert.equal(me.grant, null);
  await a.signIn("", { recheck: true });
  assert.equal((await a.go("/api/me/grant", { method: "PUT", json: { groups: ["sleep"], historyDays: 30, validDays: 30 } })).status, 409);
});
