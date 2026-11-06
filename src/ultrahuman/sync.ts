// sync: pulls the granted groups from the person's source and seals them. Only granted tools are called,
// only allow-listed fields are kept (storeRows), and only days inside the grant are stored.
import { createHash } from "node:crypto";
import type { Db } from "../db/index.js";
import { GROUPS, type Group } from "../pool/metrics.js";
import { Refused } from "../pool/query.js";
import { syntheticPerson } from "../pool/seed.js";
import { activeGrant, addDays, iso, storeRows, today } from "../pool/store.js";
import { accessToken, getConnection, type RingApi } from "./connection.js";

const MAX_DAYS_PER_CALL = 90; // Ultrahuman's dated tools take at most about 90 days per call
const REPULL_DAYS = 3; // recent nights can still be revised, so each sync re-reads the last few days
const SAMPLE_ORIGIN = "2026-01-01"; // sample series start here, so a day's values never change between syncs

export type SyncSummary = Partial<Record<Group, { from: string; to: string; stored: number }>>;

const inFlight = new Set<string>();

export async function syncPerson(db: Db, kek: Buffer, api: RingApi, personId: string, on = today()): Promise<SyncSummary> {
  if (inFlight.has(personId)) throw new Refused("sync_in_progress", 409);
  inFlight.add(personId);
  try {
    const grant = await activeGrant(db, personId, on);
    if (!grant) throw new Refused("no_active_grant", 409);
    const conn = await getConnection(db, personId);
    if (!conn) throw new Refused("not_connected", 409);
    if (conn.status === "needs_reconnect") throw new Refused("ring_needs_reconnect", 409);

    const historyFrom = iso(grant.history_from);
    const end = [on, iso(grant.expires_at)].sort()[0];
    const summary: SyncSummary = {};
    for (const grp of grant.groups) {
      const last = (await db.query<{ last: Date | null }>("SELECT max(day) AS last FROM records WHERE contributor_id = $1 AND grp = $2", [personId, grp])).rows[0].last;
      const from = last ? [historyFrom, addDays(iso(last), -REPULL_DAYS)].sort()[1] : historyFrom;
      if (from > end) continue;
      const rows = conn.source === "sample"
        ? syntheticPerson(sampleSeed(personId), SAMPLE_ORIGIN, end)[grp].filter(r => String(r.date) >= from)
        : await pull(db, kek, api, personId, GROUPS[grp].tool, from, end);
      summary[grp] = { from, to: end, stored: await storeRows(db, kek, personId, grp, rows, on) };
    }
    await db.query("UPDATE connections SET last_sync_at = now(), last_sync = $2 WHERE contributor_id = $1", [personId, { at: new Date().toISOString(), groups: summary }]);
    return summary;
  } finally {
    inFlight.delete(personId);
  }
}

/** One tool over a date range, in chunks. A 401 refreshes once and retries; a 429 stops the sync. */
async function pull(db: Db, kek: Buffer, api: RingApi, personId: string, tool: string, from: string, to: string) {
  const out: Record<string, unknown>[] = [];
  for (let start = from; start <= to; start = addDays(start, MAX_DAYS_PER_CALL)) {
    const args = { start_date: start, end_date: [addDays(start, MAX_DAYS_PER_CALL - 1), to].sort()[0] };
    let token = await accessToken(db, kek, api, personId);
    try {
      out.push(...(await api.rows(token, tool, args)));
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429) throw new Refused("ring_rate_limited", 429);
      if (status !== 401) throw e;
      token = await accessToken(db, kek, api, personId, { force: true, stale: token });
      out.push(...(await api.rows(token, tool, args)));
    }
  }
  return out;
}

/** The scheduled pass: everyone with auto-collect on, an active source, and no sync in the last few hours. */
export async function syncDue(db: Db, kek: Buffer, api: RingApi, everyHours: number, on = today()) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.contributor_id AS id FROM connections c
       JOIN grants g ON g.contributor_id = c.contributor_id AND g.status = 'active' AND g.auto_collect AND g.expires_at >= $1::date
      WHERE c.status = 'active' AND (c.last_sync_at IS NULL OR c.last_sync_at < now() - make_interval(hours => $2))`,
    [on, everyHours]);
  const results: Record<string, string> = {};
  for (const { id } of rows) {
    try {
      await syncPerson(db, kek, api, id, on);
      results[id] = "ok";
    } catch (e) {
      results[id] = e instanceof Refused ? e.code : "error";
    }
  }
  return results;
}

const sampleSeed = (personId: string) => parseInt(createHash("sha256").update(personId).digest("hex").slice(0, 8), 16);
