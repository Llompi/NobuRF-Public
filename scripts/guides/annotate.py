"""Crop app screenshots and draw numbered callouts with arrows for the site's guides.

Coordinates in a spec are CSS pixels of the page the shot was taken from; `scale` is that shot's
device pixel ratio. Each callout outlines its target and, when given a badge position, draws a
leader from the badge to the target's nearest edge with an arrowhead.

usage: python3 annotate.py <spec.json> <out dir>
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CYAN = (98, 205, 232, 255)
INK = (10, 14, 20, 255)
SS = 4  # supersampling for the overlay, so lines and circles come out smooth
FONT = '/usr/share/fonts/opentype/inter/Inter-Bold.otf'


def nearest_point(rect, px, py):
    x, y, w, h = rect
    return min(max(px, x), x + w), min(max(py, y), y + h)


def annotate(item, out_dir):
    src = Image.open(item['src']).convert('RGB')
    scale = item.get('scale', 1)
    cx0, cy0, cx1, cy1 = item['crop']
    img = src.crop((round(cx0 * scale), round(cy0 * scale), round(cx1 * scale), round(cy1 * scale)))
    # Everything below is drawn in output pixels: CSS px minus the crop origin, times scale.
    k = scale * SS
    overlay = Image.new('RGBA', (img.width * SS, img.height * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = ImageFont.truetype(FONT, round(13 * k))
    line_w = round(2 * k)
    radius = 11 * k

    def to_px(x, y):
        return (x - cx0) * k, (y - cy0) * k

    for c in item.get('callouts', []):
        x, y, w, h = c['rect']
        pad = c.get('pad', 4)
        rx0, ry0 = to_px(x - pad, y - pad)
        rx1, ry1 = to_px(x + w + pad, y + h + pad)
        if c.get('outline', True):
            draw.rounded_rectangle((rx0, ry0, rx1, ry1), radius=5 * k, outline=CYAN, width=line_w)
        if 'badge' in c:
            bx, by = c['badge']
        elif x - pad - 26 >= cx0:  # just left of the outline, at its middle
            bx, by = x - pad - 14, y + h / 2
        elif y - pad - 26 >= cy0:  # just above it, at its left
            bx, by = x + 12, y - pad - 14
        else:  # on its top-left corner
            bx, by = x - pad, y - pad
        pbx, pby = to_px(bx, by)
        if 'badge' in c:
            tx, ty = nearest_point((x - pad, y - pad, w + 2 * pad, h + 2 * pad), bx, by)
            ptx, pty = to_px(tx, ty)
            dist = math.hypot(ptx - pbx, pty - pby)
            if dist > radius * 1.5:
                ux, uy = (ptx - pbx) / dist, (pty - pby) / dist
                start = (pbx + ux * radius, pby + uy * radius)
                head = 9 * k
                tip = (ptx - ux * line_w, pty - uy * line_w)
                base = (tip[0] - ux * head, tip[1] - uy * head)
                draw.line((start, base), fill=CYAN, width=line_w)
                nx, ny = -uy, ux
                draw.polygon([tip, (base[0] + nx * head * 0.5, base[1] + ny * head * 0.5),
                              (base[0] - nx * head * 0.5, base[1] - ny * head * 0.5)], fill=CYAN)
        draw.ellipse((pbx - radius, pby - radius, pbx + radius, pby + radius), fill=CYAN, outline=INK, width=round(1.5 * k))
        draw.text((pbx, pby + 0.5 * k), str(c['n']), font=font, fill=INK, anchor='mm')

    overlay = overlay.resize(img.size, Image.LANCZOS)
    out = Image.alpha_composite(img.convert('RGBA'), overlay).convert('RGB')
    if 'max_width' in item and out.width > item['max_width']:
        h = round(out.height * item['max_width'] / out.width)
        out = out.resize((item['max_width'], h), Image.LANCZOS)
    path = Path(out_dir) / item['out']
    out.save(path, 'WEBP', quality=item.get('quality', 88), method=6)
    print(f'{path} {out.width}x{out.height} {path.stat().st_size // 1024} KB')


if __name__ == '__main__':
    spec = json.loads(Path(sys.argv[1]).read_text())
    Path(sys.argv[2]).mkdir(parents=True, exist_ok=True)
    for entry in spec:
        annotate(entry, sys.argv[2])
