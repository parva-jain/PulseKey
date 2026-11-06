// proof: what a buyer, judge or contributor can check without trusting us. For a query: the answer, the USDC
// payment on Hedera, how it was split, the sealed reads and 0G's own attestation verdicts. For the buyer agent:
// its public spending log, the hash chain, and a reconciliation against the account's real USDC movements.
// Everything comes from public sources or from rows that carry no person.
import type { Db } from "../db/index.js";
import { mirrorTxId, readTopic, reconcile, replay, usdcDebits, type Entry } from "../hedera/audit.js";
import { hashscanUrl } from "../x402/server.js";
import { ZG_BASE_URL } from "../zg/sealed.js";

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const ZG_ROOT = ZG_BASE_URL.replace(/\/v1$/, "");
const ATTESTATION_TTL_MS = 10 * 60_000;
export const PCVERIFY = "git clone https://github.com/0gfoundation/0g-pc-e2ee && cd 0g-pc-e2ee/client/cmd/pcverify && go build -o pcverify . && ./pcverify -gateway router-api.0g.ai -strict";

type Fetch = typeof fetch;
const getJson = async (f: Fetch, url: string) => {
  const r = await f(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json() as Promise<any>;
};

let attestationCache: { at: number; key: string; value: unknown } | null = null;

/** 0G's gateway and provider identity, as 0G reports it right now. Verdicts are shown as given, never upgraded. */
export async function zgAttestation(providers: string[], f: Fetch = fetch) {
  const key = [...providers].sort().join(",");
  if (attestationCache && attestationCache.key === key && Date.now() - attestationCache.at < ATTESTATION_TTL_MS) return attestationCache.value as Awaited<ReturnType<typeof load>>;
  const value = await load();
  attestationCache = { at: Date.now(), key, value };
  return value;

  async function load() {
    const g = await getJson(f, `${ZG_ROOT}/v1/gateway/identity`).catch(e => ({ error: String(e.message) }));
    const ps = await Promise.all(providers.map(async address => {
      const p = await getJson(f, `${ZG_ROOT}/v1/providers/${address}/identity`).catch(e => ({ error: String(e.message) }));
      return { address, verdicts: p.verdicts ?? null, composeHash: p.compose_hash ?? null, osImage: p.os_image ?? null, error: p.error ?? null };
    }));
    return {
      checkedAt: new Date().toISOString(),
      gateway: { release: g.matched_release?.tag ?? null, releaseUrl: g.matched_release?.url ?? null, composeHash: g.compose_hash ?? null, osImage: g.os_image ?? null, note: g.verify ?? null, error: g.error ?? null },
      providers: ps,
      verifyYourself: PCVERIFY,
      wording: "The gateway verifies the enclave's signature for each sealed response. Gateway and provider attestation can be checked independently with pcverify. These verdicts are 0G's own report, shown as returned.",
    };
  }
}

/** One mirror-node lookup: did this transaction succeed, and how much USDC moved to payTo? */
async function onChain(f: Fetch, tx: string, payTo: string, asset: string) {
  try {
    const { transactions } = await getJson(f, `${MIRROR}/transactions/${mirrorTxId(tx)}`);
    const t = transactions?.find((x: any) => x.result === "SUCCESS");
    if (!t) return { found: false };
    const credit = t.token_transfers?.find((x: any) => x.token_id === asset && x.account === payTo);
    const debit = t.token_transfers?.find((x: any) => x.token_id === asset && x.amount < 0);
    return { found: true, consensusAt: new Date(Number(t.consensus_timestamp) * 1000).toISOString(), creditedMicro: credit ? String(credit.amount) : "0", payer: debit?.account ?? null };
  } catch {
    return { found: false, error: "mirror_unavailable" };
  }
}

export async function queryProof(db: Db, id: string, deps: { payTo: string; asset: string; fetchImpl?: Fetch }) {
  const f = deps.fetchImpl ?? fetch;
  const { rows } = await db.query<{ id: string; route: string; spec: any; result: any; price_micro: string; payment_tx: string | null; payer_account: string | null; status: string; created_at: Date; epsilon: number }>(
    "SELECT id, route, spec, result, price_micro::text, payment_tx, payer_account, status, created_at, epsilon FROM queries WHERE id = $1", [id]);
  const q = rows[0];
  if (!q) return null;
  const split = await db.query<{ people_micro: string; platform_micro: string; earners: number }>(
    `SELECT coalesce(sum(micro) FILTER (WHERE kind = 'earning'), 0)::text AS people_micro,
            coalesce(sum(micro) FILTER (WHERE kind = 'platform'), 0)::text AS platform_micro,
            count(*) FILTER (WHERE kind = 'earning')::int AS earners
       FROM ledger WHERE query_id = $1`, [id]);
  const calls = await db.query<{ request_id: string; provider: string | null; model: string }>("SELECT request_id, provider, model FROM inference_calls WHERE query_id = $1 ORDER BY id", [id]);
  const providers = [...new Set(calls.rows.map(c => c.provider).filter((p): p is string => !!p))];
  const s = split.rows[0];
  return {
    queryId: q.id,
    at: q.created_at.toISOString(),
    status: q.status,
    question: q.spec,
    answer: q.status === "answered" ? q.result : null, // never shown before the payment settled
    privacy: { epsilon: q.epsilon, peopleAbout: q.result?.peopleAbout ?? null, syntheticShare: q.result?.syntheticShare ?? null },
    payment: {
      priceMicro: q.price_micro,
      tx: q.payment_tx,
      hashscan: q.payment_tx ? hashscanUrl(q.payment_tx) : null,
      onChain: q.payment_tx ? await onChain(f, q.payment_tx, deps.payTo, deps.asset) : null,
    },
    // Rounded like every other count, so the split does not reveal the exact group.
    split: { toPeopleMicro: s.people_micro, platformMicro: s.platform_micro, peoplePaidAbout: Math.floor(s.earners / 10) * 10, addsUp: BigInt(s.people_micro) + BigInt(s.platform_micro) === BigInt(q.price_micro) || q.status !== "answered" },
    sealedReads: calls.rows.length
      ? { count: calls.rows.length, model: calls.rows[0].model, providers, requestIds: calls.rows.map(c => c.request_id), attestation: await zgAttestation(providers, f) }
      : null,
  };
}

/** The agent's log: every entry, whether the chain holds, and whether it matches real money movement. */
export async function agentAudit(topicId: string, account: string, deps: { read?: typeof readTopic; debits?: typeof usdcDebits } = {}) {
  const messages = await (deps.read ?? readTopic)(topicId);
  const state = replay(messages, account);
  const entries = messages.map(m => { try { return JSON.parse(m) as Entry; } catch { return null; } })
    .filter((e): e is Entry => !!e && e.account === account);
  const since = entries[0]?.at;
  const debits = since ? await (deps.debits ?? usdcDebits)(account, since) : [];
  const rec = reconcile(state.settled, debits);
  const sum = (xs: { micro: bigint }[]) => xs.reduce((a, x) => a + x.micro, 0n).toString();
  return {
    topicId, account,
    hashscanTopic: `https://hashscan.io/testnet/topic/${topicId}`,
    chain: { entries: state.n, intact: state.breaks.length === 0, breaksAt: state.breaks },
    policy: { hash: state.policy, spentUnderPolicyMicro: state.spentSincePolicy.toString() },
    reconciliation: {
      since: since ?? null,
      loggedSettledMicro: sum(state.settled.map(e => ({ micro: BigInt(e.amount ?? 0) }))),
      actualDebitsMicro: sum(debits),
      matched: rec.matched.length,
      unlogged: rec.unlogged.map(d => ({ ...d, micro: d.micro.toString(), hashscan: hashscanUrl(d.tx) })),
      unbacked: rec.unbacked.map(d => ({ ...d, micro: d.micro.toString() })),
      ok: rec.unlogged.length === 0 && rec.unbacked.length === 0,
    },
    entries: entries.map(e => ({ n: e.n, at: e.at, ev: e.ev, merchant: e.merchant ?? null, amountMicro: e.amount ?? null, tx: e.tx ?? null, hashscan: e.tx ? hashscanUrl(e.tx) : null, reason: e.reason ?? null })),
    note: "Tamper-evident is not the same as complete: an agent could skip logging a payment. That is why every USDC debit on the account is matched against a logged settlement.",
  };
}
