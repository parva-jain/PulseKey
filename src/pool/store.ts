// store: contributors, standing grants, sealed daily records, and withdrawal.
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { pickFields } from "../ultrahuman/client.js";
import { sealRecord, unwrapPersonKey, wrapPersonKey } from "./crypto.js";
import { GROUPS, isGroup, type Group } from "./metrics.js";

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);

export async function createContributor(db: Db, kek: Buffer, kind: "real" | "seed", world?: { iss: string; sub: string }) {
  const id = randomUUID();
  const { wrapped } = wrapPersonKey(kek, id);
  await db.transaction(async tx => {
    await tx.query("INSERT INTO contributors (id, kind, world_iss, world_sub) VALUES ($1, $2, $3, $4)", [id, kind, world?.iss ?? null, world?.sub ?? null]);
    await tx.query("INSERT INTO contributor_keys (contributor_id, wrapped) VALUES ($1, $2)", [id, wrapped]);
  });
  return id;
}

export async function personKey(db: Db, kek: Buffer, personId: string) {
  const { rows } = await db.query<{ wrapped: Uint8Array }>("SELECT wrapped FROM contributor_keys WHERE contributor_id = $1", [personId]);
  if (!rows[0]) throw new Error("withdrawn");
  return unwrapPersonKey(kek, personId, rows[0].wrapped);
}

export type GrantInput = { groups: Group[]; historyDays: number; validDays: number; autoCollect?: boolean };

/** One active grant per person: a new grant replaces the old one, so widening and narrowing are the same call. */
export async function setGrant(db: Db, personId: string, g: GrantInput, on = today()) {
  if (!g.groups.length || !g.groups.every(isGroup)) throw new Error("bad_groups");
  if (!(g.historyDays >= 0 && g.historyDays <= 365 && g.validDays >= 1 && g.validDays <= 365)) throw new Error("bad_days");
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.query("UPDATE grants SET status = 'revoked' WHERE contributor_id = $1 AND status = 'active'", [personId]);
    await tx.query(
      "INSERT INTO grants (id, contributor_id, groups, history_from, expires_at, auto_collect) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, personId, g.groups, addDays(on, -g.historyDays), addDays(on, g.validDays), g.autoCollect ?? true],
    );
  });
  return id;
}

export async function activeGrant(db: Db, personId: string, on = today()) {
  const { rows } = await db.query<{ id: string; groups: Group[]; history_from: Date; expires_at: Date; auto_collect: boolean }>(
    "SELECT id, groups, history_from, expires_at, auto_collect FROM grants WHERE contributor_id = $1 AND status = 'active' AND expires_at >= $2",
    [personId, on],
  );
  return rows[0] ?? null;
}

/**
 * Seals raw tool rows for one group. Only allow-listed fields survive, and only days inside the
 * active grant are kept, so the collector cannot store something the person did not grant.
 */
export async function storeRows(db: Db, kek: Buffer, personId: string, grp: Group, rows: Record<string, unknown>[], on = today()) {
  const grant = await activeGrant(db, personId, on);
  if (!grant?.groups.includes(grp)) throw new Error("not_granted");
  const from = iso(grant.history_from), to = iso(grant.expires_at);
  const key = await personKey(db, kek, personId);
  let stored = 0;
  for (const raw of rows) {
    const { date, values } = pickFields(raw, GROUPS[grp].fields);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to || !Object.keys(values).length) continue;
    const { iv, blob } = sealRecord(key, personId, date, grp, values);
    await db.query(
      "INSERT INTO records (contributor_id, day, grp, iv, blob) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (contributor_id, day, grp) DO UPDATE SET iv = $4, blob = $5",
      [personId, date, grp, iv, blob],
    );
    stored++;
  }
  return stored;
}

/** Destroys the key first, so even a failure halfway leaves the records unreadable. */
export async function withdraw(db: Db, personId: string) {
  await db.transaction(async tx => {
    await tx.query("DELETE FROM contributor_keys WHERE contributor_id = $1", [personId]);
    await tx.query("UPDATE grants SET status = 'revoked' WHERE contributor_id = $1", [personId]);
    await tx.query("DELETE FROM records WHERE contributor_id = $1", [personId]);
    await tx.query("DELETE FROM labels WHERE contributor_id = $1", [personId]);
    await tx.query("DELETE FROM personal_insights WHERE contributor_id = $1", [personId]);
  });
}

export const iso = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
