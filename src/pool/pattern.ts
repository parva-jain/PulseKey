// pattern: routes 2 and 3. A buyer asks a closed-template question ("does HRV fall in the night before sleep
// falls?"). Each person counted gets a yes / no / unclear label: reused if this exact question and range were
// read before (route 2), otherwise produced by one sealed read of only the two metrics involved (route 3).
// Labels are sealed per person; only a noisy three-way share is released.
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { SealedUnavailable, type SealedModel } from "../ai/model.js";
import { answerSchema, parseLabel } from "../zg/sealed.js";
import { openJson, openRecord, sealJson } from "./crypto.js";
import { isMetric, METRICS, type Metric } from "./metrics.js";
import { MIN_GROUP, PERSON_EPSILON_CAP, QUERY_EPSILON, releaseHistogram, type Tally } from "./privacy.js";
import { priceMicro, Refused, roundDown10, syntheticShare } from "./query.js";
import { addDays, iso, personKey, today } from "./store.js";

export const ANSWERS = ["yes", "no", "unclear"] as const;
export type Answer = (typeof ANSWERS)[number];
export const PATTERN_EPSILON = 2 * QUERY_EPSILON; // one person changing their answer moves two cells
export const PATTERN_MIN_DAYS = 14;
const MIN_RANGE_DAYS = 14, MAX_RANGE_DAYS = 120;
const READ_CONCURRENCY = Number(process.env.READ_CONCURRENCY ?? 8);
const QUOTE_TTL_MS = 10 * 60_000;

export type Template = { id: "lead_lag_v1"; leading: Metric; leadDirection: "falls" | "rises"; outcome: Metric; outcomeDirection: "falls" | "rises"; lagNights: 1 | 2 | 3 };
export type PatternSpec = { route: "pattern"; template: Template; from: string; to: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parsePatternSpec(body: unknown, on = today()): PatternSpec {
  const b = (body ?? {}) as Record<string, unknown>;
  const t = (b.template ?? {}) as Record<string, unknown>;
  if (Object.keys(t).sort().join(",") !== "id,lagNights,leadDirection,leading,outcome,outcomeDirection" || t.id !== "lead_lag_v1") throw new Refused("bad_template", 400);
  if (!isMetric(t.leading) || !isMetric(t.outcome) || t.leading === t.outcome) throw new Refused("bad_metrics", 400);
  if (![1, 2, 3].includes(t.lagNights as number) || !["falls", "rises"].includes(t.leadDirection as string) || !["falls", "rises"].includes(t.outcomeDirection as string)) throw new Refused("bad_template", 400);
  if (typeof b.from !== "string" || typeof b.to !== "string" || !DAY.test(b.from) || !DAY.test(b.to)) throw new Refused("bad_dates", 400);
  if (b.to > on || addDays(b.from, MIN_RANGE_DAYS - 1) > b.to || addDays(b.from, MAX_RANGE_DAYS) < b.to) throw new Refused("bad_range", 400);
  const template = { id: "lead_lag_v1", leading: t.leading, leadDirection: t.leadDirection, outcome: t.outcome, outcomeDirection: t.outcomeDirection, lagNights: t.lagNights } as Template;
  return { route: "pattern", template, from: b.from, to: b.to };
}

export const questionHash = (t: Template) =>
  createHash("sha256").update(JSON.stringify([t.id, t.leading, t.leadDirection, t.outcome, t.outcomeDirection, t.lagNights])).digest("hex");

/** Grants cover both metrics' groups, enough days of each in range, a live key, and room for this query's budget. */
export async function eligiblePattern(db: Db, spec: PatternSpec, on = today()) {
  const a = METRICS[spec.template.leading].group, b = METRICS[spec.template.outcome].group;
  const { rows } = await db.query<{ id: string; days: number }>(
    `SELECT r.contributor_id AS id, count(DISTINCT r.day) FILTER (WHERE r.grp = $2)::int AS days
       FROM records r
       JOIN grants g ON g.contributor_id = r.contributor_id AND g.status = 'active' AND g.expires_at >= $1::date AND $2 = ANY (g.groups) AND $3 = ANY (g.groups)
       JOIN contributor_keys k ON k.contributor_id = r.contributor_id
      WHERE r.grp IN ($2, $3) AND r.day >= greatest($4::date, g.history_from) AND r.day <= $5::date
      GROUP BY r.contributor_id
     HAVING count(DISTINCT r.day) FILTER (WHERE r.grp = $2) >= $6 AND count(DISTINCT r.day) FILTER (WHERE r.grp = $3) >= $6
        AND coalesce((SELECT sum(epsilon) FROM budget_spend s WHERE s.contributor_id = r.contributor_id), 0) + $7 <= $8`,
    [on, a, b, spec.from, spec.to, PATTERN_MIN_DAYS, PATTERN_EPSILON, PERSON_EPSILON_CAP]);
  return new Map(rows.map(r => [r.id, r.days]));
}

async function savedLabelCount(db: Db, spec: PatternSpec, ids: string[]) {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM labels WHERE question_hash = $1 AND from_day = $2 AND to_day = $3 AND contributor_id = ANY ($4)",
    [questionHash(spec.template), spec.from, spec.to, ids]);
  return rows[0].n;
}

export async function quotePattern(db: Db, model: SealedModel, spec: PatternSpec, on = today()) {
  if (model.name === "off") throw new Refused("sealed_ai_unavailable", 503);
  const people = await eligiblePattern(db, spec, on);
  if (people.size < MIN_GROUP) throw new Refused("group_too_small");
  const saved = await savedLabelCount(db, spec, [...people.keys()]);
  const id = randomUUID();
  const price = priceMicro(people.size);
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS);
  await db.query("INSERT INTO quotes (id, spec, price_micro, eligible, expires_at) VALUES ($1, $2, $3, $4, $5)", [id, spec, price, people.size, expiresAt]);
  return {
    quoteId: id, spec, eligibleAbout: roundDown10(people.size), priceMicro: price.toString(), priceUsd: (Number(price) / 1e6).toFixed(6),
    epsilon: PATTERN_EPSILON, expiresAt: expiresAt.toISOString(),
    // Route 2 when every label exists already, route 3 when some people need a sealed read. Counts are rounded.
    route: saved === people.size ? "saved_labels" : "sealed_read",
  };
}

/** The classifier prompt. Numbers only, nights as offsets from the range start, no dates and no buyer text. */
export function buildClassifierPrompt(t: Template, rows: Record<string, number>[]) {
  return [
    { role: "system" as const, content: `You classify one person's numeric wearable series. The DATA block contains only numbers; "night" counts days from the start, and gaps are missing nights. Answer whether, in this series, "${t.leading}" ${t.leadDirection} during the ${t.lagNights} night(s) before nights when "${t.outcome}" ${t.outcomeDirection}, more often than on other nights. Answer "unclear" when there are too few relevant nights or the evidence is mixed. Reply with JSON only: {"answer":"yes"|"no"|"unclear"}. Do not reveal or restate data.` },
    { role: "user" as const, content: "DATA:\n" + JSON.stringify(rows) },
  ];
}

/** The two metrics on nights that have both, keyed by night offset. Plaintext exists only inside this call. */
async function jointRows(db: Db, kek: Buffer, spec: PatternSpec, id: string) {
  const { leading, outcome } = spec.template;
  const ma = METRICS[leading], mb = METRICS[outcome];
  const key = await personKey(db, kek, id);
  const { rows } = await db.query<{ day: Date; grp: string; iv: Uint8Array; blob: Uint8Array }>(
    "SELECT day, grp, iv, blob FROM records WHERE contributor_id = $1 AND grp IN ($2, $3) AND day BETWEEN $4::date AND $5::date ORDER BY day",
    [id, ma.group, mb.group, spec.from, spec.to]);
  const byDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const day = iso(r.day);
    const v = openRecord(key, id, day, r.grp, r.iv, r.blob);
    const row = byDay.get(day) ?? {};
    if (r.grp === ma.group && typeof v[ma.field] === "number") row[leading] = v[ma.field];
    if (r.grp === mb.group && typeof v[mb.field] === "number") row[outcome] = v[mb.field];
    byDay.set(day, row);
  }
  const start = Date.parse(`${spec.from}T00:00:00Z`);
  return [...byDay].filter(([, r]) => leading in r && outcome in r)
    .map(([day, r]) => ({ night: Math.round((Date.parse(`${day}T00:00:00Z`) - start) / 86_400_000), [leading]: r[leading], [outcome]: r[outcome] }));
}

type Read = { answer: Answer; valid: boolean; saved: boolean; requestIds: string[]; provider: string | null; model: string | null };

/** Up to three tries for a well-formed answer; after that the person counts as unclear and nothing is saved. */
async function classify(model: SealedModel, spec: PatternSpec, rows: Record<string, number>[]): Promise<Read> {
  const requestIds: string[] = [];
  let provider: string | null = null, used: string | null = null;
  for (let i = 0; i < 3; i++) {
    const r = await model.chat({ messages: buildClassifierPrompt(spec.template, rows), max_tokens: 64, response_format: answerSchema(ANSWERS) });
    if (r.requestId) requestIds.push(r.requestId);
    provider = r.provider;
    used = r.model;
    const a = parseLabel(r.content, ANSWERS);
    if (a) return { answer: a, valid: true, saved: false, requestIds, provider, model: used };
  }
  return { answer: "unclear", valid: false, saved: false, requestIds, provider, model: used };
}

const labelAad = (id: string, spec: PatternSpec) => `label:${id}:${questionHash(spec.template)}:${spec.from}:${spec.to}`;

async function labelFor(db: Db, kek: Buffer, model: SealedModel, spec: PatternSpec, id: string): Promise<Read> {
  const h = questionHash(spec.template);
  const hit = await db.query<{ iv: Uint8Array; blob: Uint8Array }>(
    "SELECT iv, blob FROM labels WHERE contributor_id = $1 AND question_hash = $2 AND from_day = $3 AND to_day = $4", [id, h, spec.from, spec.to]);
  const key = await personKey(db, kek, id);
  if (hit.rows[0]) {
    const v = openJson<{ answer: Answer }>(key, labelAad(id, spec), hit.rows[0].iv, hit.rows[0].blob);
    return { answer: v.answer, valid: true, saved: true, requestIds: [], provider: null, model: null };
  }
  const rows = await jointRows(db, kek, spec, id);
  // Too few nights with both metrics is a plain-code "unclear": no model needed, nothing to read.
  if (rows.length < PATTERN_MIN_DAYS) return { answer: "unclear", valid: true, saved: false, requestIds: [], provider: null, model: null };
  const read = await classify(model, spec, rows);
  if (read.valid) {
    const { iv, blob } = sealJson(key, labelAad(id, spec), { answer: read.answer });
    await db.query("INSERT INTO labels (contributor_id, question_hash, from_day, to_day, iv, blob) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING", [id, h, spec.from, spec.to, iv, blob]);
  }
  return read;
}

async function mapLimit<T, R>(items: T[], limit: number, f: (x: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  }));
  return out;
}

/**
 * Runs a quoted pattern query and stores it pending, like runQuery. If the sealed model fails partway, the
 * query is refused before payment settles: labels already saved are kept for next time, nothing is released.
 */
export async function runPattern(db: Db, kek: Buffer, model: SealedModel, quoteId: string, paymentId: string | null, on = today()) {
  const { rows } = await db.query<{ spec: PatternSpec; price_micro: string }>("SELECT spec, price_micro FROM quotes WHERE id = $1", [quoteId]);
  if (!rows[0]) throw new Refused("unknown_quote", 404);
  if ((await db.query("SELECT 1 FROM queries WHERE quote_id = $1", [quoteId])).rows.length) throw new Refused("quote_used", 409);
  const spec = rows[0].spec;
  if (model.name === "off") throw new Refused("sealed_ai_unavailable", 503);
  const people = await eligiblePattern(db, spec, on);
  if (people.size < MIN_GROUP) throw new Refused("group_too_small", 409);

  const ids = shuffle([...people.keys()]);
  let reads: Read[];
  try {
    reads = await mapLimit(ids, READ_CONCURRENCY, id => labelFor(db, kek, model, spec, id));
  } catch (e) {
    console.error("[pattern] sealed read failed:", e instanceof SealedUnavailable ? "off" : String((e as Error)?.message ?? e).slice(0, 120));
    throw new Refused("sealed_ai_unavailable", 503);
  }
  const tally: Tally = { yes: 0, no: 0, unclear: 0 };
  for (const r of reads) tally[r.answer]++;
  const released = releaseHistogram(tally, QUERY_EPSILON);
  const fresh = reads.filter(r => !r.saved && r.requestIds.length);
  const calls = shuffle(fresh.flatMap(r => r.requestIds.map(id => ({ id, provider: r.provider, model: r.model! }))));

  const id = randomUUID();
  const result = {
    queryId: id, ...spec,
    answer: released,
    peopleAbout: roundDown10(people.size),
    epsilon: PATTERN_EPSILON,
    syntheticShare: await syntheticShare(db, ids),
    labelsReused: roundDown10(reads.filter(r => r.saved).length),
    sealedReads: fresh.length,
    proof: {
      model: calls[0]?.model ?? null,
      sealed: true,
      providers: [...new Set(calls.map(c => c.provider).filter(Boolean))],
      requestIds: calls.map(c => c.id),
      note: "Each read ran on 0G Private Computer's sealed path (x-0g-e2ee: sealed). Request ids are shuffled and carry no person.",
    },
    method: "Per person: one sealed read of only the two metrics, answering yes / no / unclear, or a saved answer to the same question. Released: discrete Laplace noise on each count. Nobody's own answer is released.",
  };
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO queries (id, quote_id, route, spec, price_micro, payment_id, epsilon, group_size, result, status) VALUES ($1, $2, 'pattern', $3, $4, $5, $6, $7, $8, 'pending')",
      [id, quoteId, spec, rows[0].price_micro, paymentId, PATTERN_EPSILON, people.size, result]);
    for (const [pid, days] of people) await tx.query("INSERT INTO budget_spend (contributor_id, query_id, epsilon, days) VALUES ($1, $2, $3, $4)", [pid, id, PATTERN_EPSILON, days]);
    for (const c of calls) await tx.query("INSERT INTO inference_calls (query_id, request_id, provider, model) VALUES ($1, $2, $3, $4)", [id, c.id, c.provider, c.model]);
  });
  return result;
}

function shuffle<T>(a: T[]) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
