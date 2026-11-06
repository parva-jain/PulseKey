// Routes 2 and 3 and the daily brief, with a scripted model in place of 0G: what reaches the model, label
// sealing and reuse, malformed replies, failing closed, payment to everyone counted, and the brief's rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db/index.js";
import { createApi } from "../src/api/app.js";
import { offModel, scriptedModel } from "../src/ai/model.js";
import { seedPool, syntheticPerson } from "../src/pool/seed.js";
import { addDays, createContributor, setGrant, storeRows, today, withdraw } from "../src/pool/store.js";
import * as q from "../src/pool/query.js";
import * as p from "../src/pool/pattern.js";
import { todaysBrief } from "../src/pool/brief.js";

const kek = randomBytes(32);
const ON = today();
const range = { from: addDays(ON, -45), to: addDays(ON, -1) };
const template = { id: "lead_lag_v1", leading: "hrv_ms", leadDirection: "falls", outcome: "sleep_minutes", outcomeDirection: "falls", lagNights: 1 };
const body = { route: "pattern", template, ...range };
const yes = () => scriptedModel(() => '{"answer":"yes"}');

async function pool(people = 25) {
  const db = await openDb();
  await seedPool(db, kek, { people, days: 60, on: ON });
  return db;
}

test("pattern specs: closed template, two different metrics, 14 to 120 days", () => {
  assert.deepEqual(p.parsePatternSpec(body, ON), { route: "pattern", template, ...range });
  assert.throws(() => p.parsePatternSpec({ ...body, template: { ...template, extra: 1 } }, ON), /bad_template/);
  assert.throws(() => p.parsePatternSpec({ ...body, template: { ...template, outcome: "hrv_ms" } }, ON), /bad_metrics/);
  assert.throws(() => p.parsePatternSpec({ ...body, template: { ...template, lagNights: 4 } }, ON), /bad_template/);
  assert.throws(() => p.parsePatternSpec({ ...body, from: addDays(ON, -5) }, ON), /bad_range/);
});

test("route 3: one sealed read per person, of only the two metrics, with nights instead of dates", async () => {
  const db = await pool();
  const model = yes();
  const spec = p.parsePatternSpec(body, ON);
  const quote = await p.quotePattern(db, model, spec, ON);
  assert.equal(quote.route, "sealed_read");
  const n = (await p.eligiblePattern(db, spec, ON)).size;
  const res = await p.runPattern(db, kek, model, quote.quoteId, "pay-1", ON);

  assert.equal(model.calls.length, n, "exactly one read per person counted");
  for (const c of model.calls) {
    const data = String(c.messages[1].content);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(data), "no dates reach the model");
    const row = JSON.parse(data.replace("DATA:\n", ""))[0];
    assert.deepEqual(Object.keys(row).sort(), ["hrv_ms", "night", "sleep_minutes"], "only the two metrics asked about");
  }
  assert.equal(res.sealedReads, n);
  assert.equal(res.proof.requestIds.length, n);
  assert.ok(res.answer.yesPct > 70, `everyone said yes, released ${res.answer.yesPct}% ±${res.answer.plusMinus95}`);
  const labels = await db.query<{ blob: Uint8Array }>("SELECT blob FROM labels");
  assert.equal(labels.rows.length, n);
  assert.ok(labels.rows.every(l => !Buffer.from(l.blob).toString("latin1").includes("yes")), "labels are sealed");
  assert.equal((await db.query("SELECT 1 FROM inference_calls")).rows.length, n);

  await q.settleQuery(db, res.queryId, { tx: "0.0.1@1.1" });
  const earners = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger WHERE kind = 'earning' AND query_id = $1", [res.queryId]);
  assert.equal(earners.rows[0].n, n, "everyone counted is paid");
});

test("route 2: the same question and range reuses saved labels with no new reads", async () => {
  const db = await pool();
  const model = yes();
  const spec = p.parsePatternSpec(body, ON);
  await p.runPattern(db, kek, model, (await p.quotePattern(db, model, spec, ON)).quoteId, null, ON);
  const first = model.calls.length;
  const again = await p.quotePattern(db, model, spec, ON);
  assert.equal(again.route, "saved_labels");
  const res = await p.runPattern(db, kek, model, again.quoteId, null, ON);
  assert.equal(model.calls.length, first, "no model calls on route 2");
  assert.equal(res.sealedReads, 0);
  assert.ok(res.labelsReused >= 20);
  const other = p.parsePatternSpec({ ...body, template: { ...template, lagNights: 2 } }, ON);
  assert.equal((await p.quotePattern(db, model, other, ON)).route, "sealed_read", "a different question needs reads");
});

test("malformed replies get three tries, then count as unclear and are not saved", async () => {
  const db = await pool(22);
  const model = scriptedModel(() => "yes"); // bare word, not the JSON shape
  const spec = p.parsePatternSpec(body, ON);
  const n = (await p.eligiblePattern(db, spec, ON)).size;
  const res = await p.runPattern(db, kek, model, (await p.quotePattern(db, model, spec, ON)).quoteId, null, ON);
  assert.equal(model.calls.length, 3 * n);
  assert.ok(res.answer.unclearPct > 70);
  assert.equal((await db.query("SELECT 1 FROM labels")).rows.length, 0);
});

test("the sealed model failing partway refuses the query before payment, keeping saved labels", async () => {
  const db = await pool(22);
  const flaky = scriptedModel((_r, n) => { if (n > 5) throw new Error("provider down"); return '{"answer":"no"}'; });
  const spec = p.parsePatternSpec(body, ON);
  const quote = await p.quotePattern(db, flaky, spec, ON);
  await assert.rejects(p.runPattern(db, kek, flaky, quote.quoteId, null, ON), /sealed_ai_unavailable/);
  assert.equal((await db.query("SELECT 1 FROM queries")).rows.length, 0, "nothing released, nothing to settle");
  assert.equal((await db.query("SELECT 1 FROM budget_spend")).rows.length, 0, "no budget spent");
  assert.ok((await db.query("SELECT 1 FROM labels")).rows.length >= 5, "labels from reads that worked are kept");
  await assert.rejects(p.quotePattern(db, offModel, spec, ON), /sealed_ai_unavailable/);
});

test("buyer API: a pattern quote with sealed AI off is refused before any payment is asked for", async () => {
  const db = await pool(0);
  const app = createApi(db, kek, { getSupported: async () => ({ kinds: [], extensions: [], signers: {} }) } as any, { baseUrl: "http://x", payTo: "0.0.7", model: offModel });
  const server = app.listen(0);
  try {
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    const r = await fetch(`${url}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("payment-required"), null);
    const cat = await (await fetch(`${url}/catalog`)).json();
    assert.equal(cat.endpoints.find((e: any) => e.route === "pattern").available, false);
  } finally {
    server.close();
  }
});

test("brief: own nights only, once a day, sealed, and unavailable rather than unsealed", async () => {
  const db = await pool(3);
  const id = await createContributor(db, kek, "real");
  await setGrant(db, id, { groups: ["sleep", "hrv", "resting_hr", "recovery"], historyDays: 40, validDays: 30 }, ON);
  const rows = syntheticPerson(5, addDays(ON, -40), addDays(ON, -1));
  for (const g of ["sleep", "hrv", "resting_hr", "recovery"] as const) await storeRows(db, kek, id, g, rows[g], ON);

  assert.deepEqual(await todaysBrief(db, kek, offModel, id, ON), { available: false, reason: "sealed_ai_unavailable" });
  assert.equal((await todaysBrief(db, kek, scriptedModel(() => "  "), id, ON) as any).reason, "sealed_ai_bad_reply");

  const model = scriptedModel(() => "You slept a little less than usual last night.");
  const b = await todaysBrief(db, kek, model, id, ON);
  assert.equal(b.available, true);
  if (!b.available) return;
  assert.equal(b.brief.requestId, "req-1");
  const data = JSON.parse(String(model.calls[0].messages[1].content).replace("DATA:\n", ""));
  assert.equal(data.at(-1).night, 0, "the last row is last night");
  assert.ok(data.length >= 25 && data.length <= 31);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(String(model.calls[0].messages[1].content)));

  const again = await todaysBrief(db, kek, model, id, ON);
  assert.equal(model.calls.length, 1, "cached for the day");
  assert.equal(again.available && again.cached, true);

  const fresh = await createContributor(db, kek, "real");
  assert.equal((await todaysBrief(db, kek, model, fresh, ON) as any).reason, "not_enough_nights");
  await withdraw(db, id);
  assert.equal((await db.query("SELECT 1 FROM personal_insights WHERE contributor_id = $1", [id])).rows.length, 0);
  assert.equal((await todaysBrief(db, kek, model, id, ON) as any).reason, "withdrawn");
});
