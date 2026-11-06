// The landing page: the Stitch design (landing.generated.tsx) with two live parts, the activity strip from
// /proof/feed and an FAQ whose answers match how the system actually works.
import { useEffect, useState } from "react";
import { api, describeQuestion } from "../api";
import { DemoBanner } from "../components/ui";
import { StitchLanding } from "./landing.generated";

type Feed = {
  totals: { answers: number; paidByAgentsMicro: string; paidToPeopleMicro: string };
  pool: { people: number; synthetic: number };
  audit: { topicId: string } | null;
  queries: { id: string; at: string; route: "plain_math" | "sealed_ai" | "saved_labels"; question: unknown; peopleAbout: number; priceMicro: string; paymentTx: string | null; hashscan: string | null }[];
};

const ROUTE = {
  sealed_ai: { label: "Sealed AI", cls: "bg-indigo-light text-indigo border-indigo-muted" },
  saved_labels: { label: "Saved labels", cls: "bg-sage-subtle text-sage border-sage-border" },
  plain_math: { label: "Plain math", cls: "bg-paper-deeper text-muted border-borderWarm" },
};

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const money = (micro: string) => { const n = Number(micro) / 1e6; return `$${n.toFixed(n !== 0 && n < 0.01 ? 4 : 2)}`; };

function LiveStrip({ feed }: { feed: Feed | null }) {
  const stats = feed ? [
    { label: "Answers sold", value: String(feed.totals.answers), gold: false },
    { label: "Paid to people", value: money(feed.totals.paidToPeopleMicro), gold: true },
    { label: "People in the pool", value: `${feed.pool.people}`, sub: `${feed.pool.synthetic} synthetic, labelled`, gold: false },
    { label: "Rows ever shared", value: "0", sub: "agents get group answers only", gold: false },
  ] : [];
  return (
    <section className="w-full bg-paper-light py-24 border-b border-borderWarm" id="live-activity">
      <div className="max-w-[1280px] mx-auto px-8">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-10 pb-6 border-b border-borderWarm">
          <div>
            <div className="inline-flex items-center gap-2 font-mono uppercase text-xs tracking-wider text-indigo font-semibold mb-3"><span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /><span>Live activity</span></div>
            <h2 className="font-serif text-3xl md:text-4xl text-ink font-normal tracking-tight mb-2">Happening right now. On the record.</h2>
            <p className="text-sm md:text-base text-muted max-w-[720px]">Every paid answer settles in USDC on Hedera, and the buyer agent logs its spending to a public topic. Check any of it yourself.</p>
          </div>
          <div className="shrink-0"><span className="inline-block text-xs font-mono px-2.5 py-1 rounded-full border border-borderWarm bg-white text-muted shadow-sm">Testnet</span></div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {stats.map(s => (
            <div key={s.label} className="bg-white rounded-2xl border border-borderWarm p-6 shadow-sm">
              <div className="text-xs font-mono uppercase tracking-wider text-muted mb-2">{s.label}</div>
              <div className={`font-serif text-3xl font-normal ${s.gold ? "text-gold" : "text-ink"}`}>{s.value}</div>
              {s.sub && <div className="text-xs text-muted mt-2">{s.sub}</div>}
            </div>
          ))}
        </div>
        <div className="bg-white rounded-2xl border border-borderWarm p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="font-medium text-ink">Latest paid answers</div>
            <a className="text-sm text-indigo hover:underline font-medium" href="/audit">View full audit log →</a>
          </div>
          {!feed ? <p className="text-sm text-muted py-4">Loading…</p> : feed.queries.length === 0 ? <p className="text-sm text-muted py-4">No paid answers yet. The first one an agent buys will appear here.</p> : (
            <table className="w-full text-left">
              <thead><tr className="text-xs font-mono uppercase tracking-wider text-muted border-b border-borderWarm">
                <th className="py-2 pr-4 font-normal">Time</th><th className="py-2 px-4 font-normal">Question</th><th className="py-2 px-4 font-normal">Counted</th><th className="py-2 px-4 font-normal">Paid</th><th className="py-2 px-4 font-normal">Route</th><th className="py-2 pl-4 font-normal text-right">Transaction</th>
              </tr></thead>
              <tbody className="divide-y divide-borderWarm/60 text-sm">
                {feed.queries.slice(0, 5).map(q => (
                  <tr key={q.id} className="hover:bg-paper-light/50 transition-colors">
                    <td className="py-3.5 pr-4 text-xs text-muted whitespace-nowrap">{ago(q.at)}</td>
                    <td className="py-3.5 px-4 text-ink">{describeQuestion(q.question)}</td>
                    <td className="py-3.5 px-4 text-xs font-mono text-muted whitespace-nowrap">{q.peopleAbout}+ people</td>
                    <td className="py-3.5 px-4 text-sm font-semibold text-gold whitespace-nowrap">{money(q.priceMicro)}</td>
                    <td className="py-3.5 px-4 whitespace-nowrap"><span className={`border text-xs px-2 py-0.5 rounded-full font-mono ${ROUTE[q.route].cls}`}>{ROUTE[q.route].label}</span></td>
                    <td className="py-3.5 pl-4 text-right whitespace-nowrap">{q.hashscan && <a className="font-mono text-xs text-muted hover:text-indigo bg-paper-light px-2 py-1 rounded border border-borderWarm inline-block" href={q.hashscan} target="_blank" rel="noopener">{q.paymentTx!.slice(0, 18)}… ↗</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="text-xs text-muted font-mono mt-4 pt-3 border-t border-borderWarm/60 flex items-center justify-between flex-wrap gap-2">
            {feed?.audit ? <a className="hover:text-indigo" href={`https://hashscan.io/testnet/topic/${feed.audit.topicId}`} target="_blank" rel="noopener">Spending log on Hedera Consensus Service · topic {feed.audit.topicId} ↗</a> : <span />}
            <span className="text-[11px]">All query fees settled in USDC</span>
          </div>
        </div>
      </div>
    </section>
  );
}

const QA: [string, string][] = [
  ["Do agents ever see my data?", "No. Agents only receive rounded group answers about 20 or more people, with noise added. Your nightly rows stay encrypted under your own key. We run the server that collects and counts, so we are trusted with that part."],
  ["How much can I earn?", "Each time an agent's question counts you, 90% of the price goes to the people counted, split by days of data. On this testnet demo that is fractions of a cent per answer; it depends on how many questions agents ask."],
  ["Do I need a crypto wallet?", "No. When you claim, your browser makes a key and we open a fresh Hedera account for it, with no link to your PulseKey account. You download the key; we never have a copy."],
  ["What happens if I stop sharing?", "No new nights are collected and you're left out of new answers. Withdrawing goes further: your data key is destroyed and your records are deleted. Answers already sold stay sold, and unclaimed earnings stay claimable."],
  ["Is the brief medical advice?", "No. It is written by a model inside a sealed enclave on 0G, from your own nights only, and it can be wrong. Talk to a doctor about anything that worries you."],
];

function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <div className="lg:col-span-7 divide-y divide-borderWarm border-t border-b border-borderWarm">
      {QA.map(([q, a], i) => (
        <div key={q} className="py-5">
          <button className="w-full flex items-center justify-between text-left" onClick={() => setOpen(open === i ? -1 : i)}>
            <h3 className="font-medium text-base text-ink">{q}</h3><span className="text-muted text-lg font-mono">{open === i ? "−" : "+"}</span>
          </button>
          {open === i && <p className="text-sm text-muted mt-2.5 leading-relaxed">{a}</p>}
        </div>
      ))}
    </div>
  );
}

export function Landing() {
  const [feed, setFeed] = useState<Feed | null>(null);
  useEffect(() => { api.get<Feed>("/proof/feed").then(setFeed).catch(() => {}); }, []);
  return (
    <div className="min-h-screen bg-paper-light">
      <DemoBanner />
      <StitchLanding live={<LiveStrip feed={feed} />} faq={<Faq />} />
    </div>
  );
}
