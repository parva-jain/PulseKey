"""Ports the Stitch landing page (landing-v6.html) to web/src/pages/landing.generated.tsx.

Applies the PulseKey rename and honesty edits to the copy, turns call-to-action buttons into real links, leaves
slots for the live strip and FAQ (rendered by Landing.tsx from live data), then converts HTML to JSX.
Every edit must match, so a new Stitch export that changes the copy fails loudly instead of silently.
Run: python3 web/stitch/convert.py
"""
import re
from pathlib import Path

HERE = Path(__file__).parent
src = (HERE / "landing-v6.html").read_text()
body = src[src.index("<body"):]
body = body[body.index(">") + 1: body.rindex("</body>")]

def must(old, new, count=None):
    global body
    n = body.count(old)
    assert n >= 1, f"not found: {old[:70]!r}"
    if count is not None:
        assert n == count, f"{old[:50]!r} found {n} times, expected {count}"
    body = body.replace(old, new)

# ---- Copy that would overclaim. Our brief reads only the person's own nights; it never compares with the pool.
must("Your ring shows your numbers. Pool shows what they mean, next to hundreds of others.",
     "Your ring shows your numbers. Each morning a sealed model reads only your own nights and tells you what stands out.")
must("You slept 7h 12m with 1h 32m of deep sleep. Across the pool, people whose HRV dipped two nights in a row slept 41 minutes less the next night. Yours dipped Monday and Tuesday, so tonight an earlier wind-down is worth trying.",
     "You slept 7h 12m with 1h 32m of deep sleep, about 14 minutes more deep sleep than your usual. Your HRV of 52 ms is back near your normal after two lower nights, so last night looks like a good recovery night.")
must("You vs the pool", "You vs your usual")
must("Deep sleep distribution", "Deep sleep, your last 30 nights")
must("Pool median · 1h 18m", "Your median · 1h 18m")
must("you're in the top 35%", "above your usual")
must("Pool figures come from group answers: 20+ people, noise added. Not medical advice.", "Computed from your own nights only. Example data. Not medical advice.")
must("Patterns from the pool that apply to you", "Questions you helped answer")
for old, new in [
    ("Two low-HRV nights → 41 min less sleep the next night", "Does HRV drop the night after short sleep?"),
    ("212 people · group answer", "170+ people · noisy group answer"),
    ("Correlation observed", "Sealed AI"),
    ("Applies to you: Mon–Tue", "You earned +$0.0005"),
    ("Workouts after 8 pm → 22 min less deep sleep", "Typical nightly sleep, last 30 days"),
    ("180 people · group answer", "200+ people · noisy group answer"),
    ("Circadian shift", "Plain math"),
    ("You: 3 of last 7 nights", "You earned +$0.0010"),
    ("Consistent bedtime → HRV recovers a day sooner", "Share of people with HRV under 40 ms"),
    ("240 people · group answer", "170+ people · noisy group answer"),
    ("Recovery speed", "Plain math"),
    ("You're on track", "You earned +$0.0010"),
    ("See all patterns", "See your activity"),
]:
    must(old, new)
# Our server handles plaintext at collection and for plain-math answers; only pattern reads and the brief are sealed.
must("AI reads your nights only in here. Zero raw persistence.", "Pattern questions and your brief are read by AI only in here.")
must("Privacy budget: ε 1 of 6 used", "A privacy budget caps how often you're counted")
must("Mathematically enforced k-anonymity", "Checked in code before any payment")
# Pay is split by days of data, and claims go to a fresh account.
must("Same pay for everyone counted. Claim to your own account anytime.", "Split by days of data among everyone counted. Claim to a fresh account anytime.")
must("Active Inquiries", "Example inquiries")
must("Verified humans only, via World ID. No wallet needed.", "One human, one account, via World ID. No wallet needed.")

# ---- Brand: the export predates the rename.
body = re.sub(r"\bPool\b", "PulseKey", body)

# ---- Slots for live parts. The live strip is a whole section; the FAQ keeps its header and swaps the list.
live = re.search(r'<!--\s*=+\s*5\. LIVE STRIP.*?</section>', body, re.S)
assert live, "live strip"
body = body[:live.start()] + "<live-slot></live-slot>" + body[live.end():]
faq = re.search(r'<div class="lg:col-span-7 divide-y divide-borderWarm border-t border-b border-borderWarm">.*?Is the brief medical advice\?.*?</div></div>', body, re.S)
assert faq, "faq list"
body = body[:faq.start()] + "<faq-slot></faq-slot>" + body[faq.end():]

# ---- Calls to action become links. A button keeps its classes; a dead "#" link gets a real target.
LINKS = {
    "Connect my ring": "/signup/verify", "Try with sample data": "/signup/verify", "Get started": "/signup/verify",
    "Sign in": "/signup/verify", "Start earning": "/signup/verify",
    "Claim to Hedera": "/app/earnings", "View full audit log": "/audit", "See your activity": "/app/activity",
    "How it works": "#how-it-works", "Privacy": "#privacy", "Morning brief": "#brief", "Live activity": "/audit",
    "Agent API": "/catalog", "Audit log": "/audit", "GitHub": "https://github.com/parva-jain/PulseKey",
    "Pricing": "/catalog", "Docs": "/catalog", "Contact": "https://github.com/parva-jain/PulseKey",
    "ETHGlobal": "https://ethglobal.com", "Sealed run": "/audit", "USDC transfer": "/audit",
}
def linkify(m):
    tag, attrs, inner = m.group(1), m.group(2), m.group(3)
    text = re.sub(r"<[^>]+>", "", inner).strip()
    for label, href in LINKS.items():
        if text.startswith(label):
            attrs = re.sub(r'\s*(href|target|rel)="[^"]*"', "", attrs)
            ext = ' target="_blank" rel="noopener"' if href.startswith("http") else ""
            return f'<a{attrs} href="{href}"{ext}>{inner}</a>'
    return m.group(0)
body = re.sub(r"<(button|a)(\b[^>]*)>(.*?)</\1>", linkify, body, flags=re.S)
body = body.replace('href="#"', 'href="/"')  # what is left is the logo

# ---- HTML to JSX.
body = re.sub(r"<!--(.*?)-->", lambda m: "{/*" + m.group(1).replace("*/", "* /") + "*/}", body, flags=re.S)
ATTRS = {"class": "className", "for": "htmlFor", "viewbox": "viewBox", "tabindex": "tabIndex", "colspan": "colSpan",
         "rowspan": "rowSpan", "crossorigin": "crossOrigin", "autocomplete": "autoComplete", "preserveaspectratio": "preserveAspectRatio"}
def camel(a):
    return re.sub(r"-([a-z])", lambda m: m.group(1).upper(), a)
def fix_tag(m):
    tag = m.group(0)
    def attr(am):
        name, val = am.group(1), am.group(2)
        if name in ATTRS:
            name = ATTRS[name]
        elif name.startswith(("aria-", "data-")):
            pass
        elif "-" in name or ":" in name:
            if name.startswith("xmlns:") or name.startswith("xlink:"):
                return ""
            name = camel(name)
        if name == "style":
            decls = [d.split(":", 1) for d in val.split(";") if ":" in d]
            obj = ", ".join(f'{camel(k.strip())}: "{v.strip()}"' for k, v in decls)
            return f" style={{{{{obj}}}}}"
        return f' {name}="{val}"'
    tag = re.sub(r'\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"', attr, tag)
    if re.match(r"<(br|hr|img|input|meta|link|source)\b", tag) and not tag.endswith("/>"):
        tag = tag[:-1] + "/>"
    return tag
body = re.sub(r"<[a-zA-Z][^<>]*>", fix_tag, body)
body = body.replace("<live-slot></live-slot>", "{live}").replace("<faq-slot></faq-slot>", "{faq}")
# Stray braces in text would be read as JSX expressions.
assert not re.search(r">[^<]*[{}][^<]*<", re.sub(r"\{/\*.*?\*/\}|\{live\}|\{faq\}|style=\{\{.*?\}\}", "", body, flags=re.S)), "brace in text"

out = f"""// GENERATED by web/stitch/convert.py from the Stitch landing page (landing-v6.html). Edit the converter, not this file.
import type {{ ReactNode }} from "react";

export function StitchLanding({{ live, faq }}: {{ live: ReactNode; faq: ReactNode }}) {{
  return (
    <>
{body}
    </>
  );
}}
"""
(HERE.parent / "src/pages/landing.generated.tsx").write_text(out)
print("wrote", len(out), "chars")
