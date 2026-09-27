#!/usr/bin/env python3
"""Cut the rendered takes (render.py + audio.py) into the final edit and encode the deliverables.

Usage:
  python3 tools/video/assemble.py tools/video/cuts/launch.json [--out DIR] [--only master,youtube,x]

Transitions come from each shot's "in": "cut" (hard cut, 12 ms audio de-click) or "dissolve" with
"xf" seconds (video xfade + audio acrossfade). "cards" are title overlays rendered with PIL in the
HUD's font (D-DIN) and faded in/out. Audio is resampled to 48 kHz (soxr) and loudness-normalised to
-14 LUFS / -1 dBTP (two-pass loudnorm), the usual target of social platforms.

Outputs in <out>/:
  <name>_master.mkv        4K60 x264 yuv444p CRF 10 + FLAC (edit master)
  <name>_4k60.mp4          YouTube: 3840x2160 60 fps H.264 High, ~CRF 16, AAC 384k
  <name>_1080p60.mp4       X / LinkedIn / Facebook: 1920x1080 60 fps H.264, AAC 256k
"""
import argparse, json, os, re, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from common import ROOT, load_cut, out_dir

FONT_B = os.path.join(ROOT, 'public/fonts/D-DIN-Bold.woff2')
FONT_R = os.path.join(ROOT, 'public/fonts/D-DIN.woff2')
AUDIO_XCUT = 0.012


def run(cmd, **kw):
    print('  $', ' '.join(c if len(c) < 120 else c[:117] + '...' for c in cmd), flush=True)
    return subprocess.run(cmd, check=True, **kw)


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


def make_card(path, W, H, title, sub, y_frac, tracking=0.28):
    """Transparent full-frame overlay: tracked title, thin rule, subtitle, soft shadow behind."""
    s = H / 2160
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ft = ImageFont.truetype(FONT_B, round(92 * s))
    fs = ImageFont.truetype(FONT_R, round(46 * s))
    y = H * y_frac
    # soft dark halo for legibility over bright plumes and sky
    shade = Image.new('L', (W, H), 0)
    ImageDraw.Draw(shade).ellipse([W * 0.2, y - 150 * s, W * 0.8, y + 250 * s], fill=120)
    shade = shade.filter(ImageFilter.GaussianBlur(110 * s))
    img.putalpha(shade)
    d = ImageDraw.Draw(img)
    w = tracked(d, (W / 2, y), title, ft, (255, 255, 255, 255), tracking)
    ry = y + 128 * s
    d.rectangle([W / 2 - w * 0.18, ry, W / 2 + w * 0.18, ry + max(2, round(3 * s))], fill=(255, 255, 255, 200))
    if sub:
        tracked(d, (W / 2, ry + 34 * s), sub, fs, (225, 230, 235, 235), 0.12)
    img.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cut')
    ap.add_argument('--out', default=None)
    ap.add_argument('--only', default='master,youtube,x')
    args = ap.parse_args()
    cut = load_cut(args.cut)
    odir = out_dir(args.cut, args.out)
    name = os.path.splitext(os.path.basename(args.cut))[0]
    want = set(args.only.split(','))
    fps = cut['fps']
    shots = cut['shots']
    W, H = cut['size'][0] * cut['scale'], cut['size'][1] * cut['scale']

    # ---- timeline: shot start times, groups of hard-cut shots joined by dissolves
    starts, t, groups = [], 0.0, []
    for i, s in enumerate(shots):
        s['dur'] = round((s['t1'] - s['t0']) * fps) / fps
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
    print(f'edit length {total:.2f} s, {len(shots)} shots, {len(groups)} groups')
    for i, s in enumerate(shots):
        take = os.path.join(odir, 'takes', s['id'])
        for ext in ('.mkv', '.wav'):
            if not os.path.exists(take + ext):
                sys.exit(f'missing {take}{ext}')

    # ---- audio mix -> loudness-normalised 48 kHz WAV
    mix = os.path.join(odir, f'{name}_mix.wav')
    ins, fc = [], []
    for i, s in enumerate(shots):
        ins += ['-i', os.path.join(odir, 'takes', s['id'] + '.wav')]
        d = s['dur']
        fc.append(f"[{i}:a]aresample=48000:resampler=soxr,atrim=0:{d:.6f},asetpts=PTS-STARTPTS,"
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
    fc.append(f"{cur}afade=t=in:d=0.4,afade=t=out:st={total - 1.6:.3f}:d=1.6[aout]")
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
        make_card(p, W, H, c['title'], c.get('sub', ''), c.get('y', 0.2), c.get('tracking', 0.28))
        st = starts[sid[c['shot']]] + c['from']
        card_ins.append((p, st, c['to'] - c['from']))

    # ---- video edit master
    master = os.path.join(odir, f'{name}_master.mkv')
    if 'master' in want or not os.path.exists(master):
        ins, fc = [], []
        for i, s in enumerate(shots):
            ins += ['-i', os.path.join(odir, 'takes', s['id'] + '.mkv')]
            fc.append(f"[{i}:v]trim=start_frame=0:end_frame={round(s['dur'] * fps)},setpts=PTS-STARTPTS,fps={fps},format=yuv444p,settb=AVTB[v{i}]")
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
        fc.append(f"{cur}fade=t=in:d=0.5,fade=t=out:st={total - 1.2:.3f}:d=1.2,format=yuv444p[vout]")
        run(['ffmpeg', '-v', 'error', '-stats', '-y', *ins, '-i', mix, '-filter_complex', ';'.join(fc),
             '-map', '[vout]', '-map', f'{n + len(card_ins)}:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '10',
             '-pix_fmt', 'yuv444p', '-r', str(fps), '-c:a', 'flac', '-t', f'{total:.4f}', master])

    common_v = ['-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
                '-x264-params', 'aq-mode=3', '-g', str(fps // 2), '-bf', '2', '-movflags', '+faststart',
                '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']
    if 'youtube' in want:
        run(['ffmpeg', '-v', 'error', '-stats', '-y', '-i', master, *common_v, '-crf', '16', '-maxrate', '80M',
             '-bufsize', '160M', '-c:a', 'aac', '-b:a', '384k', os.path.join(odir, f'{name}_4k60.mp4')])
    if 'x' in want:
        run(['ffmpeg', '-v', 'error', '-stats', '-y', '-i', master, '-vf', 'scale=1920:1080:flags=lanczos', *common_v,
             '-crf', '17', '-maxrate', '20M', '-bufsize', '40M', '-c:a', 'aac', '-b:a', '256k',
             os.path.join(odir, f'{name}_1080p60.mp4')])
    for f in sorted(os.listdir(odir)):
        if f.endswith(('.mp4', '.mkv')):
            p = os.path.join(odir, f)
            print(f'{p}  {os.path.getsize(p) / 1e6:.0f} MB')


main()
