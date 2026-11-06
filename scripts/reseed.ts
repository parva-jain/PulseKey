// Replaces the synthetic seed people in a persistent pool with a fresh, planted set. Real people, their ring
// connections, records, sessions and earnings are untouched. Stop the server first: PGlite is single-process.
// Usage: tsx --env-file=.env scripts/reseed.ts [people=200] [--force]
// --force also deletes seed people's ledger rows; without it, any seed payment history stops the reseed.
import { openDb } from "../src/db/index.js";
import { poolKek } from "../src/pool/crypto.js";
import { seedPool } from "../src/pool/seed.js";
import { today } from "../src/pool/store.js";

const people = Number(process.argv.find(a => /^\d+$/.test(a)) ?? process.env.SEED_PEOPLE ?? 200);
const force = process.argv.includes("--force");
const db = await openDb(process.env.PGLITE_DIR ?? "./data/pool");
const kek = poolKek();
const count = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;

const real = await count("SELECT count(*)::int AS n FROM contributors WHERE kind = 'real'");
const realRecords = await count("SELECT count(*)::int AS n FROM records r JOIN contributors c ON c.id = r.contributor_id AND c.kind = 'real'");
const seedLedger = await count("SELECT count(*)::int AS n FROM ledger l JOIN contributors c ON c.id = l.contributor_id AND c.kind = 'seed'");
if (seedLedger && !force) {
  console.error(`seed people have ${seedLedger} ledger rows (earnings or sweeps); rerun with --force to drop them too`);
  process.exit(1);
}

await db.transaction(async tx => {
  if (force) await tx.query("DELETE FROM ledger WHERE contributor_id IN (SELECT id FROM contributors WHERE kind = 'seed')");
  // Cascades to keys, grants, records, labels, seed_truth and budget rows of seed people only.
  await tx.query("DELETE FROM contributors WHERE kind = 'seed'");
});
console.log(`removed old seed people; seeding ${people} planted ones...`);
await seedPool(db, kek, { people, days: 90, on: today() });

const after = {
  seed: await count("SELECT count(*)::int AS n FROM contributors WHERE kind = 'seed'"),
  planted: await count("SELECT count(*)::int AS n FROM seed_truth"),
  real: await count("SELECT count(*)::int AS n FROM contributors WHERE kind = 'real'"),
  realRecords: await count("SELECT count(*)::int AS n FROM records r JOIN contributors c ON c.id = r.contributor_id AND c.kind = 'real'"),
};
console.log(after);
if (after.real !== real || after.realRecords !== realRecords) {
  console.error("real people changed during reseed: restore the backup");
  process.exit(1);
}
await db.close();
process.exit(0);
