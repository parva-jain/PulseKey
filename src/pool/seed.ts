// seed: labelled synthetic people in the exact row shape Ultrahuman's tools return. Everyday structure: a short
// night slightly lowers next-day HRV and recovery and raises resting HR; weekends sleep longer. On top, each
// demo person gets a planted cohort (eval/planted.ts) whose truth goes to seed_truth, which no query reads.
// Values are fake and marked kind='seed'.
import type { Db } from "../db/index.js";
import type { Group } from "./metrics.js";
import { addDays, createContributor, setGrant, storeRows } from "./store.js";
import { rng } from "./rng.js";
import { pickCohort, plantEvents } from "../eval/planted.js";

export { rng } from "./rng.js";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r = (v: number, dp = 0) => Number(v.toFixed(dp));

/** Raw tool rows for one person over [from, to], keyed by group. */
export function syntheticPerson(seed: number, from: string, to: string) {
  const g = rng(seed);
  const base = { sleep: g.normal(420, 35), hrv: clamp(g.normal(55, 15), 20, 110), rhr: clamp(g.normal(60, 6), 45, 80) };
  const rows: Record<Group, Record<string, unknown>[]> = { sleep: [], hrv: [], resting_hr: [], recovery: [] };
  let prevSleep = base.sleep;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (g.next() < 0.07) continue; // ring not worn
    const weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
    // HRV and RHR are measured overnight, so they reflect the previous night's sleep.
    const debt = (prevSleep - base.sleep) / 60; // hours above (+) or below (-) this person's normal
    const hrv = clamp(base.hrv + 4 * debt + g.normal(0, 5), 12, 140);
    const rhr = clamp(base.rhr - 1.5 * debt + g.normal(0, 2), 40, 95);
    const total = clamp(base.sleep + (weekend ? 40 : 0) + g.normal(0, 45), 200, 660);
    const deep = total * clamp(g.normal(0.17, 0.03), 0.08, 0.3);
    const rem = total * clamp(g.normal(0.22, 0.03), 0.12, 0.32);
    const awake = clamp(g.normal(35, 12), 5, 120);
    const eff = clamp((total / (total + awake)) * 100, 60, 99);
    const score = clamp(50 + (total - 360) / 6 + (eff - 85) + g.normal(0, 5), 20, 99);
    const recovery = clamp(55 + 0.6 * (hrv - base.hrv) - 1.2 * (rhr - base.rhr) + 6 * debt + g.normal(0, 6), 5, 99);
    rows.sleep.push({
      date: day, total_sleep_minutes: r(total), deep_sleep_minutes: r(deep), rem_sleep_minutes: r(rem),
      light_sleep_minutes: r(total - deep - rem), awake_minutes: r(awake), sleep_efficiency: r(eff, 1),
      sleep_score: r(score), toss_turn_count: r(clamp(g.normal(18, 6), 2, 50)),
    });
    rows.hrv.push({ date: day, hrv_rmssd_ms: r(hrv, 1) });
    rows.resting_hr.push({ date: day, bpm: r(rhr) });
    rows.recovery.push({ date: day, recovery_score: r(recovery) });
    prevSleep = total;
  }
  return rows;
}

const ALL: Group[] = ["sleep", "hrv", "resting_hr", "recovery"];

/** Most seed people grant everything; some grant subsets, so eligibility genuinely varies by query. */
export async function seedPool(db: Db, kek: Buffer, opts: { people: number; days: number; seed?: number; on: string }) {
  const g = rng(opts.seed ?? 42);
  const mix = rng((opts.seed ?? 42) * 7919); // a separate stream, so grants stay as they were before cohorts existed
  const from = addDays(opts.on, -opts.days), to = addDays(opts.on, -1);
  const ids: string[] = [];
  for (let i = 0; i < opts.people; i++) {
    const roll = g.next();
    const groups: Group[] = roll < 0.7 ? ALL : roll < 0.85 ? ["sleep", "hrv"] : ["sleep", "resting_hr", "recovery"];
    const historyDays = Math.round(opts.days * (0.5 + 0.5 * g.next()));
    const id = await createContributor(db, kek, "seed");
    await setGrant(db, id, { groups, historyDays, validDays: 30 }, opts.on);
    const cohort = pickCohort(mix.next());
    const rows = plantEvents(syntheticPerson((opts.seed ?? 42) * 1000 + i, from, to), cohort, from, to, (opts.seed ?? 42) * 1000 + i + 1);
    for (const grp of groups) await storeRows(db, kek, id, grp, rows[grp], opts.on);
    await db.query("INSERT INTO seed_truth (contributor_id, cohort) VALUES ($1, $2)", [id, cohort]);
    ids.push(id);
  }
  return ids;
}
