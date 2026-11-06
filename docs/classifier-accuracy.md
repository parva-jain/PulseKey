# Sealed classifier accuracy

Measured 2026-11-06 with `npm run eval -- <perCohort> <seed> <clear|subtle>` on 0G Private Computer (`0gm-1.0-35b-a3b`, sealed path). Synthetic people only, no real data.

## What is measured

Four groups of labelled synthetic people, 60 days each, 12 per group:

| Group | What was planted |
|---|---|
| `sleep_leads_hrv` | Short nights, then an HRV dip the next night |
| `hrv_leads_sleep` | HRV dips, then a short night the next night |
| `independent_events` | Both happen, at unrelated times |
| `no_events` | Neither |

Each person is asked two questions: "does sleep fall the night before HRV falls?" and the reverse. Only the matching group's true answer is yes, so a model that just spots "both metrics dip sometimes" gets the reverse direction wrong. Raw per-person answers are scored before any noise. The plain-code reference rule runs on the same people.

## Results (96 answers per run)

| Run | Judge | Coverage | Accuracy among answered (95% CI) | Sensitivity | Specificity | False yes, reverse direction |
|---|---|---|---|---|---|---|
| Clear, seed 101 | Plain-code rule | 95% | 98.9% (94.0–99.8) | 100% | 98.5% | 0% |
| Clear, seed 101 | 0G sealed model | 100% | 100% (96.2–100) | 100% | 100% | 0% |
| Subtle, seed 202 | Plain-code rule | 90% | 100% (95.7–100) | 100% | 100% | 0% |
| Subtle, seed 202 | 0G sealed model | 100% | 95.8% (89.8–98.4) | 83% | 100% | 0% |

"Clear" is a 2 to 3 hour short night and a 20 to 35% HRV dip; "subtle" is about an hour and a 10 to 20% dip.

## What did not work

| Input | Result |
|---|---|
| Raw nightly values, thinking off, 64 tokens | Answered "no" for all 96. Sensitivity 0%; the 75% accuracy was just the share of true noes |
| Raw nightly values, thinking on, 4,000 tokens | 29% coverage, mostly unclear or malformed, 70 calls for 48 answers, 12.9 minutes for 12 people |

The working input ("aligned", the default) has plain code reshape the data without deciding anything: each row pairs a night's outcome with the leading metric over the nights before it, both as z-scores against the person's own average. The model never sees absolute values or dates.

## Limits

- Synthetic data with a known structure. Accuracy on real people is unknown.
- The prompt's "below -1 z" wording mirrors the reference rule, so on these questions the model is close to applying that rule. Its value is handling any closed template inside the sealed enclave without new code per question, not beating the rule.
- Two seeds, 48 people each. Wider seeds and lag 2 and 3 are untested.
