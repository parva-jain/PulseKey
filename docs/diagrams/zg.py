"""How PulseKey uses 0G Private Computer. Run: python3 docs/diagrams/zg.py <out-dir>"""
import sys
from excalidraw import Diagram

d = Diagram(1700, 1330)
d.text(40, 28, "How PulseKey uses 0G Private Computer", size=34, width=1200)
d.text(40, 80, "Two sealed reads: each contributor's daily brief, and each person's answer to a buyer's pattern question. Health numbers reach a model only inside 0G's enclaves.", size=17, color="muted", width=1600)

# Contributor
d.box(40, 170, 270, 100, "Contributor\nUltrahuman ring, or labelled sample data", size=17)
d.box(40, 560, 270, 130, "Today screen\nDaily brief + its 0G request ID\n\"Not medical advice\"", size=17, stroke="gold", fill="gold_bg")

# PulseKey server
d.box(390, 140, 380, 700, "", stroke="muted", fill="paper", style="dashed")
d.text(400, 148, "PulseKey server (we run it)", size=16, color="muted", width=360)
d.box(415, 190, 330, 90, "Encrypted pool\nAES-256, one key per person", size=16)
d.box(415, 330, 330, 100, "Brief prompt\nyour own last 30 nights: numbers only, nights not dates", size=16, stroke="gold", fill="gold_bg")
d.box(415, 470, 330, 110, "Pattern prompt, per person\nonly the 2 metrics asked about, as z-scores vs your own average", size=16, stroke="indigo", fill="indigo_bg")
d.box(415, 620, 330, 90, "Saved labels\nsealed under each person's key, reused next time", size=16)
d.box(415, 740, 330, 80, "Plain code: tally + noise\n20+ people · Laplace noise · budget", size=16)

# 0G
d.box(850, 140, 420, 560, "", stroke="indigo", fill="indigo_bg", sw=2)
d.text(865, 148, "0G Private Computer", size=20, color="indigo", width=390)
d.box(880, 200, 360, 95, "Router API (OpenAI-compatible)\nrouter-api.0g.ai · trust mode: private · encrypted transit: required", size=15)
d.box(880, 335, 360, 80, "Gateway enclave (TEE)\nchecks the provider's signature", size=15)
d.box(880, 455, 360, 90, "Provider enclave (TEE)\nmodel 0gm-1.0-35b-a3b", size=15)
d.box(880, 585, 360, 95, "Used only if the reply says\nx-0g-e2ee: sealed\nelse refused, never sent elsewhere", size=15, stroke="sage", fill="sage_bg")
d.arrow([(1060, 295), (1060, 335)], color="indigo", sw=1)
d.arrow([(1060, 415), (1060, 455)], color="indigo", sw=1)
d.text(850, 712, "Measured on planted synthetic people: 100% correct on clear patterns, 95.8% on subtle, no false yes.", size=14, color="muted", width=420)

# Buyer
d.box(1350, 170, 310, 100, "Buyer AI agent\npays per answer in USDC (x402 on Hedera)", size=16)
d.box(1350, 470, 310, 110, "What the agent gets\nnoisy shares only: yes ≈ 45% · no ≈ 50% · ±12, group 170+", size=16, stroke="sage", fill="sage_bg")
d.box(1350, 640, 310, 130, "Public proof page\n0G request IDs (no person) · gateway + provider attestation · pcverify command", size=16)

# Brief flow (gold)
d.arrow([(310, 220), (415, 235)], color="gold", label="1", label_dx=-8, label_dy=-26, label_w=30, size=18)
d.arrow([(500, 280), (500, 330)], color="gold")
d.arrow([(745, 360), (880, 240)], color="gold", label="2", label_dx=-18, label_dy=-30, label_w=30, size=18)
d.arrow([(880, 275), (745, 410)], color="gold", label="3", label_dx=6, label_dy=4, label_w=30, size=18)
d.arrow([(415, 400), (310, 600)], color="gold", label="4", label_dx=-26, label_dy=-14, label_w=30, size=18)

# Pattern flow (indigo)
d.arrow([(1350, 250), (1310, 250), (1310, 865), (790, 865), (790, 525), (745, 525)], color="indigo", label="a", label_at=0.5, label_dx=-10, label_dy=6, label_w=30, size=18)
d.arrow([(745, 495), (880, 270)], color="indigo", label="b", label_dx=-32, label_dy=-10, label_w=30, size=18)
d.arrow([(880, 520), (745, 650)], color="indigo", label="c", label_dx=-44, label_dy=-22, label_w=30, size=18)
d.arrow([(580, 710), (580, 740)], color="indigo")
d.arrow([(745, 790), (1335, 790), (1335, 525), (1350, 525)], color="indigo", label="d", label_at=0.3, label_dx=-10, label_dy=-26, label_w=30, size=18)
d.arrow([(1505, 580), (1505, 640)], color="indigo")
d.arrow([(1270, 640), (1350, 700)], color="indigo", style="dashed", sw=1)

# Bottom: the one sentence, and honest limits
d.box(40, 910, 800, 160, "What breaks without 0G\nEach person's nights would have to be read by a model that whoever runs it can see. The daily brief and the per-person pattern reads could not exist without exposing raw health data, so contributors would have no reason to say yes.", size=17, stroke="indigo", fill="white", sw=2)
d.box(880, 910, 780, 160, "Honest limits\nOur server handles plaintext when it collects nights and builds prompts. Plain-math answers (averages, shares) don't use 0G. The router doesn't expose a per-response TEE verdict: the gateway checks the enclave signature, and anyone can re-check attestation with pcverify.", size=16, stroke="muted", fill="white", color="muted")
d.box(40, 1100, 800, 190, "Daily brief (contributor side)\n1  Your nights sync into the pool, sealed under your own key.\n2  Each morning the server sends only your last 30 nights, sealed, to 0G.\n3  The model writes your brief inside the enclave; it returns with a request ID.\n4  Sealed under your key and shown on Today, once a day.", size=16, stroke="gold", fill="gold_bg")
d.box(880, 1100, 780, 190, "Pattern question (buyer side)\na  An agent pays per answer (x402, USDC on Hedera).\nb  For each person counted: one sealed read of just the 2 metrics.\nc  The enclave answers yes / no / unclear; saved under that person's key.\nd  Plain code counts and adds noise; the agent gets only noisy shares and a public proof.", size=16, stroke="indigo", fill="indigo_bg")
d.text(40, 1300, "Gold: daily brief (contributor side)   ·   Indigo: pattern question (buyer side)   ·   Dashed: attestation", size=15, color="muted", width=1200)

out = sys.argv[1]
d.save(f"{out}/pulsekey-0g.excalidraw", f"{out}/pulsekey-0g.svg")
print("saved")
