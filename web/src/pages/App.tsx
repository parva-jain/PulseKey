// The signed-in app, screens 6 to 9: Today (the sealed brief), Activity, Earnings with the claim flow, and Grant.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { secp256k1 } from "@noble/curves/secp256k1";
import { api, ApiError, describeAnswer, describeQuestion, GROUP_LABEL, takePending, usd, withFreshCheck, type ActivityItem, type Brief, type Earnings, type Group, type Ring } from "../api";
import { AppShell, Money, Notice, ProofChip, Spinner, Toggle, useMe } from "../components/ui";

const DAY_MS = 86_400_000;
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const routeChip = (i: Pick<ActivityItem, "route"> & { sealed?: boolean }) =>
  i.route === "pattern"
    ? <span className="chip bg-indigo-light border-indigo/10 text-indigo">Sealed AI</span>
    : <span className="chip bg-paper-muted border-line text-muted">Plain math</span>;

function useActivity() {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  useEffect(() => { api.get<{ items: ActivityItem[] }>("/api/me/activity").then(r => setItems(r.items)).catch(() => setItems([])); }, []);
  return items;
}

// ---------------- Today ----------------

export function Today() {
  const { me } = useMe();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [nights, setNights] = useState<{ day: string; sleepMinutes?: number; hrvMs?: number }[]>([]);
  const [earn, setEarn] = useState<Earnings | null>(null);
  const [ring, setRing] = useState<Ring | null>(null);
  const items = useActivity();
  useEffect(() => {
    api.get<Brief>("/api/me/brief").then(setBrief).catch(() => setBrief({ available: false, reason: "error" }));
    api.get<{ nights: typeof nights }>("/api/me/nights").then(r => setNights(r.nights)).catch(() => {});
    api.get<Earnings>("/api/me/earnings").then(setEarn).catch(() => {});
    api.get<Ring>("/api/ring").then(setRing).catch(() => {});
  }, []);
  const week = (items ?? []).filter(i => Date.now() - Date.parse(i.at) < 7 * DAY_MS);
  const today = (items ?? []).filter(i => new Date(i.at).toDateString() === new Date().toDateString());
  const sum = (xs: ActivityItem[]) => xs.reduce((a, i) => a + Number(i.earnedMicro), 0);
  const grant = me?.grant;
  const total = grant ? Math.round((Date.parse(grant.expiresAt) - Date.parse(grant.historyFrom)) / DAY_MS) : 0;
  const left = grant ? Math.max(0, Math.round((Date.parse(grant.expiresAt) - Date.now()) / DAY_MS)) : 0;

  return (
    <AppShell me={me}>
      <div className="flex items-baseline justify-between border-b border-line pb-5">
        <div className="flex items-baseline gap-3">
          <h1 className="font-serif text-[34px] tracking-tight">Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}</h1>
          <span className="text-sm text-muted">{new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
        </div>
        {today.length > 0 && <span className="chip bg-gold-bg border-gold-border text-gold text-xs">+{usd(sum(today))} today</span>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card p-7 flex flex-col justify-between">
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Your morning brief</span>
              {brief?.available && <span className="chip bg-paper border-line text-muted font-mono">from your last {brief.brief.nights} nights</span>}
            </div>
            {!brief ? (
              <div className="space-y-3 animate-pulse"><div className="h-5 bg-paper-muted rounded w-11/12" /><div className="h-5 bg-paper-muted rounded w-10/12" /><div className="h-5 bg-paper-muted rounded w-7/12" /><div className="text-xs text-muted flex items-center gap-2"><Spinner className="w-3.5 h-3.5" /> Reading your nights inside a sealed enclave…</div></div>
            ) : brief.available ? (
              <p className="font-serif text-[22px] leading-relaxed text-ink/90">“{brief.brief.text}”</p>
            ) : (
              <div className="rounded-xl border border-line bg-paper p-5 text-sm">
                <div className="font-medium">{brief.reason === "not_enough_nights" ? "Your first brief is on its way." : "Your brief is unavailable right now."}</div>
                <p className="text-muted mt-1">{brief.reason === "not_enough_nights" ? "It needs at least 5 nights of data. Check back after a few more nights sync." : "The sealed model couldn't be reached. We never fall back to a model that could read your data in the clear."}</p>
              </div>
            )}
            <SleepBars nights={nights} />
          </div>
          <div className="flex items-center justify-between pt-5 mt-5 border-t border-line">
            {brief?.available && brief.brief.requestId ? <ProofChip label="Sealed on 0G ·" value={brief.brief.requestId} /> : <span />}
            <span className="text-[11px] text-muted">Not medical advice</span>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div className="card p-6">
            <div className="flex items-center justify-between mb-3"><span className="eyebrow">Earnings</span><span className="text-[11px] text-muted font-mono">USDC · testnet</span></div>
            <div className="flex items-baseline gap-2"><Money micro={earn?.balanceMicro ?? "0"} className="font-serif text-4xl" /><span className="text-xs text-muted">ready to claim</span></div>
            <p className="text-xs text-muted mt-1 mb-5">{usd(sum(week))} this week · {week.length} answers</p>
            <div className="pt-4 border-t border-line flex items-center justify-between">
              <span className="text-[11px] text-muted">Sent to a fresh Hedera account</span>
              <Link to="/app/earnings" className="bg-indigo hover:bg-indigo-hover text-white text-xs font-medium px-4 py-1.5 rounded-lg">Claim</Link>
            </div>
          </div>
          <div className="card p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="eyebrow">Your grant</span>
              {grant ? <span className="chip bg-sage-bg border-sage-border text-sage">● Collecting</span> : <span className="chip bg-paper-muted border-line text-muted">Not sharing</span>}
            </div>
            {grant ? (<>
              <div className="font-medium mb-3">{grant.groups.map(g => GROUP_LABEL[g].name).join(" + ")}</div>
              <div className="w-full h-1.5 bg-line rounded-full overflow-hidden"><div className="h-full bg-indigo" style={{ width: `${Math.min(100, ((total - left) / Math.max(1, total)) * 100)}%` }} /></div>
              <div className="pt-3 mt-3 border-t border-line text-xs text-muted flex justify-between">
                <span>{left} days left</span>
                <span>{ring?.connection?.lastSyncAt ? `synced ${new Date(ring.connection.lastSyncAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span>
              </div>
            </>) : <Link className="link text-sm" to="/signup/share">Choose what to share →</Link>}
          </div>
        </div>
      </div>

      <div className="card p-6">
        <div className="flex items-center justify-between pb-4 border-b border-line mb-1">
          <span className="eyebrow">Recently counted</span>
          <span className="text-xs text-muted">Agents receive noisy answers about 20+ people</span>
        </div>
        {items === null ? <div className="py-6"><Spinner /></div> : items.length === 0 ? (
          <p className="text-sm text-muted py-6">No answers yet. When an agent's question counts you, it shows up here with what you earned.</p>
        ) : items.slice(0, 4).map(i => (
          <div key={i.queryId} className="py-3 flex items-center justify-between gap-4 text-sm border-b border-line last:border-0">
            <div className="flex items-center gap-3 min-w-0">{routeChip(i)}<span className="truncate">{describeQuestion(i)}</span></div>
            <div className="flex items-center gap-6 shrink-0"><span className="font-mono text-[11px] text-muted">{i.peopleAbout}+ people</span><Money micro={i.earnedMicro} className="font-serif min-w-[56px] text-right" /></div>
          </div>
        ))}
        <div className="pt-3 flex justify-end"><Link to="/app/activity" className="text-xs text-indigo font-medium">See all activity →</Link></div>
      </div>
    </AppShell>
  );
}

/** The person's own last 30 nights, with last night in gold. Their own numbers, shown only to them. */
function SleepBars({ nights }: { nights: { day: string; sleepMinutes?: number }[] }) {
  const pts = nights.filter(n => typeof n.sleepMinutes === "number").slice(-30);
  if (pts.length < 3) return null;
  const max = Math.max(...pts.map(p => p.sleepMinutes!)), avg = pts.reduce((a, p) => a + p.sleepMinutes!, 0) / pts.length;
  const last = pts[pts.length - 1];
  const hm = (m: number) => `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
  return (
    <div className="bg-paper border border-line rounded-xl p-5">
      <div className="flex items-center justify-between text-xs mb-3">
        <span className="font-medium">Your last {pts.length} nights</span>
        <span className="text-muted">Last night <strong className="text-ink">{hm(last.sleepMinutes!)}</strong> · your average {hm(avg)}</span>
      </div>
      <div className="h-20 flex items-end gap-1">
        {pts.map((p, i) => <div key={p.day} title={`${p.day}: ${hm(p.sleepMinutes!)}`} className={`flex-1 rounded-t-sm ${i === pts.length - 1 ? "bg-gold" : "bg-indigo-muted/70"}`} style={{ height: `${(p.sleepMinutes! / max) * 100}%` }} />)}
      </div>
    </div>
  );
}

// ---------------- Activity ----------------

export function Activity() {
  const { me } = useMe();
  const items = useActivity();
  const [filter, setFilter] = useState<"all" | "pattern" | "stat">("all");
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const out = new Map<string, ActivityItem[]>();
    for (const i of (items ?? []).filter(i => filter === "all" || i.route === filter)) {
      const d = new Date(i.at);
      const label = d.toDateString() === new Date().toDateString() ? "Today" : d.toDateString() === new Date(Date.now() - DAY_MS).toDateString() ? "Yesterday" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      out.set(label, [...(out.get(label) ?? []), i]);
    }
    return [...out];
  }, [items, filter]);
  const used = me?.privacyBudget.used ?? 0, cap = me?.privacyBudget.cap ?? 10;

  return (
    <AppShell me={me}>
      <div><h1 className="font-serif text-[32px] tracking-tight">Activity</h1><p className="text-sm text-muted mt-1">Where your data helped, and what you earned.</p></div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 items-start">
        <div className="xl:col-span-2 space-y-6">
          <div className="flex gap-2">
            {([["all", "All"], ["pattern", "Sealed AI"], ["stat", "Plain math"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} className={`px-3.5 py-1.5 text-xs rounded-full border ${filter === k ? "bg-indigo text-white border-indigo font-medium" : "bg-white text-muted border-line hover:text-ink"}`}>{l}</button>
            ))}
          </div>
          {items === null ? <Spinner /> : groups.length === 0 ? (
            <div className="card p-10 text-center text-muted text-sm">Nothing yet. When an agent pays for an answer that counts you, it appears here, with the noisy result it received and what you earned.</div>
          ) : groups.map(([label, rows]) => (
            <section key={label} className="space-y-3">
              <div className="flex justify-between px-1"><span className="eyebrow font-mono">{label}</span><span className="text-xs text-muted">{rows.length} answers</span></div>
              <div className="card divide-y divide-line overflow-hidden">
                {rows.map(i => (
                  <article key={i.queryId}>
                    <button className="w-full text-left p-5 flex items-start justify-between gap-4 hover:bg-paper/50" onClick={() => setOpen(open === i.queryId ? null : i.queryId)}>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2"><span className="text-sm">{describeQuestion(i)}</span>{routeChip(i)}</div>
                        <div className="mt-1.5 flex gap-3 text-xs text-muted font-mono"><span>{i.peopleAbout}+ people</span><span>·</span><span>ε {i.epsilon}</span><span>·</span><span>{i.yourDays} of your days</span><span>·</span><span>{new Date(i.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>
                      </div>
                      <div className="text-right shrink-0"><Money micro={i.earnedMicro} className="text-sm font-medium font-mono" /><div className="text-[11px] text-muted">USDC</div></div>
                    </button>
                    {open === i.queryId && (
                      <div className="px-5 pb-5 pt-3 space-y-3 border-t border-line bg-paper/40 text-xs">
                        <div className="flex items-center gap-2"><span className="text-muted">What the agent received:</span><span className="font-mono bg-white px-2 py-0.5 rounded border border-line">{describeAnswer(i.answer)} · about {i.peopleAbout}+ people · noise added</span></div>
                        <a className="link font-medium" href={`/proof/queries/${i.queryId}`} target="_blank" rel="noopener">Open the public proof for this answer ↗</a>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
        <aside className="card p-6 space-y-5">
          <div><span className="eyebrow">Privacy budget</span><h2 className="font-medium mt-1">How much agents have asked about you</h2></div>
          <div className="flex items-baseline justify-between"><div className="font-mono text-2xl">{used.toFixed(1)} <span className="text-sm text-muted">/ {cap} ε</span></div><div className="text-xs text-muted font-mono">{Math.round((used / cap) * 100)}% used</div></div>
          <div className="w-full h-2 bg-paper-muted border border-line rounded-full overflow-hidden"><div className="h-full bg-indigo" style={{ width: `${Math.min(100, (used / cap) * 100)}%` }} /></div>
          <p className="text-xs text-muted leading-relaxed">Each answer uses a little: 0.5 for plain math, 1 for a pattern read. When it's full, you're left out of new answers, so repeated questions can't narrow in on you.</p>
          <div className="text-[11px] text-muted font-mono bg-paper px-3 py-2 rounded-lg border border-line">Group of at least 20 · Laplace noise · counts rounded to 10</div>
        </aside>
      </div>
    </AppShell>
  );
}

// ---------------- Earnings ----------------

type ClaimState = { phase: "idle" } | { phase: "claiming" } | { phase: "claimed"; micro: string; accountId: string; hashscan: string; accountUrl: string; keyFile: string } | { phase: "failed"; reason: string };

/** A fresh secp256k1 key made in this browser. Only the public half is sent; the private half is offered as a file. */
function newClaimKey() {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, true);
  const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  return { publicKeyDer: "302d300706052b8104000a032200" + hex(pub), privateKeyHex: hex(priv), privateKeyDer: "3030020100300706052b8104000a04220420" + hex(priv) };
}

export function EarningsPage() {
  const { me } = useMe();
  const [params] = useSearchParams();
  const [earn, setEarn] = useState<Earnings | null>(null);
  const [state, setState] = useState<ClaimState>({ phase: "idle" });
  const [saved, setSaved] = useState(false);
  const items = useActivity();
  const load = () => api.get<Earnings>("/api/me/earnings").then(setEarn);
  useEffect(() => { load(); }, []);

  const claim = async (publicKeyDer?: string, keyPair?: ReturnType<typeof newClaimKey>) => {
    const k = keyPair ?? newClaimKey();
    const body = { publicKey: publicKeyDer ?? k.publicKeyDer };
    // The private key is parked only for the length of a re-check, then removed.
    sessionStorage.setItem("claimKey", JSON.stringify(k));
    setState({ phase: "claiming" });
    try {
      const r = await withFreshCheck("claim", "/app/earnings", body, b => api.post<{ micro: string; accountId: string; hashscan: string; accountUrl: string }>("/api/me/claim", b));
      if (!r) return;
      const keyFile = JSON.stringify({ network: "hedera-testnet", accountId: r.accountId, privateKeyHex: k.privateKeyHex, privateKeyDer: k.privateKeyDer, note: "This key controls this account. PulseKey has no copy." }, null, 2);
      sessionStorage.removeItem("claimKey");
      setState({ phase: "claimed", ...r, keyFile });
      load();
    } catch (e) {
      sessionStorage.removeItem("claimKey");
      setState({ phase: "failed", reason: e instanceof ApiError ? e.code : "network" });
      load();
    }
  };

  useEffect(() => {
    if (params.get("resume") !== "claim") return;
    const body = takePending("claim") as { publicKey: string } | null;
    const k = JSON.parse(sessionStorage.getItem("claimKey") ?? "null");
    if (params.get("check")) { sessionStorage.removeItem("claimKey"); setState({ phase: "failed", reason: "check_" + params.get("check") }); return; }
    if (body && k) claim(body.publicKey, k);
  }, []);

  const bal = BigInt(earn?.balanceMicro ?? "0"), min = BigInt(earn?.minClaimMicro ?? "10000");
  const weeks = useMemo(() => [3, 2, 1, 0].map(w => (items ?? []).filter(i => { const age = (Date.now() - Date.parse(i.at)) / (7 * DAY_MS); return age >= w && age < w + 1; }).reduce((a, i) => a + Number(i.earnedMicro), 0)), [items]);
  const wmax = Math.max(1, ...weeks);

  return (
    <AppShell me={me}>
      <h1 className="font-serif text-[32px] tracking-tight">Earnings</h1>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 space-y-6">
          <div className="card p-7">
            <div className="eyebrow">Ready to claim</div>
            <div className="flex items-baseline gap-3 mt-2"><Money micro={earn?.balanceMicro ?? "0"} className="font-serif text-5xl" /><span className="text-sm text-muted">USDC · testnet</span></div>
            <div className="h-20 flex items-end gap-3 mt-6">
              {weeks.map((w, i) => <div key={i} className="flex-1 flex flex-col items-center gap-1"><div className={`w-full rounded-t ${i === 3 ? "bg-gold" : "bg-gold/40"}`} style={{ height: `${(w / wmax) * 64 + 2}px` }} /><span className="text-[10px] text-muted font-mono">{i === 3 ? "this week" : `${3 - i}w ago`}</span></div>)}
            </div>
            <div className="text-sm text-muted mt-4">All time {usd(earn?.earnedMicro)} · Claimed {usd(earn?.claimedMicro)} · {items?.length ?? 0} answers</div>
          </div>

          {state.phase === "idle" && (
            <button className="btn-primary w-full" disabled={bal < min || me?.withdrawn === undefined} onClick={() => claim()}>
              {bal < min ? `Claims start at ${usd(min.toString())}` : `Claim ${usd(earn?.balanceMicro)}`}
            </button>
          )}
          {state.phase === "claiming" && (
            <div className="card p-6 flex items-start gap-4"><Spinner /><div><div className="font-medium">Sending {usd(earn?.balanceMicro)} USDC…</div>
              <ul className="text-sm text-muted mt-2 space-y-1"><li>✓ Key created in your browser</li><li>… Fresh account being created on Hedera</li><li>… Transfer settling</li></ul></div></div>
          )}
          {state.phase === "claimed" && (<>
            <div className="rounded-2xl border border-sage-border bg-sage-bg p-6">
              <div className="font-medium text-lg">{usd(state.micro)} sent</div>
              <div className="flex flex-wrap items-center gap-3 mt-2"><ProofChip label="to" value={state.accountId} href={state.accountUrl} /><a className="link text-sm" href={state.hashscan} target="_blank" rel="noopener">View on HashScan ↗</a></div>
            </div>
            <div className="rounded-2xl border border-brick p-6 bg-white">
              <div className="font-medium">Save your key now.</div>
              <p className="text-sm text-muted mt-1">This key controls your money. We don't have a copy. If you lose it, the funds are gone.</p>
              <div className="flex items-center gap-4 mt-4">
                <a className="btn-primary" download={`pulsekey-${state.accountId}.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(state.keyFile)}`}>Download my key</a>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />I've saved my key</label>
              </div>
              {saved && <button className="link text-sm mt-3" onClick={() => setState({ phase: "idle" })}>Done</button>}
            </div>
          </>)}
          {state.phase === "failed" && (
            <div className="rounded-2xl border border-brick-border bg-brick-bg p-6">
              <div className="font-medium">Claim didn't go through.</div>
              <p className="text-sm text-muted mt-1">{state.reason === "nothing_to_claim" ? "There's nothing to claim yet." : "Your balance is safe and you can't be paid twice. If a transfer was already on its way, it stays reserved until it's checked, rather than being sent again."} <span className="font-mono text-[11px]">({state.reason})</span></p>
              <button className="btn-primary mt-4" onClick={() => setState({ phase: "idle" })}>Try again</button>
            </div>
          )}
        </div>
        <div className="card p-6 bg-paper">
          <div className="font-medium mb-3">How claiming works</div>
          {["Your browser creates a key. It never leaves this page.", "We open a fresh Hedera account for that key, with no link to your PulseKey account.", "Your USDC is sent there. Save your key to use it later."].map((t, i) => (
            <div key={i} className="flex gap-3 py-2 text-sm"><span className="w-6 h-6 rounded-full border border-line flex items-center justify-center text-xs shrink-0">{i + 1}</span><span className="text-muted">{t}</span></div>
          ))}
          <p className="text-xs text-muted mt-3">The transfer is public on Hedera (account, amount, time). It carries no identity or health data.</p>
        </div>
      </div>
      <div className="card p-6">
        <div className="eyebrow mb-3">Past claims</div>
        {!earn?.claims.length ? <p className="text-sm text-muted">No claims yet.</p> : earn.claims.map((c, i) => (
          <div key={i} className="flex items-center justify-between py-3 border-b border-line last:border-0 text-sm">
            <span>{new Date(c.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · <Money micro={c.micro} /> · account <span className="font-mono">{c.accountId}</span> {c.status !== "paid" && <span className="chip bg-amber-bg border-amber-border text-amber ml-2">{c.status}</span>}</span>
            {c.hashscan && <a className="chip bg-paper-muted border-line text-muted font-mono" href={c.hashscan} target="_blank" rel="noopener">HashScan ↗</a>}
          </div>
        ))}
      </div>
    </AppShell>
  );
}

// ---------------- Grant ----------------

export function GrantPage() {
  const { me, reload } = useMe();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [ring, setRing] = useState<Ring | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "sage" | "brick" | "amber"; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [earn, setEarn] = useState<Earnings | null>(null);
  const loadRing = () => api.get<Ring>("/api/ring").then(setRing).catch(() => {});
  useEffect(() => { loadRing(); api.get<Earnings>("/api/me/earnings").then(setEarn).catch(() => {}); }, []);
  const g = me?.grant;

  const change = async (groups: Group[], validDays: number) => {
    const histDays = g ? Math.round((Date.now() - Date.parse(g.historyFrom)) / DAY_MS) : 30;
    setBusy("grant"); setMsg(null);
    try {
      const r = await withFreshCheck("grant-edit", "/app/grant", { groups, historyDays: Math.min(365, Math.max(0, histDays)), validDays }, b => api.put("/api/me/grant", b));
      if (r) { await reload(); await loadRing(); setMsg({ tone: "sage", text: "Grant updated." }); }
    } catch (e) { setMsg({ tone: "brick", text: e instanceof ApiError ? e.code : "failed" }); }
    setBusy(null);
  };

  useEffect(() => {
    if (params.get("check")) { takePending("grant-edit"); setMsg({ tone: "amber", text: "The check didn't finish, so nothing changed." }); return; }
    if (params.get("resume") === "grant-edit") {
      const p = takePending("grant-edit") as { groups: Group[]; validDays: number } | null;
      if (p) change(p.groups, p.validDays);
    }
  }, []);

  const left = g ? Math.max(0, Math.round((Date.parse(g.expiresAt) - Date.now()) / DAY_MS)) : 0;
  const total = g ? Math.round((Date.parse(g.expiresAt) - Date.parse(g.historyFrom)) / DAY_MS) : 0;
  const nights = Math.max(0, ...Object.values(ring?.stored ?? {}).map(s => s?.days ?? 0));

  const sync = async () => {
    setBusy("sync"); setMsg(null);
    try { await api.post("/api/ring/sync"); await loadRing(); setMsg({ tone: "sage", text: "Synced." }); }
    catch (e) { setMsg({ tone: "amber", text: e instanceof ApiError && e.code === "too_soon" ? "Synced less than a minute ago." : `Sync didn't work (${e instanceof ApiError ? e.code : "network"}).` }); }
    setBusy(null);
  };

  const withdraw = async () => {
    setBusy("withdraw");
    try { await api.post("/api/me/withdraw", { confirm: true }); await reload(); setConfirm(false); setMsg({ tone: "sage", text: "You've withdrawn. Your data key is destroyed and your records are deleted." }); }
    catch (e) { setMsg({ tone: "brick", text: e instanceof ApiError ? e.code : "failed" }); }
    setBusy(null);
  };

  return (
    <AppShell me={me}>
      <h1 className="font-serif text-[32px] tracking-tight">Your grant</h1>
      {msg && <Notice tone={msg.tone} title={msg.text} />}
      {me?.withdrawn ? (
        <Notice tone="amber" title="You've withdrawn from PulseKey.">Nothing new is collected or read. You can still claim any earnings left on the Earnings page.</Notice>
      ) : (<>
        <div className="card p-6">
          <div className="flex items-center gap-2 text-sm">{g ? <span className="chip bg-sage-bg border-sage-border text-sage">● Collecting</span> : <span className="chip bg-paper-muted border-line text-muted">Stopped</span>}</div>
          {g ? (<>
            <div className="font-serif text-2xl mt-3">{g.groups.map(x => GROUP_LABEL[x].name).join(" + ")}</div>
            <div className="w-full h-1.5 bg-line rounded-full overflow-hidden mt-4"><div className="h-full bg-indigo" style={{ width: `${Math.min(100, ((total - left) / Math.max(1, total)) * 100)}%` }} /></div>
            <p className="text-sm text-muted mt-3">History from {fmtDay(g.historyFrom)} · ends {fmtDay(g.expiresAt)} · {left} days left</p>
          </>) : <p className="text-sm text-muted mt-3">No new nights are being collected. <Link className="link" to="/signup/share">Start sharing again</Link></p>}
          <div className="flex flex-wrap items-center gap-3 mt-4 text-xs text-muted font-mono">
            <span>{ring?.connection ? `${ring.connection.source === "sample" ? "Sample data" : "Ultrahuman"} · ${ring.connection.status}` : "No source connected"}</span>
            <span>·</span><span>{nights} nights stored, encrypted under your key</span>
            {ring?.connection?.lastSyncAt && <><span>·</span><span>last sync {new Date(ring.connection.lastSyncAt).toLocaleString()}</span></>}
            {ring?.connection && g && <button className="link font-sans" disabled={busy === "sync"} onClick={sync}>{busy === "sync" ? "Syncing…" : "Sync now"}</button>}
            {ring?.connection?.status === "needs_reconnect" && <a className="link font-sans" href="/api/ring/connect?return=/app/grant">Reconnect Ultrahuman</a>}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <div className="card p-6">
            <div className="eyebrow mb-2">Shared data</div>
            {(Object.keys(GROUP_LABEL) as Group[]).map(x => {
              const on = !!g?.groups.includes(x);
              return (
                <div key={x} className="flex items-center justify-between py-3 border-b border-line last:border-0">
                  <div><div className="font-medium text-sm">{GROUP_LABEL[x].name}</div><div className="text-xs text-muted">{GROUP_LABEL[x].sub}</div></div>
                  <Toggle on={on} disabled={!g || busy === "grant" || (on && g.groups.length === 1)} onChange={v => g && change(v ? [...g.groups, x] : g.groups.filter(y => y !== x), Math.max(1, left))} />
                </div>
              );
            })}
            <p className="text-xs text-muted mt-3">Adding data or extending time needs a fresh World ID check. Removing never does.</p>
            {g && <button className="btn-secondary mt-4" disabled={busy === "grant"} onClick={() => change(g.groups, Math.min(365, left + 30))}>Extend 30 days</button>}
          </div>
          <div className="card p-6 space-y-5">
            <div className="eyebrow">Pause or stop</div>
            <div className="flex items-start justify-between gap-4">
              <div><div className="font-medium text-sm">Stop collecting</div><p className="text-xs text-muted mt-1">Keeps what's stored and your earnings. No new nights are added, and you're left out of new answers.</p></div>
              <button className="btn-secondary !py-2" disabled={!g} onClick={async () => { await api.del("/api/me/grant"); reload(); }}>Stop</button>
            </div>
            <div className="h-px bg-line" />
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-medium text-sm text-brick">Withdraw completely</div>
                <p className="text-xs text-muted mt-1">We destroy your data key, delete your records, saved answers and briefs, and disconnect Ultrahuman. Answers already sold and past payments can't be changed.</p>
                {earn && BigInt(earn.balanceMicro) > 0n && <p className="text-xs text-gold mt-2">You have {usd(earn.balanceMicro)} unclaimed. Claim it first.</p>}
              </div>
              <button className="btn-danger" onClick={() => setConfirm(true)}>Withdraw</button>
            </div>
          </div>
        </div>
      </>)}

      {confirm && (
        <div className="fixed inset-0 bg-ink/30 flex items-center justify-center z-50" onClick={() => setConfirm(false)}>
          <div className="card p-8 w-[520px]" onClick={e => e.stopPropagation()}>
            <h2 className="font-serif text-2xl">Withdraw from PulseKey?</h2>
            <ul className="text-sm mt-4 space-y-1"><li>✓ Your data key is destroyed</li><li>✓ Your {nights} stored nights are deleted</li><li>✓ Ultrahuman is disconnected</li><li>✓ You leave all future answers</li></ul>
            <ul className="text-sm text-muted mt-3 space-y-1"><li>· Answers already sold stay sold</li><li>· Past payments stay on Hedera</li><li>· Unclaimed earnings stay claimable</li></ul>
            <div className="flex items-center gap-3 mt-6">
              {earn && BigInt(earn.balanceMicro) > 0n && <button className="btn-primary" onClick={() => nav("/app/earnings")}>Claim {usd(earn.balanceMicro)} first</button>}
              <button className="inline-flex items-center gap-2 bg-brick text-white rounded-xl px-5 py-3 font-medium" disabled={busy === "withdraw"} onClick={withdraw}>{busy === "withdraw" ? "Withdrawing…" : "Withdraw anyway"}</button>
              <button className="text-sm text-muted" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
