// server.ts: Express 5 + @x402/express 2.30.0 on Hedera testnet.
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type HTTPRequestContext } from "@x402/core/server";
import {
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { Transaction } from "@x402/hedera";

const NETWORK = "hedera:testnet" as const;
const USDC = "0.0.429274"; // Circle testnet USDC, 6 decimals
const PAY_TO = process.env.STUDY_ACCOUNT_ID ?? "0.0.1234"; // must be associated with USDC
const BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:4021";
const MIN_BUDGET_MICRO = 5_000_000n;
const MAX_BUDGET_MICRO = 1_000_000_000n;

/** "60" or "60.50" to micro-USDC, with no floats. Returns null when malformed. */
export function usdToMicro(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^\d+(\.\d{1,6})?$/.test(v)) return null;
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

/** Dynamic price: reads the body parsed by express.json(). Must be deterministic. */
function studyPrice(ctx: HTTPRequestContext) {
  const body = ctx.adapter.getBody?.() as { budgetUsd?: string } | undefined;
  const micro = usdToMicro(body?.budgetUsd);
  if (micro === null) throw new Error("budgetUsd missing; validateStudy must run first");
  return { amount: micro.toString(), asset: USDC, extra: {} };
}

/** Runs BEFORE the payment middleware, so a bad request gets 400 and never a 402. */
function validateStudy(req: Request, res: Response, next: NextFunction) {
  const micro = usdToMicro(req.body?.budgetUsd);
  if (micro === null) return void res.status(400).json({ error: "budgetUsd must be a decimal string" });
  if (micro < MIN_BUDGET_MICRO || micro > MAX_BUDGET_MICRO)
    return void res.status(422).json({ error: "budget_out_of_range" });
  if (!req.body?.spec) return void res.status(400).json({ error: "spec required" });
  next();
}

/** The Hedera transaction id is fixed by the client, so we can read it from the signed bytes. */
export function txIdOfPayload(payload: { payload: Record<string, unknown> }): string {
  const bytes = Buffer.from(payload.payload.transaction as string, "base64");
  return Transaction.fromBytes(bytes).transactionId!.toString();
}
/** 0.0.1@1.2 becomes 0.0.1-1-2, the form the mirror node and HashScan both accept. */
const dashed = (txId: string) => txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
export const hashscanUrl = (txId: string) => `https://hashscan.io/testnet/transaction/${dashed(txId)}`;
export function decodeHeader(header: string) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

/** Did this exact transaction reach consensus and credit payTo? */
export async function mirrorConfirms(txId: string, payTo: string, asset: string, amount: string) {
  const id = dashed(txId);
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${id}`);
    if (r.ok) {
      const { transactions } = (await r.json()) as { transactions: any[] };
      const ok = transactions.find(t => t.result === "SUCCESS" && t.name === "CRYPTOTRANSFER");
      const credit = ok?.token_transfers?.find((t: any) => t.token_id === asset && t.account === payTo);
      const debit = ok?.token_transfers?.find((t: any) => t.token_id === asset && t.amount < 0);
      if (credit && String(credit.amount) === amount) return { payer: debit?.account as string };
      if (transactions.length && !ok) return null; // reached consensus but failed
    }
    await new Promise(res => setTimeout(res, 2000));
  }
  return null;
}

type Study = { id: string; status: string; budgetUsd: string; spec: unknown; paymentTx: string; payer?: string };
export const studies = new Map<string, Study>();
const studyByTx = new Map<string, string>(); // use a UNIQUE constraint on payment_tx in a real DB
const studyByPaymentId = new Map<string, string>(); // and on payment_id
export const refundDue: Array<{ tx: string; payer?: string; reason: string }> = [];

export function createApp(facilitator: FacilitatorClient, opts: { failPlanner?: boolean; failCreate?: boolean; baseUrl?: string; confirm?: typeof mirrorConfirms } = {}) {
  const base = opts.baseUrl ?? BASE_URL;
  const resourceServer = new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactHederaScheme())
    .onAfterSettle(async ({ result, phase, transportContext }) => {
      // The Express adapter holds req; the official payment-identifier example also reads adapter.req.
      const ctx = transportContext as { request?: { adapter?: { req?: Request & { x402?: unknown } } } };
      if (ctx?.request?.adapter?.req) ctx.request.adapter.req.x402 = result;
      console.log(`[x402] settled phase=${phase} tx=${result.transaction} payer=${result.payer}`);
    })
    // A settle timeout or a duplicate may still mean the money moved, so ask the ledger before saying "failed".
    .onSettleFailure(async ({ paymentPayload, requirements, transportContext }) => {
      const txId = txIdOfPayload(paymentPayload as any);
      const hit = await (opts.confirm ?? mirrorConfirms)(txId, requirements.payTo, requirements.asset, requirements.amount);
      if (!hit) return;
      const result = { success: true, transaction: txId, network: requirements.network, payer: hit.payer };
      const ctx = transportContext as { request?: { adapter?: { req?: Request & { x402?: unknown } } } };
      if (ctx?.request?.adapter?.req) ctx.request.adapter.req.x402 = result;
      return { recovered: true as const, result };
    });

  const app = express();
  app.use(express.json({ limit: "256kb" })); // must come before paymentMiddleware for getBody()

  // Free catalog: this is the "finds the endpoint" step.
  const catalog = (_req: Request, res: Response) => {
    res.json({
      service: "health-data-pool",
      x402: { version: 2, network: NETWORK, asset: USDC, decimals: 6, payTo: PAY_TO },
      endpoints: [
        { method: "POST", url: `${base}/quote`, price: { type: "fixed", usd: "0.02" }, input: { question: "string" } },
        { method: "POST", url: `${base}/studies`, price: { type: "dynamic", from: "body.budgetUsd", minUsd: "5", maxUsd: "1000" }, input: { quoteId: "string", budgetUsd: "decimal string", spec: "object" }, returns: "202 + studyId + resultUrl" },
      ],
    });
  };
  app.get("/catalog", catalog);
  app.get("/.well-known/x402", catalog);

  app.post("/studies", validateStudy); // pre-payment validation

  const routes = {
    "POST /quote": {
      accepts: {
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        price: { amount: "20000", asset: USDC, extra: {} }, // 0.02 USDC
        maxTimeoutSeconds: 90,
      },
      description: "Plan a study question: eligible count and minimum price",
      mimeType: "application/json",
    },
    "POST /studies": {
      accepts: {
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        price: studyPrice,
        maxTimeoutSeconds: 90,
        extra: { paymentFlow: "upfront" }, // settle first, then run the handler
      },
      description: "Post a study; pays the whole budget",
      mimeType: "application/json",
      extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) },
      settlementFailedResponseBody: async (_ctx: unknown, failure: { errorReason: string }) => ({
        contentType: "application/json",
        body: { error: "payment_failed", reason: failure.errorReason },
      }),
    },
  };

  // Retried logical request with a known payment id: skip payment and let the handler return the same ticket.
  const httpServer = new x402HTTPResourceServer(resourceServer, routes as any).onProtectedRequest(async ctx => {
    if (!ctx.paymentHeader) return;
    try {
      const id = extractPaymentIdentifier(decodeHeader(ctx.paymentHeader));
      if (id && studyByPaymentId.has(id)) return { grantAccess: true };
    } catch {
      // Malformed header: fall through and let normal payment handling reject it.
    }
  });
  app.use(paymentMiddlewareFromHTTPServer(httpServer));

  // Default "authorization" flow: a 500 here means settle never runs and the buyer keeps the 0.02.
  app.post("/quote", async (req, res) => {
    if (opts.failPlanner) return void res.status(500).json({ error: "planner_failed" });
    res.json({ quoteId: randomUUID(), eligible: 48, minPriceUsd: "5.00", spec: { question: req.body?.question } });
  });

  // "upfront" flow: runs only after settlement succeeded.
  app.post("/studies", async (req: Request & { x402?: any }, res) => {
    const paid = decodeHeader(req.header("payment-signature")!);
    const paymentId = extractPaymentIdentifier(paid);
    const known = paymentId && studyByPaymentId.get(paymentId);
    if (known) return void res.status(202).json({ studyId: known, resultUrl: `${base}/studies/${known}`, replay: true });
    const txId = txIdOfPayload(paid);
    const sameTx = studyByTx.get(txId);
    if (sameTx) return void res.status(202).json({ studyId: sameTx, resultUrl: `${base}/studies/${sameTx}`, replay: true });
    try {
      if (opts.failCreate) throw new Error("db down");
      const id = randomUUID();
      studies.set(id, { id, status: "recruiting", budgetUsd: req.body.budgetUsd, spec: req.body.spec, paymentTx: txId, payer: req.x402?.payer });
      studyByTx.set(txId, id);
      if (paymentId) studyByPaymentId.set(paymentId, id);
      res.status(202).location(`/studies/${id}`).json({
        studyId: id,
        status: "recruiting",
        resultUrl: `${base}/studies/${id}`,
        paymentTx: txId,
        hashscan: hashscanUrl(txId),
      });
    } catch (err) {
      refundDue.push({ tx: txId, payer: req.x402?.payer, reason: String(err) }); // money has moved: owe a refund
      res.status(500).json({ error: "study_not_created", refund: "pending", paymentTx: txId });
    }
  });

  // Free poll. A real build should gate this with the buyer's signature or a capability token.
  app.get("/studies/:id", (req, res) => {
    const s = studies.get(req.params.id);
    if (!s) return void res.status(404).json({ error: "not_found" });
    res.status(s.status === "complete" ? 200 : 202).json(s);
  });

  return app;
}

if (process.argv[1]?.endsWith("server.ts")) {
  const url = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
  createApp(new HTTPFacilitatorClient({ url, timeoutMs: 60_000 })).listen(4021, () => console.log(`listening on 4021 via ${url}`));
}
