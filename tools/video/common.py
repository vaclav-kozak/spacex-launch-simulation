"""Shared bits for the offline video tools: cut-list loading, take lookup, browser launch, page URLs."""
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
    """A cut list: page setup, shots (each a take rendered from the sim, or a reference to a take of another
    cut via "take": "<cut>/<id>"), title cards, subtitles and deliverables. See cuts/*.json."""
    cut = json.load(open(path))
    cut['name'] = os.path.splitext(os.path.basename(path))[0]
    cut.setdefault('fps', 60)
    cut.setdefault('size', [1920, 1080])
    cut.setdefault('scale', 2)
    cut.setdefault('query', '')
    cut.setdefault('css', '')
    for s in cut['shots']:
        s.setdefault('preroll', 2.0)
        s.setdefault('split', False)
    return cut


def own_shots(cut):
    """Shots whose take this cut renders itself (not references to another cut's take)."""
    return [s for s in cut['shots'] if not s.get('take')]


def take_base(cut, shot):
    """Path prefix of a shot's take files (<prefix>.mkv / .json / .wav / .subs.json)."""
    ref = shot.get('take')
    name, tid = (ref.split('/', 1) if '/' in ref else (cut['name'], ref)) if ref else (cut['name'], shot['id'])
    return os.path.join(ROOT, 'video', name, 'takes', tid)


def shot_url(base, cut, shot, t_start, extra=''):
    q = f"shot=1&director=0&{cut['query']}&seek={t_start:.3f}&cam={shot['cam']}"
    if cut['scale'] > 2:
        q += f"&dpr={cut['scale']}"  # the app caps the pixel ratio at 2 unless told otherwise
    if shot['split']:
        q += '&split=1'
    if shot.get('query'):
        q += '&' + shot['query']
    if extra:
        q += '&' + extra
    return f'{base}/?{q}'


def out_dir(cut, out=None):
    d = out or os.path.join(ROOT, 'video', cut['name'])
    os.makedirs(os.path.join(d, 'takes'), exist_ok=True)
    return d
