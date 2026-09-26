"""Vector-ish logo / marking masks drawn with Pillow (procedural stand-ins for real livery)."""
import math
import numpy as np
from PIL import Image, ImageDraw
from texlib import font


def _poly_mask(w, h, polys, ss=4):
    im = Image.new('L', (w * ss, h * ss), 0)
    d = ImageDraw.Draw(im)
    for p in polys:
        d.polygon([(x * ss, y * ss) for x, y in p], fill=255)
    return np.asarray(im.resize((w, h), Image.LANCZOS), np.float32) / 255.0


def spacex_wordmark(cap=200, track=0.22):
    """Horizontal 'SPACEX' wordmark mask (float, 1 = ink). Geometric sans letters, an 'A' without
    crossbar and an X whose rising stroke becomes a long tapered trajectory swoosh."""
    ss = 3
    capS = cap * ss
    f = font('URWGothic-Demi', int(capS * 1.38))
    letters = ['S', 'P', 'A', 'C', 'E', 'X']
    widths = []
    for ch in letters:
        if ch == 'A':
            widths.append(capS * 0.95)
        elif ch == 'X':
            widths.append(capS * 1.05)
        else:
            b = f.getbbox(ch)
            widths.append(b[2] - b[0])
    gap = capS * track
    W = int(sum(widths) + gap * (len(letters) - 1) + capS * 0.9)
    H = int(capS * 1.9)
    base = int(capS * 1.45)  # baseline y
    top = base - capS
    im = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(im)
    x = capS * 0.1
    stroke = capS * 0.2
    for ch, w in zip(letters, widths):
        if ch == 'A':
            # Λ: two strokes meeting at a flat apex, no crossbar
            ax = x + w / 2
            d.polygon([(x, base), (x + stroke * 1.05, base), (ax, top + stroke * 1.3), (x + w - stroke * 1.05, base),
                       (x + w, base), (ax + stroke * 0.35, top), (ax - stroke * 0.35, top)], fill=255)
        elif ch == 'X':
            # falling stroke (top-left -> bottom-right)
            t = stroke * 0.55
            d.polygon([(x, top), (x + t * 1.9, top), (x + w, base), (x + w - t * 1.9, base)], fill=255)
            # rising stroke as a long tapered swoosh: starts thin under the previous letters,
            # sweeps up through the X and past the cap height to the upper right
            pts_u, pts_l = [], []
            n = 60
            x0, y0 = x - capS * 2.3, base + capS * 0.02
            x1, y1 = x + w + capS * 0.55, top - capS * 0.42
            for i in range(n + 1):
                s = i / n
                # quadratic curve, bowed downward (trajectory)
                cx, cy = x + w * 0.1, base + capS * 0.05
                px = (1 - s) ** 2 * x0 + 2 * (1 - s) * s * cx + s * s * x1
                py = (1 - s) ** 2 * y0 + 2 * (1 - s) * s * cy + s * s * y1
                # thickness: hairline at start, full stroke around the X, tapered tip
                th = stroke * 0.62 * (math.sin(min(1, s * 1.25) * math.pi / 2) ** 2.2) * (1 - smooth(0.82, 1.0, s) * 0.92)
                # normal of the curve
                dx = 2 * (1 - s) * (cx - x0) + 2 * s * (x1 - cx)
                dy = 2 * (1 - s) * (cy - y0) + 2 * s * (y1 - cy)
                L = math.hypot(dx, dy) or 1
                nx, ny = -dy / L, dx / L
                pts_u.append((px + nx * th, py + ny * th))
                pts_l.append((px - nx * th, py - ny * th))
            d.polygon(pts_u + pts_l[::-1], fill=255)
        else:
            b = f.getbbox(ch)
            # vertically fit glyph cap height to capS
            gim = Image.new('L', (int(b[2] - b[0] + 4), int(b[3] - b[1] + 4)), 0)
            ImageDraw.Draw(gim).text((2 - b[0], 2 - b[1]), ch, font=f, fill=255)
            gim = gim.resize((int(w), int(capS)), Image.LANCZOS)
            im.paste(255, (int(x), int(top)), gim)
        x += w + gap
    im = im.resize((W // ss, H // ss), Image.LANCZOS)
    a = np.asarray(im, np.float32) / 255.0
    # crop to content
    ys, xs = np.where(a > 0.02)
    return a[max(0, ys.min() - 2):ys.max() + 3, max(0, xs.min() - 2):xs.max() + 3]


def smooth(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def us_flag(w):
    """US flag as (h, w, 3) linear RGB + alpha mask. w in pixels, standard 10:19 ratio."""
    ss = 4
    W = w * ss
    H = int(round(W * 10 / 19))
    im = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(im)
    red, blue = (178, 34, 52), (60, 59, 110)
    sh = H / 13
    for i in range(13):
        if i % 2 == 0:
            d.rectangle([0, i * sh, W, (i + 1) * sh], fill=red)
    cw, ch = W * 0.4, sh * 7
    d.rectangle([0, 0, cw, ch], fill=blue)
    r = sh * 0.31
    for row in range(9):
        cols = 6 if row % 2 == 0 else 5
        for c in range(cols):
            cx = cw / 12 * (2 * c + 1 + (0 if row % 2 == 0 else 1))
            cy = ch / 10 * (row + 1)
            pts = []
            for k in range(10):
                ang = -math.pi / 2 + k * math.pi / 5
                rr = r if k % 2 == 0 else r * 0.38
                pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
            d.polygon(pts, fill=(255, 255, 255))
    im = im.resize((w, int(round(H / ss))), Image.LANCZOS)
    a = np.asarray(im, np.float32) / 255.0
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    return lin


def stencil_lines(w, h, lines, size_px, seed=0):
    """small black placard text block (several lines of fake technical stencil)."""
    f = font('NimbusSans-Bold', size_px * 3)
    im = Image.new('L', (w * 3, h * 3), 0)
    d = ImageDraw.Draw(im)
    y = 0
    for ln in lines:
        d.text((0, y), ln, font=f, fill=255)
        y += size_px * 3 * 1.3
    return np.asarray(im.resize((w, h), Image.LANCZOS), np.float32) / 255.0
