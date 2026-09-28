#!/usr/bin/env python3
"""Cut the rendered takes (render.py + audio.py) into the final edit and encode the deliverables.

Usage:
  python3 tools/video/assemble.py tools/video/cuts/launch.json [--only master,<deliverable file>,...]

Shots use their own take, or part of another cut's take ("take": "<cut>/<id>", with t0/t1 inside the
take's range), so short edits reuse the long one's renders. Transitions come from each shot's "in": "cut"
(hard cut, 12 ms audio de-click) or "dissolve" with "xf" seconds (video xfade + audio acrossfade). "cards"
are title overlays rendered with PIL in the HUD's font (D-DIN) and faded in/out. Audio is resampled to
48 kHz (soxr) and loudness-normalised to -14 LUFS / -1 dBTP (two-pass loudnorm), the usual target of
social platforms.

Subtitles: every callout clip the audio pass heard (<take>.subs.json, mission time) is mapped onto the
edit timeline, de-duplicated across cuts, and written as <name>.srt (whole phrases, for upload as closed
captions) and <name>.ass (short chunks, burned in by deliverables with "subs": true). "subs": {"style":
"landscape" | "vertical"} in the cut picks the look and placement (vertical keeps clear of the TikTok /
Reels / Shorts UI).

Outputs: video/<name>/<name>_master.mkv (x264 yuv444p CRF 10 + FLAC, no subtitles; rebuilt when an input
is newer) and the cut's "deliver" list, e.g. {"file": "socials/video/x.mp4", "preset": "4k", "subs": true}
or {"srt": "socials/video/x.en.srt"}. Presets: 4k (YouTube), 1080p (X / LinkedIn / Facebook), vertical
(1080x1920 for TikTok / Reels / Shorts).
"""
import argparse, json, os, re, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from common import ROOT, load_cut, out_dir, take_base

FONT_B = os.path.join(ROOT, 'public/fonts/D-DIN-Bold.woff2')
FONT_R = os.path.join(ROOT, 'public/fonts/D-DIN.woff2')
FONT_DIR = os.path.join(ROOT, 'video/fonts')  # TTF copies of D-DIN for libass (WOFF2 -> TTF, fontTools)
AUDIO_XCUT = 0.012

PRESETS = {
    # scale (None = master size), crf, maxrate, audio bitrate
    '4k': (None, 16, '80M', '384k'),
    '1080p': ((1920, 1080), 17, '20M', '256k'),
    'vertical': ((1080, 1920), 17, '25M', '256k'),
}

SUB_STYLE = {
    # font size and placement as fractions of the frame; chunk = max chars per line, 2 lines at most
    'landscape': {'fs': 0.044, 'x': 0.5, 'y': 0.787, 'chunk': 40, 'ml': 0.12, 'mr': 0.12},
    'vertical': {'fs': 0.0345, 'x': 0.465, 'y': 0.655, 'chunk': 20, 'ml': 0.07, 'mr': 0.17},
}


def run(cmd, **kw):
    print('  $', ' '.join(c if len(c) < 120 else c[:117] + '...' for c in cmd), flush=True)
    return subprocess.run(cmd, check=True, **kw)


def ensure_fonts():
    if os.path.exists(os.path.join(FONT_DIR, 'D-DIN-Bold.ttf')):
        return
    from fontTools.ttLib import TTFont  # needs the brotli module for WOFF2
    os.makedirs(FONT_DIR, exist_ok=True)
    for n in ('D-DIN-Bold', 'D-DIN'):
        f = TTFont(os.path.join(ROOT, f'public/fonts/{n}.woff2'))
        f.flavor = None
        f.save(os.path.join(FONT_DIR, f'{n}.ttf'))


# ---------------------------------------------------------------------------------------- title cards
def tracked(draw, xy, text, font, fill, tracking):
    """Draw text with letter spacing (em fraction), centred on xy[0]."""
    widths = [font.getlength(ch) for ch in text]
    sp = font.size * tracking
    total = sum(widths) + sp * (len(text) - 1)
    x = xy[0] - total / 2
    for ch, w in zip(text, widths):
        draw.text((x, xy[1]), ch, font=font, fill=fill)
        x += w + sp
    return total


def make_card(path, W, H, title, sub, y_frac, tracking=0.28, size=1.0):
    """Transparent full-frame overlay: tracked title (lines split on \\n), thin rule, subtitle, soft shadow."""
    s = min(W / 3840, H / 2160) * size
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ft = ImageFont.truetype(FONT_B, round(92 * s))
    fs = ImageFont.truetype(FONT_R, round(46 * s))
    lines = title.split('\n')
    y = H * y_frac
    lh = 118 * s
    # soft dark halo for legibility over bright plumes and sky
    shade = Image.new('L', (W, H), 0)
    hw = min(W * 0.3, 1150 * s * 1.3)
    ImageDraw.Draw(shade).ellipse([W / 2 - hw, y - 150 * s, W / 2 + hw, y + lh * (len(lines) - 1) + 250 * s], fill=120)
    shade = shade.filter(ImageFilter.GaussianBlur(110 * s))
    img.putalpha(shade)
    d = ImageDraw.Draw(img)
    w = max(tracked(d, (W / 2, y + i * lh), ln, ft, (255, 255, 255, 255), tracking) for i, ln in enumerate(lines))
    ry = y + lh * (len(lines) - 1) + 128 * s
    d.rectangle([W / 2 - w * 0.18, ry, W / 2 + w * 0.18, ry + max(2, round(3 * s))], fill=(255, 255, 255, 200))
    # first sub line is the tagline; any further lines are small print (credits)
    fp = ImageFont.truetype(FONT_R, round(33 * s))
    for i, ln in enumerate(sub.split('\n') if sub else []):
        if i == 0:
            tracked(d, (W / 2, ry + 34 * s), ln, fs, (225, 230, 235, 235), 0.12)
        else:
            tracked(d, (W / 2, ry + 58 * s + i * 46 * s), ln, fp, (215, 220, 228, 165), 0.08)
    img.save(path)


# ---------------------------------------------------------------------------------------- subtitles
COUNT = {w: str(i) for i, w in enumerate('zero one two three four five six seven eight nine ten'.split())}


def sub_text(text):
    """On-screen form of a callout: countdown words become digits ("Seven." -> "7")."""
    w = text.strip().rstrip('.!').lower()
    return COUNT.get(w, text.strip())


def gather_subs(cut, shots, starts):
    """Callout clips heard in each shot's audio take, on the edit timeline, de-duplicated across shots."""
    out = []
    for s, st in zip(shots, starts):
        p = s['base'] + '.subs.json'
        if not os.path.exists(p):
            continue
        for c in json.load(open(p)):
            c['text'] = sub_text(c['text'])
            a = st + (c['m0'] - s['t0'])
            b = st + (c['m1'] - s['t0'])
            a, b = max(a, st), min(b, st + s['dur'])
            if b - a < 0.25:
                continue
            dup = next((o for o in out if o['text'] == c['text'] and abs(o['a'] - a) < 0.4
                        or o['text'] == c['text'] and a <= o['b'] + 0.05 and b >= o['a']), None)
            if dup:
                dup['a'], dup['b'] = min(dup['a'], a), max(dup['b'], b)
            else:
                out.append({'text': c['text'], 'voice': c['voice'], 'a': a, 'b': b})
    out.sort(key=lambda o: o['a'])
    # never overlap: a line ends when the next one starts
    for o, n in zip(out, out[1:]):
        o['b'] = min(o['b'], n['a'] - 0.02)
    return [o for o in out if o['b'] - o['a'] >= 0.25]


def wrap2(words, width):
    """Split words into at most two balanced lines."""
    text = ' '.join(words)
    if len(text) <= width or len(words) < 2:
        return text
    best = min(range(1, len(words)), key=lambda k: abs(len(' '.join(words[:k])) - len(' '.join(words[k:]))))
    return ' '.join(words[:best]) + '\n' + ' '.join(words[best:])


def chunks(text, width):
    """Short on-screen chunks (<= 2 lines of `width` chars), with their share of the phrase duration."""
    words = text.split()
    out, cur = [], []
    for w in words:
        if cur and len(' '.join(cur + [w])) > width * 2 - 4:
            out.append(cur)
            cur = []
        cur.append(w)
        # break after a sentence end when the chunk already has some words
        if re.search(r'[.!?]$', w) and len(' '.join(cur)) > width * 0.6:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    weight = [sum(len(w) + 2 for w in c) for c in out]
    return [(wrap2(c, width), wt / sum(weight)) for c, wt in zip(out, weight)]


def ts(t, sep='.'):
    h, r = divmod(max(0, t), 3600)
    m, s = divmod(r, 60)
    if sep == ',':
        return f'{int(h):02d}:{int(m):02d}:{s:06.3f}'.replace('.', ',')
    return f'{int(h)}:{int(m):02d}:{s:05.2f}'


def write_srt(path, subs):
    with open(path, 'w') as f:
        for i, o in enumerate(subs, 1):
            f.write(f"{i}\n{ts(o['a'], ',')} --> {ts(o['b'], ',')}\n{wrap2(o['text'].split(), 42)}\n\n")


def write_ass(path, subs, W, H, style):
    st = SUB_STYLE[style]
    fs = round(H * st['fs']) if style == 'landscape' else round(W * st['fs'] * 16 / 9)
    x, y = round(W * st['x']), round(H * st['y'])
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,D-DIN,{fs},&H00FFFFFF,&H00FFFFFF,&H30000000,&H90000000,-1,0,0,0,100,100,{fs * 0.02:.1f},0,1,{fs * 0.075:.1f},{fs * 0.05:.1f},5,{round(W * st['ml'])},{round(W * st['mr'])},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    for o in subs:
        t = o['a']
        span = o['b'] - o['a']
        for text, share in chunks(o['text'], st['chunk']):
            d = span * share
            body = text.replace('\n', r'\N')
            ev.append(f"Dialogue: 0,{ts(t)},{ts(t + d)},Sub,,0,0,0,,{{\\pos({x},{y})\\fad(90,90)\\blur{fs * 0.015:.1f}}}{body}")
            t += d
    open(path, 'w').write(head + '\n'.join(ev) + '\n')


# ---------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cut')
    ap.add_argument('--out', default=None)
    ap.add_argument('--only', default='', help='comma list: master and/or substrings of deliverable file names')
    args = ap.parse_args()
    cut = load_cut(args.cut)
    odir = out_dir(cut, args.out)
    name = cut['name']
    want = [w for w in args.only.split(',') if w]
    fps = cut['fps']
    shots = cut['shots']
    W, H = round(cut['size'][0] * cut['scale']), round(cut['size'][1] * cut['scale'])

    # ---- takes: where each shot's frames and samples start inside its take
    for s in shots:
        s['base'] = take_base(cut, s)
        for ext in ('.mkv', '.json', '.wav'):
            if not os.path.exists(s['base'] + ext):
                sys.exit(f"missing {s['base']}{ext}")
        tk = json.load(open(s['base'] + '.json'))
        s['off'] = round((s['t0'] - tk['t0']) * fps)
        s['dur'] = round((s['t1'] - s['t0']) * fps) / fps
        if s['off'] < 0 or s['off'] + round(s['dur'] * fps) > len(tk['frames']):
            sys.exit(f"{s['id']}: {s['t0']}..{s['t1']} is outside its take {tk['t0']}..{tk['t1']}")
        if tuple(tk['size']) != (W, H):
            sys.exit(f"{s['id']}: take is {tk['size']}, the cut is {W}x{H}")

    # ---- timeline: shot start times, groups of hard-cut shots joined by dissolves
    starts, t, groups = [], 0.0, []
    for i, s in enumerate(shots):
        dissolve = i > 0 and s.get('in') == 'dissolve'
        if dissolve:
            t -= s['xf']
        starts.append(t)
        t += s['dur']
        if i == 0 or dissolve:
            groups.append({'shots': [i], 'xf': s.get('xf', 0) if dissolve else 0})
        else:
            groups[-1]['shots'].append(i)
    total = t
    fade_in, fade_out = cut.get('fade', [0.5, 1.2])
    print(f'{name}: edit length {total:.2f} s, {len(shots)} shots, {len(groups)} groups, {W}x{H}')
    for i, s in enumerate(shots):
        print(f"  {starts[i]:6.2f}  {s['id']:<22} {s['cam']:<28} T{s['t0']:+.1f}..{s['t1']:+.1f}")

    inputs = [s['base'] + e for s in shots for e in ('.mkv', '.wav')]
    master = os.path.join(odir, f'{name}_master.mkv')
    mix = os.path.join(odir, f'{name}_mix.wav')
    stale = not os.path.exists(master) or os.path.getmtime(master) < max(os.path.getmtime(p) for p in inputs) \
        or os.path.getmtime(master) < os.path.getmtime(args.cut)

    # ---- subtitles
    subs = gather_subs(cut, shots, starts)
    srt, ass = os.path.join(odir, f'{name}.srt'), os.path.join(odir, f'{name}.ass')
    write_srt(srt, subs)
    write_ass(ass, subs, W, H, (cut.get('subs') or {}).get('style', 'landscape'))
    print(f'  {len(subs)} subtitle lines -> {srt}')

    if stale or 'master' in want:
        # ---- audio mix -> loudness-normalised 48 kHz WAV
        ins, fc = [], []
        for i, s in enumerate(shots):
            ins += ['-i', s['base'] + '.wav']
            a0, d = s['off'] / fps, s['dur']
            fc.append(f"[{i}:a]aresample=48000:resampler=soxr,atrim={a0:.6f}:{a0 + d:.6f},asetpts=PTS-STARTPTS,"
                      f"afade=t=in:d={AUDIO_XCUT},afade=t=out:st={d - AUDIO_XCUT:.6f}:d={AUDIO_XCUT}[a{i}]")
        gl = []
        for g, grp in enumerate(groups):
            lab = ''.join(f'[a{i}]' for i in grp['shots'])
            fc.append(f"{lab}concat=n={len(grp['shots'])}:v=0:a=1[ag{g}]" if len(grp['shots']) > 1 else f"{lab}anull[ag{g}]")
            gl.append(f'[ag{g}]')
        cur = gl[0]
        for g in range(1, len(groups)):
            fc.append(f"{cur}{gl[g]}acrossfade=d={groups[g]['xf']}:c1=qsin:c2=qsin[ax{g}]")
            cur = f'[ax{g}]'
        fc.append(f"{cur}afade=t=in:d={min(0.4, fade_in):.3f},afade=t=out:st={total - fade_out - 0.4:.3f}:d={fade_out + 0.4:.3f}[aout]")
        raw = mix.replace('.wav', '_raw.wav')
        run(['ffmpeg', '-v', 'error', '-y', *ins, '-filter_complex', ';'.join(fc), '-map', '[aout]', '-c:a', 'pcm_f32le', raw])
        meas = subprocess.run(['ffmpeg', '-hide_banner', '-i', raw, '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
                               '-f', 'null', '-'], capture_output=True, text=True).stderr
        m = json.loads(re.search(r'\{[^{}]*"input_i"[^{}]*\}', meas, re.S).group(0))
        print(f"  loudness in: {m['input_i']} LUFS, TP {m['input_tp']}, LRA {m['input_lra']}")
        run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-af',
             f"loudnorm=I=-14:TP=-1:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
             f"measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,aresample=48000:resampler=soxr",
             '-c:a', 'pcm_s24le', mix])

        # ---- cards
        card_ins = []
        sid = {s['id']: i for i, s in enumerate(shots)}
        for k, c in enumerate(cut.get('cards', [])):
            p = os.path.join(odir, f'card{k}.png')
            make_card(p, W, H, c['title'], c.get('sub', ''), c.get('y', 0.2), c.get('tracking', 0.28), c.get('size', 1.0))
            st = starts[sid[c['shot']]] + c['from']
            card_ins.append((p, st, c['to'] - c['from']))

        # ---- video edit master
        ins, fc = [], []
        for i, s in enumerate(shots):
            ins += ['-i', s['base'] + '.mkv']
            fc.append(f"[{i}:v]trim=start_frame={s['off']}:end_frame={s['off'] + round(s['dur'] * fps)},setpts=PTS-STARTPTS,"
                      f"fps={fps},format=yuv444p,settb=AVTB[v{i}]")
        gl = []
        for g, grp in enumerate(groups):
            lab = ''.join(f'[v{i}]' for i in grp['shots'])
            fc.append(f"{lab}concat=n={len(grp['shots'])}:v=1:a=0[vg{g}]" if len(grp['shots']) > 1 else f"{lab}null[vg{g}]")
            gl.append(f'[vg{g}]')
        cur, length = gl[0], sum(shots[i]['dur'] for i in groups[0]['shots'])
        for g in range(1, len(groups)):
            xf = groups[g]['xf']
            fc.append(f"{cur}{gl[g]}xfade=transition=fade:duration={xf}:offset={length - xf:.6f}[vx{g}]")
            length += sum(shots[i]['dur'] for i in groups[g]['shots']) - xf
            cur = f'[vx{g}]'
        n = len(shots)
        for k, (p, st, dur) in enumerate(card_ins):
            ins += ['-loop', '1', '-framerate', str(fps), '-t', f'{dur:.3f}', '-i', p]
            fc.append(f"[{n + k}:v]format=rgba,fade=t=in:st=0:d=0.7:alpha=1,fade=t=out:st={dur - 0.7:.3f}:d=0.7:alpha=1,"
                      f"setpts=PTS-STARTPTS+{st:.4f}/TB[c{k}]")
            fc.append(f"{cur}[c{k}]overlay=eof_action=pass:format=yuv444[vc{k}]")
            cur = f'[vc{k}]'
        fc.append(f"{cur}fade=t=in:d={fade_in},fade=t=out:st={total - fade_out:.3f}:d={fade_out},format=yuv444p[vout]")
        run(['ffmpeg', '-v', 'error', '-y', *ins, '-i', mix, '-filter_complex', ';'.join(fc),
             '-map', '[vout]', '-map', f'{n + len(card_ins)}:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '10',
             '-pix_fmt', 'yuv444p', '-r', str(fps), '-c:a', 'flac', '-t', f'{total:.4f}', master])

    # ---- deliverables
    for d in cut.get('deliver', []):
        if 'srt' in d:
            p = os.path.join(ROOT, d['srt'])
            os.makedirs(os.path.dirname(p), exist_ok=True)
            write_srt(p, subs)
            print(f'  {p}')
            continue
        out = os.path.join(ROOT, d['file'])
        if want and not any(w in os.path.basename(out) for w in want):
            continue
        os.makedirs(os.path.dirname(out), exist_ok=True)
        size, crf, maxrate, abr = PRESETS[d['preset']]
        vf = []
        if size and tuple(size) != (W, H):
            vf.append(f'scale={size[0]}:{size[1]}:flags=lanczos')
        if d.get('subs') and subs:
            ensure_fonts()
            vf.append(f"subtitles={ass}:fontsdir={FONT_DIR}")
        run(['ffmpeg', '-v', 'error', '-y', '-i', master, *(['-vf', ','.join(vf)] if vf else []),
             '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
             '-x264-params', 'aq-mode=3', '-g', str(fps // 2), '-bf', '2', '-movflags', '+faststart',
             '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
             '-crf', str(crf), '-maxrate', maxrate, '-bufsize', str(int(maxrate[:-1]) * 2) + 'M',
             '-c:a', 'aac', '-b:a', abr, out])
        print(f'  {out}  {os.path.getsize(out) / 1e6:.0f} MB')


if __name__ == '__main__':
    main()
