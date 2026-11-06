// db: PGlite (Postgres in-process) for local work. The query/exec/transaction surface matches what `pg` gives on Railway.
import { mkdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

export type Db = PGlite;

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** dataDir undefined means in-memory, which the tests use. */
export async function openDb(dataDir = process.env.PGLITE_DIR): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true }); // PGlite creates only the last folder
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.exec(SCHEMA);
  return db;
}
