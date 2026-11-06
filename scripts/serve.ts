// Runs the buyer API on a persistent local pool, seeding labelled synthetic people on first start.
import { HTTPFacilitatorClient } from "@x402/core/server";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { openDb } from "../src/db/index.js";
import { createApi } from "../src/api/app.js";
import { createContributorApi } from "../src/api/contributor.js";
import { identityFromEnv } from "../src/identity/index.js";
import { hederaPayouts } from "../src/pool/payouts.js";
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
const baseUrl = process.env.API_BASE ?? `http://localhost:${PORT}`;
const payTo = process.env.STUDY_ACCOUNT_ID!;
const app = createApi(db, kek, new HTTPFacilitatorClient({ url: facilitator, timeoutMs: 60_000 }), { baseUrl, payTo });

const identity = identityFromEnv(baseUrl);
const study = Client.forTestnet().setOperator(payTo, PrivateKey.fromStringECDSA(process.env.STUDY_PRIVATE_KEY!));
app.use("/api", createContributorApi(db, kek, { identity, chain: hederaPayouts(study, payTo), baseUrl, appUrl: process.env.APP_URL }));
app.listen(PORT, () => console.log(`buyer API and contributor API on ${PORT} via ${facilitator}; identity: ${identity.name}`));
