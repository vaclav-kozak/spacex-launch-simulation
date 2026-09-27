#!/usr/bin/env python3
"""Env asset pipeline: downloads public-domain / CC data and bakes the runtime textures.

Usage:  python3 src/render/env/tools/prep_assets.py [--raw DIR] [step ...]
Steps:  stars milkyway moon earth night(+city crop) clouds mask terrain coast  (default: all)
Raw downloads are cached in --raw (default: .cache/env-raw, not shipped).
Outputs: public/textures/env/*, public/data/env/*  (sources + licenses in docs/assets/env.md)
"""
import argparse, gzip, io, json, math, os, struct, subprocess, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../..'))
TEX = os.path.join(ROOT, 'public/textures/env')
DATA = os.path.join(ROOT, 'public/data/env')
R_EARTH = 6_371_000.0
PAD_LAT, PAD_LON = 34.6321, -120.6106
PAD_ELEV = 60.0

# regional (lat/lon rectangle) textures
REG = dict(lat0=18.0, lat1=42.0, lon0=-130.0, lon1=-106.0)
# city-lights crop at the native ~460 m/px of the Black Marble 500 m tiles (SF Bay .. San Diego, Las Vegas
# on the edge); must match NIGHT_CITY_BOX in src/render/env/earth.ts
CITY = dict(lat0=32.0, lat1=38.4, lon0=-123.5, lon1=-115.0)
# local azimuthal-equidistant terrain grids (x east, z south, meters, centered on cx, cz)
T1 = dict(name='t1', cx=8000.0, cz=2000.0, size=40000.0, hN=2048, iN=4096, demZ=13, imgZ=14)
T2 = dict(name='t2', cx=100000.0, cz=50000.0, size=400000.0, hN=2048, iN=4096, demZ=10, imgZ=11)

UA = {'User-Agent': 'Mozilla/5.0 (falcon9-sim asset prep)'}


def fetch(url, path, retries=4):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            with open(path + '.part', 'wb') as f:
                f.write(data)
            os.replace(path + '.part', path)
            return path
        except Exception as e:  # noqa
            if i == retries - 1:
                print('FAILED', url, e)
                return None
    return None


def big_fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print('downloading', url)
    subprocess.check_call(['curl', '-sL', '--retry', '4', '-o', path + '.part', url])
    os.replace(path + '.part', path)
    return path


# ------------------------------------------------------------------ geo helpers
def along_azimuth(dist, az_rad):
    """spherical: point at surface distance dist (m) and initial heading az from the pad -> lat, lon (deg)"""
    phi0, lam0 = math.radians(PAD_LAT), math.radians(PAD_LON)
    d = dist / R_EARTH
    lat = np.arcsin(np.sin(phi0) * np.cos(d) + np.cos(phi0) * np.sin(d) * np.cos(az_rad))
    lon = lam0 + np.arctan2(np.sin(az_rad) * np.sin(d) * np.cos(phi0), np.cos(d) - np.sin(phi0) * np.sin(lat))
    return np.degrees(lat), np.degrees(lon)


def grid_latlon(T, n, rows=None):
    """lat/lon of pixel centers of a local grid texture (row 0 = north edge = min z)."""
    half = T['size'] / 2
    c = (np.arange(n) + 0.5) / n * T['size'] - half
    xs = T['cx'] + c
    zs = T['cz'] + c
    if rows is not None:
        zs = zs[rows]
    X, Z = np.meshgrid(xs, zs)
    s = np.hypot(X, Z)
    az = np.arctan2(X, -Z)
    return along_azimuth(s, az)


def merc_px(lat, lon, z):
    n = 2 ** z * 256
    x = (lon + 180.0) / 360.0 * n
    latr = np.radians(np.clip(lat, -85.05, 85.05))
    y = (1 - np.log(np.tan(latr) + 1 / np.cos(latr)) / math.pi) / 2 * n
    return x, y


def tile_range(lat, lon, z):
    x, y = merc_px(lat, lon, z)
    return int(np.floor(x.min() / 256)) - 1, int(np.floor(x.max() / 256)) + 1, int(np.floor(y.min() / 256)) - 1, int(np.floor(y.max() / 256)) + 1


def mosaic(kind, z, tx0, tx1, ty0, ty1, raw):
    """download + assemble tiles into an array (terrarium -> float heights, imagery -> uint8 RGB)"""
    jobs = []
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            if kind == 'dem':
                url = f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx}/{ty}.png'
                p = f'{raw}/terrarium/{z}/{tx}_{ty}.png'
            else:
                url = f'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{ty}/{tx}.jpg'
                p = f'{raw}/eox/{z}/{tx}_{ty}.jpg'
            jobs.append((url, p, tx, ty))
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda j: fetch(j[0], j[1]), jobs))
    W = (tx1 - tx0 + 1) * 256
    H = (ty1 - ty0 + 1) * 256
    out = np.zeros((H, W), np.float32) if kind == 'dem' else np.zeros((H, W, 3), np.uint8)
    for url, p, tx, ty in jobs:
        if not os.path.exists(p):
            continue
        try:
            im = Image.open(p).convert('RGB')
        except Exception:
            continue
        a = np.asarray(im)
        oy, ox = (ty - ty0) * 256, (tx - tx0) * 256
        if kind == 'dem':
            a = a.astype(np.float32)
            out[oy:oy + 256, ox:ox + 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
        else:
            out[oy:oy + 256, ox:ox + 256] = a
    return out


def bilinear(img, x, y):
    H, W = img.shape[:2]
    x = np.clip(x - 0.5, 0, W - 1.001)
    y = np.clip(y - 0.5, 0, H - 1.001)
    x0 = np.floor(x).astype(np.int64); y0 = np.floor(y).astype(np.int64)
    fx = (x - x0); fy = (y - y0)
    if img.ndim == 3:
        fx = fx[..., None]; fy = fy[..., None]
    a = img[y0, x0].astype(np.float32); b = img[y0, x0 + 1].astype(np.float32)
    c = img[y0 + 1, x0].astype(np.float32); d = img[y0 + 1, x0 + 1].astype(np.float32)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def resample_merc(src, z, tx0, ty0, lat, lon):
    x, y = merc_px(lat, lon, z)
    return bilinear(src, x - tx0 * 256, y - ty0 * 256)


# ------------------------------------------------------------------ steps
def step_stars(raw):
    p = big_fetch('https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz', f'{raw}/bsc5.gz')
    rows = []
    with gzip.open(p, 'rt', encoding='latin-1') as f:
        for line in f:
            try:
                rah, ram, ras = int(line[75:77]), int(line[77:79]), float(line[79:83])
                sgn = -1 if line[83] == '-' else 1
                ded, dem, des = int(line[84:86]), int(line[86:88]), int(line[88:90])
                vmag = float(line[102:107])
            except ValueError:
                continue
            try:
                bv = float(line[109:114])
            except ValueError:
                bv = 0.6
            ra = (rah + ram / 60 + ras / 3600) * 15.0
            dec = sgn * (ded + dem / 60 + des / 3600)
            rows.append((math.radians(ra), math.radians(dec), vmag, bv))
    rows.sort(key=lambda r: r[2])
    arr = np.array(rows, np.float32)
    arr.tofile(os.path.join(DATA, 'stars.bin'))
    print('stars', len(rows), 'brightest', rows[:3])


def step_milkyway(raw):
    p = big_fetch('https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr', f'{raw}/milkyway_2020_4k.exr')
    png = f'{raw}/milkyway_4k.png'
    if not os.path.exists(png):
        subprocess.check_call(['ffmpeg', '-y', '-loglevel', 'error', '-i', p, '-pix_fmt', 'rgb48le', png])
    a = np.asarray(Image.open(png)).astype(np.float32) if False else None
    # PIL can't read rgb48 png reliably -> use ffmpeg raw
    w, h = 4096, 2048
    rawf = subprocess.check_output(['ffmpeg', '-loglevel', 'error', '-i', p, '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-'])
    a = np.frombuffer(rawf, np.float32).reshape(3, h, w)
    rgb = np.stack([a[2], a[0], a[1]], -1)  # gbr planar -> rgb
    print('milkyway linear range', rgb.min(), rgb.max(), np.percentile(rgb, [50, 99, 99.9]))
    # downsample 2x
    rgb = rgb.reshape(h // 2, 2, w // 2, 2, 3).mean((1, 3))
    scale = float(np.percentile(rgb, 99.95))
    enc = np.clip(rgb / scale, 0, 1) ** (1 / 2.2)
    Image.fromarray((enc * 255 + 0.5).astype(np.uint8)).save(os.path.join(TEX, 'milkyway.jpg'), quality=90)
    meta_update({'milkyway': {'scale': scale, 'gamma': 2.2, 'frame': 'equatorial ICRS, u=RA (0 at center? see shader)'}})


def step_moon(raw):
    p = big_fetch('https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg', f'{raw}/moon_1k.jpg')
    Image.open(p).convert('RGB').save(os.path.join(TEX, 'moon.jpg'), quality=90)


def step_earth(raw):
    p = big_fetch('https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/world.200407.3x21600x10800.jpg', f'{raw}/bm_21600.jpg')
    im = Image.open(p).convert('RGB')
    im.resize((8192, 4096), Image.LANCZOS).save(os.path.join(TEX, 'earth_day.jpg'), quality=88)
    # regional crop from the 500 m A1 tile (lon -180..-90, lat 90..0, 21600 px)
    pa = big_fetch('https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/world.200407.3x21600x21600.A1.jpg', f'{raw}/bm_A1.jpg')
    a1 = Image.open(pa).convert('RGB')
    ppd = 21600 / 90.0
    box = (int((REG['lon0'] + 180) * ppd), int((90 - REG['lat1']) * ppd), int((REG['lon1'] + 180) * ppd), int((90 - REG['lat0']) * ppd))
    a1.crop(box).resize((4096, 4096), Image.LANCZOS).save(os.path.join(TEX, 'earth_day_reg.jpg'), quality=88)


def step_night(raw):
    p = big_fetch('https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg', f'{raw}/blackmarble_3km.jpg')
    Image.open(p).convert('RGB').resize((8192, 4096), Image.LANCZOS).save(os.path.join(TEX, 'earth_night.jpg'), quality=85)
    pa = big_fetch('https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_A1.jpg', f'{raw}/blackmarble_A1.jpg')
    a1 = Image.open(pa).convert('RGB')
    ppd = a1.width / 90.0
    box = (int((REG['lon0'] + 180) * ppd), int((90 - REG['lat1']) * ppd), int((REG['lon1'] + 180) * ppd), int((90 - REG['lat0']) * ppd))
    a1.crop(box).resize((2048, 2048), Image.LANCZOS).save(os.path.join(TEX, 'earth_night_reg.jpg'), quality=85)
    # California coast at full tile resolution: 8.5 x 6.4 deg = 2040 x 1536 px -> 2048 x 1536.
    # The 500 m tile is the ~15" VIIRS grid upsampled 2x by pixel replication (2-px blocks, which a
    # bilinear lookup turns into visible squares); a sigma 0.9 px blur removes the blocks and keeps
    # the real (~0.7-0.9 km) detail.
    from PIL import ImageFilter
    box = (round((CITY['lon0'] + 180) * ppd), round((90 - CITY['lat1']) * ppd), round((CITY['lon1'] + 180) * ppd), round((90 - CITY['lat0']) * ppd))
    city = a1.crop((box[0] - 4, box[1] - 4, box[2] + 4, box[3] + 4)).filter(ImageFilter.GaussianBlur(0.9))
    city = city.crop((4, 4, city.width - 4, city.height - 4))
    city.resize((2048, 1536), Image.LANCZOS).save(os.path.join(TEX, 'earth_night_city.jpg'), quality=90)
    meta_update({'city': CITY})


def step_clouds(raw):
    p = big_fetch('https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif', f'{raw}/clouds_8192.tif')
    Image.open(p).convert('L').resize((4096, 2048), Image.LANCZOS).save(os.path.join(TEX, 'earth_clouds.jpg'), quality=88)


def step_mask(raw):
    """water masks: global (equirect 4096x2048 from terrarium z4) and regional (4096^2 from z8).
    R = land coverage (0 water .. 1 land), G = ocean depth / 4000 m (for deep/shallow tint)"""
    bm = np.asarray(Image.open(os.path.join(TEX, 'earth_day.jpg')).convert('RGB').resize((4096, 2048), Image.BILINEAR)).astype(np.float32)
    for name, z, lat_a, lat_b, lon_a, lon_b, W, H, bmimg in (
        ('mask_global', 4, 85.0, -85.0, -180.0, 180.0, 4096, 2048, bm),
        ('mask_reg', 8, REG['lat1'], REG['lat0'], REG['lon0'], REG['lon1'], 4096, 4096, None),
    ):
        lat = lat_a + (np.arange(H) + 0.5) / H * (lat_b - lat_a)
        lon = lon_a + (np.arange(W) + 0.5) / W * (lon_b - lon_a)
        if name == 'mask_global':
            lat = 90 - (np.arange(H) + 0.5) / H * 180
        LON, LAT = np.meshgrid(lon, lat)
        tx0, tx1, ty0, ty1 = tile_range(LAT, LON, z)
        tx0 = max(tx0, 0); ty0 = max(ty0, 0); tx1 = min(tx1, 2 ** z - 1); ty1 = min(ty1, 2 ** z - 1)
        dem = mosaic('dem', z, tx0, tx1, ty0, ty1, raw)
        h = resample_merc(dem, z, tx0, ty0, LAT, LON)
        land = (h > 0.5).astype(np.float32)
        if bmimg is not None:
            # depressions / lakes: trust Blue Marble color for shallow "below sea level" land
            r, g, b = bmimg[..., 0], bmimg[..., 1], bmimg[..., 2]
            not_water = (r + g > 1.3 * b + 20)
            land = np.where((h <= 0.5) & (h > -150) & not_water, 1.0, land)
            land = np.where(np.abs(LAT) > 84, 1.0, land)
        depth = np.clip(-h / 4000.0, 0, 1)
        img = np.stack([land, depth, np.zeros_like(land)], -1)
        Image.fromarray((img * 255 + 0.5).astype(np.uint8)).save(os.path.join(TEX, f'{name}.png'))
        print(name, 'land fraction', land.mean())


def step_terrain(raw):
    meta = {}
    for T in (T1, T2):
        n = T['hN']
        lat, lon = grid_latlon(T, n)
        tx0, tx1, ty0, ty1 = tile_range(lat, lon, T['demZ'])
        dem = mosaic('dem', T['demZ'], tx0, tx1, ty0, ty1, raw)
        # terrarium nodata (-32768) -> sea (the coast step then cleans the shoreline)
        dem = np.where(dem < -11000, np.nan, dem)
        if np.isnan(dem).any():
            dem[np.isnan(dem)] = -100.0
        h = resample_merc(dem, T['demZ'], tx0, ty0, lat, lon)
        # flatten the pad area (models engineer puts SLC-4E there at PAD_ELEVATION)
        half = T['size'] / 2
        c = (np.arange(n) + 0.5) / n * T['size'] - half
        X, Z = np.meshgrid(T['cx'] + c, T['cz'] + c)
        r = np.hypot(X, Z)
        t = np.clip((r - 320.0) / (650.0 - 320.0), 0, 1)
        t = t * t * (3 - 2 * t)
        h = PAD_ELEV * (1 - t) + h * t
        hq = np.clip(np.round(h * 10), -32768, 32767).astype('<i2')
        hq.tofile(os.path.join(DATA, f'{T["name"]}_height.bin'))
        print(T['name'], 'height range', float(np.nanmin(h)), float(np.nanmax(h)), 'pad', float(h[n // 2, n // 2]))
        # imagery, in row strips to bound memory
        ni = T['iN']
        img = np.zeros((ni, ni, 3), np.uint8)
        lat_i, lon_i = grid_latlon(T, ni)
        tx0, tx1, ty0, ty1 = tile_range(lat_i, lon_i, T['imgZ'])
        mos = mosaic('img', T['imgZ'], tx0, tx1, ty0, ty1, raw)
        step = 512
        for r0 in range(0, ni, step):
            img[r0:r0 + step] = np.clip(resample_merc(mos, T['imgZ'], tx0, ty0, lat_i[r0:r0 + step], lon_i[r0:r0 + step]), 0, 255).astype(np.uint8)
        Image.fromarray(img).save(os.path.join(TEX, f'{T["name"]}_albedo.jpg'), quality=87)
        meta[T['name']] = {k: T[k] for k in ('cx', 'cz', 'size', 'hN', 'iN')}
        meta[T['name']]['heightScale'] = 0.1
    meta_update({'terrain': meta, 'region': REG})
    step_coast(raw)


def _grow(mask, allowed, iters=100000):
    """4-connected flood fill of mask through allowed (numpy only)"""
    m = mask & allowed
    for _ in range(iters):
        g = m.copy()
        g[1:] |= m[:-1]; g[:-1] |= m[1:]; g[:, 1:] |= m[:, :-1]; g[:, :-1] |= m[:, 1:]
        g &= allowed
        if (g == m).all():
            break
        m = g
    return m


def step_coast(raw):
    """Fix the terrarium DEM offshore (flat 0 m tiles, positive interpolation blobs along the coast):
    water = imagery-classified water connected to the open sea (+ enclosed non-land specks);
    its height is pushed to <= -4 m so the ocean shader draws it. Idempotent, runs on the outputs."""
    for T in (T1, T2):
        n = T['hN']
        path = os.path.join(DATA, f'{T["name"]}_height.bin')
        hq = np.fromfile(path, dtype='<i2').reshape(n, n)
        h = hq.astype(np.float32) * 0.1
        img = np.asarray(Image.open(os.path.join(TEX, f'{T["name"]}_albedo.jpg'))).astype(np.float32)
        k = img.shape[0] // n
        img = img.reshape(n, k, n, k, 3).mean((1, 3))
        r, g, b = img[..., 0], img[..., 1], img[..., 2]
        lum = 0.3 * r + 0.55 * g + 0.15 * b
        cand = ((b - r > 6) & (lum < 120)) | (h < -20) | (h == 0)
        seed = (h < -20) | (h == 0)
        water = _grow(seed, cand)
        land = _grow(h > 30, ~water)
        water |= ~land  # offshore specks (surf, bogus blobs) not connected to the mainland
        out = np.where(water, np.minimum(h, -4.0), h)
        changed = int((out != h).sum())
        np.clip(np.round(out * 10), -32768, 32767).astype('<i2').tofile(path)
        print(T['name'], 'coast fix: water px', int(water.sum()), 'changed', changed)


def meta_update(d):
    p = os.path.join(DATA, 'meta.json')
    m = {}
    if os.path.exists(p):
        with open(p) as f:
            m = json.load(f)
    m.update(d)
    with open(p, 'w') as f:
        json.dump(m, f, indent=1)


STEPS = dict(stars=step_stars, milkyway=step_milkyway, moon=step_moon, earth=step_earth, night=step_night,
             clouds=step_clouds, mask=step_mask, terrain=step_terrain, coast=step_coast)

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', default=os.path.join(ROOT, '.cache/env-raw'))
    ap.add_argument('steps', nargs='*')
    a = ap.parse_args()
    os.makedirs(TEX, exist_ok=True); os.makedirs(DATA, exist_ok=True)
    for s in (a.steps or list(STEPS)):
        print('==', s, flush=True)
        STEPS[s](a.raw)
