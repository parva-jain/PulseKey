// contributor: the person-facing API under /api. Sign-in through the identity swap point, cookie sessions,
// and the person's own sharing, activity, earnings, claim and withdrawal. Never returns anyone else's data.
import { createHash, randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Db } from "../db/index.js";
import { newAttempt, type Attempt, type IdentityProvider } from "../identity/index.js";
import { isGroup, type Group } from "../pool/metrics.js";
import { balanceMicro, claim, MIN_CLAIM_MICRO, type PayoutChain } from "../pool/payouts.js";
import { PERSON_EPSILON_CAP } from "../pool/privacy.js";
import { Refused } from "../pool/query.js";
import { activeGrant, createContributor, iso, setGrant, today, withdraw } from "../pool/store.js";
import { hashscanUrl } from "../x402/server.js";
import { ATTEMPT_TTL_S } from "../world/oidc.js";

const SESSION_COOKIE = "pk_session";
const ATTEMPT_COOKIE = "pk_attempt";
const SESSION_DAYS = 7;
export const FRESH_WINDOW_S = Number(process.env.FRESH_WINDOW_S ?? 600); // a check counts as fresh for 10 minutes

type Session = { tokenHash: string; contributorId: string; provider: string; checkedAt: Date };
type AuthedReq = Request & { session?: Session };

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function cookies(req: Request) {
  const out: Record<string, string> = {};
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Only same-app paths: "//evil.com" and "/\evil.com" are other origins to a browser. */
const safeReturn = (v: unknown) => (typeof v === "string" && /^\/(?![/\\])[\w\-./?=&%#]*$/.test(v) ? v : "/");

export function createContributorApi(db: Db, kek: Buffer, deps: { identity: IdentityProvider; chain: PayoutChain; baseUrl: string; appUrl?: string }) {
  const { identity, chain } = deps;
  const secure = deps.baseUrl.startsWith("https://");
  const appUrl = deps.appUrl ?? deps.baseUrl;
  const redirectUri = `${deps.baseUrl}/api/auth/callback`;
  const cookieOpts = (maxAgeS: number) => ({ httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: maxAgeS * 1000 });

  const r = express.Router();
  r.use(express.json({ limit: "16kb" }));

  // Session lookup for every route; routes that need one call requireSession.
  r.use(async (req: AuthedReq, _res, next) => {
    const token = cookies(req)[SESSION_COOKIE];
    if (token) {
      const { rows } = await db.query<{ token_hash: string; contributor_id: string; provider: string; checked_at: Date }>(
        "SELECT token_hash, contributor_id, provider, checked_at FROM sessions WHERE token_hash = $1 AND expires_at > now()", [hash(token)]);
      if (rows[0]) req.session = { tokenHash: rows[0].token_hash, contributorId: rows[0].contributor_id, provider: rows[0].provider, checkedAt: rows[0].checked_at };
    }
    next();
  });

  // Mutations must be JSON: a cross-site form cannot send that without a CORS preflight, which we never grant.
  r.use((req, res, next) => {
    if (req.method !== "GET" && !req.is("application/json")) return void res.status(415).json({ error: "json_required" });
    next();
  });

  const requireSession = (req: AuthedReq, res: Response, next: NextFunction) => {
    if (!req.session) return void res.status(401).json({ error: "sign_in_required" });
    next();
  };
  const isFresh = (s: Session) => Date.now() - s.checkedAt.getTime() <= FRESH_WINDOW_S * 1000;
  /** 428 tells the app to run a re-check (GET /api/auth/start?recheck=1) and then retry the same request. */
  const requireFresh = (req: AuthedReq, res: Response, next: NextFunction) => {
    if (!isFresh(req.session!)) return void res.status(428).json({ error: "fresh_check_required", recheck: "/api/auth/start?recheck=1" });
    next();
  };

  // ---- Sign-in ----

  r.get("/auth/start", async (req: AuthedReq, res) => {
    const recheck = req.query.recheck === "1" && req.session;
    let expected: { iss: string; sub: string } | null = null;
    if (recheck) {
      const { rows } = await db.query<{ world_iss: string; world_sub: string }>("SELECT world_iss, world_sub FROM contributors WHERE id = $1", [req.session!.contributorId]);
      expected = { iss: rows[0].world_iss, sub: rows[0].world_sub };
    }
    const a = newAttempt({ fresh: true, expectedIss: expected?.iss, expectedSub: expected?.sub });
    await db.query(
      "INSERT INTO auth_attempts (state, nonce, verifier, expected_iss, expected_sub, return_to, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [a.state, a.nonce, a.verifier, a.expectedIss, a.expectedSub, safeReturn(req.query.return), a.createdAt]);
    res.cookie(ATTEMPT_COOKIE, a.state, cookieOpts(ATTEMPT_TTL_S));
    res.redirect(302, await identity.start(a, redirectUri));
  });

  r.get("/auth/callback", async (req: AuthedReq, res) => {
    const state = String(req.query.state ?? "");
    // The attempt must have started in this browser, or someone could sign a victim into the attacker's account.
    if (!state || cookies(req)[ATTEMPT_COOKIE] !== state) return void res.status(400).json({ error: "attempt_not_from_this_browser" });
    res.clearCookie(ATTEMPT_COOKIE, { path: "/" });
    const { rows } = await db.query<{ nonce: string; verifier: string; expected_iss: string | null; expected_sub: string | null; return_to: string; created_at: number }>(
      "UPDATE auth_attempts SET status = 'used' WHERE state = $1 AND status = 'pending' RETURNING *", [state]);
    const row = rows[0];
    if (!row) return void res.status(400).json({ error: "unknown_or_used_attempt" });
    if (Date.now() / 1000 > row.created_at + ATTEMPT_TTL_S) return void res.status(400).json({ error: "attempt_expired" });
    const attempt: Attempt = { state, nonce: row.nonce, verifier: row.verifier, createdAt: row.created_at, fresh: true, expectedIss: row.expected_iss, expectedSub: row.expected_sub };

    let proof;
    try {
      proof = await identity.finish(new URL(req.originalUrl, deps.baseUrl), attempt);
    } catch (e) {
      return void res.status(403).json({ error: "check_failed", reason: String((e as Error)?.message ?? e).slice(0, 80) });
    }

    // One (iss, sub), one contributor. A first check creates the person; later checks find them.
    const found = await db.query<{ id: string }>("SELECT id FROM contributors WHERE world_iss = $1 AND world_sub = $2", [proof.iss, proof.sub]);
    const contributorId = found.rows[0]?.id ?? (await createContributor(db, kek, "real", { iss: proof.iss, sub: proof.sub }));

    const token = randomBytes(32).toString("base64url");
    await db.transaction(async tx => {
      if (req.session) await tx.query("DELETE FROM sessions WHERE token_hash = $1", [req.session.tokenHash]);
      await tx.query(
        "INSERT INTO sessions (token_hash, contributor_id, provider, checked_at, expires_at) VALUES ($1, $2, $3, to_timestamp($4), now() + make_interval(days => $5))",
        [hash(token), contributorId, proof.provider, proof.authTime, SESSION_DAYS]);
    });
    res.cookie(SESSION_COOKIE, token, cookieOpts(SESSION_DAYS * 86_400));
    res.redirect(302, `${appUrl}${row.return_to}`);
  });

  if (identity.name === "dev") {
    r.get("/auth/dev", (req, res) => {
      const state = String(req.query.state ?? "").replace(/[^\w-]/g, "");
      const recheck = req.query.recheck === "1";
      res.type("html").send(devPage(state, recheck));
    });
  }

  r.post("/auth/logout", async (req: AuthedReq, res) => {
    if (req.session) await db.query("DELETE FROM sessions WHERE token_hash = $1", [req.session.tokenHash]);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // ---- The person's own data ----

  r.get("/me", requireSession, async (req: AuthedReq, res) => {
    const s = req.session!;
    const id = s.contributorId;
    const [grant, keyRow, spent, bal] = await Promise.all([
      activeGrant(db, id),
      db.query("SELECT 1 FROM contributor_keys WHERE contributor_id = $1", [id]),
      db.query<{ eps: number }>("SELECT coalesce(sum(epsilon), 0)::float8 AS eps FROM budget_spend WHERE contributor_id = $1", [id]),
      balanceMicro(db, id),
    ]);
    res.json({
      identity: { provider: s.provider, verifiedHuman: s.provider === "world" },
      freshUntil: new Date(s.checkedAt.getTime() + FRESH_WINDOW_S * 1000).toISOString(),
      withdrawn: keyRow.rows.length === 0,
      grant: grant && grantView(grant),
      privacyBudget: { used: spent.rows[0].eps, cap: PERSON_EPSILON_CAP },
      balanceMicro: bal.toString(),
    });
  });

  r.get("/me/grant", requireSession, async (req: AuthedReq, res) => {
    const g = await activeGrant(db, req.session!.contributorId);
    res.json({ grant: g && grantView(g) });
  });

  /** Creating, widening or renewing needs a fresh check. Narrowing never does: sharing less is always easy. */
  r.put("/me/grant", requireSession, async (req: AuthedReq, res, next) => {
    const id = req.session!.contributorId;
    const input = parseGrant(req.body);
    if (!(await db.query("SELECT 1 FROM contributor_keys WHERE contributor_id = $1", [id])).rows.length) throw new Refused("withdrawn", 409);
    const cur = await activeGrant(db, id);
    const on = today();
    const widens = !cur
      || input.groups.some(g => !cur.groups.includes(g))
      || input.historyDays > daysBetween(iso(cur.history_from), on)
      || input.validDays > daysBetween(on, iso(cur.expires_at))
      || (input.autoCollect && !cur.auto_collect);
    if (widens && !isFresh(req.session!)) return requireFresh(req, res, next);
    await setGrant(db, id, input, on);
    res.json({ grant: grantView((await activeGrant(db, id))!), neededFreshCheck: widens });
  });

  r.delete("/me/grant", requireSession, async (req: AuthedReq, res) => {
    await db.query("UPDATE grants SET status = 'revoked' WHERE contributor_id = $1 AND status = 'active'", [req.session!.contributorId]);
    res.json({ grant: null });
  });

  /** "Where your data went": every answered query this person was counted in, and what they earned from it. */
  r.get("/me/activity", requireSession, async (req: AuthedReq, res) => {
    const { rows } = await db.query<{ id: string; created_at: Date; spec: Record<string, unknown>; result: Record<string, unknown>; epsilon: number; days: number; earned: string | null }>(
      `SELECT q.id, q.created_at, q.spec, q.result, b.epsilon, b.days, l.micro::text AS earned
         FROM budget_spend b
         JOIN queries q ON q.id = b.query_id AND q.status = 'answered'
         LEFT JOIN ledger l ON l.query_id = q.id AND l.contributor_id = b.contributor_id AND l.kind = 'earning'
        WHERE b.contributor_id = $1
        ORDER BY q.created_at DESC LIMIT 100`, [req.session!.contributorId]);
    res.json({
      items: rows.map(r => ({
        queryId: r.id, at: r.created_at.toISOString(), route: r.spec.route, metric: r.spec.metric, stat: r.spec.stat, threshold: r.spec.threshold ?? null,
        from: r.spec.from, to: r.spec.to, answer: { value: r.result.value, plusMinus95: r.result.plusMinus95, unit: r.result.unit },
        peopleAbout: r.result.peopleAbout, yourDays: r.days, epsilon: r.epsilon, earnedMicro: r.earned ?? "0",
      })),
    });
  });

  r.get("/me/earnings", requireSession, async (req: AuthedReq, res) => {
    const id = req.session!.contributorId;
    const sums = await db.query<{ earned: string; claimed: string }>(
      `SELECT coalesce(sum(micro) FILTER (WHERE kind = 'earning'), 0)::text AS earned,
              coalesce(sum(micro) FILTER (WHERE kind = 'claim'), 0)::text AS claimed FROM ledger WHERE contributor_id = $1`, [id]);
    const claims = await db.query<{ micro: string; account_id: string | null; transfer_tx: string | null; status: string; created_at: Date }>(
      "SELECT micro::text, account_id, transfer_tx, status, created_at FROM claims WHERE contributor_id = $1 AND status <> 'failed' ORDER BY created_at DESC", [id]);
    res.json({
      balanceMicro: (BigInt(sums.rows[0].earned) - BigInt(sums.rows[0].claimed)).toString(),
      earnedMicro: sums.rows[0].earned,
      claimedMicro: sums.rows[0].claimed,
      minClaimMicro: MIN_CLAIM_MICRO.toString(),
      claims: claims.rows.map(c => ({ micro: c.micro, accountId: c.account_id, status: c.status, at: c.created_at.toISOString(), hashscan: c.transfer_tx && hashscanUrl(c.transfer_tx) })),
    });
  });

  /** The browser makes the key and sends only the public half. Money moves, so the check must be fresh. */
  r.post("/me/claim", requireSession, requireFresh, async (req: AuthedReq, res) => {
    const c = await claim(db, chain, req.session!.contributorId, req.body?.publicKey);
    res.json({ ...c, hashscan: hashscanUrl(c.tx), accountUrl: `https://hashscan.io/testnet/account/${c.accountId}` });
  });

  /** As easy as joining: no re-check. Earnings stay claimable, so the session survives. */
  r.post("/me/withdraw", requireSession, async (req: AuthedReq, res) => {
    if (req.body?.confirm !== true) throw new Refused("confirm_required", 400);
    const id = req.session!.contributorId;
    await withdraw(db, id);
    res.json({ withdrawn: true, unclaimedMicro: (await balanceMicro(db, id)).toString() });
  });

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof Refused) return void res.status(err.status).json({ error: err.code });
    console.error("[contributor api]", err);
    res.status(500).json({ error: "internal" });
  });

  return r;
}

function parseGrant(b: unknown) {
  const g = (b ?? {}) as Record<string, unknown>;
  const groups = g.groups;
  if (!Array.isArray(groups) || !groups.length || !groups.every(isGroup) || new Set(groups).size !== groups.length) throw new Refused("bad_groups", 400);
  const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : null);
  const historyDays = int(g.historyDays, 0, 365), validDays = int(g.validDays, 1, 365);
  if (historyDays === null || validDays === null) throw new Refused("bad_days", 400);
  if (g.autoCollect !== undefined && typeof g.autoCollect !== "boolean") throw new Refused("bad_auto_collect", 400);
  return { groups: groups as Group[], historyDays, validDays, autoCollect: (g.autoCollect as boolean | undefined) ?? true };
}

function grantView(g: { groups: Group[]; history_from: Date; expires_at: Date; auto_collect: boolean }) {
  return { groups: g.groups, historyFrom: iso(g.history_from), expiresAt: iso(g.expires_at), autoCollect: g.auto_collect };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

function devPage(state: string, recheck: boolean) {
  const action = `/api/auth/callback`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev sign-in</title><style>body{font:16px system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem}
.warn{background:#fff4d6;border:1px solid #e0b94c;padding:.75rem;border-radius:.5rem}input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin-top:.5rem}</style></head>
<body><h1>Dev sign-in</h1><p class="warn">Development stand-in for World. This proves nothing about being a real, unique person. Accounts made here are labelled "dev".</p>
<form method="get" action="${action}"><input type="hidden" name="state" value="${state}"><input type="hidden" name="iss" value="dev:local">
${recheck ? "<p>Confirm it's still you.</p>" : '<label>Demo name (the same name returns the same account)<input name="dev_name" maxlength="64" autocomplete="off"></label>'}
<button type="submit">${recheck ? "Confirm" : "Continue"}</button></form></body></html>`;
}
