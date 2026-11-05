// Pool storage tests on an in-memory database: grants gate storage, records are sealed per person, withdrawal destroys access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openDb } from "../src/db/index.js";
import { openRecord } from "../src/pool/crypto.js";
import { seedPool, syntheticPerson } from "../src/pool/seed.js";
import { activeGrant, addDays, createContributor, iso, personKey, setGrant, storeRows, withdraw } from "../src/pool/store.js";

const kek = randomBytes(32);
const ON = "2026-11-06";

test("seed respects each grant's groups and history window", async () => {
  const db = await openDb();
  const ids = await seedPool(db, kek, { people: 25, days: 60, on: ON });
  const { rows } = await db.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM records r JOIN grants g ON g.contributor_id = r.contributor_id AND g.status = 'active'
    WHERE NOT (r.grp = ANY (g.groups)) OR r.day < g.history_from OR r.day > g.expires_at`);
  assert.equal(rows[0].n, 0);
  const total = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM records")).rows[0].n;
  assert.ok(total > 25 * 20, `expected plenty of records, got ${total}`);
  assert.equal(ids.length, 25);
});

test("dates survive the round trip without a timezone shift", async () => {
  const db = await openDb();
  const id = await createContributor(db, kek, "seed");
  await setGrant(db, id, { groups: ["hrv"], historyDays: 10, validDays: 5 }, ON);
  const g = (await activeGrant(db, id, ON))!;
  assert.equal(iso(g.history_from), addDays(ON, -10));
  assert.equal(iso(g.expires_at), addDays(ON, 5));
  await storeRows(db, kek, id, "hrv", [{ date: addDays(ON, -1), hrv_rmssd_ms: 50 }], ON);
  const { rows } = await db.query<{ day: Date }>("SELECT day FROM records WHERE contributor_id = $1", [id]);
  assert.equal(iso(rows[0].day), addDays(ON, -1));
});

test("records open only with the right person, day and group", async () => {
  const db = await openDb();
  const a = await createContributor(db, kek, "seed");
  const b = await createContributor(db, kek, "seed");
  for (const id of [a, b]) await setGrant(db, id, { groups: ["sleep", "hrv"], historyDays: 20, validDays: 5 }, ON);
  const rowsA = syntheticPerson(1, addDays(ON, -20), addDays(ON, -1));
  await storeRows(db, kek, a, "sleep", rowsA.sleep, ON);
  await storeRows(db, kek, b, "sleep", syntheticPerson(2, addDays(ON, -20), addDays(ON, -1)).sleep, ON);

  const { rows } = await db.query<{ day: Date; iv: Uint8Array; blob: Uint8Array }>(
    "SELECT day, iv, blob FROM records WHERE contributor_id = $1 AND grp = 'sleep' ORDER BY day LIMIT 1", [a]);
  const day = iso(rows[0].day);
  const vals = openRecord(await personKey(db, kek, a), a, day, "sleep", rows[0].iv, rows[0].blob);
  const raw = rowsA.sleep.find(r => r.date === day)!;
  assert.equal(vals.total_sleep_minutes, raw.total_sleep_minutes);
  assert.equal(Object.keys(vals).includes("date"), false);

  // Right key but another day or group, or another person's key: all must fail authentication.
  const keyA = await personKey(db, kek, a);
  assert.throws(() => openRecord(keyA, a, addDays(day, 1), "sleep", rows[0].iv, rows[0].blob));
  assert.throws(() => openRecord(keyA, a, day, "hrv", rows[0].iv, rows[0].blob));
  const keyB = await personKey(db, kek, b);
  assert.throws(() => openRecord(keyB, b, day, "sleep", rows[0].iv, rows[0].blob));
});

test("storage refuses groups the person did not grant, and fields outside the allow-list", async () => {
  const db = await openDb();
  const id = await createContributor(db, kek, "seed");
  await setGrant(db, id, { groups: ["sleep"], historyDays: 5, validDays: 5 }, ON);
  await assert.rejects(storeRows(db, kek, id, "hrv", [{ date: addDays(ON, -1), hrv_rmssd_ms: 40 }], ON), /not_granted/);
  await storeRows(db, kek, id, "sleep", [{ date: addDays(ON, -1), total_sleep_minutes: 400, user_id: "u_123", timezone: "Asia/Kolkata" }], ON);
  const { rows } = await db.query<{ iv: Uint8Array; blob: Uint8Array }>("SELECT iv, blob FROM records WHERE contributor_id = $1", [id]);
  const vals = openRecord(await personKey(db, kek, id), id, addDays(ON, -1), "sleep", rows[0].iv, rows[0].blob);
  assert.deepEqual(vals, { total_sleep_minutes: 400 });
  // Older than the grant's history window: dropped.
  assert.equal(await storeRows(db, kek, id, "sleep", [{ date: addDays(ON, -30), total_sleep_minutes: 400 }], ON), 0);
});

test("withdrawal destroys the key, records and grant", async () => {
  const db = await openDb();
  const id = await createContributor(db, kek, "seed");
  await setGrant(db, id, { groups: ["hrv"], historyDays: 5, validDays: 5 }, ON);
  await storeRows(db, kek, id, "hrv", [{ date: addDays(ON, -1), hrv_rmssd_ms: 40 }], ON);
  await withdraw(db, id);
  await assert.rejects(personKey(db, kek, id), /withdrawn/);
  assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM records WHERE contributor_id = $1", [id])).rows[0].n, 0);
  assert.equal(await activeGrant(db, id, ON), null);
});
