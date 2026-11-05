// privacy: noise, the group minimum, budgets, and the pay split. Plain code only; no model touches these numbers.
import { randomBytes } from "node:crypto";

export const MIN_GROUP = Number(process.env.MIN_GROUP ?? 20);
export const QUERY_EPSILON = Number(process.env.QUERY_EPSILON ?? 0.5);
/** Lifetime privacy spend per person. Someone at the cap is no longer eligible for anything. */
export const PERSON_EPSILON_CAP = Number(process.env.PERSON_EPSILON_CAP ?? 10);
export const MIN_DAYS = 3;

/** Uniform in (0, 1) from the OS CSPRNG; Math.random is predictable enough to subtract the noise back out. */
function uniform() {
  const n = randomBytes(6).readUIntBE(0, 6);
  return (n + 0.5) / 2 ** 48;
}

/** Continuous Laplace(0, scale) by inverse CDF. */
export function laplace(scale: number) {
  const u = uniform() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

/** Discrete Laplace for counts: the difference of two geometric draws with p = 1 - e^(-epsilon). */
export function discreteLaplace(epsilon: number) {
  const p = 1 - Math.exp(-epsilon);
  const geo = () => Math.floor(Math.log(uniform()) / Math.log(1 - p));
  return geo() - geo();
}

/** Half-width of the central 95% of Laplace(scale) noise, so buyers can see how rough an answer is. */
export const laplace95 = (scale: number) => scale * Math.log(20);

/** Integer split by days, largest remainder first, so the parts always add up to the pool exactly. */
export function splitByDays(poolMicro: bigint, days: Map<string, number>) {
  const total = BigInt([...days.values()].reduce((a, b) => a + b, 0));
  if (total === 0n) throw new Error("no_days");
  const rows = [...days].map(([id, d]) => {
    const n = poolMicro * BigInt(d);
    return { id, amt: n / total, rem: n % total };
  });
  let left = poolMicro - rows.reduce((a, r) => a + r.amt, 0n);
  rows.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.id < b.id ? -1 : 1));
  for (const r of rows) {
    if (left === 0n) break;
    r.amt += 1n;
    left -= 1n;
  }
  return new Map(rows.map(r => [r.id, r.amt]));
}
