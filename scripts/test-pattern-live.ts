// Live run of routes 3 and 2 and the daily brief: real 0G sealed reads, real x402 payment on Hedera testnet.
// Synthetic people only, so no real person's data is read. Writes test-results/pattern-live-*.json.
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { PrivateKey } from "@x402/hedera";

process.env.PER_PERSON_MICRO ??= "1000";
const { openDb } = await import("../src/db/index.js");
const { createApi } = await import("../src/api/app.js");
const { zgModel } = await import("../src/ai/model.js");
const { seedPool, syntheticPerson } = await import("../src/pool/seed.js");
const { addDays, createContributor, setGrant, storeRows, today } = await import("../src/pool/store.js");
const { buildPayingFetch, openSpendLog, runAgent } = await import("../src/x402/agent.js");
const { USDC_TESTNET } = await import("../src/hedera/accounts.js");
const { todaysBrief } = await import("../src/pool/brief.js");
const { hashscanUrl } = await import("../src/x402/server.js");

const FAC = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const PORT = 4024, BASE = `http://localhost:${PORT}`;
const buyer = process.env.BUYER_ACCOUNT_ID!, payTo = process.env.STUDY_ACCOUNT_ID!;
const out: Record<string, unknown> = { facilitator: FAC, at: new Date().toISOString() };
const log = (k: string, v: unknown) => { out[k] = v; console.log(k, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))); };
const day = (n: number) => addDays(today(), -n);

const db = await openDb();
const kek = randomBytes(32);
const model = zgModel();
const PEOPLE = Number(process.env.LIVE_PEOPLE ?? 60);
console.log(`seeding ${PEOPLE} synthetic people with planted patterns...`);
await seedPool(db, kek, { people: PEOPLE, days: 70, on: today() });
const { eligiblePattern, parsePatternSpec } = await import("../src/pool/pattern.js");
const { TRUTH } = await import("../src/eval/planted.js");
/** The share of eligible people whose planted truth is yes: what a perfect, noiseless classifier would release. */
async function truthShare(spec: unknown, q: keyof typeof TRUTH) {
  const ids = [...(await eligiblePattern(db, parsePatternSpec(spec))).keys()];
  const { rows } = await db.query<{ cohort: string }>("SELECT cohort FROM seed_truth WHERE contributor_id = ANY ($1)", [ids]);
  return Math.round((100 * rows.filter(r => TRUTH[q][r.cohort as keyof (typeof TRUTH)[typeof q]] === "yes").length) / ids.length);
}
const server = createApi(db, kek, new HTTPFacilitatorClient({ url: FAC, timeoutMs: 60_000 }), { baseUrl: BASE, payTo, model }).listen(PORT);

const key = PrivateKey.fromStringECDSA(process.env.BUYER_PRIVATE_KEY!);
// Every payment goes through the agent's public spending log, so reconciliation has nothing unlogged to flag.
const policy = { asset: USDC_TESTNET, maxSessionMicro: "5000000", maxPerPaymentMicro: "5000000", allowPayTo: [payTo] };
const audit = await openSpendLog(buyer, key, policy);
const session = { spent: audit?.spent ?? 0n };
const payFetch = (pid: string) => buildPayingFetch({ accountId: buyer, key, maxSpendMicro: BigInt(policy.maxSessionMicro), session, allowPayTo: [payTo], paymentId: () => pid, audit: audit?.log }) as typeof fetch;
const ask = { why: "Does HRV fall the night before short sleep?", spec: { route: "pattern", template: { id: "lead_lag_v1", leading: "hrv_ms", leadDirection: "falls", outcome: "sleep_minutes", outcomeDirection: "falls", lagNights: 1 }, from: day(60), to: day(1) }, maxPriceMicro: 1_000_000n };
// The coach's question. The demo pool plants it in about 40% of people, and the reverse in about 20%.
const reverse = { why: "Does HRV drop the night after short sleep?", spec: { ...ask.spec, template: { ...ask.spec.template, leading: "sleep_minutes", outcome: "hrv_ms" } }, maxPriceMicro: 1_000_000n };

try {
  for (const [round, q] of [["route3_sealed_read", ask], ["route2_saved_labels", ask], ["route3_reverse_direction", reverse]] as const) {
    const truthYesPct = await truthShare(q.spec, q === ask ? "hrv_then_sleep" : "sleep_then_hrv");
    const t0 = Date.now();
    const [r] = await runAgent(BASE, payFetch, [q], console.log, audit?.log) as any[];
    if (r.answer?.queryId) {
      // The public proof page for this query, as a judge would open it.
      const html = await (await fetch(`${BASE}/proof/queries/${r.answer.queryId}`, { headers: { accept: "text/html" } })).text();
      writeFileSync(`test-results/proof-${round}.html`, html);
    }
    log(round, {
      ms: Date.now() - t0, truthYesPct, quoteRoute: r.quote?.route, price: r.quote?.priceUsd, skipped: r.skipped,
      answer: r.answer && { ...r.answer.answer, peopleAbout: r.answer.peopleAbout, sealedReads: r.answer.sealedReads, labelsReused: r.answer.labelsReused, syntheticShare: r.answer.syntheticShare },
      proof: r.answer && { model: r.answer.proof.model, providers: r.answer.proof.providers, requestIds: r.answer.proof.requestIds.length, firstIds: r.answer.proof.requestIds.slice(0, 3) },
      hashscan: r.receipt?.transaction && hashscanUrl(r.receipt.transaction),
    });
  }

  // A sample-data person reads their own brief.
  const id = await createContributor(db, kek, "real");
  await setGrant(db, id, { groups: ["sleep", "hrv", "resting_hr", "recovery"], historyDays: 40, validDays: 30 });
  const rows = syntheticPerson(77, day(40), day(1));
  for (const g of ["sleep", "hrv", "resting_hr", "recovery"] as const) await storeRows(db, kek, id, g, rows[g]);
  const t0 = Date.now();
  const b = await todaysBrief(db, kek, model, id);
  log("brief", { ms: Date.now() - t0, ...b });
  log("agent_spent_micro", session.spent);
} catch (e: any) {
  log("error", String(e?.stack ?? e).slice(0, 1200));
} finally {
  writeFileSync(`test-results/pattern-live-${Date.now()}.json`, JSON.stringify(out, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
  server.close();
  process.exit(0);
}
