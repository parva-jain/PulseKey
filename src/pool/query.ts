// query: route 1, simple numbers by plain code. Quote (count and price) -> run (decrypt, clip, add noise) -> settle (pay everyone counted).
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { openRecord } from "./crypto.js";
import { isMetric, METRICS, type Metric } from "./metrics.js";
import {
  discreteLaplace, laplace, laplace95, MIN_DAYS, MIN_GROUP, PERSON_EPSILON_CAP, QUERY_EPSILON, splitByDays,
} from "./privacy.js";
import { addDays, iso, personKey, today } from "./store.js";

export const PER_PERSON_MICRO = BigInt(process.env.PER_PERSON_MICRO ?? 20_000); // $0.02 to each person counted, on average
export const CUT_BPS = 1_000n; // 10% platform cut, a placeholder
const QUOTE_TTL_MS = 10 * 60_000;
const MAX_RANGE_DAYS = 180;

export type StatSpec = {
  route: "stat";
  metric: Metric;
  stat: "mean" | "share_below" | "share_above";
  threshold?: number;
  from: string;
  to: string;
};

export class Refused extends Error {
  constructor(public code: string, public status = 422) { super(code); }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseSpec(body: unknown, on = today()): StatSpec {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.route !== undefined && b.route !== "stat") throw new Refused("unsupported_route", 400);
  if (!isMetric(b.metric)) throw new Refused("unknown_metric", 400);
  if (b.stat !== "mean" && b.stat !== "share_below" && b.stat !== "share_above") throw new Refused("unknown_stat", 400);
  if (typeof b.from !== "string" || typeof b.to !== "string" || !DAY.test(b.from) || !DAY.test(b.to)) throw new Refused("bad_dates", 400);
  if (b.from > b.to || b.to > on || addDays(b.from, MAX_RANGE_DAYS) < b.to) throw new Refused("bad_range", 400);
  const m = METRICS[b.metric];
  if (b.stat !== "mean" && (typeof b.threshold !== "number" || b.threshold < m.lo || b.threshold > m.hi)) throw new Refused("bad_threshold", 400);
  return { route: "stat", metric: b.metric, stat: b.stat, threshold: b.stat === "mean" ? undefined : (b.threshold as number), from: b.from, to: b.to };
}

/**
 * Who can be counted right now: an active grant covering the metric's group, a live key, enough days in range
 * inside the grant's window, and privacy budget left. Reads only plaintext metadata, never a health value.
 */
export async function eligible(db: Db, spec: StatSpec, on = today()) {
  const grp = METRICS[spec.metric].group;
  const { rows } = await db.query<{ id: string; days: number }>(
    `SELECT r.contributor_id AS id, count(*)::int AS days
       FROM records r
       JOIN grants g ON g.contributor_id = r.contributor_id AND g.status = 'active' AND g.expires_at >= $1::date AND $2 = ANY (g.groups)
       JOIN contributor_keys k ON k.contributor_id = r.contributor_id
      WHERE r.grp = $2 AND r.day >= greatest($3::date, g.history_from) AND r.day <= $4::date
      GROUP BY r.contributor_id
     HAVING count(*) >= $5
        AND coalesce((SELECT sum(epsilon) FROM budget_spend b WHERE b.contributor_id = r.contributor_id), 0) + $6 <= $7`,
    [on, grp, spec.from, spec.to, MIN_DAYS, QUERY_EPSILON, PERSON_EPSILON_CAP],
  );
  return new Map(rows.map(r => [r.id, r.days]));
}

/** Price covers the per-person average plus the cut, rounded up to a whole micro-USDC. */
export function priceMicro(people: number) {
  const net = BigInt(people) * PER_PERSON_MICRO * 10_000n;
  return (net + (10_000n - CUT_BPS) - 1n) / (10_000n - CUT_BPS);
}

/** Counted people are shown to buyers rounded down to 10, because the exact figure says who shares what. */
const roundDown10 = (n: number) => Math.floor(n / 10) * 10;

export async function quote(db: Db, spec: StatSpec, on = today()) {
  const people = await eligible(db, spec, on);
  if (people.size < MIN_GROUP) throw new Refused("group_too_small");
  const id = randomUUID();
  const price = priceMicro(people.size);
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS);
  await db.query("INSERT INTO quotes (id, spec, price_micro, eligible, expires_at) VALUES ($1, $2, $3, $4, $5)", [id, spec, price, people.size, expiresAt]);
  return {
    quoteId: id,
    spec,
    eligibleAbout: roundDown10(people.size),
    priceMicro: price.toString(),
    priceUsd: (Number(price) / 1e6).toFixed(6),
    epsilon: QUERY_EPSILON,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Price for a paid request, read from the stored quote so the 402 and the paid retry always agree.
 * A used quote still prices: a buyer retrying a lost response must reach the payment step to present its
 * payment id and get the same answer back. A new payment on a used quote is refused by runQuery, before settlement.
 */
export async function quotedPrice(db: Db, quoteId: unknown) {
  if (typeof quoteId !== "string" || !/^[0-9a-f-]{36}$/.test(quoteId)) throw new Refused("bad_quote", 400);
  const { rows } = await db.query<{ price_micro: string; expires_at: Date }>("SELECT price_micro, expires_at FROM quotes WHERE id = $1", [quoteId]);
  if (!rows[0]) throw new Refused("unknown_quote", 404);
  if (rows[0].expires_at.getTime() < Date.now()) throw new Refused("quote_expired", 410);
  return BigInt(rows[0].price_micro);
}

/** Each person's mean over the range, clipped to the metric's bounds. Plaintext lives only inside this loop. */
async function personMeans(db: Db, kek: Buffer, spec: StatSpec, ids: string[]) {
  const m = METRICS[spec.metric];
  const means: number[] = [];
  for (const id of shuffle(ids)) {
    const key = await personKey(db, kek, id);
    const { rows } = await db.query<{ day: Date; iv: Uint8Array; blob: Uint8Array }>(
      "SELECT day, iv, blob FROM records WHERE contributor_id = $1 AND grp = $2 AND day BETWEEN $3::date AND $4::date",
      [id, m.group, spec.from, spec.to],
    );
    const vals = rows.map(r => openRecord(key, id, iso(r.day), m.group, r.iv, r.blob)[m.field]).filter((v): v is number => typeof v === "number");
    if (vals.length) means.push(Math.min(m.hi, Math.max(m.lo, vals.reduce((a, b) => a + b, 0) / vals.length)));
  }
  return means;
}

function release(spec: StatSpec, means: number[], eps: number) {
  const m = METRICS[spec.metric];
  const n = means.length;
  if (spec.stat === "mean") {
    const scale = (m.hi - m.lo) / eps; // one person moves the clipped sum by at most hi - lo
    const value = (means.reduce((a, b) => a + b, 0) + laplace(scale)) / n;
    return { value: round(Math.min(m.hi, Math.max(m.lo, value)), 1), plusMinus95: round(laplace95(scale) / n, 1), unit: m.unit };
  }
  const t = spec.threshold!;
  const hits = means.filter(v => (spec.stat === "share_below" ? v < t : v > t)).length;
  const share = Math.min(1, Math.max(0, (hits + discreteLaplace(eps)) / n));
  return { value: round(share * 100, 0), plusMinus95: round((laplace95(1 / eps) / n) * 100, 0), unit: "% of people" };
}

/**
 * Runs a quoted query and stores it as pending. Budget is spent here, before payment, which errs toward privacy:
 * if settlement then fails the answer is never released but the spend stays.
 */
export async function runQuery(db: Db, kek: Buffer, quoteId: string, paymentId: string | null, on = today()) {
  const { rows } = await db.query<{ spec: StatSpec; price_micro: string }>("SELECT spec, price_micro FROM quotes WHERE id = $1", [quoteId]);
  if (!rows[0]) throw new Refused("unknown_quote", 404);
  if ((await db.query("SELECT 1 FROM queries WHERE quote_id = $1", [quoteId])).rows.length) throw new Refused("quote_used", 409);
  const spec = rows[0].spec;
  const people = await eligible(db, spec, on);
  if (people.size < MIN_GROUP) throw new Refused("group_too_small", 409);

  const means = await personMeans(db, kek, spec, [...people.keys()]);
  if (means.length < MIN_GROUP) throw new Refused("group_too_small", 409);
  // Synthetic means seed people plus anyone whose source is labelled sample data, so the label never undercounts.
  const seed = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM contributors c LEFT JOIN connections k ON k.contributor_id = c.id
      WHERE c.id = ANY ($1) AND (c.kind = 'seed' OR k.source = 'sample')`, [[...people.keys()]])).rows[0].n;

  const id = randomUUID();
  const result = {
    queryId: id,
    ...spec,
    ...release(spec, means, QUERY_EPSILON),
    peopleAbout: roundDown10(people.size),
    epsilon: QUERY_EPSILON,
    syntheticShare: Math.round((seed / people.size) * 10) / 10,
    method: "Each person's range mean, clipped, then Laplace noise on the group total. Nobody's own value is released.",
  };
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO queries (id, quote_id, route, spec, price_micro, payment_id, epsilon, group_size, result, status) VALUES ($1, $2, 'stat', $3, $4, $5, $6, $7, $8, 'pending')",
      [id, quoteId, spec, rows[0].price_micro, paymentId, QUERY_EPSILON, people.size, result],
    );
    for (const [pid, days] of people) {
      await tx.query("INSERT INTO budget_spend (contributor_id, query_id, epsilon, days) VALUES ($1, $2, $3, $4)", [pid, id, QUERY_EPSILON, days]);
    }
  });
  return result;
}

/** After the buyer's payment settles: everyone counted earns by days of data, whatever the answer. Idempotent. */
export async function settleQuery(db: Db, queryId: string, payment: { tx: string; payer?: string }) {
  return db.transaction(async tx => {
    const upd = await tx.query<{ price_micro: string }>(
      "UPDATE queries SET status = 'answered', payment_tx = $2, payer_account = $3 WHERE id = $1 AND status = 'pending' RETURNING price_micro",
      [queryId, payment.tx, payment.payer ?? null],
    );
    if (!upd.rows[0]) return false;
    const price = BigInt(upd.rows[0].price_micro);
    const pool = (price * (10_000n - CUT_BPS)) / 10_000n;
    const { rows } = await tx.query<{ contributor_id: string; days: number }>("SELECT contributor_id, days FROM budget_spend WHERE query_id = $1", [queryId]);
    const split = splitByDays(pool, new Map(rows.map(r => [r.contributor_id, r.days])));
    const days = new Map(rows.map(r => [r.contributor_id, r.days]));
    for (const [pid, micro] of split) {
      await tx.query("INSERT INTO ledger (contributor_id, query_id, kind, micro, days) VALUES ($1, $2, 'earning', $3, $4)", [pid, queryId, micro, days.get(pid)]);
    }
    await tx.query("INSERT INTO ledger (contributor_id, query_id, kind, micro, tx) VALUES (NULL, $1, 'platform', $2, $3)", [queryId, price - pool, payment.tx]);
    return true;
  });
}

export async function markUnpaid(db: Db, queryId: string) {
  await db.query("UPDATE queries SET status = 'unpaid' WHERE id = $1 AND status = 'pending'", [queryId]);
}

export async function answeredByPaymentId(db: Db, paymentId: string) {
  const { rows } = await db.query<{ result: unknown }>("SELECT result FROM queries WHERE payment_id = $1 AND status = 'answered'", [paymentId]);
  return rows[0]?.result ?? null;
}

function shuffle<T>(a: T[]) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
const round = (v: number, dp: number) => Number(v.toFixed(dp));
