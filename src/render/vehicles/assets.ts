// Asset loading for vehicle / pad / ship models. OWNER: models.
// GLBs are Draco-compressed (decoder copied to public/models/draco/). Textures are plain JPEGs
// authored for glTF UV conventions (flipY = false, row 0 = v 0).
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
export const MODEL_URL = (name: string) => `${BASE}models/${name}`;
export const TEX_URL = (name: string) => `${BASE}textures/vehicles/${name}`;

let draco: DRACOLoader | null = null;
let gltfLoader: GLTFLoader | null = null;

function loader(): GLTFLoader {
  if (!gltfLoader) {
    draco = new DRACOLoader();
    draco.setDecoderPath(MODEL_URL('draco/'));
    gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(draco);
  }
  return gltfLoader;
}

const gltfCache = new Map<string, Promise<GLTF>>();

/** Load (and cache) a GLB from public/models. Resolves to null on failure (the app must stay loadable). */
export async function loadModel(name: string): Promise<GLTF | null> {
  let p = gltfCache.get(name);
  if (!p) {
    p = loader().loadAsync(MODEL_URL(name));
    gltfCache.set(name, p);
  }
  try {
    return await p;
  } catch (e) {
    console.warn(`[vehicles] failed to load model ${name}`, e);
    return null;
  }
}

const texLoader = new THREE.TextureLoader();
const texCache = new Map<string, THREE.Texture>();
let maxAniso = 8;

export function setMaxAnisotropy(renderer: THREE.WebGLRenderer): void {
  maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
}

export interface TexOpts {
  srgb?: boolean;
  repeat?: boolean;
  aniso?: number;
}

/** Load a texture from public/textures/vehicles (cached). Returns immediately; the image streams in. */
export function tex(name: string, opts: TexOpts = {}): THREE.Texture {
  const key = `${name}|${opts.srgb ? 1 : 0}|${opts.repeat ? 1 : 0}`;
  let t = texCache.get(key);
  if (t) return t;
  t = texLoader.load(TEX_URL(name), undefined, undefined, () => console.warn(`[vehicles] missing texture ${name}`));
  t.flipY = false;
  t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = opts.aniso ?? maxAniso;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texCache.set(key, t);
  return t;
}

/** Wait until every texture requested so far has an image (bounded by `timeoutMs`). */
export async function texturesReady(timeoutMs = 8000): Promise<void> {
  const t0 = performance.now();
  const pending = () => [...texCache.values()].filter((t) => !t.image);
  while (pending().length && performance.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Find a node by exact name (depth-first). */
export function byName(root: THREE.Object3D, name: string): THREE.Object3D | null {
  return root.getObjectByName(name) ?? null;
}
