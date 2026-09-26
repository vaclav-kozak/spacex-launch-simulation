"""Shared helpers for procedural texture generation (system python3 + numpy + Pillow).

All noise is periodic (FFT-filtered white noise), so cylindrical textures wrap seamlessly in u.
Images are float32 arrays in LINEAR colour space unless noted; `save_srgb` converts on write.
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_TEX = os.path.join(ROOT, 'public', 'textures', 'vehicles')
os.makedirs(OUT_TEX, exist_ok=True)

FONT_DIR = '/usr/share/fonts/opentype/urw-base35'


def font(name='URWGothic-Demi', size=100):
    for ext in ('.otf', '.ttf'):
        p = os.path.join(FONT_DIR, name + ext)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


_rng_cache = {}


def white(h, w, seed):
    return np.random.default_rng(seed).standard_normal((h, w)).astype(np.float32)


def fnoise(h, w, sy, sx, seed=0, white_noise=None):
    """Periodic gaussian-filtered noise, correlation lengths sy (rows) / sx (cols) in pixels.
    Normalised to zero mean, unit std."""
    n = white(h, w, seed) if white_noise is None else white_noise
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (np.pi ** 2) * ((fy * sy) ** 2 + (fx * sx) ** 2))
    out = np.fft.irfft2(np.fft.rfft2(n) * g, s=(h, w)).astype(np.float32)
    out -= out.mean()
    s = out.std()
    return out / (s if s > 1e-9 else 1)


def fbm(h, w, sy, sx, octaves=4, gain=0.5, lac=2.0, seed=0):
    acc = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        acc += amp * fnoise(h, w, max(0.6, sy / lac ** o), max(0.6, sx / lac ** o), seed + 17 * o)
        tot += amp * amp
        amp *= gain
    return acc / np.sqrt(tot)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def rgb(hexstr):
    """'#rrggbb' (sRGB) -> linear float3"""
    h = hexstr.lstrip('#')
    return srgb_to_lin(np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32))


def save_srgb(img_lin, name, quality=90):
    a = (lin_to_srgb(img_lin) * 255 + 0.5).astype(np.uint8)
    _save(a, name, quality)


def save_raw(img01, name, quality=90):
    """save a non-colour (data) image in [0,1] without colour conversion"""
    a = (np.clip(img01, 0, 1) * 255 + 0.5).astype(np.uint8)
    _save(a, name, quality)


def _save(a, name, quality):
    p = os.path.join(OUT_TEX, name)
    im = Image.fromarray(a)
    if name.endswith('.jpg'):
        im.save(p, quality=quality, optimize=True, progressive=True, subsampling=0 if quality >= 90 else 2)
    elif name.endswith('.webp'):
        im.save(p, quality=quality, method=6)
    else:
        im.save(p, optimize=True)
    print('wrote', p, os.path.getsize(p) // 1024, 'KB')


def height_to_normal(hgt, strength=1.0, wrap_x=True):
    """height (pixels units scaled by strength) -> tangent-space normal map in [0,1] (OpenGL +Y up
    in texture space = towards row 0)."""
    hx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5 * strength
    hy = (np.roll(hgt, 1, 0) - np.roll(hgt, -1, 0)) * 0.5 * strength  # +v is toward row 0 (up)
    n = np.stack([-hx, -hy, np.ones_like(hgt)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def mask_from_draw(h, w, fn, supersample=2):
    """Rasterise a vector drawing (fn(draw, scale)) into a float mask [0,1] with antialiasing."""
    s = supersample
    im = Image.new('L', (w * s, h * s), 0)
    d = ImageDraw.Draw(im)
    fn(d, s)
    im = im.resize((w, h), Image.LANCZOS)
    return np.asarray(im, np.float32) / 255.0


def text_mask(text, fnt, pad=4, spacing=0):
    """Render text into a tight float mask. Returns array (h, w)."""
    bbox = fnt.getbbox(text)
    w = bbox[2] - bbox[0] + 2 * pad + spacing * max(0, len(text) - 1)
    h = bbox[3] - bbox[1] + 2 * pad
    im = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(im)
    if spacing == 0:
        d.text((pad - bbox[0], pad - bbox[1]), text, font=fnt, fill=255)
    else:
        x = pad - bbox[0]
        for ch in text:
            d.text((x, pad - bbox[1]), ch, font=fnt, fill=255)
            x += fnt.getlength(ch) + spacing
    return np.asarray(im, np.float32) / 255.0


def paste_mask(dst, src, cy, cx, wrap_x=True):
    """max-blend src mask into dst centred at (cy, cx); wraps horizontally."""
    h, w = src.shape
    H, W = dst.shape[:2]
    y0 = int(round(cy - h / 2))
    x0 = int(round(cx - w / 2))
    for yy in range(h):
        Y = y0 + yy
        if Y < 0 or Y >= H:
            continue
        xs = (np.arange(w) + x0) % W if wrap_x else np.clip(np.arange(w) + x0, 0, W - 1)
        dst[Y, xs] = np.maximum(dst[Y, xs], src[yy])
    return dst


def resize_mask(m, h, w):
    im = Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8))
    return np.asarray(im.resize((w, h), Image.LANCZOS), np.float32) / 255.0


def blur(a, r):
    im = Image.fromarray((np.clip(a, 0, 1) * 65535).astype(np.uint16).astype(np.int32), mode='I')
    # PIL blur for 32-bit images is unsupported; use FFT gaussian instead
    return gauss(a, r, r)


def gauss(a, sy, sx):
    h, w = a.shape
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (np.pi ** 2) * ((fy * sy) ** 2 + (fx * sx) ** 2))
    return np.fft.irfft2(np.fft.rfft2(a) * g, s=(h, w)).astype(np.float32)
