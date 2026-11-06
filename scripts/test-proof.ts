// Proof pages with a scripted model and faked public sources (mirror node, 0G identity): what is shown, what
// is withheld before settlement, that verdicts pass through untouched, that unlogged spending is caught, and escaping.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db/index.js";
import { createApi } from "../src/api/app.js";
import { scriptedModel } from "../src/ai/model.js";
import { seedPool } from "../src/pool/seed.js";
import { addDays, today } from "../src/pool/store.js";
import * as q from "../src/pool/query.js";
import * as p from "../src/pool/pattern.js";
import { SpendLog } from "../src/hedera/audit.js";
import { agentAudit, queryProof } from "../src/proof/index.js";
import { agentAuditHtml } from "../src/proof/html.js";

const kek = randomBytes(32);
const PAY_TO = "0.0.7", USDC = "0.0.429274";
const db = await openDb();
await seedPool(db, kek, { people: 25, days: 60, on: today() });

const verdicts = { quote_dcap: "pass", onchain_signer: "pass", measurement: "pass", runtime_release: "not_checked", compose_baseline: "no_baseline" };
let priceForMirror = "0";
const fakeFetch = (async (url: string) => {
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("/gateway/identity")) return json({ matched_release: { tag: "release-x", url: "https://example/r" }, compose_hash: "abc", os_image: "dstack", verify: "self-reported" });
  if (url.includes("/identity")) return json({ verdicts, compose_hash: "def", os_image: "dstack-nvidia" });
  if (url.includes("/transactions/")) return json({ transactions: [{ result: "SUCCESS", consensus_timestamp: "1793900000.000000000", token_transfers: [{ token_id: USDC, account: PAY_TO, amount: Number(priceForMirror) }, { token_id: USDC, account: "0.0.2", amount: -Number(priceForMirror) }] }] });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const model = scriptedModel(() => '{"answer":"yes"}');
const spec = p.parsePatternSpec({ route: "pattern", template: { id: "lead_lag_v1", leading: "sleep_minutes", leadDirection: "falls", outcome: "hrv_ms", outcomeDirection: "falls", lagNights: 1 }, from: addDays(today(), -45), to: addDays(today(), -1) });
const quote = await p.quotePattern(db, model, spec);
const res = await p.runPattern(db, kek, model, quote.quoteId, "pid-1");
priceForMirror = quote.priceMicro;

const app = createApi(db, kek, { getSupported: async () => ({ kinds: [], extensions: [], signers: {} }) } as any, { baseUrl: "http://x", payTo: PAY_TO, model, proofDeps: { fetchImpl: fakeFetch } });
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("before settlement the proof withholds the answer", async () => {
  const pending = await queryProof(db, res.queryId, { payTo: PAY_TO, asset: USDC, fetchImpl: fakeFetch });
  assert.equal(pending!.status, "pending");
  assert.equal(pending!.answer, null);
});

test("after settlement: answer, exact on-chain payment, a split that adds up, sealed reads and 0G verdicts as given", async () => {
  await q.settleQuery(db, res.queryId, { tx: "0.0.9@1793900000.1", payer: "0.0.2" });
  const pr = (await (await fetch(`${base}/proof/queries/${res.queryId}`)).json()) as any;
  assert.equal(pr.status, "answered");
  assert.ok(pr.answer.answer.label.yes);
  assert.equal(pr.payment.onChain.found, true);
  assert.equal(pr.payment.onChain.creditedMicro, quote.priceMicro);
  assert.equal(pr.split.addsUp, true);
  assert.equal(pr.split.peoplePaidAbout % 10, 0, "rounded like every other count");
  assert.equal(pr.sealedReads.count, res.sealedReads);
  assert.deepEqual(pr.sealedReads.attestation.providers[0].verdicts, verdicts, "verdicts are passed through, not upgraded");
  assert.match(pr.sealedReads.attestation.verifyYourself, /pcverify -gateway router-api\.0g\.ai -strict/);
  assert.ok(!JSON.stringify(pr).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)!.some(u => u !== res.queryId && u !== quote.quoteId && !pr.sealedReads.requestIds.includes(u)), "no contributor id appears");

  const html = await (await fetch(`${base}/proof/queries/${res.queryId}`, { headers: { accept: "text/html" } })).text();
  assert.match(html, /Query proof/);
  assert.match(html, /confirmed on the mirror node/);
  assert.match(html, /no_baseline/);
});

test("bad and unknown ids, and the agent page without a topic", async () => {
  assert.equal((await fetch(`${base}/proof/queries/nope`)).status, 400);
  assert.equal((await fetch(`${base}/proof/queries/00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await fetch(`${base}/proof/agent`)).status, 400);
});

test("agent audit: intact chain, matched settlements, and money that left without a log entry is caught", async () => {
  const messages: string[] = [];
  const log = new SpendLog({ submit: async m => { messages.push(m); } }, "agent", "0.0.2");
  await log.setPolicy({ asset: USDC, maxSessionMicro: "1", maxPerPaymentMicro: "1", allowPayTo: [PAY_TO] });
  await log.append("pay.intent", { amount: "20000" });
  await log.append("pay.settled", { amount: "20000", tx: "0.0.9@100.1", merchant: PAY_TO });
  const debits = async () => [{ tx: "0.0.9-100-1", micro: 20_000n, at: "" }, { tx: "0.0.9-200-2", micro: 5_000n, at: "" }];
  const a = await agentAudit("0.0.55", "0.0.2", { read: async () => messages, debits });
  assert.equal(a.chain.intact, true);
  assert.equal(a.reconciliation.matched, 1);
  assert.equal(a.reconciliation.ok, false);
  assert.deepEqual(a.reconciliation.unlogged.map(u => u.tx), ["0.0.9-200-2"]);
  assert.equal(a.reconciliation.actualDebitsMicro, "25000");

  await log.append("pay.denied", { reason: "<script>alert(1)</script>" });
  const html = agentAuditHtml(await agentAudit("0.0.55", "0.0.2", { read: async () => messages, debits }));
  assert.ok(!html.includes("<script>alert"), "escaped");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /1 unlogged/);
});
