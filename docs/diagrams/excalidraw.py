"""A tiny Excalidraw writer: boxes with wrapped labels, free text and arrows, saved as a .excalidraw file
(open it at excalidraw.com: menu > Open) plus an SVG preview drawn from the same coordinates."""
import json, random, textwrap
from html import escape

PALETTE = {
    "ink": "#1c1b22", "muted": "#6b6876", "indigo": "#2e3a6b", "indigo_bg": "#e8ecf8",
    "gold": "#c8912e", "gold_bg": "#fdf7eb", "sage": "#4f8a6e", "sage_bg": "#edf5f1",
    "brick": "#b4483c", "brick_bg": "#fbefed", "paper": "#faf8f4", "white": "#ffffff", "line": "#e8e4dc",
}

class Diagram:
    def __init__(self, width, height):
        self.w, self.h = width, height
        self.els, self.svg = [], []
        self.rng = random.Random(7)

    def _base(self, kind, x, y, w, h, **kw):
        e = {
            "id": f"{kind[:2]}{len(self.els)}", "type": kind, "x": x, "y": y, "width": w, "height": h, "angle": 0,
            "strokeColor": kw.get("stroke", PALETTE["ink"]), "backgroundColor": kw.get("fill", "transparent"),
            "fillStyle": "solid", "strokeWidth": kw.get("sw", 1), "strokeStyle": kw.get("style", "solid"),
            "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None, "roundness": kw.get("round"),
            "seed": self.rng.randint(1, 2**31), "version": 1, "versionNonce": self.rng.randint(1, 2**31),
            "isDeleted": False, "boundElements": [], "updated": 1, "link": None, "locked": False,
        }
        self.els.append(e)
        return e

    def _text_el(self, x, y, w, h, text, size, color, align, valign, family, container=None):
        e = self._base("text", x, y, w, h, stroke=color)
        e.update({"text": text, "originalText": text, "fontSize": size, "fontFamily": family, "textAlign": align,
                  "verticalAlign": valign, "containerId": container, "lineHeight": 1.25, "autoResize": True,
                  "roundness": None})
        return e

    @staticmethod
    def wrap(text, width, size):
        per_line = max(8, int(width / (size * 0.52)))
        return "\n".join("\n".join(textwrap.wrap(p, per_line)) if p else "" for p in text.split("\n"))

    def box(self, x, y, w, h, text="", size=16, stroke="ink", fill="white", style="solid", sw=1, color="ink", bold_title=None, family=2):
        r = self._base("rectangle", x, y, w, h, stroke=PALETTE[stroke], fill=PALETTE[fill], style=style, sw=sw, round={"type": 3})
        dash = ' stroke-dasharray="8 6"' if style == "dashed" else ""
        self.svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{PALETTE[fill]}" stroke="{PALETTE[stroke]}" stroke-width="{sw}"{dash}/>')
        if text:
            body = self.wrap(text, w - 24, size)
            lines = body.split("\n")
            th = len(lines) * size * 1.25
            t = self._text_el(x + 12, y + (h - th) / 2, w - 24, th, body, size, PALETTE[color], "center", "middle", family, r["id"])
            r["boundElements"].append({"type": "text", "id": t["id"]})
            self._svg_lines(x + w / 2, y + (h - th) / 2, lines, size, PALETTE[color], "middle")
        return r

    def text(self, x, y, text, size=16, color="ink", width=400, align="left", family=2):
        body = self.wrap(text, width, size)
        lines = body.split("\n")
        self._text_el(x, y, width, len(lines) * size * 1.25, body, size, PALETTE[color], align, "top", family)
        ax = {"left": x, "center": x + width / 2, "right": x + width}[align]
        self._svg_lines(ax, y, lines, size, PALETTE[color], {"left": "start", "center": "middle", "right": "end"}[align])

    def _svg_lines(self, x, y, lines, size, color, anchor):
        for i, line in enumerate(lines):
            self.svg.append(f'<text x="{x}" y="{y + (i + 0.85) * size * 1.25:.1f}" font-family="Helvetica, Arial" font-size="{size}" fill="{color}" text-anchor="{anchor}">{escape(line)}</text>')

    def arrow(self, pts, color="ink", sw=2, style="solid", label=None, label_at=0.5, label_dx=8, label_dy=-22, size=14, label_w=220):
        x0, y0 = pts[0]
        rel = [[px - x0, py - y0] for px, py in pts]
        xs, ys = [p[0] for p in rel], [p[1] for p in rel]
        e = self._base("arrow", x0, y0, max(xs) - min(xs), max(ys) - min(ys), stroke=PALETTE[color], sw=sw, style=style, round={"type": 2})
        e.update({"points": rel, "lastCommittedPoint": None, "startBinding": None, "endBinding": None,
                  "startArrowhead": None, "endArrowhead": "arrow", "elbowed": False})
        dash = ' stroke-dasharray="8 6"' if style == "dashed" else ""
        d = " ".join(f"{'M' if i == 0 else 'L'}{px} {py}" for i, (px, py) in enumerate(pts))
        self.svg.append(f'<path d="{d}" fill="none" stroke="{PALETTE[color]}" stroke-width="{sw}"{dash} marker-end="url(#h-{color})"/>')
        if label:
            # label next to the segment holding the label_at point
            i = min(int(label_at * (len(pts) - 1)), len(pts) - 2)
            (ax, ay), (bx, by) = pts[i], pts[i + 1]
            self.text((ax + bx) / 2 + label_dx, (ay + by) / 2 + label_dy, label, size=size, color=color, width=label_w)

    def save(self, path_excalidraw, path_svg):
        doc = {"type": "excalidraw", "version": 2, "source": "https://excalidraw.com", "elements": self.els,
               "appState": {"viewBackgroundColor": PALETTE["paper"], "gridSize": None}, "files": {}}
        with open(path_excalidraw, "w") as f:
            json.dump(doc, f, indent=1)
        markers = "".join(f'<marker id="h-{c}" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="{PALETTE[c]}"/></marker>' for c in PALETTE)
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}"><defs>{markers}</defs><rect width="100%" height="100%" fill="{PALETTE["paper"]}"/>' + "".join(self.svg) + "</svg>"
        with open(path_svg, "w") as f:
            f.write(svg)
