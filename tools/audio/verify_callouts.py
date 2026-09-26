#!/usr/bin/env python3
"""ASR intelligibility check of the generated callout clips (faster-whisper base.en, CPU).

Usage: tools/audio/.venv/bin/python tools/audio/verify_callouts.py [--min 0.8]
Prints every clip whose transcript word-matches its text below --min (after norm_key). Expected
residue: compound splits ('lift off', 'shut down'), 'SECO' (respelled 'Seeko'), 'Fairing'.
"""
import argparse, difflib, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from gen_callouts import norm_key  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--min', type=float, default=0.8)
    a = ap.parse_args()
    from faster_whisper import WhisperModel
    m = WhisperModel('base.en', device='cpu', compute_type='int8',
                     download_root=os.path.join(HERE, '.venv', 'models', 'whisper'))
    d = os.path.join(ROOT, 'public', 'audio', 'callouts')
    lines = json.load(open(os.path.join(d, 'manifest.json')))['lines']
    bad = []
    for l in lines:
        segs, _ = m.transcribe(os.path.join(d, l['file']), beam_size=3, language='en')
        hyp = ' '.join(s.text for s in segs).strip()
        r = difflib.SequenceMatcher(None, norm_key(l['text']).split(), norm_key(hyp).split()).ratio()
        if r < a.min:
            bad.append((round(r, 2), l['voice'], l['text'], hyp))
    print(f'{len(lines)} clips; {len(bad)} below {a.min} word match')
    for x in sorted(bad):
        print('  ', x)


if __name__ == '__main__':
    main()
