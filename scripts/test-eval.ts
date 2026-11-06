// The accuracy harness itself: planted patterns are detectable by a plain rule (so the truth labels mean
// something), and scoring counts what it should. The live model run is scripts/eval-classifier.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptedModel } from "../src/ai/model.js";
import { evaluate } from "../src/eval/run.js";
import { CLEAR, plantedPerson, score } from "../src/eval/planted.js";

test("planted data: a short night is followed by an HRV dip only in the sleep-leads cohort", () => {
  const a = plantedPerson(1, "2026-09-01", 60, "sleep_leads_hrv");
  const short = a.sleep.map((r, i) => [r.total_sleep_minutes, i] as const).sort((x, y) => x[0] - y[0]).slice(0, CLEAR.events).map(([, i]) => i);
  const meanHrv = a.hrv.reduce((s, r) => s + r.hrv_rmssd_ms, 0) / a.hrv.length;
  const after = short.filter(i => i + 1 < 60).map(i => a.hrv[i + 1].hrv_rmssd_ms);
  assert.ok(after.every(v => v < meanHrv), "HRV is below its mean the night after every planted short night");
  const none = plantedPerson(2, "2026-09-01", 60, "no_events");
  assert.ok(Math.min(...none.sleep.map(r => r.total_sleep_minutes)) > 300, "no planted short nights");
});

test("the plain-code baseline finds the planted direction, so the truth labels are sound", async () => {
  const r = await evaluate({ kind: "baseline" }, { perCohort: 8 });
  console.log("  baseline:", JSON.stringify({ coverage: r.overall.coverage, accuracy: r.overall.accuracyAmongAnswered, sens: r.overall.sensitivity, spec: r.overall.specificity }));
  assert.ok(r.overall.accuracyAmongAnswered! >= 0.85);
  assert.ok(r.overall.sensitivity! >= 0.8);
  assert.ok(r.overall.falseYesOnReverseDirection! <= 0.15, "direction matters");
});

test("scoring: an always-no model is perfectly specific and never sensitive", async () => {
  const model = scriptedModel(() => '{"answer":"no"}');
  const r = await evaluate({ kind: "model", model }, { perCohort: 3 });
  assert.equal(r.overall.specificity, 1);
  assert.equal(r.overall.sensitivity, 0);
  assert.equal(r.overall.coverage, 1);
  assert.equal(model.calls.length, 3 * 4 * 2, "one read per person per question");
  assert.deepEqual(score([{ cohort: "no_events", truth: "no", got: "unclear" }]).coverage, 0);
});

test("demo seed pool: planted cohorts are recorded and the plain rule finds them in the real pipeline", async () => {
  const { randomBytes } = await import("node:crypto");
  const { openDb } = await import("../src/db/index.js");
  const { seedPool } = await import("../src/pool/seed.js");
  const { addDays, today } = await import("../src/pool/store.js");
  const { eligiblePattern, jointRows } = await import("../src/pool/pattern.js");
  const { baselineAnswer, QUESTIONS, TRUTH } = await import("../src/eval/planted.js");
  const db = await openDb();
  const kek = randomBytes(32);
  await seedPool(db, kek, { people: 60, days: 90, on: today() });
  const truth = new Map((await db.query<{ contributor_id: string; cohort: string }>("SELECT contributor_id, cohort FROM seed_truth")).rows.map(r => [r.contributor_id, r.cohort]));
  assert.equal(truth.size, 60);
  const share = [...truth.values()].filter(c => c === "sleep_leads_hrv").length / 60;
  assert.ok(share > 0.25 && share < 0.55, `about 40% planted with the coach's pattern, got ${share}`);

  const spec = { route: "pattern" as const, template: QUESTIONS.sleep_then_hrv, from: addDays(today(), -45), to: addDays(today(), -1) };
  let answered = 0, correct = 0;
  for (const id of (await eligiblePattern(db, spec)).keys()) {
    const got = baselineAnswer(spec.template, await jointRows(db, kek, spec, id));
    if (got === "unclear") continue;
    answered++;
    if (got === TRUTH.sleep_then_hrv[truth.get(id) as keyof typeof TRUTH.sleep_then_hrv]) correct++;
  }
  console.log(`  demo pool, plain rule: ${correct}/${answered} correct among answered`);
  assert.ok(answered >= 25 && correct / answered >= 0.85);
});
