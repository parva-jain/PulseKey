// agent.ts: discovers the pool, buys quotes and answers within its own budget, with no human in the loop.
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { appendPaymentIdentifierToExtensions, generatePaymentId } from "@x402/extensions/payment-identifier";
import { Client } from "@hiero-ledger/sdk";
import { hcsSink, readTopic, replay, sha256, SpendLog, type Policy } from "../hedera/audit.js";

const USDC = "0.0.429274";

export function buildPayingFetch(opts: { accountId: string; key: PrivateKey; maxSpendMicro: bigint; session?: { spent: bigint }; allowPayTo?: string[]; fetchImpl?: typeof fetch; paymentId?: () => string | undefined; audit?: SpendLog }) {
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
    .onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements: r }) => {
      const id = opts.paymentId?.();
      if (id && paymentRequired.extensions) appendPaymentIdentifierToExtensions(paymentRequired.extensions, id);
      // Logged before signing: if the public log cannot be written, the agent does not pay.
      try {
        await opts.audit?.append("pay.intent", { merchant: r.payTo, asset: r.asset, amount: r.amount, reqHash: call.reqHash, pid: id });
      } catch {
        return { abort: true as const, reason: "audit_log_unavailable" };
      }
    })
    .onAfterPaymentCreation(async ({ selectedRequirements: r }) => {
      call.signed = BigInt(r.amount);
      call.merchant = r.payTo;
    });
  // A signed payment only costs money once the server settles it, which the PAYMENT-RESPONSE header confirms.
  // Refusals and replays come back without one, so they do not use up the budget.
  let call = { signed: 0n, merchant: "", reqHash: "" };
  const paying = wrapFetchWithPayment(opts.fetchImpl ?? fetch, client);
  const note = async (...a: Parameters<SpendLog["append"]>) => {
    // Money has already moved or been refused by now, so a failed write is reported, not thrown. Reconciliation catches the gap.
    try { await opts.audit?.append(...a); } catch (e) { console.error("audit write failed:", String(e)); }
  };
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    call = { signed: 0n, merchant: "", reqHash: sha256(`${init?.method ?? "GET"} ${String(input)} ${init?.body ?? ""}`) };
    const base = { reqHash: call.reqHash, pid: opts.paymentId?.() };
    let res: Response;
    try {
      res = await paying(input, init);
    } catch (e) {
      // Thrown before signing means a policy (budget, asset, payee, per-payment cap) or the log refused it.
      await note(call.signed ? "pay.failed" : "pay.denied", { ...base, reason: String((e as Error)?.message ?? e).slice(0, 160) });
      throw e;
    }
    const receipt = readReceipt(res) as { success?: boolean; transaction?: string } | null;
    if (receipt?.success) {
      session.spent += call.signed;
      await note("pay.settled", { ...base, merchant: call.merchant, asset: USDC, amount: call.signed.toString(), tx: receipt.transaction });
    } else if (call.signed) {
      await note("pay.failed", { ...base, amount: call.signed.toString(), reason: `not_charged_http_${res.status}` });
    }
    return res;
  };
}

/** A question the agent wants answered, plus the most it will pay for the answer. */
export type Ask = { why: string; spec: Record<string, unknown>; maxPriceMicro: bigint };

/**
 * Finds the service from its free catalog, then for each ask: pays $0.02 for a quote, checks the quoted price
 * against its own limit, and pays for the answer. Spending rules live in code, outside any model.
 */
export async function runAgent(baseUrl: string, payFetch: (paymentId: string) => typeof fetch, asks: Ask[], log = console.log, audit?: SpendLog) {
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
      await audit?.append("pay.denied", { merchant: catalog.x402.payTo, asset: catalog.x402.asset, amount: q.priceMicro, reqHash: sha256(q.quoteId), reason: "over_question_limit" });
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
    const shown = answer.answer
      ? `yes ${answer.answer.label.yes}, no ${answer.answer.label.no}, unclear ${answer.answer.label.unclear} (±${answer.answer.plusMinus95} points; ${answer.sealedReads} sealed reads, ${answer.labelsReused}+ saved labels)`
      : `${answer.value} ${answer.unit} (±${answer.plusMinus95}, 95% noise range)`;
    log(`  answer: ${shown}, ${answer.peopleAbout}+ people`);
    log(`  paid $${q.priceUsd}: ${receipt?.transaction}`);
    out.push({ ask, quote: q, answer, receipt, paymentId: pid });
  }
  return out;
}

/**
 * Opens the agent's log on HCS_TOPIC_ID, if set: resumes the hash chain, commits the policy if it changed,
 * and returns what was already spent under it, so a restart cannot reset the budget.
 */
export async function openSpendLog(account: string, key: PrivateKey, policy: Policy, topicId = process.env.HCS_TOPIC_ID) {
  if (!topicId) return null;
  const client = Client.forTestnet().setOperator(account, key);
  const log = new SpendLog(hcsSink(client, topicId, key), "pulsekey-coach-agent", account);
  const spent = log.resume(replay(await readTopic(topicId), account));
  const before = log.policy;
  await log.setPolicy(policy);
  // A changed policy starts a new budget, and the change itself is public.
  return { log, client, spent: log.policy === before ? spent : 0n, topicId };
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
    // A pattern inside each person's own nights, read by a sealed model on 0G: does a short night pull next-day HRV down?
    { why: "Does HRV drop the night after people sleep less?", spec: { route: "pattern", template: { id: "lead_lag_v1", leading: "sleep_minutes", leadDirection: "falls", outcome: "hrv_ms", outcomeDirection: "falls", lagNights: 1 }, from: day(60), to: day(1) }, maxPriceMicro: 3_000_000n },
  ];
  const key = PrivateKey.fromStringECDSA(process.env.BUYER_PRIVATE_KEY!);
  const account = process.env.BUYER_ACCOUNT_ID!;
  const allowPayTo = process.env.ALLOW_PAY_TO?.split(",");
  const policy: Policy = { asset: USDC, maxSessionMicro: "10000000", maxPerPaymentMicro: "5000000", allowPayTo: allowPayTo ?? null };
  const audit = await openSpendLog(account, key, policy);
  const session = { spent: audit?.spent ?? 0n };
  const payFetch = (paymentId: string) => buildPayingFetch({
    paymentId: () => paymentId,
    accountId: account,
    key,
    maxSpendMicro: BigInt(policy.maxSessionMicro),
    session,
    allowPayTo,
    audit: audit?.log,
  }) as typeof fetch;
  const out = await runAgent(process.env.API_BASE ?? "http://localhost:4021", payFetch, asks, console.log, audit?.log);
  console.log(`\nspent this session: $${Number(session.spent) / 1e6}`);
  for (const o of out) if ("receipt" in o && o.receipt?.transaction) console.log("HashScan:", `https://hashscan.io/testnet/transaction/${String(o.receipt.transaction).replace("@", "-").replace(/\.(\d+)$/, "-$1")}`);
}
