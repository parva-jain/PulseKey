// Live Hedera testnet test. FULL=1 makes real payments of $0.02 and $5 from the buyer to the study account.
import { writeFileSync } from "node:fs";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { PrivateKey } from "@x402/hedera";
import { generatePaymentId } from "@x402/extensions/payment-identifier";
import { createApp, hashscanUrl } from "../src/x402/server.js";
import { buildPayingFetch, openSpendLog } from "../src/x402/agent.js";
import { usdcMicroBalance } from "../src/hedera/accounts.js";

const FAC = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const PORT = 4021, BASE = `http://localhost:${PORT}`;
const buyer = process.env.BUYER_ACCOUNT_ID!, study = process.env.STUDY_ACCOUNT_ID!;
const out: Record<string, unknown> = { facilitator: FAC };
const log = (k: string, v: unknown) => { out[k] = v; console.log(k, JSON.stringify(v)); };
const dashed = (t: string) => t.replace("@", "-").replace(/\.(\d+)$/, "-$1");
const server = createApp(new HTTPFacilitatorClient({ url: FAC, timeoutMs: 60_000 }), { baseUrl: BASE }).listen(PORT);
await new Promise((r) => setTimeout(r, 500));

const mirrorTx = async (tx: string) => {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const r = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${dashed(tx)}`);
    if (r.ok) { const t = ((await r.json()) as any).transactions?.[0]; if (t) return { result: t.result, fee: t.charged_tx_fee, payerAccount: t.transaction_id?.split("-")[0], usdc: t.token_transfers }; }
  }
  return null;
};

try {
  log("catalog", (await (await fetch(`${BASE}/.well-known/x402`)).json() as any).x402);
  const unpaid = await fetch(`${BASE}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const required = unpaid.headers.get("payment-required");
  log("unpaid_quote", { status: unpaid.status, accepts: required ? JSON.parse(Buffer.from(required, "base64").toString()).accepts : null });

  if (process.env.FULL === "1") {
    const before = { buyer: await usdcMicroBalance(buyer), study: await usdcMicroBalance(study) };
    log("balances_before", { buyer: before.buyer.toString(), study: before.study.toString() });
    if (before.buyer < 5_020_000n) throw new Error("buyer needs at least 5.02 USDC");
    const key = PrivateKey.fromStringECDSA(process.env.BUYER_PRIVATE_KEY!);
    const audit = (await openSpendLog(buyer, key, { asset: "0.0.429274", maxSessionMicro: "25000000", maxPerPaymentMicro: "5000000", allowPayTo: [study] }))?.log;
    const quotePay = buildPayingFetch({ accountId: buyer, key, maxSpendMicro: 25_000_000n, allowPayTo: [study], audit }) as typeof fetch;
    const q = await quotePay(`${BASE}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Does HRV fall before poor sleep?" }) });
    const qr = decodePaymentResponseHeader(q.headers.get("payment-response")!) as any;
    log("paid_quote", { status: q.status, receipt: qr, hashscan: qr?.transaction ? hashscanUrl(qr.transaction) : null });
    log("quote_on_ledger", qr?.transaction ? await mirrorTx(qr.transaction) : null);

    const id = generatePaymentId();
    const studyPay = buildPayingFetch({ accountId: buyer, key, maxSpendMicro: 25_000_000n, allowPayTo: [study], paymentId: () => id, audit }) as typeof fetch;
    const body = JSON.stringify({ quoteId: "test", budgetUsd: "5.00", spec: { template: "test" } });
    const s = await studyPay(`${BASE}/studies`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const sText = await s.text();
    const sh = s.headers.get("payment-response");
    const sr = sh ? (decodePaymentResponseHeader(sh) as any) : null;
    log("upfront_study", { status: s.status, body: sText.slice(0, 400), receipt: sr });
    if (sr?.transaction) log("study_on_ledger", await mirrorTx(sr.transaction));
    const again = await studyPay(`${BASE}/studies`, { method: "POST", headers: { "content-type": "application/json" }, body });
    log("retry_same_payment_id", { status: again.status, body: (await again.text()).slice(0, 200) });
    await new Promise((r) => setTimeout(r, 6000));
    log("balances_after", { buyer: (await usdcMicroBalance(buyer)).toString(), study: (await usdcMicroBalance(study)).toString() });
  }
} catch (e: any) {
  log("error", String(e?.message ?? e).slice(0, 500));
} finally {
  writeFileSync(`test-results/x402-${Date.now()}.json`, JSON.stringify(out, null, 2));
  server.close();
  process.exit(0);
}
