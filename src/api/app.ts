// app: the buyer API. Free catalog, $0.02 quote, then a query priced by its quote. Express 5 + @x402/express 2.30.0 on Hedera testnet.
// Both paid routes use x402's default authorization flow: the handler runs first and settlement happens only on a 2xx,
// so a refusal costs nothing and a failed settlement never releases the answer.
import express, { type NextFunction, type Request, type Response } from "express";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/express";
import type { FacilitatorClient, HTTPRequestContext } from "@x402/core/server";
import { declarePaymentIdentifierExtension, extractPaymentIdentifier, PAYMENT_IDENTIFIER } from "@x402/extensions/payment-identifier";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import type { Db } from "../db/index.js";
import { METRICS } from "../pool/metrics.js";
import { MIN_GROUP, QUERY_EPSILON } from "../pool/privacy.js";
import { answeredByPaymentId, markUnpaid, parseSpec, PER_PERSON_MICRO, quote, quotedPrice, Refused, runQuery, settleQuery } from "../pool/query.js";
import { PATTERN_EPSILON, parsePatternSpec, quotePattern, runPattern } from "../pool/pattern.js";
import { offModel, type SealedModel } from "../ai/model.js";
import { agentAudit, queryProof } from "../proof/index.js";
import { agentAuditHtml, queryProofHtml } from "../proof/html.js";
import { decodeHeader, hashscanUrl, mirrorConfirms, txIdOfPayload } from "../x402/server.js";

const NETWORK = "hedera:testnet" as const;
const USDC = "0.0.429274";

type PaidReq = Request & { queryId?: string; x402?: unknown };
type Ctx = { request?: { adapter?: { req?: PaidReq } } };
const reqOf = (transportContext: unknown) => (transportContext as Ctx)?.request?.adapter?.req;

function paymentIdOf(req: Request) {
  const h = req.header("payment-signature");
  if (!h) return null;
  try {
    return extractPaymentIdentifier(decodeHeader(h)) ?? null;
  } catch {
    return null;
  }
}

function sendRefusal(res: Response, err: unknown) {
  if (err instanceof Refused) return void res.status(err.status).json({ error: err.code });
  throw err;
}

export function createApi(db: Db, kek: Buffer, facilitator: FacilitatorClient, opts: { baseUrl: string; payTo: string; confirm?: typeof mirrorConfirms; model?: SealedModel; audit?: { topicId?: string; account?: string }; proofDeps?: Parameters<typeof agentAudit>[2] & { fetchImpl?: typeof fetch } }) {
  const { baseUrl: base, payTo } = opts;
  const model = opts.model ?? offModel;
  const isPattern = (body: unknown) => (body as { route?: unknown } | undefined)?.route === "pattern";

  const resourceServer = new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactHederaScheme())
    .onAfterSettle(async ({ result, transportContext }) => {
      const req = reqOf(transportContext);
      if (req) req.x402 = result;
      if (req?.queryId) await settleQuery(db, req.queryId, { tx: result.transaction, payer: result.payer });
      console.log(`[x402] settled tx=${result.transaction} payer=${result.payer}${req?.queryId ? ` query=${req.queryId}` : ""}`);
    })
    // A timeout may still mean the money moved, so ask the ledger before calling it failed.
    .onSettleFailure(async ({ paymentPayload, requirements, transportContext }) => {
      const req = reqOf(transportContext);
      const txId = txIdOfPayload(paymentPayload as any);
      const hit = await (opts.confirm ?? mirrorConfirms)(txId, requirements.payTo, requirements.asset, requirements.amount);
      if (!hit) {
        if (req?.queryId) await markUnpaid(db, req.queryId);
        return;
      }
      const result = { success: true, transaction: txId, network: requirements.network, payer: hit.payer };
      if (req) req.x402 = result;
      if (req?.queryId) await settleQuery(db, req.queryId, { tx: txId, payer: hit.payer });
      return { recovered: true as const, result };
    });

  const app = express();
  app.use(express.json({ limit: "32kb" })); // before the payment middleware, so the price function can read the body

  const catalog = (_req: Request, res: Response) => {
    res.json({
      service: "health-data-pool",
      about: "Group answers from consenting ring wearers. You pay for an answer, never for rows. Everyone counted is paid.",
      x402: { version: 2, network: NETWORK, asset: USDC, decimals: 6, payTo },
      privacy: { minGroup: MIN_GROUP, epsilonPerQuery: QUERY_EPSILON, noise: "Laplace on clipped per-person means" },
      endpoints: [
        {
          method: "POST", url: `${base}/quote`, price: { type: "fixed", usd: "0.02" },
          input: { metric: Object.keys(METRICS), stat: ["mean", "share_below", "share_above"], threshold: "number, for share_*", from: "YYYY-MM-DD", to: "YYYY-MM-DD" },
          returns: "quoteId, eligibleAbout, priceUsd, expiresAt (10 minutes)",
        },
        {
          method: "POST", url: `${base}/quote`, price: { type: "fixed", usd: "0.02" }, route: "pattern",
          about: "A pattern inside each person's own series, answered yes / no / unclear per person by a sealed model on 0G, released as noisy shares.",
          available: model.name !== "off",
          input: {
            route: "pattern",
            template: { id: "lead_lag_v1", leading: "metric", leadDirection: ["falls", "rises"], outcome: "metric, not the leading one", outcomeDirection: ["falls", "rises"], lagNights: [1, 2, 3] },
            from: "YYYY-MM-DD", to: "YYYY-MM-DD, 14 to 120 days after from",
          },
          example: { route: "pattern", template: { id: "lead_lag_v1", leading: "hrv_ms", leadDirection: "falls", outcome: "sleep_minutes", outcomeDirection: "falls", lagNights: 1 } },
          returns: "quote as above, plus route: saved_labels (no new reads) or sealed_read",
          epsilonPerQuery: PATTERN_EPSILON,
        },
        {
          method: "POST", url: `${base}/queries`, price: { type: "dynamic", from: "quote.priceUsd", perPersonUsd: Number(PER_PERSON_MICRO) / 1e6 },
          input: { quoteId: "string" }, returns: "noisy answer with a 95% noise range",
        },
      ],
      metrics: Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, { unit: m.unit, clip: [m.lo, m.hi] }])),
    });
  };
  app.get("/catalog", catalog);
  app.get("/.well-known/x402", catalog);

  // Pre-payment checks: a malformed request gets a 4xx and never a 402.
  app.post("/quote", (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isPattern(req.body)) parseSpec(req.body);
      else if (model.name === "off") throw new Refused("sealed_ai_unavailable", 503);
      else parsePatternSpec(req.body);
      next();
    } catch (e) {
      sendRefusal(res, e);
    }
  });
  app.post("/queries", async (req: Request, res: Response, next: NextFunction) => {
    const pid = paymentIdOf(req);
    if (pid && (await answeredByPaymentId(db, pid))) return next(); // a retry of something already paid for
    try {
      await quotedPrice(db, req.body?.quoteId);
      next();
    } catch (e) {
      sendRefusal(res, e);
    }
  });

  const queryPrice = async (ctx: HTTPRequestContext) => {
    const body = ctx.adapter.getBody?.() as { quoteId?: string } | undefined;
    return { amount: (await quotedPrice(db, body?.quoteId)).toString(), asset: USDC, extra: {} };
  };

  const routes = {
    "POST /quote": {
      accepts: { scheme: "exact", network: NETWORK, payTo, price: { amount: "20000", asset: USDC, extra: {} }, maxTimeoutSeconds: 90 },
      description: "Count who can be included and price the query",
      mimeType: "application/json",
    },
    "POST /queries": {
      accepts: { scheme: "exact", network: NETWORK, payTo, price: queryPrice, maxTimeoutSeconds: 90 },
      description: "Run a quoted query and receive a noisy group answer",
      mimeType: "application/json",
      extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) },
    },
  };

  // A retry carrying the payment id of an answered query skips payment and gets the same answer back.
  const httpServer = new x402HTTPResourceServer(resourceServer, routes as any).onProtectedRequest(async ctx => {
    if (!ctx.paymentHeader) return;
    try {
      const id = extractPaymentIdentifier(decodeHeader(ctx.paymentHeader));
      if (id && (await answeredByPaymentId(db, id))) return { grantAccess: true };
    } catch {
      // Malformed header: let normal payment handling reject it.
    }
  });
  app.use(paymentMiddlewareFromHTTPServer(httpServer));

  app.post("/quote", async (req, res) => {
    try {
      res.json(isPattern(req.body) ? await quotePattern(db, model, parsePatternSpec(req.body)) : await quote(db, parseSpec(req.body)));
    } catch (e) {
      sendRefusal(res, e);
    }
  });

  app.post("/queries", async (req: PaidReq, res) => {
    const pid = paymentIdOf(req);
    const known = pid ? await answeredByPaymentId(db, pid) : null;
    if (known) return void res.json({ ...(known as object), replay: true });
    try {
      const { rows } = await db.query<{ route: string }>("SELECT spec->>'route' AS route FROM quotes WHERE id = $1", [req.body.quoteId]);
      const result = rows[0]?.route === "pattern"
        ? await runPattern(db, kek, model, req.body.quoteId, pid)
        : await runQuery(db, kek, req.body.quoteId, pid);
      req.queryId = result.queryId;
      res.json(result);
    } catch (e) {
      sendRefusal(res, e);
    }
  });

  app.get("/queries/:id/receipt", async (req, res) => {
    const { rows } = await db.query<{ status: string; payment_tx: string | null; price_micro: string }>(
      "SELECT status, payment_tx, price_micro FROM queries WHERE id = $1", [req.params.id]);
    if (!rows[0]) return void res.status(404).json({ error: "not_found" });
    const r = rows[0];
    res.json({ status: r.status, priceMicro: r.price_micro, paymentTx: r.payment_tx, hashscan: r.payment_tx ? hashscanUrl(r.payment_tx) : null });
  });

  // ---- Public proof pages: HTML for a browser, JSON for anything else ----

  const wantsHtml = (req: Request) => req.accepts(["json", "html"]) === "html";

  app.get("/proof/queries/:id", async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return void res.status(400).json({ error: "bad_id" });
    const p = await queryProof(db, req.params.id, { payTo, asset: USDC, fetchImpl: opts.proofDeps?.fetchImpl });
    if (!p) return void res.status(404).json({ error: "not_found" });
    wantsHtml(req) ? res.type("html").send(queryProofHtml(p)) : res.json(p);
  });

  app.get("/proof/agent", async (req, res) => {
    const topicId = String(req.query.topic ?? opts.audit?.topicId ?? "");
    const account = String(req.query.account ?? opts.audit?.account ?? "");
    if (!/^0\.0\.\d+$/.test(topicId) || !/^0\.0\.\d+$/.test(account)) return void res.status(400).json({ error: "topic_and_account_required" });
    try {
      const a = await agentAudit(topicId, account, opts.proofDeps);
      wantsHtml(req) ? res.type("html").send(agentAuditHtml(a)) : res.json(a);
    } catch {
      res.status(502).json({ error: "mirror_unavailable" });
    }
  });

  return app;
}
