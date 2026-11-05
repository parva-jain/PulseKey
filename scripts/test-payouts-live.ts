// Live Hedera testnet run of payouts and the agent's spending log: the agent pays with every step logged on
// HCS, one real contributor claims to a fresh account, seed shares sweep to the treasury, and the log is
// reconciled against the buyer's actual USDC movements on the mirror node.
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { Client, PrivateKey } from "@hiero-ledger/sdk";

process.env.PER_PERSON_MICRO ??= "1000"; // $0.001 a person keeps faucet money lasting
process.env.MIN_CLAIM_MICRO ??= "100";
const { openDb } = await import("../src/db/index.js");
const { createApi } = await import("../src/api/app.js");
const { seedPool, syntheticPerson } = await import("../src/pool/seed.js");
const { addDays, createContributor, setGrant, storeRows, today } = await import("../src/pool/store.js");
const { buildPayingFetch, openSpendLog, runAgent } = await import("../src/x402/agent.js");
const { usdcMicroBalance, USDC_TESTNET } = await import("../src/hedera/accounts.js");
const { balanceMicro, claim, hederaPayouts, sweepSeedShares } = await import("../src/pool/payouts.js");
const { readTopic, reconcile, replay, usdcDebits } = await import("../src/hedera/audit.js");
const { hashscanUrl } = await import("../src/x402/server.js");

const FAC = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const PORT = 4023, BASE = `http://localhost:${PORT}`;
const buyer = process.env.BUYER_ACCOUNT_ID!, payTo = process.env.STUDY_ACCOUNT_ID!, treasury = process.env.DEMO_TREASURY_ID!;
const out: Record<string, unknown> = { facilitator: FAC, at: new Date().toISOString() };
const log = (k: string, v: unknown) => { out[k] = v; console.log(k, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))); };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const day = (n: number) => addDays(today(), -n);

const db = await openDb();
const kek = randomBytes(32);
console.log("seeding 200 synthetic people and one real contributor...");
await seedPool(db, kek, { people: 200, days: 90, on: today() });
const real = await createContributor(db, kek, "real");
await setGrant(db, real, { groups: ["sleep", "hrv", "resting_hr", "recovery"], historyDays: 90, validDays: 30 });
const rows = syntheticPerson(4242, day(90), day(1));
for (const grp of ["sleep", "hrv", "resting_hr", "recovery"] as const) await storeRows(db, kek, real, grp, rows[grp]);
const server = createApi(db, kek, new HTTPFacilitatorClient({ url: FAC, timeoutMs: 60_000 }), { baseUrl: BASE, payTo }).listen(PORT);

const key = PrivateKey.fromStringECDSA(process.env.BUYER_PRIVATE_KEY!);
const policy = { asset: USDC_TESTNET, maxSessionMicro: "5000000", maxPerPaymentMicro: "5000000", allowPayTo: [payTo] };
const study = Client.forTestnet().setOperator(payTo, PrivateKey.fromStringECDSA(process.env.STUDY_PRIVATE_KEY!));

try {
  const audit = (await openSpendLog(buyer, key, policy))!;
  log("audit_resumed", { topic: audit.topicId, entries: audit.log.n, spentUnderPolicy: audit.spent });
  const startedAt = new Date().toISOString();
  const session = { spent: audit.spent };
  const payFetch = (pid: string) => buildPayingFetch({ accountId: buyer, key, maxSpendMicro: BigInt(policy.maxSessionMicro), session, allowPayTo: [payTo], paymentId: () => pid, audit: audit.log }) as typeof fetch;
  const before = { buyer: await usdcMicroBalance(buyer), study: await usdcMicroBalance(payTo), treasury: await usdcMicroBalance(treasury) };
  log("balances_before", before);

  const results = await runAgent(BASE, payFetch, [
    { why: "Typical nightly sleep over the last 30 days", spec: { metric: "sleep_minutes", stat: "mean", from: day(30), to: day(1) }, maxPriceMicro: 2_000_000n },
    { why: "Deliberately over the per-question limit, to log a denial", spec: { metric: "hrv_ms", stat: "mean", from: day(30), to: day(1) }, maxPriceMicro: 1_000n },
  ], console.log, audit.log);
  log("agent", results.map((r: any) => ({ why: r.ask.why, price: r.quote?.priceUsd, answer: r.answer && `${r.answer.value} ±${r.answer.plusMinus95}`, tx: r.receipt?.transaction, skipped: r.skipped })));

  // Claim: the browser would generate this key and keep it; only the public half reaches us.
  const owed = await balanceMicro(db, real);
  const browserKey = PrivateKey.generateECDSA();
  const chain = hederaPayouts(study, payTo);
  const c = await claim(db, chain, real, browserKey.publicKey.toStringDer());
  log("claim", { owed, ...c, hashscan: hashscanUrl(c.tx) });
  const s = await sweepSeedShares(db, chain, treasury);
  log("seed_sweep", s && { ...s, hashscan: hashscanUrl(s.tx) });
  await assertRefused(() => claim(db, chain, real, PrivateKey.generateECDSA().publicKey.toStringDer()), "nothing_to_claim");

  await wait(8000); // mirror node lag
  log("new_account_usdc", { account: c.accountId, balance: await usdcMicroBalance(c.accountId), expected: c.micro });
  const after = { buyer: await usdcMicroBalance(buyer), study: await usdcMicroBalance(payTo), treasury: await usdcMicroBalance(treasury) };
  log("balances_after", after);
  log("deltas", { buyerPaid: before.buyer - after.buyer, agentCounted: session.spent - audit.spent, treasuryGot: after.treasury - before.treasury, sweep: s?.micro });

  const messages = await readTopic(audit.topicId);
  const state = replay(messages, buyer);
  const mine = messages.map(m => JSON.parse(m)).filter((e: any) => e.at >= startedAt);
  log("topic", { total: messages.length, chainBreaks: state.breaks, thisRun: mine.map((e: any) => `${e.n} ${e.ev}${e.amount ? " " + e.amount : ""}${e.reason ? " " + e.reason : ""}`) });
  const rec = reconcile(state.settled.filter(e => e.at >= startedAt), await usdcDebits(buyer, startedAt));
  log("reconcile", { matched: rec.matched.length, unlogged: rec.unlogged, unbacked: rec.unbacked });
  log("hashscan_topic", `https://hashscan.io/testnet/topic/${audit.topicId}`);
  audit.client.close();
} catch (e: any) {
  log("error", String(e?.stack ?? e).slice(0, 1200));
} finally {
  writeFileSync(`test-results/payouts-live-${Date.now()}.json`, JSON.stringify(out, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
  study.close();
  server.close();
  process.exit(0);
}

async function assertRefused(f: () => Promise<unknown>, code: string) {
  try { await f(); log(`refused_${code}`, false); } catch (e: any) { log(`refused_${code}`, e?.code === code); }
}
