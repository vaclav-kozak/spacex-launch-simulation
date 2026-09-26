#!/usr/bin/env python3
"""Analyze a capture from tools/audio/capture.py: loudness timeline, clipping, spectral balance,
crackle statistics (pressure / derivative skewness, impulse rate) and an optional spectrogram PNG.

Usage: tools/audio/.venv/bin/python tools/audio/analyze.py shots/audio/X.wav [--win 0.5] [--png]
"""
import argparse, json, os
import numpy as np
import soundfile as sf
from scipy import signal, stats

BANDS = [(15, 60), (60, 250), (250, 1000), (1000, 4000), (4000, 16000)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('wav')
    ap.add_argument('--win', type=float, default=0.5)
    ap.add_argument('--png', action='store_true')
    a = ap.parse_args()
    x, sr = sf.read(a.wav, dtype='float64')
    if x.ndim == 1:
        x = x[:, None]
    m = x.mean(axis=1)
    n = len(m)
    print(f'{a.wav}: {n / sr:.2f}s sr={sr} peak={np.abs(x).max():.3f} '
          f'clipped(>0.999)={int((np.abs(x) > 0.999).sum())} rms={20 * np.log10(np.sqrt(np.mean(m ** 2)) + 1e-12):.1f}dBFS')
    w = int(a.win * sr)
    sos = {b: signal.butter(4, b, btype='band', fs=sr, output='sos') for b in BANDS}
    bandsig = {b: signal.sosfilt(sos[b], m) for b in BANDS}
    hdr = 't(s)   rmsdB  peak  | ' + ' '.join(f'{lo}-{hi}'.rjust(9) for lo, hi in BANDS) + ' | dskew  imp/s  L/R corr'
    print(hdr)
    for i in range(0, n - w + 1, w):
        seg = m[i:i + w]
        r = np.sqrt(np.mean(seg ** 2)) + 1e-12
        bs = ' '.join(f'{20 * np.log10(np.sqrt(np.mean(bandsig[b][i:i + w] ** 2)) + 1e-12):9.1f}' for b in BANDS)
        d = np.diff(seg)
        ds = stats.skew(d) if np.std(d) > 1e-9 else 0
        # impulse rate: derivative spikes > 6 sigma (robust sigma via MAD)
        sig = 1.4826 * np.median(np.abs(d - np.median(d))) + 1e-12
        imp = int(((d > 6 * sig)[1:] & ~(d > 6 * sig)[:-1]).sum()) / a.win
        c = np.corrcoef(x[i:i + w, 0], x[i:i + w, -1])[0, 1] if x.shape[1] > 1 and np.std(x[i:i + w, 0]) > 1e-9 else 1
        print(f'{i / sr:5.1f} {20 * np.log10(r):7.1f} {np.abs(seg).max():5.2f} | {bs} | {ds:5.1f} {imp:6.0f}  {c:5.2f}')
    if a.png:
        try:
            import matplotlib
        except ImportError:
            print('--png needs matplotlib: tools/audio/.venv/bin/pip install matplotlib')
            return
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        f, t, S = signal.spectrogram(m, sr, nperseg=4096, noverlap=3072)
        plt.figure(figsize=(12, 5))
        plt.pcolormesh(t, f, 10 * np.log10(S + 1e-14), shading='auto', vmin=-130, vmax=-30, cmap='magma')
        plt.yscale('symlog', linthresh=100); plt.ylim(10, sr / 2); plt.colorbar(label='dB')
        plt.xlabel('s'); plt.ylabel('Hz'); plt.title(os.path.basename(a.wav))
        out = a.wav.replace('.wav', '.png'); plt.tight_layout(); plt.savefig(out, dpi=90); print('wrote', out)


if __name__ == '__main__':
    main()
