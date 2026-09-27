"""Shared bits for the offline video tools: cut-list loading, browser launch, page URLs."""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GPU_ENV = {
    'GALLIUM_DRIVER': 'd3d12',
    'MESA_D3D12_DEFAULT_ADAPTER_NAME': 'NVIDIA',
    'LD_LIBRARY_PATH': '/usr/lib/wsl/lib:' + os.environ.get('LD_LIBRARY_PATH', ''),
}
CHROME_ARGS = ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu',
               '--autoplay-policy=no-user-gesture-required']

# UI that belongs to the interactive app, not to a broadcast frame
HIDE_CSS = '.cpanel, .sound-prompt, .dlg-wrap { display: none !important; } * { cursor: none !important; }'


def load_cut(path):
    cut = json.load(open(path))
    cut.setdefault('fps', 60)
    cut.setdefault('size', [1920, 1080])
    cut.setdefault('scale', 2)
    cut.setdefault('query', '')
    for s in cut['shots']:
        s.setdefault('preroll', 2.0)
        s.setdefault('split', False)
    return cut


def shot_url(base, cut, shot, t_start, extra=''):
    q = f"shot=1&director=0&{cut['query']}&seek={t_start:.3f}&cam={shot['cam']}"
    if shot['split']:
        q += '&split=1'
    if shot.get('query'):
        q += '&' + shot['query']
    if extra:
        q += '&' + extra
    return f'{base}/?{q}'


def out_dir(cut_path, out=None):
    name = os.path.splitext(os.path.basename(cut_path))[0]
    d = out or os.path.join(ROOT, 'video', name)
    os.makedirs(os.path.join(d, 'takes'), exist_ok=True)
    return d
