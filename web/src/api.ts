// api: thin client for the contributor API and the public proof feed. Mutations send JSON, which the server
// requires (a cross-site form cannot). A 428 means "run a fresh identity check, then retry".

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: any) { super(code); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: method === "GET" ? {} : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `http_${res.status}`, data);
  return data as T;
}

export const api = {
  get: <T>(p: string) => call<T>("GET", p),
  post: <T>(p: string, b?: unknown) => call<T>("POST", p, b),
  put: <T>(p: string, b?: unknown) => call<T>("PUT", p, b),
  del: <T>(p: string) => call<T>("DELETE", p),
};

export type Group = "sleep" | "hrv" | "resting_hr" | "recovery";
export type Grant = { groups: Group[]; historyFrom: string; expiresAt: string; autoCollect: boolean };
export type Me = {
  identity: { provider: "world" | "dev"; verifiedHuman: boolean };
  freshUntil: string; withdrawn: boolean; grant: Grant | null;
  privacyBudget: { used: number; cap: number }; balanceMicro: string;
};
export type Ring = {
  connection: { source: "ultrahuman" | "sample"; status: "active" | "needs_reconnect"; lastSyncAt: string | null; lastSync: any } | null;
  stored: Partial<Record<Group, { days: number; first: string; last: string }>>;
};
export type Brief = { available: true; brief: { date: string; text: string; nights: number; requestId: string | null; provider: string | null; model: string }; cached: boolean; disclaimer: string } | { available: false; reason: string };
export type ActivityItem = {
  queryId: string; at: string; route: "stat" | "pattern"; metric?: string; stat?: string; threshold: number | null; template?: unknown; from: string; to: string;
  answer: any; peopleAbout: number; yourDays: number; epsilon: number; earnedMicro: string;
};
export type Earnings = { balanceMicro: string; earnedMicro: string; claimedMicro: string; minClaimMicro: string; claims: { micro: string; accountId: string | null; status: string; at: string; hashscan: string | null }[] };

/** Starts an identity check that comes back to `returnTo`. With recheck, it must be the signed-in person. */
export function startCheck(returnTo: string, recheck = false) {
  window.location.href = `/api/auth/start?${recheck ? "recheck=1&" : ""}return=${encodeURIComponent(returnTo)}`;
}

/**
 * Runs a mutation that may need a fresh check. On 428 the pending body is parked in sessionStorage, the browser
 * goes through the check, and the page retries it on return (see resumePending).
 */
export async function withFreshCheck<T>(key: string, returnTo: string, body: unknown, run: (b: unknown) => Promise<T>): Promise<T | null> {
  try {
    return await run(body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 428) {
      sessionStorage.setItem(`pending:${key}`, JSON.stringify(body));
      const sep = returnTo.includes("?") ? "&" : "?";
      startCheck(`${returnTo}${sep}resume=${key}`, true);
      return null;
    }
    throw e;
  }
}

export function takePending(key: string): unknown | null {
  const v = sessionStorage.getItem(`pending:${key}`);
  if (v === null) return null;
  sessionStorage.removeItem(`pending:${key}`);
  return JSON.parse(v);
}

export const usd = (micro: string | number | bigint | null | undefined, dp = 2) =>
  micro == null ? "" : `$${(Number(micro) / 1e6).toFixed(Number(micro) !== 0 && Math.abs(Number(micro)) < 10_000 ? 4 : dp)}`;

export const GROUP_LABEL: Record<Group, { name: string; sub: string }> = {
  sleep: { name: "Sleep", sub: "duration, stages, efficiency" },
  hrv: { name: "HRV", sub: "nightly average" },
  resting_hr: { name: "Resting heart rate", sub: "nightly" },
  recovery: { name: "Recovery", sub: "daily score" },
};

export const METRIC_LABEL: Record<string, string> = {
  sleep_minutes: "sleep", deep_sleep_minutes: "deep sleep", rem_sleep_minutes: "REM sleep", sleep_efficiency: "sleep efficiency",
  sleep_score: "sleep score", hrv_ms: "HRV", resting_hr_bpm: "resting heart rate", recovery_score: "recovery",
};

/** A buyer's question in plain words, from the spec. */
export function describeQuestion(q: any): string {
  if (q?.template) {
    const t = q.template;
    return `Does ${METRIC_LABEL[t.outcome] ?? t.outcome} ${t.outcomeDirection === "falls" ? "drop" : "rise"} the night after ${METRIC_LABEL[t.leading] ?? t.leading} ${t.leadDirection === "falls" ? "drops" : "rises"}?`;
  }
  if (q?.route === "pattern") return "A pattern question";
  const m = METRIC_LABEL[q?.metric] ?? q?.metric;
  if (q?.stat === "mean") return `Typical ${m}`;
  return `Share of people with ${m} ${q?.stat === "share_below" ? "below" : "above"} ${q?.threshold}`;
}

export function describeAnswer(a: any): string {
  if (!a) return "";
  if (a.label) return `yes ${a.label.yes} · no ${a.label.no} · unclear ${a.label.unclear}`;
  return `${a.value} ${a.unit} ±${a.plusMinus95}`;
}
