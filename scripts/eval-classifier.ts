// Measures the sealed classifier on 0G against planted synthetic people (no real data), next to the plain-code
// baseline on the same people. Writes test-results/eval-<time>.json. Usage: tsx --env-file=.env scripts/eval-classifier.ts [perCohort]
import { writeFileSync } from "node:fs";
import { zgModel } from "../src/ai/model.js";
import { evaluate } from "../src/eval/run.js";
import { CLEAR, SUBTLE } from "../src/eval/planted.js";

// Usage: eval-classifier.ts [perCohort=12] [seed=7] [clear|subtle]
const perCohort = Number(process.argv[2] ?? 12);
const seed = Number(process.argv[3] ?? 7);
const strengthName = process.argv[4] ?? "clear";
const strength = strengthName === "subtle" ? SUBTLE : CLEAR;
const t0 = Date.now();
const baseline = await evaluate({ kind: "baseline" }, { perCohort, seed, strength });
const model = await evaluate({ kind: "model", model: zgModel() }, { perCohort, seed, strength });
const out = { at: new Date().toISOString(), seed, strength: strengthName, input: process.env.CLASSIFIER_INPUT ?? "aligned", thinking: process.env.CLASSIFIER_THINKING ?? "0", minutes: Number(((Date.now() - t0) / 60_000).toFixed(1)), baseline, model };
writeFileSync(`test-results/eval-${Date.now()}.json`, JSON.stringify(out, null, 2));

for (const r of [baseline, model]) {
  console.log(`\n== ${r.judge} (${r.perCohort} per group, ${r.days} days, seed ${seed}, ${strengthName}) ==`);
  const o = r.overall;
  console.log(`coverage ${o.coverage}, accuracy among answered ${o.accuracyAmongAnswered} (95% ${JSON.stringify(o.accuracy95)}), sensitivity ${o.sensitivity}, specificity ${o.specificity}, false yes on reverse direction ${o.falseYesOnReverseDirection}`);
  for (const [q, s] of Object.entries(r.byQuestion)) {
    console.log(`  ${q}:`);
    for (const [row, c] of Object.entries(s!.matrix)) console.log(`    ${row.padEnd(34)} yes ${c.yes}  no ${c.no}  unclear ${c.unclear}`);
  }
}
