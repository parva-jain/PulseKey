// agent.ts: discovers the pool, buys quotes and answers within its own budget, with no human in the loop.
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { appendPaymentIdentifierToExtensions, generatePaymentId } from "@x402/extensions/payment-identifier";

const USDC = "0.0.429274";

export function buildPayingFetch(opts: { accountId: string; key: PrivateKey; maxSpendMicro: bigint; session?: { spent: bigint }; allowPayTo?: string[]; fetchImpl?: typeof fetch; paymentId?: () => string | undefined }) {
  // The session object is shared across purchases, so the budget covers the whole run, not one call.
  const session = opts.session ?? { spent: 0n };
  const signer = createClientHederaSigner(opts.accountId, opts.key, { network: "hedera:testnet" });
  const client = new x402Client()
    .register("hedera:*", new ExactHederaScheme(signer))
    // The SDK default is a $1 cap per payment, which would reject most queries before any signing.
    .setSpendControls({ maxAmountPerPayment: "$5" })
    // Session budget and allowlist: the buyer side of the spending limit.
    .registerPolicy((_v, reqs) => reqs.filter(r => r.asset === USDC))
    .registerPolicy((_v, reqs) => reqs.filter(r => !opts.allowPayTo || opts.allowPayTo.includes(r.payTo)))
    .registerPolicy((_v, reqs) => reqs.filter(r => session.spent + BigInt(r.amount) <= opts.maxSpendMicro))
    // Same id on every retry of one logical purchase, so a dropped response cannot pay twice.
    .onBeforePaymentCreation(async ({ paymentRequired }) => {
      const id = opts.paymentId?.();
      if (id && paymentRequired.extensions) appendPaymentIdentifierToExtensions(paymentRequired.extensions, id);
    })
    .onAfterPaymentCreation(async ({ selectedRequirements }) => {
      signed = BigInt(selectedRequirements.amount);
    });
  // A signed payment only costs money once the server settles it, which the PAYMENT-RESPONSE header confirms.
  // Refusals and replays come back without one, so they do not use up the budget.
  let signed = 0n;
  const paying = wrapFetchWithPayment(opts.fetchImpl ?? fetch, client);
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    signed = 0n;
    const res = await paying(input, init);
    const receipt = readReceipt(res) as { success?: boolean } | null;
    if (receipt?.success) session.spent += signed;
    return res;
  };
}

/** A question the agent wants answered, plus the most it will pay for the answer. */
export type Ask = { why: string; spec: Record<string, unknown>; maxPriceMicro: bigint };

/**
 * Finds the service from its free catalog, then for each ask: pays $0.02 for a quote, checks the quoted price
 * against its own limit, and pays for the answer. Spending rules live in code, outside any model.
 */
export async function runAgent(baseUrl: string, payFetch: (paymentId: string) => typeof fetch, asks: Ask[], log = console.log) {
  const catalog = await (await fetch(`${baseUrl}/.well-known/x402`)).json();
  const quoteEp = catalog.endpoints.find((e: any) => e.url.endsWith("/quote"));
  const queryEp = catalog.endpoints.find((e: any) => e.url.endsWith("/queries"));
  log(`found ${catalog.service}: pays ${catalog.x402.asset} to ${catalog.x402.payTo} on ${catalog.x402.network}`);
  const post = (f: typeof fetch, url: string, body: unknown) =>
    f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const out = [];
  for (const ask of asks) {
    log(`\nask: ${ask.why}`);
    const qRes = await post(payFetch(generatePaymentId()), quoteEp.url, ask.spec);
    if (!qRes.ok) {
      out.push({ ask, skipped: `quote refused: ${qRes.status} ${await qRes.text()}` });
      log(`  quote refused (${qRes.status}), nothing charged`);
      continue;
    }
    const q = await qRes.json();
    log(`  quote: about ${q.eligibleAbout}+ people, $${q.priceUsd}, paid $0.02 (${readReceipt(qRes)?.transaction})`);
    if (BigInt(q.priceMicro) > ask.maxPriceMicro) {
      out.push({ ask, quote: q, skipped: "over this question's price limit" });
      log(`  over my limit of $${Number(ask.maxPriceMicro) / 1e6}, skipping`);
      continue;
    }
    // One payment id per logical purchase: a retry after a lost response returns the same answer without paying twice.
    const pid = generatePaymentId();
    const aRes = await post(payFetch(pid), queryEp.url, { quoteId: q.quoteId });
    if (!aRes.ok) throw new Error(`query failed ${aRes.status}: ${await aRes.text()}`);
    const answer = await aRes.json();
    const receipt = readReceipt(aRes);
    log(`  answer: ${answer.value} ${answer.unit} (±${answer.plusMinus95}, 95% noise range), ${answer.peopleAbout}+ people`);
    log(`  paid $${q.priceUsd}: ${receipt?.transaction}`);
    out.push({ ask, quote: q, answer, receipt, paymentId: pid });
  }
  return out;
}

function readReceipt(res: Response) {
  const h = res.headers.get("PAYMENT-RESPONSE");
  return h ? decodePaymentResponseHeader(h) : null;
}

if (process.argv[1]?.endsWith("agent.ts")) {
  // The coach story: a health-coach agent wants population context for a client, with a hard budget and no human approving.
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const asks: Ask[] = [
    { why: "What is typical nightly sleep across ring wearers over the last 30 days?", spec: { metric: "sleep_minutes", stat: "mean", from: day(30), to: day(1) }, maxPriceMicro: 3_000_000n },
    { why: "What share of people average HRV under 40 ms?", spec: { metric: "hrv_ms", stat: "share_below", threshold: 40, from: day(30), to: day(1) }, maxPriceMicro: 3_000_000n },
  ];
  const key = PrivateKey.fromStringECDSA(process.env.BUYER_PRIVATE_KEY!);
  const session = { spent: 0n };
  const payFetch = (paymentId: string) => buildPayingFetch({
    paymentId: () => paymentId,
    accountId: process.env.BUYER_ACCOUNT_ID!,
    key,
    maxSpendMicro: 10_000_000n,
    session,
    allowPayTo: process.env.ALLOW_PAY_TO?.split(","),
  }) as typeof fetch;
  const out = await runAgent(process.env.API_BASE ?? "http://localhost:4021", payFetch, asks);
  console.log(`\nspent this session: $${Number(session.spent) / 1e6}`);
  for (const o of out) if ("receipt" in o && o.receipt?.transaction) console.log("HashScan:", `https://hashscan.io/testnet/transaction/${String(o.receipt.transaction).replace("@", "-").replace(/\.(\d+)$/, "-$1")}`);
}
