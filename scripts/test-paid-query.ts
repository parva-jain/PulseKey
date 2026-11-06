// Live Hedera testnet run of route 1: a seeded pool behind the real API, and the buyer agent paying real USDC.
// Checks: refusal costs nothing, quote and answer settle, a retry with the same payment id replays without paying,
// balances move by exactly what was charged, and the ledger pays everyone counted.
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { PrivateKey } from "@x402/hedera";

process.env.PER_PERSON_MICRO ??= "5000"; // $0.005 a person keeps testnet faucet money lasting; production pricing is separate
const { openDb } = await import("../src/db/index.js");
const { createApi } = await import("../src/api/app.js");
const { seedPool } = await import("../src/pool/seed.js");
const { today } = await import("../src/pool/store.js");
const { buildPayingFetch, openSpendLog, runAgent } = await import("../src/x402/agent.js");
const { usdcMicroBalance } = await import("../src/hedera/accounts.js");
const { hashscanUrl, mirrorConfirms } = await import("../src/x402/server.js");

const FAC = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const PORT = 4022, BASE = `http://localhost:${PORT}`;
const buyer = process.env.BUYER_ACCOUNT_ID!, payTo = process.env.STUDY_ACCOUNT_ID!;
const out: Record<string, unknown> = { facilitator: FAC, at: new Date().toISOString() };
const log = (k: string, v: unknown) => { out[k] = v; console.log(k, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))); };
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const db = await openDb();
const kek = randomBytes(32);
console.log("seeding 200 synthetic people...");
await seedPool(db, kek, { people: 200, days: 90, on: today() });
const server = createApi(db, kek, new HTTPFacilitatorClient({ url: FAC, timeoutMs: 60_000 }), { baseUrl: BASE, payTo }).listen(PORT);

const key = PrivateKey.fromStringECDSA(process.env.BUYER_PRIVATE_KEY!);
const session = { spent: 0n };
const audit = await openSpendLog(buyer, key, { asset: "0.0.429274", maxSessionMicro: "5000000", maxPerPaymentMicro: "5000000", allowPayTo: [payTo] });
session.spent = audit?.spent ?? 0n;
const payFetch = (pid: string) => buildPayingFetch({ accountId: buyer, key, maxSpendMicro: 5_000_000n, session, allowPayTo: [payTo], paymentId: () => pid, audit: audit?.log }) as typeof fetch;

try {
  const before = { buyer: await usdcMicroBalance(buyer), payTo: await usdcMicroBalance(payTo) };
  log("balances_before", before);

  // A valid spec without payment gets the 402 price quote; the group check happens in the handler, after signing but before settling.
  const refused = await fetch(`${BASE}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metric: "hrv_ms", stat: "mean", from: day(2), to: day(1) }) });
  log("unpaid_quote_status", refused.status); // 402: the spec is valid, so the agent is asked to pay

  const results = await runAgent(BASE, payFetch, [
    { why: "Typical nightly sleep over the last 30 days", spec: { metric: "sleep_minutes", stat: "mean", from: day(30), to: day(1) }, maxPriceMicro: 2_000_000n },
    { why: "Share of people averaging HRV under 40 ms", spec: { metric: "hrv_ms", stat: "share_below", threshold: 40, from: day(30), to: day(1) }, maxPriceMicro: 2_000_000n },
    { why: "Too narrow to answer safely (expect a free refusal after the quote)", spec: { metric: "hrv_ms", stat: "mean", from: day(2), to: day(1) }, maxPriceMicro: 2_000_000n },
  ]);
  log("agent", results.map(r => ({ why: r.ask.why, quote: r.quote && { price: r.quote.priceUsd, about: r.quote.eligibleAbout }, answer: (r as any).answer, tx: (r as any).receipt?.transaction, skipped: (r as any).skipped })));

  const first = results.find(r => "answer" in r) as any;
  const replay = await payFetch(first.paymentId)(`${BASE}/queries`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: first.quote.quoteId }) });
  const replayBody = await replay.json();
  log("retry_same_payment_id", { status: replay.status, replay: replayBody.replay, sameAnswer: replayBody.value === first.answer.value });

  const fresh = await payFetch(crypto.randomUUID().replace(/-/g, ""))(`${BASE}/queries`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteId: first.quote.quoteId }) });
  log("reuse_quote_new_payment", { status: fresh.status, body: await fresh.text() }); // 409, and no settlement

  const charged = results.reduce((a, r: any) => a + (r.quote ? 20_000n : 0n) + (r.answer ? BigInt(r.quote.priceMicro) : 0n), 0n);
  for (const r of results as any[]) if (r.receipt?.transaction) log(`hashscan_${r.answer.metric}`, hashscanUrl(r.receipt.transaction));
  for (const r of results as any[]) if (r.receipt?.transaction) log(`mirror_${r.answer.metric}`, await mirrorConfirms(r.receipt.transaction, payTo, "0.0.429274", r.quote.priceMicro));
  await new Promise(r => setTimeout(r, 5000));
  const after = { buyer: await usdcMicroBalance(buyer), payTo: await usdcMicroBalance(payTo) };
  log("balances_after", after);
  log("charged_expected", { charged, agentSessionSpent: session.spent, buyerDelta: before.buyer - after.buyer, payToDelta: after.payTo - before.payTo });

  const { rows } = await db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM queries GROUP BY status");
  log("queries_by_status", rows);
  const ledger = await db.query<{ query_id: string; earners: number; earned: string; platform: string; price: string }>(`
    SELECT q.id AS query_id, count(*) FILTER (WHERE l.kind = 'earning')::int AS earners,
           coalesce(sum(l.micro) FILTER (WHERE l.kind = 'earning'), 0)::text AS earned,
           coalesce(sum(l.micro) FILTER (WHERE l.kind = 'platform'), 0)::text AS platform, q.price_micro::text AS price
      FROM queries q JOIN ledger l ON l.query_id = q.id GROUP BY q.id`);
  log("ledger", ledger.rows.map(r => ({ ...r, adds_up: BigInt(r.earned) + BigInt(r.platform) === BigInt(r.price) })));
} catch (e: any) {
  log("error", String(e?.stack ?? e).slice(0, 800));
} finally {
  writeFileSync(`test-results/paid-query-${Date.now()}.json`, JSON.stringify(out, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
  server.close();
  process.exit(0);
}
