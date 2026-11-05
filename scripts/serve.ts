// Runs the buyer API on a persistent local pool, seeding labelled synthetic people on first start.
import { HTTPFacilitatorClient } from "@x402/core/server";
import { openDb } from "../src/db/index.js";
import { createApi } from "../src/api/app.js";
import { poolKek } from "../src/pool/crypto.js";
import { seedPool } from "../src/pool/seed.js";
import { today } from "../src/pool/store.js";

const PORT = Number(process.env.PORT ?? 4021);
const db = await openDb(process.env.PGLITE_DIR ?? "./data/pool");
const kek = poolKek();

const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contributors");
if (rows[0].n === 0) {
  const people = Number(process.env.SEED_PEOPLE ?? 200);
  console.log(`seeding ${people} synthetic people...`);
  await seedPool(db, kek, { people, days: 90, on: today() });
}

const facilitator = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const app = createApi(db, kek, new HTTPFacilitatorClient({ url: facilitator, timeoutMs: 60_000 }), {
  baseUrl: process.env.API_BASE ?? `http://localhost:${PORT}`,
  payTo: process.env.STUDY_ACCOUNT_ID!,
});
app.listen(PORT, () => console.log(`buyer API on ${PORT} via ${facilitator}`));
