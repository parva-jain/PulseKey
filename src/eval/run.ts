// run: stores planted people through the normal pipeline (encrypted, allow-listed), then asks both questions per
// person through the same row builder and classifier that paid queries use. Raw per-person answers are scored
// before any noise, which is the right place to measure the classifier. Nothing is saved as a label.
import { randomBytes } from "node:crypto";
import { openDb } from "../db/index.js";
import type { SealedModel } from "../ai/model.js";
import { classify, jointRows, PATTERN_MIN_DAYS, type Answer, type PatternSpec } from "../pool/pattern.js";
import { addDays, createContributor, setGrant, storeRows, today } from "../pool/store.js";
import { baselineAnswer, CLEAR, COHORTS, plantedPerson, QUESTIONS, score, TRUTH, type Cohort, type QuestionId, type Scored, type Strength } from "./planted.js";

export type Judge = { kind: "baseline" } | { kind: "model"; model: SealedModel };

export async function evaluate(judge: Judge, opts: { perCohort?: number; days?: number; seed?: number; strength?: Strength; concurrency?: number } = {}) {
  const perCohort = opts.perCohort ?? 12, days = opts.days ?? 60, seed = opts.seed ?? 7;
  const on = today(), from = addDays(on, -days), to = addDays(on, -1);
  const db = await openDb();
  const kek = randomBytes(32);
  const people: { id: string; cohort: Cohort }[] = [];
  for (const cohort of COHORTS) {
    for (let i = 0; i < perCohort; i++) {
      const id = await createContributor(db, kek, "seed");
      await setGrant(db, id, { groups: ["sleep", "hrv"], historyDays: days, validDays: 30 }, on);
      const rows = plantedPerson(seed * 10_000 + people.length, from, days, cohort, opts.strength ?? CLEAR);
      await storeRows(db, kek, id, "sleep", rows.sleep, on);
      await storeRows(db, kek, id, "hrv", rows.hrv, on);
      people.push({ id, cohort });
    }
  }

  const out: Partial<Record<QuestionId, ReturnType<typeof score> & { requestIds: number }>> = {};
  const all: Scored[] = [];
  for (const q of Object.keys(QUESTIONS) as QuestionId[]) {
    const spec: PatternSpec = { route: "pattern", template: QUESTIONS[q], from, to };
    let requestIds = 0;
    const results = await mapLimit(people, opts.concurrency ?? 8, async p => {
      const rows = await jointRows(db, kek, spec, p.id);
      let got: Answer;
      if (rows.length < PATTERN_MIN_DAYS) got = "unclear";
      else if (judge.kind === "baseline") got = baselineAnswer(spec.template, rows);
      else {
        const r = await classify(judge.model, spec, rows);
        requestIds += r.requestIds.length;
        got = r.answer;
      }
      return { cohort: p.cohort, truth: TRUTH[q][p.cohort], got };
    });
    all.push(...results);
    out[q] = { ...score(results), requestIds };
  }
  await db.close();
  return { judge: judge.kind === "baseline" ? "plain-code baseline" : judge.model.name, perCohort, days, overall: score(all), byQuestion: out };
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
