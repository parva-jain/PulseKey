// Runs the buyer API on a persistent local pool, seeding labelled synthetic people on first start.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { openDb } from "../src/db/index.js";
import { createApi } from "../src/api/app.js";
import { createContributorApi } from "../src/api/contributor.js";
import { identityFromEnv } from "../src/identity/index.js";
import { hederaPayouts } from "../src/pool/payouts.js";
import { ultrahuman } from "../src/ultrahuman/connection.js";
import { syncDue } from "../src/ultrahuman/sync.js";
import { modelFromEnv } from "../src/ai/model.js";
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
const model = modelFromEnv();
const app = createApi(db, kek, new HTTPFacilitatorClient({ url: facilitator, timeoutMs: 60_000 }), { baseUrl, payTo, model, audit: { topicId: process.env.HCS_TOPIC_ID, account: process.env.BUYER_ACCOUNT_ID } });

const identity = identityFromEnv(baseUrl);
const study = Client.forTestnet().setOperator(payTo, PrivateKey.fromStringECDSA(process.env.STUDY_PRIVATE_KEY!));
app.use("/api", createContributorApi(db, kek, { identity, chain: hederaPayouts(study, payTo), ring: ultrahuman, model, baseUrl, appUrl: process.env.APP_URL }));

// The web app (npm run web:build), same origin as the API so the session cookie just works.
const web = resolve(import.meta.dirname, "../web/dist");
if (existsSync(web)) {
  app.use(express.static(web, { index: false }));
  app.get(/^\/(?!api\/|proof\/|catalog|quote|queries|\.well-known).*/, (_req, res) => res.sendFile(resolve(web, "index.html")));
} else console.log("web app not built: run npm run web:build");

// Auto-collect: one light pass every hour, syncing anyone not synced in the last SYNC_EVERY_HOURS.
const everyHours = Number(process.env.SYNC_EVERY_HOURS ?? 6);
setInterval(() => syncDue(db, kek, ultrahuman, everyHours).then(r => Object.keys(r).length && console.log("[sync]", r)), 3_600_000).unref();
app.listen(PORT, () => console.log(`buyer API and contributor API on ${PORT} via ${facilitator}; identity: ${identity.name}; sealed AI: ${model.name}`));
