// audit: the buyer agent's public spending log on an HCS topic. Only the agent's key can write to it.
// Entries are hash-chained, the first commits the spending limits, and a reconciliation checks the log
// against the agent's real USDC movements, because a tamper-evident log can still leave things out.
import { createHash } from "node:crypto";
import { Client, PrivateKey, TopicCreateTransaction, TopicMessageSubmitTransaction, type PublicKey } from "@hiero-ledger/sdk";
import { USDC_TESTNET } from "./accounts.js";

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
export const SCHEMA = "agent-spend-audit/1";

export type AuditEvent = "policy.set" | "pay.intent" | "pay.denied" | "pay.settled" | "pay.failed";
export type Policy = { asset: string; maxSessionMicro: string; maxPerPaymentMicro: string; allowPayTo: string[] | null };
export type Entry = {
  v: 1; schema: typeof SCHEMA; agent: string; account: string; ev: AuditEvent; n: number; prev: string | null; at: string;
  merchant?: string; asset?: string; amount?: string; reqHash?: string; pid?: string; policy?: string; tx?: string; reason?: string;
};

/** Where entries go: an HCS topic in production, an array in tests. */
export type Sink = { submit(message: string): Promise<void> };

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const policyHash = (p: Policy) => sha256(JSON.stringify(p));

export class SpendLog {
  n = 0;
  prev: string | null = null;
  policy: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private sink: Sink, readonly agent: string, readonly account: string) {}

  /** Appends one entry. Writes are serialised, because n and prev are not safe to compute concurrently. */
  append(ev: AuditEvent, fields: Partial<Entry> = {}) {
    const next = this.queue.then(async () => {
      const entry: Entry = { v: 1, schema: SCHEMA, agent: this.agent, account: this.account, ev, n: this.n + 1, prev: this.prev, ...fields, at: new Date().toISOString() };
      const bytes = JSON.stringify(entry);
      if (Buffer.byteLength(bytes) > 1024) throw new Error("audit entry over one HCS chunk");
      await this.sink.submit(bytes);
      this.n = entry.n;
      this.prev = sha256(bytes);
      if (ev === "policy.set") this.policy = fields.policy ?? null;
      return entry;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** Commits the limits before any spend. Written again only when they change, so a restart keeps the same budget. */
  async setPolicy(p: Policy) {
    const h = policyHash(p);
    if (this.policy !== h) await this.append("policy.set", { policy: h });
  }

  /** Continues an existing topic: resumes the chain and returns what was spent under the current policy. */
  resume(state: Replayed) {
    if (state.breaks.length) throw new Error(`audit chain broken at entries ${state.breaks.join(", ")}`);
    this.n = state.n;
    this.prev = state.prev;
    this.policy = state.policy;
    return state.spentSincePolicy;
  }
}

export type Replayed = ReturnType<typeof replay>;

/** Rebuilds the log's state from its messages and checks the hash chain. */
export function replay(messages: string[], account: string) {
  let n = 0, prev: string | null = null, policy: string | null = null, spentSincePolicy = 0n;
  const breaks: number[] = [];
  const settled: Entry[] = [];
  for (const m of messages) {
    let e: Entry;
    try { e = JSON.parse(m); } catch { continue; }
    if (e.schema !== SCHEMA || e.account !== account) continue;
    if (e.n !== n + 1 || e.prev !== prev) breaks.push(e.n);
    n = e.n;
    prev = sha256(m);
    if (e.ev === "policy.set") { policy = e.policy ?? null; spentSincePolicy = 0n; }
    if (e.ev === "pay.settled") { spentSincePolicy += BigInt(e.amount ?? 0); settled.push(e); }
  }
  return { n, prev, policy, spentSincePolicy, breaks, settled };
}

export function hcsSink(client: Client, topicId: string, submitKey: PrivateKey): Sink {
  return {
    async submit(message) {
      const tx = await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message).freezeWith(client).sign(submitKey);
      const receipt = await (await tx.execute(client)).getReceipt(client);
      if (receipt.status.toString() !== "SUCCESS") throw new Error(`HCS submit ${receipt.status}`);
    },
  };
}

/** A topic with a submit key and no admin key: only the agent can write, and nobody can delete or change it. */
export async function createAuditTopic(client: Client, submitKey: PublicKey) {
  const res = await new TopicCreateTransaction().setTopicMemo("buyer-agent spend audit v1").setSubmitKey(submitKey).execute(client);
  return (await res.getReceipt(client)).topicId!.toString();
}

/** Every message on the topic, oldest first. The mirror node lags consensus by a few seconds. */
export async function readTopic(topicId: string) {
  const out: string[] = [];
  let url: string | null = `${MIRROR}/topics/${topicId}/messages?order=asc&limit=100`;
  while (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`mirror ${r.status}`);
    const body = (await r.json()) as { messages: { message: string }[]; links: { next: string | null } };
    out.push(...body.messages.map(m => Buffer.from(m.message, "base64").toString("utf8")));
    url = body.links.next ? new URL(body.links.next, MIRROR).toString() : null;
  }
  return out;
}

/** "0.0.1@123.456" (SDK and x402) and "0.0.1-123-456" (mirror node) name the same transaction. */
export const mirrorTxId = (tx: string) => tx.replace("@", "-").replace(/\.(\d+)$/, "-$1");

/** The account's USDC debits since a time, from the mirror node. */
export async function usdcDebits(account: string, sinceIso: string) {
  const since = (Date.parse(sinceIso) / 1000).toFixed(9);
  const out: { tx: string; micro: bigint; at: string }[] = [];
  let url: string | null = `${MIRROR}/transactions?account.id=${account}&timestamp=gte:${since}&order=asc&limit=100`;
  while (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`mirror ${r.status}`);
    const body = (await r.json()) as {
      transactions: { transaction_id: string; result: string; consensus_timestamp: string; token_transfers?: { token_id: string; account: string; amount: number }[] }[];
      links: { next: string | null };
    };
    for (const t of body.transactions) {
      if (t.result !== "SUCCESS") continue;
      const debit = (t.token_transfers ?? []).filter(x => x.token_id === USDC_TESTNET && x.account === account && x.amount < 0).reduce((a, x) => a - BigInt(x.amount), 0n);
      if (debit > 0n) out.push({ tx: t.transaction_id, micro: debit, at: new Date(Number(t.consensus_timestamp) * 1000).toISOString() });
    }
    url = body.links.next ? new URL(body.links.next, MIRROR).toString() : null;
  }
  return out;
}

/**
 * Matches logged settlements to real money movements. "unlogged" is money that left the account with no
 * pay.settled entry; "unbacked" is a pay.settled entry with no matching transfer. Both should be empty.
 */
export function reconcile(settled: Entry[], debits: { tx: string; micro: bigint }[]) {
  const logged = new Map(settled.filter(e => e.tx).map(e => [mirrorTxId(e.tx!), BigInt(e.amount ?? 0)]));
  const moved = new Map(debits.map(d => [d.tx, d.micro]));
  const matched = [...logged].filter(([tx, micro]) => moved.get(tx) === micro).map(([tx]) => tx);
  return {
    matched,
    unlogged: debits.filter(d => !logged.has(d.tx)),
    unbacked: [...logged].filter(([tx, micro]) => moved.get(tx) !== micro).map(([tx, micro]) => ({ tx, micro })),
  };
}
