// metrics: what a grant can cover (groups) and what a query can ask about (metrics, with clip bounds).
import { TOOL_FIELDS } from "../ultrahuman/client.js";

/** A grant group is one Ultrahuman tool's allow-listed fields. */
export const GROUPS = {
  sleep: { tool: "get_sleep_summary", fields: TOOL_FIELDS.get_sleep_summary },
  hrv: { tool: "get_hrv_trend", fields: TOOL_FIELDS.get_hrv_trend },
  resting_hr: { tool: "get_resting_hr", fields: TOOL_FIELDS.get_resting_hr },
  recovery: { tool: "get_recovery_score", fields: TOOL_FIELDS.get_recovery_score },
} as const;
export type Group = keyof typeof GROUPS;
export const isGroup = (g: unknown): g is Group => typeof g === "string" && g in GROUPS;

/**
 * Queryable metrics. Each person's value is clipped to [lo, hi] before counting, which caps how much
 * one person can move a released number; that cap is the sensitivity the noise is scaled to.
 * Bounds are guesses from typical ring ranges: the Ultrahuman probe kept field types, never values.
 */
export const METRICS = {
  sleep_minutes: { group: "sleep", field: "total_sleep_minutes", lo: 180, hi: 720, unit: "min" },
  deep_sleep_minutes: { group: "sleep", field: "deep_sleep_minutes", lo: 0, hi: 240, unit: "min" },
  rem_sleep_minutes: { group: "sleep", field: "rem_sleep_minutes", lo: 0, hi: 240, unit: "min" },
  sleep_efficiency: { group: "sleep", field: "sleep_efficiency", lo: 50, hi: 100, unit: "%" },
  sleep_score: { group: "sleep", field: "sleep_score", lo: 0, hi: 100, unit: "score" },
  hrv_ms: { group: "hrv", field: "hrv_rmssd_ms", lo: 10, hi: 150, unit: "ms" },
  resting_hr_bpm: { group: "resting_hr", field: "bpm", lo: 35, hi: 100, unit: "bpm" },
  recovery_score: { group: "recovery", field: "recovery_score", lo: 0, hi: 100, unit: "score" },
} as const satisfies Record<string, { group: Group; field: string; lo: number; hi: number; unit: string }>;
export type Metric = keyof typeof METRICS;
export const isMetric = (m: unknown): m is Metric => typeof m === "string" && m in METRICS;
