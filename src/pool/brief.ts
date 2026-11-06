// brief: a short private morning note written by the sealed model from the person's own last 30 nights.
// Generated once per day, sealed under their key, shown only to them with its request id. If the sealed
// model is off or fails, the brief is unavailable: there is no fallback to an ordinary model.
import type { Db } from "../db/index.js";
import type { SealedModel } from "../ai/model.js";
import { openJson, openRecord, sealJson } from "./crypto.js";
import { METRICS } from "./metrics.js";
import { addDays, iso, personKey, today } from "./store.js";

const WINDOW_DAYS = 30;
const MIN_NIGHTS = 5;
const MAX_CHARS = 1200;

export type Brief = { date: string; text: string; nights: number; requestId: string | null; provider: string | null; model: string; sealed: true };
export type BriefResult = { available: true; brief: Brief; cached: boolean; disclaimer: string } | { available: false; reason: string };

const DISCLAIMER = "Written by a model inside a sealed enclave from your own data only. Not medical advice.";
const aad = (id: string, ref: string) => `insight:${id}:${ref}`;

/** One row per night: the metrics the person shares, by name, oldest first. "night" 0 is the latest night. */
async function ownNights(db: Db, kek: Buffer, id: string, on: string) {
  const key = await personKey(db, kek, id);
  const { rows } = await db.query<{ day: Date; grp: string; iv: Uint8Array; blob: Uint8Array }>(
    "SELECT day, grp, iv, blob FROM records WHERE contributor_id = $1 AND day BETWEEN $2::date AND $3::date ORDER BY day",
    [id, addDays(on, -WINDOW_DAYS), on]);
  const byDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const day = iso(r.day);
    const v = openRecord(key, id, day, r.grp, r.iv, r.blob);
    const row = byDay.get(day) ?? {};
    for (const [name, m] of Object.entries(METRICS)) if (m.group === r.grp && typeof v[m.field] === "number") row[name] = v[m.field];
    byDay.set(day, row);
  }
  const days = [...byDay.keys()].sort();
  const last = days.at(-1);
  if (!last) return [];
  const lastMs = Date.parse(`${last}T00:00:00Z`);
  return days.map(d => ({ night: Math.round((Date.parse(`${d}T00:00:00Z`) - lastMs) / 86_400_000), ...byDay.get(d)! }));
}

export function buildBriefPrompt(nights: Record<string, number>[]) {
  return [
    { role: "system" as const, content: "You write a short private morning brief for one person about their own ring data. DATA lists their nights oldest first; night 0 is last night and negative numbers are earlier nights. In 3 or 4 plain sentences, compare last night with their own usual values and mention the one thing that stands out most. Use only numbers present in DATA. Do not diagnose, give medical advice, or mention other people. Write to the person as \"you\"." },
    { role: "user" as const, content: "DATA:\n" + JSON.stringify(nights) },
  ];
}

export async function todaysBrief(db: Db, kek: Buffer, model: SealedModel, id: string, on = today()): Promise<BriefResult> {
  const ref = `brief:${on}`;
  const key = await personKey(db, kek, id).catch(() => null);
  if (!key) return { available: false, reason: "withdrawn" };
  const hit = await db.query<{ iv: Uint8Array; blob: Uint8Array }>("SELECT iv, blob FROM personal_insights WHERE contributor_id = $1 AND ref = $2", [id, ref]);
  if (hit.rows[0]) return { available: true, brief: openJson<Brief>(key, aad(id, ref), hit.rows[0].iv, hit.rows[0].blob), cached: true, disclaimer: DISCLAIMER };

  if (model.name === "off") return { available: false, reason: "sealed_ai_unavailable" };
  const nights = await ownNights(db, kek, id, on);
  if (nights.length < MIN_NIGHTS) return { available: false, reason: "not_enough_nights" };

  let reply;
  try {
    reply = await model.chat({ messages: buildBriefPrompt(nights), max_tokens: 400 });
  } catch {
    return { available: false, reason: "sealed_ai_unavailable" };
  }
  const text = reply.content.trim();
  if (!text || text.length > MAX_CHARS) return { available: false, reason: "sealed_ai_bad_reply" };
  const brief: Brief = { date: on, text, nights: nights.length, requestId: reply.requestId, provider: reply.provider, model: reply.model, sealed: true };
  const { iv, blob } = sealJson(key, aad(id, ref), brief);
  await db.query("INSERT INTO personal_insights (contributor_id, ref, iv, blob) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [id, ref, iv, blob]);
  return { available: true, brief, cached: false, disclaimer: DISCLAIMER };
}
