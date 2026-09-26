// Small GPU helpers for env passes (full-screen draws into render targets without disturbing
// the app's renderer state).
import * as THREE from 'three';

const _tri = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return g;
})();

export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** full-screen triangle pass rendering a GLSL3 ShaderMaterial into a target */
export class FullscreenPass {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly mesh: THREE.Mesh;
  constructor(public material: THREE.ShaderMaterial) {
    this.mesh = new THREE.Mesh(_tri, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.scene.matrixWorldAutoUpdate = false;
  }
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    const prev = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const prevTM = renderer.toneMapping;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev, prevFace, prevMip);
    renderer.toneMapping = prevTM;
    renderer.shadowMap.autoUpdate = prevShadow;
  }
}

export function makeRT(w: number, h: number, opts: Partial<THREE.RenderTargetOptions> = {}): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...opts,
  });
  for (const t of rt.textures) {
    t.colorSpace = THREE.NoColorSpace;
    t.minFilter = opts.minFilter ?? THREE.LinearFilter;
    t.magFilter = opts.magFilter ?? THREE.LinearFilter;
    t.wrapS = opts.wrapS ?? THREE.ClampToEdgeWrapping;
    t.wrapT = opts.wrapT ?? THREE.ClampToEdgeWrapping;
    t.type = opts.type ?? THREE.HalfFloatType;
    t.generateMipmaps = false;
  }
  return rt;
}

export function passMaterial(frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string | number> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: frag,
    uniforms,
    defines,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}
