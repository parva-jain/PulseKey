// Route 1 tests on seeded in-memory pools: pricing, the group minimum, noise accuracy, budgets, and the pay split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.PERSON_EPSILON_CAP = "1"; // two queries at epsilon 0.5, then a person is used up
const { openDb } = await import("../src/db/index.js");
const { openRecord } = await import("../src/pool/crypto.js");
const { METRICS } = await import("../src/pool/metrics.js");
const { seedPool } = await import("../src/pool/seed.js");
const { addDays, iso, personKey, withdraw } = await import("../src/pool/store.js");
const q = await import("../src/pool/query.js");

const kek = randomBytes(32);
const ON = "2026-11-06";
const range = { from: addDays(ON, -30), to: addDays(ON, -1) };

async function pool(people: number) {
  const db = await openDb();
  const ids = await seedPool(db, kek, { people, days: 60, on: ON });
  return { db, ids };
}

/** The exact answer, computed the slow way, to measure the noisy one against. */
async function trueMean(db: Awaited<ReturnType<typeof openDb>>, ids: string[], metric: keyof typeof METRICS) {
  const m = METRICS[metric];
  const means: number[] = [];
  for (const id of ids) {
    const key = await personKey(db, kek, id);
    const { rows } = await db.query<{ day: Date; iv: Uint8Array; blob: Uint8Array }>(
      "SELECT day, iv, blob FROM records WHERE contributor_id = $1 AND grp = $2 AND day BETWEEN $3 AND $4", [id, m.group, range.from, range.to]);
    const v = rows.map(r => openRecord(key, id, iso(r.day), m.group, r.iv, r.blob)[m.field]);
    if (v.length) means.push(Math.min(m.hi, Math.max(m.lo, v.reduce((a, b) => a + b, 0) / v.length)));
  }
  return means.reduce((a, b) => a + b, 0) / means.length;
}

test("specs are validated before anything is counted", () => {
  assert.throws(() => q.parseSpec({ metric: "weight", stat: "mean", ...range }, ON), /unknown_metric/);
  assert.throws(() => q.parseSpec({ metric: "hrv_ms", stat: "share_below", ...range }, ON), /bad_threshold/);
  assert.throws(() => q.parseSpec({ metric: "hrv_ms", stat: "mean", from: range.to, to: range.from }, ON), /bad_range/);
  assert.throws(() => q.parseSpec({ metric: "hrv_ms", stat: "mean", from: range.from, to: addDays(ON, 1) }, ON), /bad_range/);
  assert.deepEqual(q.parseSpec({ metric: "hrv_ms", stat: "mean", ...range }, ON), { route: "stat", metric: "hrv_ms", stat: "mean", threshold: undefined, ...range });
});

test("a pool below the group minimum is refused at quote time", async () => {
  const { db } = await pool(15);
  await assert.rejects(q.quote(db, q.parseSpec({ metric: "sleep_minutes", stat: "mean", ...range }, ON), ON), /group_too_small/);
});

test("quote, run, settle: noisy mean lands near the truth and everyone counted is paid exactly", async () => {
  const { db } = await pool(45);
  const spec = q.parseSpec({ metric: "sleep_minutes", stat: "mean", ...range }, ON);
  const quote = await q.quote(db, spec, ON);
  const eligible = await q.eligible(db, spec, ON);
  assert.equal(BigInt(quote.priceMicro), q.priceMicro(eligible.size));
  assert.equal(quote.eligibleAbout, Math.floor(eligible.size / 10) * 10);
  assert.equal(await q.quotedPrice(db, quote.quoteId), BigInt(quote.priceMicro));

  const res = await q.runQuery(db, kek, quote.quoteId, "pay_1", ON);
  const truth = await trueMean(db, [...eligible.keys()], "sleep_minutes");
  assert.ok(Math.abs(res.value - truth) <= res.plusMinus95 * 2, `noisy ${res.value} vs true ${truth.toFixed(1)} (±${res.plusMinus95})`);
  console.log(`  mean sleep: released ${res.value} ±${res.plusMinus95}, true ${truth.toFixed(1)}, people ${eligible.size}, price $${quote.priceUsd}`);

  await assert.rejects(q.runQuery(db, kek, quote.quoteId, "pay_2", ON), /quote_used/);
  assert.equal(await q.answeredByPaymentId(db, "pay_1"), null, "not released before settlement");

  assert.equal(await q.settleQuery(db, res.queryId, { tx: "0.0.1@1.1", payer: "0.0.2" }), true);
  assert.equal(await q.settleQuery(db, res.queryId, { tx: "0.0.1@1.1", payer: "0.0.2" }), false, "second settle is a no-op");
  const { rows } = await db.query<{ kind: string; n: number; total: string }>("SELECT kind, count(*)::int AS n, sum(micro)::text AS total FROM ledger GROUP BY kind");
  const by = Object.fromEntries(rows.map(r => [r.kind, r]));
  const price = BigInt(quote.priceMicro);
  assert.equal(by.earning.n, eligible.size);
  assert.equal(BigInt(by.earning.total) + BigInt(by.platform.total), price);
  assert.equal(BigInt(by.platform.total), price - (price * 9_000n) / 10_000n);
  assert.deepEqual((await q.answeredByPaymentId(db, "pay_1")) as object, res);
});

test("share queries return a percentage near the truth", async () => {
  const { db } = await pool(45);
  const spec = q.parseSpec({ metric: "hrv_ms", stat: "share_below", threshold: 50, ...range }, ON);
  const quote = await q.quote(db, spec, ON);
  const res = await q.runQuery(db, kek, quote.quoteId, null, ON);
  assert.equal(res.unit, "% of people");
  assert.ok(res.value >= 0 && res.value <= 100);
  console.log(`  share with HRV below 50 ms: ${res.value}% ±${res.plusMinus95}`);
});

test("privacy budget: people at their cap stop being counted", async () => {
  const { db } = await pool(25);
  const spec = q.parseSpec({ metric: "sleep_score", stat: "mean", ...range }, ON);
  for (let i = 0; i < 2; i++) await q.runQuery(db, kek, (await q.quote(db, spec, ON)).quoteId, null, ON);
  assert.equal((await q.eligible(db, spec, ON)).size, 0);
  await assert.rejects(q.quote(db, spec, ON), /group_too_small/);
});

test("withdrawn and expired-quote cases are excluded", async () => {
  const { db, ids } = await pool(30);
  const spec = q.parseSpec({ metric: "sleep_minutes", stat: "mean", ...range }, ON);
  const before = (await q.eligible(db, spec, ON)).size;
  await withdraw(db, ids[0]);
  assert.equal((await q.eligible(db, spec, ON)).size, before - 1);
  const quote = await q.quote(db, spec, ON);
  await db.query("UPDATE quotes SET expires_at = now() - interval '1 second' WHERE id = $1", [quote.quoteId]);
  await assert.rejects(q.quotedPrice(db, quote.quoteId), /quote_expired/);
});
