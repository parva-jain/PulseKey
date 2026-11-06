// Sign-up, screens 2 to 5 of the Stitch prompts: verify, connect a source, choose what to share, and the
// "grant wasn't created" screen when a check is cancelled or expires.
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, GROUP_LABEL, startCheck, takePending, withFreshCheck, type Group, type Me, type Ring } from "../api";
import { Notice, SignupShell, Spinner, Toggle } from "../components/ui";

const Row = ({ icon, children }: { icon: string; children: React.ReactNode }) => (
  <div className="flex items-start gap-3 py-3 border-b border-line last:border-0 text-sm"><span className="w-5 text-center text-muted">{icon}</span><div>{children}</div></div>
);

export function Verify() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => { api.get<Me>("/api/me").then(setMe).catch(() => setMe(null)); }, []);
  const check = params.get("check");
  const signedIn = !!me && !check;

  return (
    <SignupShell step={1} done={signedIn ? 1 : 0}>
      <Link to="/" className="text-sm text-muted hover:text-ink">← Back</Link>
      <h1 className="font-serif text-[40px] leading-tight tracking-tight mt-6">First, prove you're a real person.</h1>
      <p className="text-muted mt-3">PulseKey pays humans, not bots. World ID confirms you're a unique person without telling us who you are.</p>
      <div className="card p-6 mt-8">
        <Row icon="✓">We get: a private ID that only works in PulseKey</Row>
        <Row icon="⊘">We never get: your name, email, face or World account</Row>
        <Row icon="◎">One person, one account, so payouts can't be farmed</Row>
      </div>
      <div className="mt-8">
        {me === undefined ? <Spinner /> : check ? (
          <div className="rounded-2xl border border-brick-border bg-brick-bg p-6">
            <div className="font-medium">Verification didn't finish.</div>
            <p className="text-sm text-muted mt-1">{check === "expired" ? "The check expired." : "You cancelled, or the check didn't pass."} No account was created and nothing was stored.</p>
            <div className="flex items-center gap-4 mt-4">
              <button className="btn-primary" onClick={() => startCheck("/signup/verify")}>Try again</button>
            </div>
          </div>
        ) : signedIn ? (
          <div className="card p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-sage-bg border border-sage-border text-sage mx-auto flex items-center justify-center text-xl">✓</div>
            <div className="font-medium mt-3">{me!.identity.verifiedHuman ? "You're verified." : "You're signed in."}</div>
            <p className="text-sm text-muted mt-1">{me!.identity.verifiedHuman ? "Unique human confirmed" : "Dev sign-in: World ID is not live yet, so this proves nothing about being a unique person."}</p>
            <button className="btn-primary w-full mt-5" onClick={() => nav(me!.grant ? "/app/today" : "/signup/connect")}>Continue</button>
          </div>
        ) : (
          <>
            <button className="btn-primary w-full" onClick={() => startCheck("/signup/verify")}>
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /></svg>
              Verify with World ID
            </button>
            <p className="text-xs text-muted text-center mt-3">You'll come back here when you're done.</p>
          </>
        )}
      </div>
    </SignupShell>
  );
}

export function Connect() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [ring, setRing] = useState<Ring | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.get<Ring>("/api/ring").then(setRing).catch(e => { if (e instanceof ApiError && e.status === 401) nav("/signup/verify"); });
  useEffect(() => { load(); }, []);
  const ringParam = params.get("ring");
  const conn = ring?.connection;

  const useSample = async () => {
    setBusy(true); setErr(null);
    try { await api.post("/api/ring/sample"); await load(); } catch (e) { setErr(e instanceof ApiError ? e.code : "failed"); } finally { setBusy(false); }
  };

  return (
    <SignupShell step={2} done={conn ? 2 : 1}>
      <Link to="/signup/verify" className="text-sm text-muted hover:text-ink">← Back</Link>
      <h1 className="font-serif text-[40px] leading-tight tracking-tight mt-6">Connect your ring.</h1>
      <p className="text-muted mt-3">We read only what you choose to share next. You approve this on Ultrahuman's own page.</p>
      <div className="grid grid-cols-2 gap-4 mt-8">
        <div className="card p-5">
          <div className="eyebrow mb-2">What we can read</div>
          {["Sleep: duration, stages, efficiency", "HRV: nightly average", "Resting heart rate", "Recovery score"].map(t => <div key={t} className="text-sm py-1.5 flex gap-2"><span className="text-sage">✓</span>{t}</div>)}
        </div>
        <div className="card p-5">
          <div className="eyebrow mb-2">What we never collect</div>
          {["Heart rhythm (A-fib) events, even though Ultrahuman groups them under cardio", "Your Ultrahuman email or profile", "Location"].map(t => <div key={t} className="text-sm py-1.5 flex gap-2 text-muted"><span>⊘</span>{t}</div>)}
        </div>
      </div>
      <div className="mt-8 space-y-4">
        {ringParam === "denied" && <Notice tone="amber" title="Ultrahuman access wasn't approved.">Nothing was connected. You can try again or use sample data.</Notice>}
        {ringParam === "error" && <Notice tone="brick" title="Connecting didn't work.">Nothing was stored. Try again.</Notice>}
        {err && <Notice tone="brick" title="That didn't work.">{err}</Notice>}
        {conn ? (
          <div className="rounded-2xl border border-sage-border bg-sage-bg p-6">
            <div className="font-medium">{conn.source === "sample" ? "Labelled sample data selected" : "Ring connected"}</div>
            <p className="text-sm text-muted mt-1">{conn.source === "sample" ? "Real-looking nights, clearly marked as synthetic in every answer." : "Your nights are imported, each encrypted under your own key, as soon as you choose what to share."}</p>
            <button className="btn-primary w-full mt-5" onClick={() => nav("/signup/share")}>Choose what to share</button>
          </div>
        ) : (
          <>
            <a className="btn-primary w-full" href="/api/ring/connect?return=/signup/connect">◯ Connect Ultrahuman</a>
            <div className="flex items-center gap-3 text-xs text-muted"><span className="flex-1 h-px bg-line" />or<span className="flex-1 h-px bg-line" /></div>
            <button className="btn-secondary w-full" disabled={busy} onClick={useSample}>{busy ? <Spinner /> : "Use labelled sample data"}</button>
            <p className="text-xs text-muted text-center">Real-looking nights, clearly marked as synthetic. Good for trying PulseKey without a ring.</p>
          </>
        )}
      </div>
    </SignupShell>
  );
}

type GrantDraft = { groups: Group[]; historyDays: number; validDays: number };
const DRAFT_KEY = "grant";

export function Share() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [groups, setGroups] = useState<Group[]>(["sleep", "hrv"]);
  const [days, setDays] = useState(90);
  const [adult, setAdult] = useState(false);
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (draft: GrantDraft) => {
    setBusy(true); setErr(null);
    sessionStorage.setItem("lastGrantDraft", JSON.stringify(draft));
    try {
      const r = await withFreshCheck(DRAFT_KEY, "/signup/share", draft, b => api.put("/api/me/grant", b));
      if (r) nav("/app/today");
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "failed");
      setBusy(false);
    }
  };

  useEffect(() => {
    const check = params.get("check");
    if (check) { takePending(DRAFT_KEY); nav(`/signup/failed?check=${check}`); return; }
    if (params.get("resume") === DRAFT_KEY) {
      const pending = takePending(DRAFT_KEY) as GrantDraft | null;
      if (pending) submit(pending);
    }
  }, []);

  const until = new Date(Date.now() + days * 86_400_000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const ready = groups.length > 0 && adult && notice && !busy;

  return (
    <SignupShell step={3} done={2} wide>
      <Link to="/signup/connect" className="text-sm text-muted hover:text-ink">← Back</Link>
      <h1 className="font-serif text-[40px] leading-tight tracking-tight mt-6">Choose what to share.</h1>
      <p className="text-muted mt-3">New nights are added automatically until your grant ends. You can stop anytime.</p>
      <div className="grid grid-cols-5 gap-6 mt-8 items-start">
        <div className="col-span-3 space-y-6">
          <div className="card p-6">
            <div className="eyebrow mb-3">Data</div>
            {(Object.keys(GROUP_LABEL) as Group[]).map(g => (
              <div key={g} className="flex items-center justify-between py-3 border-b border-line last:border-0">
                <div><div className="font-medium">{GROUP_LABEL[g].name}</div><div className="text-xs text-muted">{GROUP_LABEL[g].sub}</div></div>
                <Toggle on={groups.includes(g)} onChange={v => setGroups(v ? [...groups, g] : groups.filter(x => x !== g))} />
              </div>
            ))}
            <div className="flex items-center justify-between py-3 text-muted text-sm"><span>Sensitive data (glucose, cycle, labs, heart rhythm)</span><span>not collected</span></div>
          </div>
          <div className="card p-6">
            <div className="eyebrow mb-3">For how long</div>
            <div className="inline-flex rounded-xl border border-line p-1 bg-paper">
              {[30, 60, 90].map(d => <button key={d} onClick={() => setDays(d)} className={`px-5 py-2 rounded-lg text-sm ${days === d ? "bg-white border border-line shadow-card font-medium" : "text-muted"}`}>{d} days</button>)}
            </div>
            <p className="text-sm text-muted mt-3">Until {until} · includes your last 30 nights, then one new night at a time.</p>
          </div>
        </div>
        <div className="col-span-2 space-y-6 sticky top-6">
          <div className="card p-6 grid grid-cols-2 gap-4 text-sm">
            <div><div className="eyebrow mb-2">They get</div>Rounded answers about 20+ people, with noise added</div>
            <div><div className="eyebrow mb-2">They never get</div>Your nights, your numbers, who you are</div>
          </div>
          <div className="card p-6">
            <div className="eyebrow mb-2">How you earn</div>
            <div className="font-serif text-2xl text-gold">Paid per answer you're counted in</div>
            <p className="text-sm text-muted mt-1">90% of each price goes to the people counted, split by days of data. Depends on how many questions agents ask.</p>
          </div>
          <div className="space-y-2 text-sm">
            <label className="flex gap-2 items-center"><input type="checkbox" checked={adult} onChange={e => setAdult(e.target.checked)} />I'm 18 or older</label>
            <label className="flex gap-2 items-center"><input type="checkbox" checked={notice} onChange={e => setNotice(e.target.checked)} />I've read the plain-language privacy notice</label>
            <details className="text-xs text-muted pl-6">
              <summary className="link cursor-pointer">Read it</summary>
              <ul className="mt-2 space-y-1 list-disc pl-4">
                <li>Agents only ever receive noisy answers about 20 or more people, never your nights or numbers.</li>
                <li>Your nights are encrypted under your own key. We run the server, so we are trusted with collection and counting.</li>
                <li>Pattern questions and your daily brief are read by a sealed model on 0G Private Computer.</li>
                <li>A privacy budget limits how often you can be counted, so repeat questions can't single you out.</li>
                <li>You can stop sharing or withdraw anytime. Withdrawing destroys your key and deletes your records; answers already sold stay sold.</li>
              </ul>
            </details>
          </div>
          {err && <Notice tone="brick" title="Couldn't save your grant.">{err}</Notice>}
          <button className="btn-primary w-full" disabled={!ready} onClick={() => submit({ groups, historyDays: 30, validDays: days })}>{busy ? <Spinner className="w-4 h-4 text-white" /> : "Confirm with World ID"}</button>
          <p className="text-xs text-muted text-center">A fresh check protects every new or wider grant.</p>
        </div>
      </div>
    </SignupShell>
  );
}

export function GrantFailed() {
  const [params] = useSearchParams();
  const expired = params.get("check") === "expired";
  const draft = JSON.parse(sessionStorage.getItem("lastGrantDraft") ?? "null") as GrantDraft | null;
  const what = draft ? `${draft.groups.map(g => GROUP_LABEL[g].name).join(" + ")} · ${draft.validDays} days` : "Your grant";
  return (
    <SignupShell step={3} done={2}>
      <div className="text-center">
        <div className="w-14 h-14 rounded-full bg-brick-bg border border-brick-border text-brick mx-auto flex items-center justify-center text-2xl">×</div>
        <h1 className="font-serif text-[40px] leading-tight tracking-tight mt-6">{expired ? "Your check expired." : "Your grant wasn't created."}</h1>
        <p className="text-muted mt-3">{expired ? "Checks are valid for 10 minutes. This one ran out before you finished, so nothing was collected." : "The check was cancelled before it finished. To protect you, PulseKey only starts collecting after a fresh human check."}</p>
      </div>
      <div className="card p-6 mt-8">
        <div className="eyebrow mb-2">What happened</div>
        <div className="flex justify-between py-2 text-sm"><span>Grant: {what} · not created</span><span className="chip bg-brick-bg border-brick-border text-brick">Blocked</span></div>
        <div className="flex justify-between py-2 text-sm"><span>Data collected for it: none</span><span className="chip bg-sage-bg border-sage-border text-sage">0 nights</span></div>
        <div className="flex justify-between py-2 text-sm"><span>Check attempt: {expired ? "expired" : "cancelled"}</span><span className="text-xs text-muted">single use</span></div>
      </div>
      <p className="text-sm text-muted mt-4">If a late approval arrives for this attempt, it will be rejected. Every approval works once.</p>
      <div className="flex items-center gap-4 mt-6">
        <Link className="btn-primary" to="/signup/share">Try again with World ID</Link>
        <Link className="link text-sm" to="/signup/share">Change what I share</Link>
      </div>
    </SignupShell>
  );
}
