"""PulseKey x 0G, the short version for a two-minute pitch. Run: python3 docs/diagrams/zg_simple.py <out-dir>"""
import sys
from excalidraw import Diagram

d = Diagram(1520, 780)
d.text(40, 30, "PulseKey × 0G", size=40, width=800)
d.text(40, 88, "Gold: for you   ·   Indigo: for paying AI agents", size=18, color="muted", width=800)

d.box(40, 300, 220, 130, "You\nring data", size=24)
d.box(420, 290, 260, 150, "PulseKey\nencrypted storage", size=24)
d.box(870, 265, 320, 200, "0G sealed AI\nreads data inside a locked box nobody can look into", size=24, stroke="indigo", fill="indigo_bg", sw=3)
d.box(1290, 300, 200, 130, "AI agent\nbuyer", size=24)

# For you
d.arrow([(260, 365), (420, 365)], label="your nights", label_dx=-55, label_dy=-30, size=18, label_w=130)
d.arrow([(680, 310), (870, 310)], color="gold", sw=3, label="your nights", label_dx=-55, label_dy=-30, size=18, label_w=130)
d.arrow([(1030, 265), (1030, 170), (150, 170), (150, 300)], color="gold", sw=3, label="your morning brief", label_at=0.5, label_dx=-80, label_dy=-32, size=20, label_w=220)

# For agents
d.arrow([(1350, 430), (1350, 560), (640, 560), (640, 440)], color="indigo", sw=3, label="question + USDC", label_at=0.5, label_dx=-70, label_dy=8, size=20, label_w=200)
d.arrow([(680, 370), (870, 370)], color="indigo", sw=3, label="one person at a time", label_dx=-75, label_dy=-26, size=16, label_w=170)
d.arrow([(870, 420), (680, 420)], color="indigo", sw=3, label="yes / no", label_dx=-35, label_dy=6, size=16, label_w=100)
d.arrow([(530, 440), (530, 640), (1430, 640), (1430, 430)], color="indigo", sw=3, label="group answer only, noise added", label_at=0.5, label_dx=-140, label_dy=8, size=20, label_w=320)

d.text(40, 715, "Without 0G, no AI could read people's nights without someone seeing them.", size=24, color="indigo", width=1440)

out = sys.argv[1]
d.save(f"{out}/pulsekey-0g-simple.excalidraw", f"{out}/pulsekey-0g-simple.svg")
print("saved")
