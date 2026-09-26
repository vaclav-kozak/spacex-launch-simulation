#!/usr/bin/env python3
"""Offline callout voice generator.

Generates every callout line (tools/audio/lines.json + CALLOUT_LINES from src/sim/callouts.ts)
with Kokoro-82M TTS (Apache-2.0, via kokoro-onnx), applies a launch-control radio treatment
to the 'lc' voice (band-pass 300-3400 Hz, compression, soft saturation, squelch key-up/tail,
faint net hiss) and a light broadcast polish to the 'host' voice, normalizes loudness
(pyloudnorm, BS.1770), encodes mono MP3 and writes public/audio/callouts/manifest.json.

Setup (once):
  python3 -m venv tools/audio/.venv
  tools/audio/.venv/bin/pip install kokoro-onnx soundfile scipy numpy pyloudnorm
  mkdir -p tools/audio/.venv/models && cd tools/audio/.venv/models && \
    curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx && \
    curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
Run:
  tools/audio/.venv/bin/python tools/audio/gen_callouts.py [--force] [--only TEXT]
"""
import argparse, hashlib, json, os, re, subprocess, sys
import numpy as np
import soundfile as sf
from scipy import signal

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'public', 'audio', 'callouts')
CACHE = os.path.join(HERE, '.venv', 'tts_cache')
MODELS = os.path.join(HERE, '.venv', 'models')
SR = 24000

VOICES = {'lc': 'am_michael', 'host': 'af_heart'}
CHATTER_VOICES = ['am_fenrir', 'am_puck', 'am_echo', 'af_sarah', 'bm_george', 'am_eric']
SPEED = {'lc': 1.08, 'host': 1.0, 'chatter': 1.1}
# per-utterance speed overrides (ASR-checked intelligibility through the radio chain)
SPEED_FOR = {'Eight!': 0.98}

NUM_WORDS = {w: str(i) for i, w in enumerate(
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen '
    'sixteen seventeen eighteen nineteen twenty'.split())}
NUM_WORDS.update({'thirty': '30', 'forty': '40', 'fifty': '50', 'sixty': '60'})


def norm_key(s: str) -> str:
    """MUST match normKey() in src/audio/callouts.ts."""
    s = s.lower().replace('…', ' ')
    s = re.sub(r't\s*-\s*minus', 't minus', s)
    s = re.sub(r't\s*-\s*(\d)', r't minus \1', s)
    s = re.sub(r'max\s*-\s*q', 'max q', s)
    s = re.sub(r'[^a-z0-9 ]+', ' ', s)
    words = [NUM_WORDS.get(w, w) for w in s.split()]
    return ' '.join(words)


# Respellings so the TTS pronounces jargon like the real launch net.
RESPELL = [
    (r'\bMECO\b', 'Meeko'), (r'\bSECO\b', 'Seeko'), (r'\bMVac\b', 'Em-vack'), (r'\bFTS\b', 'F T S'),
    (r'\bLOX\b', 'locks'), (r'(?i)\bmax[ -]?q\b', 'max cue'), (r'\bFalcon 9\b', 'Falcon nine'),
    (r'\bStage 1\b', 'stage one'), (r'\bstage 1\b', 'stage one'), (r'\bStage 2\b', 'stage two'),
    (r'\bstage 2\b', 'stage two'), (r'(?i)\bdroneship\b', 'drone ship'), (r'\bT[ -]minus\b', 'T minus'),
    # ASR-checked through the radio chain: 'Eight.' loses its final t, 'Six.' grows a breathy '-er' tail
    (r'^Eight\.$', 'Eight!'), (r'^Six\.$', 'Six!'),
    (r'\bHold hold hold\b', 'Hold, hold, hold'), (r'\bTEA-TEB\b', 'tee ee ay, tee ee bee'),
]
COUNT_WORDS = {'10': 'Ten', '9': 'Nine', '8': 'Eight!', '7': 'Seven', '6': 'Six!', '5': 'Five', '4': 'Four',
               '3': 'Three', '2': 'Two', '1': 'One', '0': 'Zero'}
EXCITED = {'liftoff', 'and liftoff', 'liftoff of falcon 9', 'the falcon has landed', 'and the falcon has landed',
           'the falcon has landed on of course i still love you'}


def tts_text(text: str, voice: str) -> str:
    t = text.strip()
    if t in COUNT_WORDS:
        w = COUNT_WORDS[t]
        return w if w.endswith('!') else w + '.'
    for pat, rep in RESPELL:
        t = re.sub(pat, rep, t)
    t = re.sub(r'\bSeeko 1\b', 'Seeko one', t)
    if not re.search(r'[.!?]$', t):
        t += '!' if norm_key(text) in EXCITED and voice == 'host' else '.'
    return t


def load_sim_lines():
    """CALLOUT_LINES from src/sim/callouts.ts ([{id, text, voice}]), imported through tsx."""
    p = os.path.join(ROOT, 'src', 'sim', 'callouts.ts')
    if not os.path.exists(p):
        return []
    code = ("import { CALLOUT_LINES } from './src/sim/callouts.ts';"
            "process.stdout.write(JSON.stringify(CALLOUT_LINES));")
    try:
        r = subprocess.run(['npx', 'tsx', '-e', code], cwd=ROOT, capture_output=True, text=True, timeout=120)
        lines = json.loads(r.stdout)
        return [{'id': l.get('id'), 'text': l['text'], 'voice': l.get('voice')} for l in lines]
    except Exception as ex:  # fall back to a regex scrape of `id: L('voice', 'text')`
        print('WARN: tsx import failed (%s); regex fallback' % ex)
        src = open(p, encoding='utf8').read()
        return [{'id': m.group(1), 'voice': m.group(2), 'text': m.group(4)} for m in
                re.finditer(r"(\w+)\s*:\s*L\(\s*'(lc|host)'\s*,\s*(['\"])(.*?)\3\s*\)", src)]


# ---------------------------------------------------------------- DSP
def trim(x, thr_db=-42.0, pad=0.03):
    env = np.abs(x)
    thr = 10 ** (thr_db / 20) * max(1e-9, env.max())
    idx = np.where(env > thr)[0]
    if len(idx) == 0:
        return x
    a = max(0, idx[0] - int(0.01 * SR))
    b = min(len(x), idx[-1] + int(0.04 * SR))
    y = x[a:b].copy()
    f = int(0.004 * SR)
    y[:f] *= np.linspace(0, 1, f)
    y[-f:] *= np.linspace(1, 0, f)
    p = np.zeros(int(pad * SR))
    return np.concatenate([p, y, p])


def compress(x, thr_db=-20.0, ratio=4.0, att=0.003, rel=0.06):
    a_a = np.exp(-1 / (att * SR)); a_r = np.exp(-1 / (rel * SR))
    env = 0.0
    g = np.empty_like(x)
    thr = 10 ** (thr_db / 20)
    for i, v in enumerate(np.abs(x)):
        env = a_a * env + (1 - a_a) * v if v > env else a_r * env + (1 - a_r) * v
        if env > thr:
            g[i] = (thr * (env / thr) ** (1 / ratio)) / env
        else:
            g[i] = 1.0
    return x * g


def band(x, lo, hi, order=4):
    sos = signal.butter(order, [lo, hi], btype='band', fs=SR, output='sos')
    return signal.sosfilt(sos, x)


def radio(x, rng, squelch=True, strength=1.0, hi=4250.0):
    x = x / (np.abs(x).max() + 1e-9)
    # comms-loop band: ~255-4250 Hz (a strict 300-3400 phone band makes /s/ and final plosives unintelligible)
    y = band(x, 255, hi, 4)
    # presence bump (cheap handheld/net speaker)
    b, a = signal.iirpeak(1900, 1.4, fs=SR)
    y = y + 0.35 * signal.lfilter(b, a, y)
    y = compress(y / (np.abs(y).max() + 1e-9), -22, 5, 0.002, 0.05)
    y = y / (np.abs(y).max() + 1e-9)
    drive = 2.2 * strength
    y = np.tanh(drive * y) / np.tanh(drive)
    y = band(y, 240, hi * 1.06, 2)
    # faint net hiss + mains hum-free carrier noise under the voice
    hiss = band(rng.standard_normal(len(y)), 400, 3200, 2)
    hiss *= 0.012 / (np.std(hiss) + 1e-9)
    y = y / (np.abs(y).max() + 1e-9) + hiss
    if squelch:
        # key-up: click + 40 ms carrier burst; tail: 110 ms squelch burst + click
        n_on = int(0.045 * SR)
        on = band(rng.standard_normal(n_on), 500, 3000, 2)
        on *= 0.05 / (np.std(on) + 1e-9) * np.linspace(1, 0.3, n_on)
        on[:3] += np.array([0.5, -0.35, 0.15])
        n_off = int(0.12 * SR)
        off = band(rng.standard_normal(n_off), 350, 3400, 2)
        off *= 0.22 / (np.std(off) + 1e-9) * np.exp(-np.linspace(0, 5, n_off))
        off[-4:] += np.array([0.3, -0.25, 0.1, -0.05])
        y = np.concatenate([on, y, off])
    return y


def polish(x):
    """Studio host voice: HPF, gentle compression."""
    sos = signal.butter(2, 80, btype='high', fs=SR, output='sos')
    y = signal.sosfilt(sos, x)
    y = compress(y / (np.abs(y).max() + 1e-9), -16, 2.5, 0.005, 0.12)
    return y


def loudnorm(x, target):
    import pyloudnorm as pyln
    meter = pyln.Meter(SR, block_size=min(0.4, max(0.1, len(x) / SR * 0.5)))
    try:
        L = meter.integrated_loudness(x)
    except Exception:
        L = -30.0
    if not np.isfinite(L):
        L = 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)
    y = x * 10 ** ((target - L) / 20)
    pk = np.abs(y).max()
    if pk > 0.89:  # true-peak-ish ceiling -1 dBFS
        y *= 0.89 / pk
    return y, L


# bump when the DSP chain changes: every clip whose source hash differs from the manifest is rebuilt
DSP_VERSION = 3


def slug(text, voice):
    s = re.sub(r'[^a-z0-9]+', '_', text.lower()).strip('_')[:48] or 'x'
    h = hashlib.sha1((voice + '|' + text).encode()).hexdigest()[:6]
    return f'{voice}_{s}_{h}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--only', default=None)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True); os.makedirs(CACHE, exist_ok=True)
    base = json.load(open(os.path.join(HERE, 'lines.json')))['lines']
    items = []
    seen = set()

    def add(text, voice, kind, cid=None):
        k = (voice, norm_key(text))
        if k in seen or not k[1]:
            return
        seen.add(k)
        items.append({'text': text, 'voice': voice, 'kind': kind, 'id': cid})

    sim_lines = load_sim_lines()
    for l in sim_lines:
        k = norm_key(l['text'])
        kind = 'count' if re.fullmatch(r'(t minus )?\d+|ignition', k) else 'callout'
        voices = [l['voice']] if l['voice'] in ('lc', 'host') else ['lc', 'host']
        for v in voices:
            add(l['text'], v, kind, l.get('id'))
    for l in base:
        v = l['voice']
        add(l['text'], v, 'chatter' if v == 'chatter' else l.get('kind', 'callout'))
    print(f'{len(items)} clips ({len(sim_lines)} lines from src/sim/callouts.ts)')

    from kokoro_onnx import Kokoro
    kok = Kokoro(os.path.join(MODELS, 'kokoro-v1.0.onnx'), os.path.join(MODELS, 'voices-v1.0.bin'))
    manifest = []
    try:
        old = {l['file']: l.get('src') for l in json.load(open(os.path.join(OUT, 'manifest.json')))['lines']}
    except Exception:
        old = {}
    chatter_i = 0
    keep = set()
    for it in items:
        text, voice, kind = it['text'], it['voice'], it['kind']
        if a.only and norm_key(a.only) != norm_key(text):
            continue
        if voice == 'chatter':
            kv = CHATTER_VOICES[chatter_i % len(CHATTER_VOICES)]; chatter_i += 1
        else:
            kv = VOICES[voice]
        tt = tts_text(text, voice)
        name = it['id'] if it.get('id') else slug(text, voice)
        keep.add(name + '.mp3')
        mp3 = os.path.join(OUT, name + '.mp3')
        sp = SPEED_FOR.get(tt, SPEED[voice]) if voice == 'lc' else SPEED[voice]
        cache = os.path.join(CACHE, hashlib.sha1(f'{kv}|{tt}|{sp}'.encode()).hexdigest() + '.wav')
        if not os.path.exists(cache) or a.force:
            s, sr = kok.create(tt, voice=kv, speed=sp, lang='en-us' if not kv.startswith('b') else 'en-gb')
            assert sr == SR
            sf.write(cache, s, SR)
        x, _ = sf.read(cache, dtype='float64')
        rng = np.random.default_rng(int(hashlib.sha1(name.encode()).hexdigest()[:8], 16))
        # count clips: tighter gate so the radio compressor does not lift the breath tail
        x = trim(x, thr_db=-30.0, pad=0.01) if kind == 'count' else trim(x, pad=0.03)
        if voice in ('lc', 'chatter'):
            y = radio(x, rng, squelch=(kind != 'count'), strength=1.3 if voice == 'chatter' else 1.0)
            y, L0 = loudnorm(y, -17.0 if voice == 'lc' else -20.0)
        else:
            y, L0 = loudnorm(polish(x), -16.0)
        dur = len(y) / SR
        src = hashlib.sha1(f'{kv}|{tt}|{sp}|{voice}|{kind}|{DSP_VERSION}'.encode()).hexdigest()[:12]
        if not os.path.exists(mp3) or a.force or a.only or old.get(name + '.mp3') != src:
            tmp = cache.replace('.wav', '.proc.wav')
            sf.write(tmp, y.astype(np.float32), SR, subtype='FLOAT')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', tmp, '-ac', '1', '-ar', str(SR), '-c:a', 'libmp3lame',
                            '-b:a', '64k', mp3], check=True)
            os.remove(tmp)
        manifest.append({'id': it.get('id'), 'text': text, 'key': norm_key(text), 'voice': voice, 'kind': kind,
                         'file': name + '.mp3', 'dur': round(dur, 3), 'src': src})
        print(f'  {voice:7s} {dur:5.2f}s  {text!r:60s} -> {tt!r}')
    if a.only:
        return
    # drop stale files
    for f in os.listdir(OUT):
        if f.endswith('.mp3') and f not in keep:
            os.remove(os.path.join(OUT, f))
    json.dump({'version': 1, 'generator': 'tools/audio/gen_callouts.py', 'tts': 'Kokoro-82M v1.0 (Apache-2.0)',
               'lines': manifest}, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
    print('wrote', os.path.join(OUT, 'manifest.json'))


if __name__ == '__main__':
    main()
