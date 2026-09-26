// Low-rate environment probe: sky + ground radiance around a point (the view focus), rendered
// into a small cube map straight from the atmosphere model and PMREM-filtered for
// scene.environment / ctx.lighting.envMap. The sun/moon discs are NOT included (the
// DirectionalLights provide the direct term + speculars).
import * as THREE from 'three';
import { ATMO_COMMON, IRR_LOOKUP_GLSL } from './atmosphere';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
${ATMO_COMMON}
${IRR_LOOKUP_GLSL}
uniform float uH;
uniform vec3 uUp;
uniform vec3 uLightDir;
uniform vec3 uLightE;
uniform vec3 uAlbedo;
uniform float uSteps;
uniform vec3 uNightGlow;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  float h = max(uH, 0.5);
  float mu = dot(dir, uUp);
  float mus = dot(uLightDir, uUp);
  float nu = dot(dir, uLightDir);
  float t0, t1;
  bool hg;
  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  bool inAtm = atmSegment(h, mu, t0, t1, hg);
  if (inAtm) atmIntegrate(h, mu, mus, nu, t0, t1, int(uSteps), h > ATM_H ? 0 : 1, uLightE, L, T);
  if (hg) {
    float r = ATM_R + h;
    float musG = (r * mus + t1 * nu) / ATM_R;
    vec3 Eg = uLightE * (atmLightTrans(0.0, musG) * max(musG, 0.0) + atmSkyIrradiance(0.0, musG));
    L += T * Eg * uAlbedo / ATM_PI;
  } else {
    L += T * uNightGlow;
  }
  gl_FragColor = vec4(L, 1.0);
}
`;

export class EnvProbe {
  readonly cubeRT: THREE.WebGLCubeRenderTarget;
  readonly cubeCam: THREE.CubeCamera;
  readonly scene = new THREE.Scene();
  readonly material: THREE.ShaderMaterial;
  pmremRT: THREE.WebGLRenderTarget | null = null;
  lastUpdate = -1e9;
  lastKey = '';

  constructor(shared: Record<string, THREE.IUniform>, size = 64) {
    this.cubeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, depthBuffer: false });
    this.cubeRT.texture.colorSpace = THREE.NoColorSpace;
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.cubeRT);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...shared,
        uH: { value: 1 },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uLightDir: { value: new THREE.Vector3(0, 1, 0) },
        uLightE: { value: new THREE.Vector3(6.6, 6.6, 6.6) },
        uAlbedo: { value: new THREE.Vector3(0.08, 0.08, 0.08) },
        uSteps: { value: 16 },
        uNightGlow: { value: new THREE.Vector3() },
      },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.material);
    m.frustumCulled = false;
    this.scene.add(m, this.cubeCam);
  }

  update(renderer: THREE.WebGLRenderer, pmrem: THREE.PMREMGenerator, alt: number, up: THREE.Vector3, lightDir: THREE.Vector3, lightE: THREE.Color, albedo: THREE.Color, glow: THREE.Vector3): THREE.Texture {
    const u = this.material.uniforms;
    u.uH.value = alt;
    u.uUp.value.copy(up);
    u.uLightDir.value.copy(lightDir);
    u.uLightE.value.set(lightE.r, lightE.g, lightE.b);
    u.uAlbedo.value.set(albedo.r, albedo.g, albedo.b);
    u.uNightGlow.value.copy(glow);
    const prevTarget = renderer.getRenderTarget();
    const tm = renderer.toneMapping;
    const sm = renderer.shadowMap.autoUpdate;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.autoUpdate = false;
    this.cubeCam.update(renderer, this.scene);
    this.pmremRT = pmrem.fromCubemap(this.cubeRT.texture, this.pmremRT);
    renderer.toneMapping = tm;
    renderer.shadowMap.autoUpdate = sm;
    renderer.setRenderTarget(prevTarget);
    return this.pmremRT.texture;
  }

  dispose(): void {
    this.cubeRT.dispose();
    this.pmremRT?.dispose();
    this.material.dispose();
  }
}
