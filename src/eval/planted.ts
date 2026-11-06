// planted: labelled synthetic people whose answer is known by construction, to measure the sealed classifier.
// Four groups: short nights pull next-day HRV down; HRV dips come before short nights; both happen but
// unrelated; neither happens. Truth labels live here and never reach the pipeline or the model.
import type { Answer, Template } from "../pool/pattern.js";
import { rng } from "../pool/seed.js";
import { addDays } from "../pool/store.js";

export const COHORTS = ["sleep_leads_hrv", "hrv_leads_sleep", "independent_events", "no_events"] as const;
export type Cohort = (typeof COHORTS)[number];

export const QUESTIONS = {
  sleep_then_hrv: { id: "lead_lag_v1", leading: "sleep_minutes", leadDirection: "falls", outcome: "hrv_ms", outcomeDirection: "falls", lagNights: 1 },
  hrv_then_sleep: { id: "lead_lag_v1", leading: "hrv_ms", leadDirection: "falls", outcome: "sleep_minutes", outcomeDirection: "falls", lagNights: 1 },
} satisfies Record<string, Template>;
export type QuestionId = keyof typeof QUESTIONS;

/** "Does <leading> fall in the night before nights when <outcome> falls?" Only the matching cohort is yes. */
export const TRUTH: Record<QuestionId, Record<Cohort, Answer>> = {
  sleep_then_hrv: { sleep_leads_hrv: "yes", hrv_leads_sleep: "no", independent_events: "no", no_events: "no" },
  hrv_then_sleep: { sleep_leads_hrv: "no", hrv_leads_sleep: "yes", independent_events: "no", no_events: "no" },
};

export type Strength = { events: number; sleepLossMin: [number, number]; hrvFactor: [number, number]; sleepNoiseMin: number; hrvNoise: number };
/** Clear but realistic: a 2 to 3 hour short night, a 20 to 35% HRV dip, everyday noise well below that. */
export const CLEAR: Strength = { events: 6, sleepLossMin: [120, 180], hrvFactor: [0.65, 0.8], sleepNoiseMin: 25, hrvNoise: 0.06 };
/** Harder: an hour or so of lost sleep, a 10 to 20% HRV dip, the same everyday noise. Closer to real effects. */
export const SUBTLE: Strength = { events: 6, sleepLossMin: [60, 100], hrvFactor: [0.8, 0.9], sleepNoiseMin: 25, hrvNoise: 0.06 };

/** Event nights spaced at least 6 apart, away from the edges, so one event never bleeds into the next. */
function eventNights(g: ReturnType<typeof rng>, days: number, n: number, avoid: Set<number> = new Set()) {
  const out: number[] = [];
  for (let tries = 0; out.length < n && tries < 1000; tries++) {
    const d = 3 + Math.floor(g.next() * (days - 6));
    if (out.some(e => Math.abs(e - d) < 6) || [...avoid].some(e => Math.abs(e - d) < 3)) continue;
    out.push(d);
  }
  return out.sort((a, b) => a - b);
}

/** Rows in the shape Ultrahuman's tools return, for the sleep and HRV groups only. */
export function plantedPerson(seed: number, from: string, days: number, cohort: Cohort, s: Strength = CLEAR) {
  const g = rng(seed);
  const baseSleep = g.normal(420, 30), baseHrv = Math.max(25, g.normal(55, 12));
  const sleep = Array.from({ length: days }, (_, i) => baseSleep + g.normal(0, s.sleepNoiseMin) + ([0, 6].includes(new Date(Date.parse(`${addDays(from, i)}T00:00:00Z`)).getUTCDay()) ? 25 : 0));
  const hrv = Array.from({ length: days }, () => baseHrv * (1 + g.normal(0, s.hrvNoise)));
  const loss = () => s.sleepLossMin[0] + g.next() * (s.sleepLossMin[1] - s.sleepLossMin[0]);
  const dip = () => s.hrvFactor[0] + g.next() * (s.hrvFactor[1] - s.hrvFactor[0]);

  const ev = eventNights(g, days, s.events);
  if (cohort === "sleep_leads_hrv") for (const e of ev) { sleep[e] -= loss(); hrv[e + 1] *= dip(); }
  if (cohort === "hrv_leads_sleep") for (const e of ev) { hrv[e] *= dip(); sleep[e + 1] -= loss(); }
  if (cohort === "independent_events") {
    for (const e of ev) sleep[e] -= loss();
    for (const e of eventNights(g, days, s.events, new Set(ev.flatMap(e => [e - 1, e, e + 1])))) hrv[e] *= dip();
  }
  const date = (i: number) => addDays(from, i);
  return {
    sleep: sleep.map((v, i) => ({ date: date(i), total_sleep_minutes: Math.round(Math.max(150, v)) })),
    hrv: hrv.map((v, i) => ({ date: date(i), hrv_rmssd_ms: Number(Math.max(8, v).toFixed(1)) })),
  };
}

/**
 * A plain-code reference rule, to answer "why use a model at all?". A metric "falls" on a night when it is more
 * than one standard deviation below the person's own mean. Yes when the leading fall precedes most outcome
 * falls and rarely precedes other nights; no when it makes no difference; unclear otherwise.
 */
export function baselineAnswer(t: Template, rows: Record<string, number>[]): Answer {
  const byNight = new Map(rows.map(r => [r.night, r]));
  const falls = (metric: string) => {
    const v = rows.map(r => r[metric]);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
    const dir = metric === t.leading ? t.leadDirection : t.outcomeDirection;
    return (r: Record<string, number> | undefined) => !!r && (dir === "falls" ? r[metric] < m - sd : r[metric] > m + sd);
  };
  const leadFell = falls(t.leading), outFell = falls(t.outcome);
  const preceded = (night: number) => Array.from({ length: t.lagNights }, (_, k) => night - 1 - k).some(n => leadFell(byNight.get(n)));
  const outNights = rows.filter(r => outFell(r)).map(r => r.night);
  const otherNights = rows.filter(r => !outFell(r) && byNight.has(r.night - 1)).map(r => r.night);
  if (outNights.length < 3) return "unclear";
  const rate = (ns: number[]) => ns.filter(preceded).length / Math.max(1, ns.length);
  const diff = rate(outNights) - rate(otherNights);
  return diff >= 0.3 ? "yes" : diff <= 0.1 ? "no" : "unclear";
}

export type Scored = { cohort: Cohort; truth: Answer; got: Answer };

/** Confusion counts plus the headline numbers, with a Wilson 95% interval on accuracy among answered. */
export function score(results: Scored[]) {
  const matrix: Record<string, Record<Answer, number>> = {};
  for (const r of results) {
    const row = (matrix[`${r.cohort} (truth ${r.truth})`] ??= { yes: 0, no: 0, unclear: 0 });
    row[r.got]++;
  }
  const answered = results.filter(r => r.got !== "unclear");
  const correct = answered.filter(r => r.got === r.truth).length;
  const pos = answered.filter(r => r.truth === "yes"), neg = answered.filter(r => r.truth === "no");
  return {
    matrix,
    people: results.length,
    coverage: ratio(answered.length, results.length),
    accuracyAmongAnswered: ratio(correct, answered.length),
    accuracy95: wilson(correct, answered.length),
    sensitivity: ratio(pos.filter(r => r.got === "yes").length, pos.length),
    specificity: ratio(neg.filter(r => r.got === "no").length, neg.length),
    falseYesOnReverseDirection: ratio(results.filter(r => r.truth === "no" && r.got === "yes" && /leads/.test(r.cohort)).length, results.filter(r => r.truth === "no" && /leads/.test(r.cohort)).length),
  };
}

const ratio = (a: number, b: number) => (b ? Number((a / b).toFixed(3)) : null);

function wilson(k: number, n: number) {
  if (!n) return null;
  const z = 1.96, p = k / n;
  const c = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Number((c - h).toFixed(3)), Number((c + h).toFixed(3))];
}
