// Local tests for the agent spending log and contributor payouts, with a fake chain in place of Hedera.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrivateKey } from "@hiero-ledger/sdk";
import { openDb } from "../src/db/index.js";
import { seedPool, syntheticPerson } from "../src/pool/seed.js";
import { addDays, createContributor, setGrant, storeRows } from "../src/pool/store.js";
import * as q from "../src/pool/query.js";
import { balanceMicro, claim, sweepSeedShares, type PayoutChain } from "../src/pool/payouts.js";
import { policyHash, reconcile, replay, SpendLog, type Policy } from "../src/hedera/audit.js";

const kek = randomBytes(32);
const ON = "2026-11-06";
const range = { from: addDays(ON, -30), to: addDays(ON, -1) };
const policy: Policy = { asset: "0.0.429274", maxSessionMicro: "10000000", maxPerPaymentMicro: "5000000", allowPayTo: ["0.0.7"] };

function memorySink() {
  const messages: string[] = [];
  return { messages, submit: async (m: string) => { messages.push(m); } };
}

function fakeChain(fail?: "create" | "send") {
  const sent: { to: string; micro: bigint }[] = [];
  let n = 0;
  const chain: PayoutChain = {
    async createAccount() {
      if (fail === "create") throw new Error("INSUFFICIENT_PAYER_BALANCE");
      return { accountId: `0.0.${9000 + ++n}`, tx: `0.0.1@${n}.0` };
    },
    async sendUsdc(to, micro) {
      if (fail === "send") throw new Error("timeout");
      sent.push({ to, micro });
      return { tx: `0.0.1@${100 + sent.length}.0` };
    },
  };
  return { chain, sent };
}

/** A pool of 30 seed people plus one real person, after one paid query, so everyone has earnings. */
async function pooledWithEarnings() {
  const db = await openDb();
  await seedPool(db, kek, { people: 30, days: 60, on: ON });
  const real = await createContributor(db, kek, "real");
  await setGrant(db, real, { groups: ["sleep", "hrv", "resting_hr", "recovery"], historyDays: 60, validDays: 30 }, ON);
  const rows = syntheticPerson(7, addDays(ON, -60), addDays(ON, -1));
  for (const grp of ["sleep", "hrv", "resting_hr", "recovery"] as const) await storeRows(db, kek, real, grp, rows[grp], ON);
  const quote = await q.quote(db, q.parseSpec({ metric: "sleep_minutes", stat: "mean", ...range }, ON), ON);
  const res = await q.runQuery(db, kek, quote.quoteId, "pay_1", ON);
  await q.settleQuery(db, res.queryId, { tx: "0.0.5@1.1", payer: "0.0.6" });
  return { db, real, price: BigInt(quote.priceMicro) };
}

const pub = () => PrivateKey.generateECDSA().publicKey.toStringDer();

test("spend log: entries chain, replay resumes, and a changed policy is written again", async () => {
  const sink = memorySink();
  const log = new SpendLog(sink, "agent", "0.0.2");
  await log.setPolicy(policy);
  await log.setPolicy(policy); // same limits: nothing new written
  await log.append("pay.intent", { merchant: "0.0.7", amount: "20000" });
  await log.append("pay.settled", { merchant: "0.0.7", amount: "20000", tx: "0.0.3@10.5" });
  await log.append("pay.settled", { merchant: "0.0.7", amount: "500000", tx: "0.0.3@11.5" });
  assert.equal(sink.messages.length, 4);

  const state = replay(sink.messages, "0.0.2");
  assert.deepEqual(state.breaks, []);
  assert.equal(state.policy, policyHash(policy));
  assert.equal(state.spentSincePolicy, 520_000n);

  const resumed = new SpendLog(sink, "agent", "0.0.2");
  assert.equal(resumed.resume(state), 520_000n);
  await resumed.setPolicy(policy);
  assert.equal(sink.messages.length, 4, "restart with the same policy keeps the chain and the budget");
  await resumed.setPolicy({ ...policy, maxSessionMicro: "20000000" });
  assert.equal(replay(sink.messages, "0.0.2").spentSincePolicy, 0n, "new limits start a new, public budget");
  assert.deepEqual(replay(sink.messages, "0.0.2").breaks, []);
});

test("spend log: an edited or dropped entry breaks the chain", async () => {
  const sink = memorySink();
  const log = new SpendLog(sink, "agent", "0.0.2");
  await log.setPolicy(policy);
  for (const amount of ["1", "2", "3"]) await log.append("pay.settled", { amount, tx: `0.0.3@${amount}.0` });
  const edited = [...sink.messages];
  edited[2] = edited[2].replace('"amount":"2"', '"amount":"0"');
  assert.deepEqual(replay(edited, "0.0.2").breaks, [4]);
  const dropped = sink.messages.filter((_, i) => i !== 1);
  assert.deepEqual(replay(dropped, "0.0.2").breaks, [3]);
  assert.throws(() => new SpendLog(sink, "agent", "0.0.2").resume(replay(dropped, "0.0.2")), /chain broken/);
  await assert.rejects(log.append("pay.intent", { reason: "x".repeat(1100) }), /one HCS chunk/);
});

test("reconcile: unlogged spends and unbacked entries both show up", () => {
  const settled = replay([], "x").settled;
  settled.push({ ev: "pay.settled", tx: "0.0.3@10.5", amount: "20000" } as any, { ev: "pay.settled", tx: "0.0.3@11.5", amount: "999" } as any);
  const r = reconcile(settled, [{ tx: "0.0.3-10-5", micro: 20_000n }, { tx: "0.0.3-12-5", micro: 7n }]);
  assert.deepEqual(r.matched, ["0.0.3-10-5"]);
  assert.deepEqual(r.unlogged.map(d => d.tx), ["0.0.3-12-5"]);
  assert.deepEqual(r.unbacked.map(d => d.tx), ["0.0.3-11-5"]);
});

test("claim pays the exact balance once, to a fresh account for the browser's key", async () => {
  const { db, real } = await pooledWithEarnings();
  const owed = await balanceMicro(db, real);
  assert.ok(owed > 0n);
  const { chain, sent } = fakeChain();
  const key = pub();
  const c = await claim(db, chain, real, key);
  assert.equal(c.micro, owed.toString());
  assert.deepEqual(sent, [{ to: c.accountId, micro: owed }]);
  assert.equal(await balanceMicro(db, real), 0n);
  await assert.rejects(claim(db, chain, real, pub()), /nothing_to_claim/);
  await assert.rejects(claim(db, chain, real, key), /key_already_used/);
  const { rows } = await db.query<{ status: string; transfer_tx: string }>("SELECT status, transfer_tx FROM claims");
  assert.deepEqual(rows, [{ status: "paid", transfer_tx: c.tx }]);
});

test("claim keys are checked, and seed people cannot claim", async () => {
  const { db, real } = await pooledWithEarnings();
  const { chain } = fakeChain();
  await assert.rejects(claim(db, chain, real, "not-a-key"), /bad_public_key/);
  await assert.rejects(claim(db, chain, real, PrivateKey.generateED25519().publicKey.toStringDer()), /ecdsa_key_required/);
  const seed = (await db.query<{ id: string }>("SELECT id FROM contributors WHERE kind = 'seed' LIMIT 1")).rows[0].id;
  await assert.rejects(claim(db, chain, seed, pub()), /seed_people_cannot_claim/);
});

test("a failed account creation undoes the debit; a failed transfer keeps it, so nothing is paid twice", async () => {
  const { db, real } = await pooledWithEarnings();
  const owed = await balanceMicro(db, real);
  const key = pub();
  await assert.rejects(claim(db, fakeChain("create").chain, real, key), /INSUFFICIENT/);
  assert.equal(await balanceMicro(db, real), owed, "nothing moved, so the balance is back");
  await assert.rejects(claim(db, fakeChain("send").chain, real, key), /timeout/, "same key may retry after a failed creation");
  assert.equal(await balanceMicro(db, real), 0n, "the transfer may have landed, so the debit stays until checked");
  const { rows } = await db.query<{ status: string }>("SELECT status FROM claims ORDER BY created_at");
  assert.deepEqual(rows.map(r => r.status).sort(), ["failed", "pending"]);
});

test("seed shares sweep to the treasury in one transfer, and only once", async () => {
  const { db, real, price } = await pooledWithEarnings();
  const { chain, sent } = fakeChain();
  const realOwed = await balanceMicro(db, real);
  const s = await sweepSeedShares(db, chain, "0.0.4242");
  const platform = price - (price * 9_000n) / 10_000n;
  assert.equal(BigInt(s!.micro) + realOwed + platform, price, "seed sweep + real person + platform = what the buyer paid");
  assert.deepEqual(sent, [{ to: "0.0.4242", micro: BigInt(s!.micro) }]);
  assert.equal(await sweepSeedShares(db, chain, "0.0.4242"), null);
  assert.equal(await balanceMicro(db, real), realOwed, "the real person's share is untouched");
});

test("a payer for the logged buyer account cannot be built without the log", async () => {
  const { buildPayingFetch } = await import("../src/x402/agent.js");
  const saved = { topic: process.env.HCS_TOPIC_ID, buyer: process.env.BUYER_ACCOUNT_ID };
  process.env.HCS_TOPIC_ID = "0.0.1";
  process.env.BUYER_ACCOUNT_ID = "0.0.2";
  try {
    const key = PrivateKey.generateECDSA() as any;
    assert.throws(() => buildPayingFetch({ accountId: "0.0.2", key, maxSpendMicro: 1n }), /public spending log/);
    assert.doesNotThrow(() => buildPayingFetch({ accountId: "0.0.3", key, maxSpendMicro: 1n }), "other accounts are not affected");
  } finally {
    process.env.HCS_TOPIC_ID = saved.topic;
    process.env.BUYER_ACCOUNT_ID = saved.buyer;
    if (saved.topic === undefined) delete process.env.HCS_TOPIC_ID;
    if (saved.buyer === undefined) delete process.env.BUYER_ACCOUNT_ID;
  }
});
