// Public pages: the landing page and the Live audit (screen 10). No sign-in, no health data.
import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, describeAnswer, describeQuestion, usd } from "../api";
import { Logo, Money, ProofChip, Spinner } from "../components/ui";

type Feed = {
  network: string; payTo: string;
  totals: { answers: number; paidByAgentsMicro: string; paidToPeopleMicro: string };
  pool: { people: number; synthetic: number; minGroup: number; epsilonCap: number; budgetHistogram: { bin: number; n: number }[] };
  audit: { topicId: string; account: string | null } | null;
  refusals: string;
  queries: { id: string; at: string; route: "plain_math" | "sealed_ai" | "saved_labels"; question: any; answer: any; peopleAbout: number; epsilon: number; priceMicro: string; sealedReads: number; paymentTx: string | null; hashscan: string | null }[];
};
type Audit = { chain: { entries: number; intact: boolean }; reconciliation: { ok: boolean; matched: number; unlogged: unknown[]; unbacked: unknown[]; actualDebitsMicro: string }; entries: { n: number; at: string; ev: string; amountMicro: string | null; hashscan: string | null; tx: string | null }[]; hashscanTopic: string };

const ROUTE: Record<Feed["queries"][number]["route"], { label: string; cls: string; about: string }> = {
  plain_math: { label: "Plain math", cls: "bg-paper-muted border-line text-muted", about: "A simple number computed by plain code over each person's clipped average, with Laplace noise." },
  sealed_ai: { label: "Sealed AI", cls: "bg-indigo-light border-indigo/10 text-indigo", about: "A new pattern: one sealed AI read per person on 0G Private Computer, answers saved for reuse." },
  saved_labels: { label: "Saved labels", cls: "bg-paper-muted border-line text-ink", about: "A pattern already read: saved per-person answers were counted again, with fresh noise and no new reads." },
};

function Nav() {
  return (
    <header className="max-w-[1280px] mx-auto px-8 py-6 flex items-center justify-between">
      <Logo />
      <nav className="flex items-center gap-8 text-sm text-muted">
        <a href="/#how" className="hover:text-ink">How it works</a>
        <a href="/#privacy" className="hover:text-ink">Privacy</a>
        <Link to="/audit" className="text-ink font-medium">Live activity</Link>
        <Link to="/signup/verify" className="btn-primary !py-2 !px-4 text-sm">Get started</Link>
      </nav>
    </header>
  );
}

export function Audit() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Feed["queries"][number]["route"]>("all");
  useEffect(() => {
    api.get<Feed>("/proof/feed").then(f => { setFeed(f); if (f.audit) api.get<Audit>("/proof/agent").then(setAudit).catch(() => {}); });
  }, []);
  const rows = (feed?.queries ?? []).filter(q => filter === "all" || q.route === filter);
  const hist = feed?.pool.budgetHistogram ?? [];
  const hmax = Math.max(1, ...hist.map(h => h.n));

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-[1280px] mx-auto px-8 pb-16">
        <div className="text-xs text-indigo font-medium flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-sage animate-pulse" />Live · Hedera testnet</div>
        <h1 className="font-serif text-5xl tracking-tight mt-3">Every paid answer, on the record.</h1>
        <p className="text-muted mt-3 max-w-2xl">Agents pay per answer in USDC. Each payment settles on Hedera, and the buyer agent logs its spending to a public topic. No health data is ever shown here.</p>
        {!feed ? <div className="mt-10"><Spinner /></div> : (<>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
            <Stat label="Answers sold" value={String(feed.totals.answers)} />
            <Stat label="USDC paid by agents" value={<Money micro={feed.totals.paidByAgentsMicro} />} />
            <Stat label="Paid to people" value={<Money micro={feed.totals.paidToPeopleMicro} />} />
            <Stat label="People in the pool" value={`${feed.pool.people}`} sub={`${feed.pool.synthetic} synthetic and labelled`} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mt-8 items-start">
            <div className="xl:col-span-2 card p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="font-medium">Paid queries</div>
                <div className="flex gap-2">
                  {(["all", "sealed_ai", "saved_labels", "plain_math"] as const).map(k => (
                    <button key={k} onClick={() => setFilter(k)} className={`px-3 py-1 text-xs rounded-full border ${filter === k ? "bg-indigo text-white border-indigo" : "bg-white text-muted border-line"}`}>{k === "all" ? "All" : ROUTE[k].label}</button>
                  ))}
                </div>
              </div>
              {rows.length === 0 ? <p className="text-sm text-muted py-6">No paid answers yet.</p> : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted border-b border-line"><th className="py-2 font-normal">Time</th><th className="font-normal">Question</th><th className="font-normal">Route</th><th className="font-normal">Group</th><th className="font-normal">Noise</th><th className="font-normal">Price</th><th className="font-normal">Payment</th></tr></thead>
                  <tbody>
                    {rows.map(q => (<Fragment key={q.id}>
                      <tr className="border-b border-line hover:bg-paper/60 cursor-pointer" onClick={() => setOpen(open === q.id ? null : q.id)}>
                        <td className="py-3 font-mono text-xs text-muted">{new Date(q.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                        <td className="pr-3">{describeQuestion(q.question)}</td>
                        <td><span className={`chip ${ROUTE[q.route].cls}`}>{ROUTE[q.route].label}</span></td>
                        <td className="font-mono text-xs">{q.peopleAbout}+</td>
                        <td className="font-mono text-xs">ε {q.epsilon}</td>
                        <td><Money micro={q.priceMicro} className="font-mono text-xs" /></td>
                        <td>{q.hashscan ? <a className="font-mono text-xs link" href={q.hashscan} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}>HashScan ↗</a> : "—"}</td>
                      </tr>
                      {open === q.id && (
                        <tr className="bg-paper/60 border-b border-line"><td colSpan={7} className="p-4 text-xs space-y-2">
                          <div><span className="text-muted">Route: </span>{ROUTE[q.route].about}</div>
                          <div><span className="text-muted">Released answer: </span><span className="font-mono">{describeAnswer(q.answer)} · about {q.peopleAbout}+ people · noise added</span></div>
                          {q.sealedReads > 0 && <div><span className="text-muted">Sealed reads: </span>{q.sealedReads} on 0G, request ids on the proof page</div>}
                          <a className="link font-medium" href={`/proof/queries/${q.id}`} target="_blank" rel="noopener">Full proof: payment, split, 0G attestation ↗</a>
                        </td></tr>
                      )}
                    </Fragment>))}
                  </tbody>
                </table>
              )}
              <p className="text-xs text-muted mt-4">{feed.refusals}</p>
            </div>
            <div className="space-y-6">
              <div className="card p-6">
                <div className="font-medium">Privacy budget, whole pool</div>
                <div className="h-24 flex items-end gap-1.5 mt-4">
                  {Array.from({ length: feed.pool.epsilonCap + 1 }, (_, b) => {
                    const n = hist.find(h => h.bin === b)?.n ?? 0;
                    return <div key={b} className="flex-1 flex flex-col items-center gap-1"><div className="w-full bg-indigo-muted rounded-t-sm" style={{ height: `${(n / hmax) * 80 + (n ? 2 : 0)}px` }} title={`${n} people`} /><span className="text-[10px] text-muted font-mono">{b}</span></div>;
                  })}
                </div>
                <p className="text-xs text-muted mt-3">People by budget used, out of {feed.pool.epsilonCap}. At the limit, a person is left out of new answers.</p>
              </div>
              {feed.audit && (
                <div className="card p-6">
                  <div className="font-medium">Agent spending log</div>
                  <div className="mt-2"><ProofChip label="HCS topic" value={feed.audit.topicId} href={audit?.hashscanTopic ?? `https://hashscan.io/testnet/topic/${feed.audit.topicId}`} /></div>
                  {audit ? (<>
                    <div className="text-sm mt-3 space-y-1">
                      <div className={audit.chain.intact ? "text-sage" : "text-brick"}>{audit.chain.intact ? "✓" : "✗"} Hash chain intact · {audit.chain.entries} entries</div>
                      <div className={audit.reconciliation.ok ? "text-sage" : "text-brick"}>{audit.reconciliation.ok ? "✓" : "✗"} Every USDC debit matches a log entry ({audit.reconciliation.matched} matched{audit.reconciliation.ok ? "" : `, ${audit.reconciliation.unlogged.length} unlogged`})</div>
                    </div>
                    <div className="mt-3 space-y-1">
                      {audit.entries.slice(-4).reverse().map(e => <div key={e.n} className="flex justify-between text-xs font-mono text-muted"><span>#{e.n} {e.ev}</span><span>{e.amountMicro ? usd(e.amountMicro, 6) : ""}</span></div>)}
                    </div>
                    <a className="link text-xs mt-3 inline-block" href="/proof/agent" target="_blank" rel="noopener">Full audit ↗</a>
                  </>) : <div className="mt-3"><Spinner className="w-4 h-4" /></div>}
                </div>
              )}
              <div className="card p-6 text-sm"><div className="font-medium">Refusals cost nothing</div><p className="text-muted mt-1">If fewer than {feed.pool.minGroup} people qualify, the question is refused before any payment is taken.</p></div>
            </div>
          </div>
        </>)}
        <footer className="text-xs text-muted text-center mt-12">Testnet demo · Synthetic data is labelled · No health data on this page</footer>
      </main>
    </div>
  );
}

const Stat = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <div className="card p-5"><div className="text-xs text-muted">{label}</div><div className="font-serif text-3xl mt-1">{value}</div>{sub && <div className="text-xs text-muted mt-1">{sub}</div>}</div>
);
