// html: plain server-rendered views of the proof JSON, so a judge can open a link. Styling is deliberately
// minimal; the web app will restyle these from the Stitch designs. Every value is escaped.
import type { agentAudit, queryProof } from "./index.js";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (micro: string | null | undefined) => (micro == null ? "" : `$${(Number(micro) / 1e6).toFixed(6)}`);
const link = (href: string | null | undefined, text: string) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : "");
const ok = (good: boolean, yes: string, no: string) => `<span class="${good ? "ok" : "bad"}">${good ? "✓" : "✗"} ${esc(good ? yes : no)}</span>`;

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b675f;--line:#e4e0d8;--ok:#1f7a4d;--bad:#b3261e;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ecebe8;--muted:#a19d95;--line:#2c2b29;--ok:#5fc98f;--bad:#ff8a80;--card:#1c1c1b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:var(--muted)}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:16px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}a{color:inherit}
.big{font-size:28px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.scroll{max-height:220px;overflow:auto}
</style></head><body><main>${body}</main></body></html>`;
}

export function queryProofHtml(p: NonNullable<Awaited<ReturnType<typeof queryProof>>>) {
  const a = p.answer as any;
  const shown = !a ? `<p class="muted">Not released: status ${esc(p.status)}.</p>`
    : a.answer ? `<div class="grid"><div><div class="muted">Yes</div><div class="big">${esc(a.answer.label.yes)}</div></div><div><div class="muted">No</div><div class="big">${esc(a.answer.label.no)}</div></div><div><div class="muted">Unclear</div><div class="big">${esc(a.answer.label.unclear)}</div></div></div><p class="muted">±${esc(a.answer.plusMinus95)} points (95% noise range)</p>`
    : `<div class="big">${esc(a.value)} ${esc(a.unit)}</div><p class="muted">±${esc(a.plusMinus95)} (95% noise range)</p>`;
  const sr = p.sealedReads;
  const att = sr?.attestation;
  return page("Query proof", `
<h1>Query proof</h1><p class="muted">${esc(p.queryId)} · ${esc(p.at)}</p>
<section><h2>Question</h2><code>${esc(JSON.stringify(p.question))}</code></section>
<section><h2>Answer</h2>${shown}<p class="muted">About ${esc(p.privacy.peopleAbout)}+ people · ε = ${esc(p.privacy.epsilon)} per person · ${esc(Math.round(Number(p.privacy.syntheticShare ?? 0) * 100))}% synthetic. Nobody's own value or answer is released.</p></section>
<section><h2>Payment on Hedera</h2>
<p>${usd(p.payment.priceMicro)} USDC · ${link(p.payment.hashscan, "view on HashScan")}</p>
<p>${!p.payment.onChain ? '<span class="muted">No payment recorded.</span>'
    : !p.payment.onChain.found ? '<span class="muted">… not on the mirror node yet. It lags consensus by a few seconds; reload to check.</span>'
    : ok(p.payment.onChain.creditedMicro === p.payment.priceMicro, `confirmed on the mirror node at ${p.payment.onChain.consensusAt ?? ""}, exact amount credited`, `mirror node shows ${usd(p.payment.onChain.creditedMicro)} credited, not the price`)}</p>
<p>To the people counted: ${usd(p.split.toPeopleMicro)} across about ${esc(p.split.peoplePaidAbout)}+ people, split by days of data · platform: ${usd(p.split.platformMicro)} · ${ok(p.split.addsUp, "adds up to the price", "does not add up")}</p></section>
${sr && att ? `<section><h2>Sealed reads on 0G Private Computer</h2>
<p>${esc(sr.count)} reads · model <code>${esc(sr.model)}</code> · every reply was refused unless it came back with <code>x-0g-e2ee: sealed</code>.</p>
<table><tr><th>Provider</th><th>DCAP quote</th><th>On-chain signer</th><th>Measurement</th><th>Runtime release</th><th>Compose baseline</th></tr>
${att.providers.map(pr => `<tr><td><code>${esc(pr.address)}</code></td>${["quote_dcap", "onchain_signer", "measurement", "runtime_release", "compose_baseline"].map(k => `<td>${esc(pr.verdicts?.[k] ?? pr.error ?? "")}</td>`).join("")}</tr>`).join("")}</table>
<p>Gateway release ${link(att.gateway.releaseUrl, att.gateway.release ?? "unknown")} · compose <code>${esc(att.gateway.composeHash)}</code> · checked ${esc(att.checkedAt)}</p>
<p class="muted">${esc(att.wording)}</p><p>Verify it yourself:</p><code>${esc(att.verifyYourself)}</code>
<h2>Request ids (shuffled, no person attached)</h2><div class="scroll"><code>${sr.requestIds.map(esc).join("<br>")}</code></div></section>` : ""}
`);
}

export function agentAuditHtml(a: Awaited<ReturnType<typeof agentAudit>>) {
  const r = a.reconciliation;
  return page("Agent spending log", `
<h1>Buyer agent spending log</h1><p class="muted">Account ${esc(a.account)} · topic ${link(a.hashscanTopic, a.topicId)}</p>
<section class="grid">
<div><div class="muted">Hash chain</div><div class="big">${ok(a.chain.intact, `${a.chain.entries} entries intact`, `broken at ${a.chain.breaksAt.join(", ")}`)}</div></div>
<div><div class="muted">Logged settlements</div><div class="big">${usd(r.loggedSettledMicro)}</div></div>
<div><div class="muted">Actual USDC debits</div><div class="big">${usd(r.actualDebitsMicro)}</div></div>
<div><div class="muted">Reconciliation</div><div class="big">${ok(r.ok, `${r.matched} matched`, `${r.unlogged.length} unlogged, ${r.unbacked.length} unbacked`)}</div></div>
</section>
${r.unlogged.length ? `<section><h2>Money that left with no log entry</h2><table><tr><th>Transaction</th><th>Amount</th></tr>${r.unlogged.map(u => `<tr><td>${link(u.hashscan, u.tx)}</td><td>${usd(u.micro)}</td></tr>`).join("")}</table></section>` : ""}
${r.unbacked.length ? `<section><h2>Logged settlements with no matching transfer</h2><table>${r.unbacked.map(u => `<tr><td><code>${esc(u.tx)}</code></td><td>${usd(u.micro)}</td></tr>`).join("")}</table></section>` : ""}
<section><h2>Entries</h2><table><tr><th>#</th><th>Time</th><th>Event</th><th>Amount</th><th>Payee</th><th>Transaction or reason</th></tr>
${a.entries.map(e => `<tr><td>${esc(e.n)}</td><td>${esc(e.at)}</td><td>${esc(e.ev)}</td><td>${e.amountMicro ? usd(e.amountMicro) : ""}</td><td><code>${esc(e.merchant)}</code></td><td>${e.hashscan ? link(e.hashscan, e.tx!) : esc(e.reason)}</td></tr>`).join("")}</table>
<p class="muted">${esc(a.note)}</p></section>
<p class="muted">Policy ${esc(a.policy.hash?.slice(0, 16))}… · spent under it: ${usd(a.policy.spentUnderPolicyMicro)} · reconciled since ${esc(r.since)}</p>
`);
}
