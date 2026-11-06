// ui: the shared pieces from the Stitch screens: logo, demo banner, app shell, sign-up frame, chips and states.
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { api, ApiError, type Me } from "../api";

export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <a href="/" className="flex items-center gap-3">
      <span className={`${size === "lg" ? "w-9 h-9" : "w-8 h-8"} rounded-full border-[1.5px] border-indigo flex items-center justify-center bg-white`}>
        <svg className="w-4 h-4 text-indigo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h3l2.5-5 3.5 10 2.5-6 1.5 2H21" /></svg>
      </span>
      <span className="font-serif text-2xl tracking-tight">PulseKey</span>
    </a>
  );
}

/** Shortens long ids: "0.0.9185802@1793940089.099938246" → "0.0.9185802@1793…6". */
export const short = (s: string, head = 10, tail = 6) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);

export function ProofChip({ label, value, href }: { label?: string; value: string; href?: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 bg-paper-muted border border-line px-2.5 py-1 rounded text-[11px] text-muted font-mono">
      {label && <span className="font-sans">{label}</span>}
      <span title={value}>{short(value)}</span>
      <button className="hover:text-ink" title="Copy" onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
        {copied ? "✓" : "⧉"}
      </button>
      {href && <a className="text-indigo hover:text-indigo-hover" href={href} target="_blank" rel="noopener">↗</a>}
    </span>
  );
}

export function Money({ micro, className = "" }: { micro: string | number; className?: string }) {
  const n = Number(micro) / 1e6;
  return <span className={`text-gold ${className}`}>${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}</span>;
}

export const Spinner = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={`${className} animate-spin text-indigo`} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>
);

export function DemoBanner() {
  const [pool, setPool] = useState<{ people: number; synthetic: number } | null>(null);
  useEffect(() => { api.get<{ pool: { people: number; synthetic: number } }>("/proof/feed").then(f => setPool(f.pool)).catch(() => {}); }, []);
  return (
    <div className="w-full bg-paper-muted border-b border-line text-xs text-muted py-1.5 px-6 flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-gold" />
      <span className="font-medium text-ink">Demo</span><span>·</span>
      <span>{pool ? `${pool.synthetic} of ${pool.people} contributors are synthetic and labelled` : "Synthetic contributors are labelled"}</span>
    </div>
  );
}

const NAV = [
  { to: "/app/today", label: "Today", icon: <><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></> },
  { to: "/app/activity", label: "Activity", icon: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /> },
  { to: "/app/earnings", label: "Earnings", icon: <><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></> },
  { to: "/app/grant", label: "Grant", icon: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></> },
];

/** Loads the signed-in person, or sends them to sign-up. */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const nav = useNavigate();
  const reload = () => api.get<Me>("/api/me").then(setMe).catch(e => { if (e instanceof ApiError && e.status === 401) nav("/signup/verify"); });
  useEffect(() => { reload(); }, []);
  return { me, reload };
}

export function AppShell({ me, children }: { me: Me | null; children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <DemoBanner />
      <div className="flex flex-1 w-full max-w-[1440px] mx-auto">
        <aside className="w-[240px] shrink-0 border-r border-line flex flex-col justify-between p-6 min-h-[calc(100vh-30px)]">
          <div className="flex flex-col gap-8">
            <Logo />
            <nav className="flex flex-col gap-1">
              {NAV.map(n => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${isActive ? "bg-white border border-line text-ink font-medium shadow-card" : "text-muted hover:text-ink hover:bg-paper-muted"}`}>
                  {({ isActive }) => (<><svg className={`w-4 h-4 ${isActive ? "text-indigo" : "text-muted"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{n.icon}</svg><span>{n.label}</span></>)}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="pt-4 border-t border-line flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-paper-muted border border-line flex items-center justify-center text-xs font-medium">You</div>
            <div className="min-w-0">
              <div className="text-sm font-medium leading-tight">Your account</div>
              {me && (me.identity.verifiedHuman
                ? <div className="text-[11px] text-sage">✓ Verified human</div>
                : <div className="text-[11px] text-amber" title="World ID sign-in is not live yet, so this account proves nothing about being a unique person">Dev sign-in · not verified</div>)}
            </div>
          </div>
        </aside>
        <main className="flex-1 p-8 lg:p-10 flex flex-col gap-6 min-w-0">{children}</main>
      </div>
    </div>
  );
}

const STEPS = ["Verify", "Connect", "Share"];

export function SignupShell({ step, done = 0, children, wide = false }: { step: number; done?: number; children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      <DemoBanner />
      <header className="px-8 py-6 grid grid-cols-3 items-center">
        <Logo />
        <ol className="flex items-center justify-center gap-3 text-sm">
          {STEPS.map((s, i) => {
            const n = i + 1, isDone = n <= done, active = n === step;
            return (
              <li key={s} className="flex items-center gap-2">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs border ${isDone ? "bg-sage border-sage text-white" : active ? "border-indigo text-indigo" : "border-line text-muted"}`}>{isDone ? "✓" : n}</span>
                <span className={active ? "text-ink font-medium" : "text-muted"}>{s}</span>
                {n < STEPS.length && <span className="w-8 h-px bg-line ml-1" />}
              </li>
            );
          })}
        </ol>
        <span />
      </header>
      <DotCluster />
      <main className={`mx-auto w-full ${wide ? "max-w-[1040px]" : "max-w-[560px]"} px-6 pb-16 pt-6 relative z-10`}>{children}</main>
    </div>
  );
}

/** The pool motif: a loose grid of muted dots with one gold "you". */
export function DotCluster({ className = "absolute right-10 top-40 opacity-60 hidden xl:block" }: { className?: string }) {
  const dots = Array.from({ length: 36 }, (_, i) => ({ x: (i % 6) * 22 + ((i * 7) % 5), y: Math.floor(i / 6) * 22 + ((i * 11) % 6) }));
  return (
    <svg className={className} width="150" height="150" viewBox="0 0 150 150" aria-hidden>
      {dots.map((d, i) => <circle key={i} cx={d.x + 10} cy={d.y + 10} r={i === 21 ? 5 : 3.5} fill={i === 21 ? "#C8912E" : "#BAC8E2"} />)}
    </svg>
  );
}

export function Notice({ tone, title, children }: { tone: "sage" | "brick" | "amber" | "indigo"; title: string; children?: ReactNode }) {
  const cls = { sage: "bg-sage-bg border-sage-border", brick: "bg-brick-bg border-brick-border", amber: "bg-amber-bg border-amber-border", indigo: "bg-indigo-light border-indigo-muted" }[tone];
  return (
    <div className={`rounded-2xl border p-5 ${cls}`}>
      <div className="font-medium">{title}</div>
      {children && <div className="text-sm text-muted mt-1 space-y-2">{children}</div>}
    </div>
  );
}

export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
      className={`w-10 h-6 rounded-full relative transition-colors ${on ? "bg-indigo" : "bg-line"} ${disabled ? "opacity-50" : ""}`}>
      <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}
