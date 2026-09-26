// Pooled GPU resources shared by every PostPipeline of one renderer. Viewports render one after
// another, so all transient targets are shared and each view draws into a (0,0,w,h) sub-region.
// Targets are sized for the whole canvas at the current render scale and only reallocated when
// the canvas / scale bucket changes — animated viewport rects never reallocate.
import * as THREE from 'three';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FS_VERT } from './shaders/common';
import {
  LINEAR_DEPTH_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG, HIST_FRAG, ADAPT_FRAG, FLARE_FRAG, DIRT_FRAG, DOF_FRAG,
} from './shaders/passes';
import { COMPOSITE_FRAG, MAX_HAZE } from './shaders/composite';
import { FINAL_FRAG } from './shaders/final';
import {
  SMAA_EDGES_VERT, SMAA_EDGES_FRAG, SMAA_WEIGHTS_VERT, SMAA_WEIGHTS_FRAG, SMAA_BLEND_VERT, SMAA_BLEND_FRAG,
} from './shaders/smaa';

export const BLOOM_LEVELS = 6;

export interface Surf { rt: THREE.WebGLRenderTarget; w: number; h: number }

type U = Record<string, THREE.IUniform>;

function mat(frag: string, uniforms: U, vert = FS_VERT, defines?: Record<string, string | number>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag, uniforms, defines: defines ?? {},
    depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
  });
}
const v4 = () => ({ value: new THREE.Vector4() });
const v2 = () => ({ value: new THREE.Vector2() });
const f = (x = 0) => ({ value: x });
const t = () => ({ value: null as THREE.Texture | null });

function target(w: number, h: number, o: Partial<THREE.RenderTargetOptions> = {}): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, ...o,
  });
  rt.texture.name = 'post';
  return rt;
}

export class PostShared {
  private static byRenderer = new WeakMap<THREE.WebGLRenderer, PostShared>();
  static acquire(r: THREE.WebGLRenderer): PostShared {
    let s = PostShared.byRenderer.get(r);
    if (!s) PostShared.byRenderer.set(r, (s = new PostShared(r)));
    s.refs++;
    return s;
  }

  refs = 0;
  readonly quad: THREE.Mesh;
  readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  W = 0;
  H = 0;
  msaa = 0;
  // targets
  scene!: THREE.WebGLRenderTarget; // resolved HDR color + depth texture
  msaaRT: THREE.WebGLRenderTarget | null = null; // external multisampled FBO
  private msaaGL: { fb: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer } | null = null;
  linDepth!: THREE.WebGLRenderTarget;
  dof: THREE.WebGLRenderTarget | null = null;
  down: THREE.WebGLRenderTarget[] = [];
  up: THREE.WebGLRenderTarget[] = [];
  flare!: THREE.WebGLRenderTarget;
  ldr!: THREE.WebGLRenderTarget;
  edges!: THREE.WebGLRenderTarget;
  weights!: THREE.WebGLRenderTarget;
  aa!: THREE.WebGLRenderTarget;
  readonly hist: THREE.WebGLRenderTarget;
  // static textures
  readonly dirt: THREE.WebGLRenderTarget;
  private dirtReady = false;
  readonly areaTex = new THREE.Texture();
  readonly searchTex = new THREE.Texture();
  smaaReady = 0;

  readonly m: {
    depth: THREE.ShaderMaterial; down: THREE.ShaderMaterial; up: THREE.ShaderMaterial;
    hist: THREE.ShaderMaterial; adapt: THREE.ShaderMaterial; flare: THREE.ShaderMaterial;
    dirt: THREE.ShaderMaterial; dof: THREE.ShaderMaterial; composite: THREE.ShaderMaterial;
    final: THREE.ShaderMaterial; edges: THREE.ShaderMaterial; weightsLo: THREE.ShaderMaterial;
    weightsHi: THREE.ShaderMaterial; blend: THREE.ShaderMaterial;
  };

  private constructor(readonly r: THREE.WebGLRenderer) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(g);
    this.quad.frustumCulled = false;

    this.hist = target(64, 8, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.dirt = target(1024, 1024, {
      type: THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    });

    const smaaW = { tDiffuse: t(), tArea: { value: this.areaTex }, tSearch: { value: this.searchTex }, resolution: v2(), uScale: v2() };
    this.m = {
      depth: mat(LINEAR_DEPTH_FRAG, { tDepth: t(), uLogFar: f(), uNearFar: v2(), uLogDepth: f(1) }),
      down: mat(BLOOM_DOWN_FRAG, { tSrc: t(), uSrc: v4(), uTexel: v2(), uFirst: f(), uKaris: f(0.35), tExp: t() }),
      up: mat(BLOOM_UP_FRAG, { tLow: t(), uLow: v4(), uLowTexel: v2(), tCur: t(), uCur: v4(), uScatter: f(0.6), uRadius: f(1) }),
      hist: mat(HIST_FRAG, { tSrc: t(), uSize: { value: new THREE.Vector2() }, uAspect: f(1), uMinLog: f(-16), uLogRange: f(28) }),
      adapt: mat(ADAPT_FRAG, {
        tHist: t(), tPrev: t(), uMinLog: f(-16), uLogRange: f(28), uP: v4(), uClamp: v4(), uAdapt: v4(), uPrior: v4(),
        uManualL: f(), uSun: v4(), tBloom: t(), uBloomX: v4(), tDepth: t(), uDepthX: v4(), uSkyDepth: f(3e5),
        uAspect: f(1), uSubjOverride: f(0),
      }),
      flare: mat(FLARE_FRAG, { tSrc: t(), uSrc: v4(), tExp: t(), uAspect: f(1), uThreshold: f(6), uSunMask: v4() }),
      dirt: mat(DIRT_FRAG, {}),
      dof: mat(DOF_FRAG, { tSrc: t(), tDepth: t(), uX: v4(), uTexel: v2(), uCoc: v4() }),
      composite: mat(COMPOSITE_FRAG, {
        tScene: t(), tDepth: t(), uSceneX: v4(), uScenePx: v2(), tBloom: t(), uBloomX: v4(), tFlare: t(), uFlareX: v4(),
        tDirt: t(), uDirtX: v4(), tExp: t(), uAspect: f(1), uTime: f(), uFrame: f(), uBloom: v4(),
        uHazeCount: { value: 0 },
        uHazeA: { value: Array.from({ length: MAX_HAZE }, () => new THREE.Vector4()) },
        uHazeB: { value: Array.from({ length: MAX_HAZE }, () => new THREE.Vector4()) },
        uHazeC: { value: Array.from({ length: MAX_HAZE }, () => new THREE.Vector4()) },
        uShimmer: v4(), uMB: v4(), uReproj: { value: new THREE.Matrix4() }, uProj: v4(), uSubjOverride: f(0),
        uSun: v4(), uSunRot: v4(), uTonemap: { value: 0 }, uLook: { value: new THREE.Vector3(1, 1, 1) },
        uDebug: { value: 0 },
      }),
      final: mat(FINAL_FRAG, {
        tColor: t(), uSrc: v4(), uTexel: v2(), tExp: t(), uOut: v2(), uAspect: f(1), uAlpha: f(1), uFrame: f(),
        uLens: v4(), uGrain: v4(), uLook: v4(),
      }),
      edges: mat(SMAA_EDGES_FRAG, { tDiffuse: t(), resolution: v2(), uScale: v2(), uMaxUv: v2(), uThreshold: f(0.1) }, SMAA_EDGES_VERT),
      weightsLo: mat(SMAA_WEIGHTS_FRAG, { ...smaaW }, SMAA_WEIGHTS_VERT, { SMAA_MAX_SEARCH_STEPS: 8 }),
      weightsHi: mat(SMAA_WEIGHTS_FRAG, {
        tDiffuse: t(), tArea: { value: this.areaTex }, tSearch: { value: this.searchTex }, resolution: v2(), uScale: v2(),
      }, SMAA_WEIGHTS_VERT, { SMAA_MAX_SEARCH_STEPS: 16 }),
      blend: mat(SMAA_BLEND_FRAG, { tDiffuse: t(), tColor: t(), resolution: v2(), uScale: v2(), uMaxUv: v2() }, SMAA_BLEND_VERT),
    };
    // premultiplied-by-alpha fade over what's already on the canvas; keep canvas alpha
    const fm = this.m.final;
    fm.blending = THREE.CustomBlending;
    fm.blendSrc = THREE.SrcAlphaFactor;
    fm.blendDst = THREE.OneMinusSrcAlphaFactor;
    fm.blendSrcAlpha = THREE.ZeroFactor;
    fm.blendDstAlpha = THREE.OneFactor;
    fm.transparent = true;

    this.loadSmaaTextures();
  }

  private loadSmaaTextures(): void {
    const proto = SMAAPass.prototype as unknown as { _getAreaTexture(): string; _getSearchTexture(): string };
    const setup = (tex: THREE.Texture, src: string, nearest: boolean) => {
      const img = new Image();
      img.onload = () => { tex.needsUpdate = true; this.smaaReady++; };
      img.src = src;
      tex.image = img;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
      tex.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
      tex.colorSpace = THREE.NoColorSpace;
    };
    setup(this.areaTex, proto._getAreaTexture(), false);
    setup(this.searchTex, proto._getSearchTexture(), true);
  }

  /** Make sure pooled targets can hold a W x H region; reallocates only on bucket changes. */
  /**
   * Make sure the pool can hold a W x H viewport. Several viewports of different sizes share
   * the pool, so it only grows immediately; it shrinks when every request over the last ~2 s
   * was well below the allocation (no realloc thrash with mixed PiP sizes / animated rects).
   */
  ensure(W: number, H: number, msaa: number, needDof: boolean): void {
    W = Math.max(16, Math.ceil(W / 32) * 32);
    H = Math.max(16, Math.ceil(H / 32) * 32);
    const now = performance.now();
    this.reqW = Math.max(this.reqW, W);
    this.reqH = Math.max(this.reqH, H);
    if (W > this.W || H > this.H) {
      this.allocate(Math.max(W, this.W), Math.max(H, this.H));
    } else if (now - this.windowStart > 2000) {
      if (this.reqW < this.W * 0.7 || this.reqH < this.H * 0.7) this.allocate(this.reqW, this.reqH);
      this.reqW = W;
      this.reqH = H;
      this.windowStart = now;
    }
    if (msaa !== this.msaa || (msaa > 0 && !this.msaaRT)) this.allocateMsaa(msaa);
    if (needDof && !this.dof) this.dof = target(this.W, this.H);
    if (!this.dirtReady) this.makeDirt();
  }
  private reqW = 0;
  private reqH = 0;
  private windowStart = 0;

  private allocate(W: number, H: number): void {
    this.disposeSized();
    this.W = W;
    this.H = H;
    const depthTexture = new THREE.DepthTexture(W, H, THREE.FloatType);
    this.scene = target(W, H, { depthBuffer: true, depthTexture });
    this.linDepth = target(W, H, {
      type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    let w = W, h = H;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      this.down.push(target(w, h));
      if (i < BLOOM_LEVELS - 1) this.up.push(target(w, h));
    }
    this.flare = target(this.down[2].width, this.down[2].height);
    const ldr = { type: THREE.UnsignedByteType };
    this.ldr = target(W, H, ldr);
    this.edges = target(W, H, { ...ldr, format: THREE.RGFormat });
    this.weights = target(W, H, ldr);
    this.aa = target(W, H, ldr);
    // MSAA FBO depends on size
    if (this.msaa > 0) this.allocateMsaa(this.msaa, true);
    // init the resolve FBO so we can blit into it
    this.r.initRenderTarget(this.scene);
  }

  private allocateMsaa(samples: number, force = false): void {
    if (!force && samples === this.msaa && (samples === 0 || this.msaaRT)) return;
    this.disposeMsaa();
    this.msaa = samples;
    if (samples <= 0 || this.W === 0) return;
    const gl = this.r.getContext() as WebGL2RenderingContext;
    const maxS = gl.getParameter(gl.MAX_SAMPLES) as number;
    const s = Math.min(samples, maxS);
    if (s < 2) { this.msaa = 0; return; }
    const color = gl.createRenderbuffer()!;
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, s, gl.RGBA16F, this.W, this.H);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, s, gl.DEPTH_COMPONENT32F, this.W, this.H);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    const fb = gl.createFramebuffer()!;
    const st = this.r.state;
    st.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    st.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(fb); gl.deleteRenderbuffer(color); gl.deleteRenderbuffer(depth);
      this.msaa = 0;
      console.warn('[post] MSAA framebuffer incomplete, disabling MSAA');
      return;
    }
    this.msaaGL = { fb, color, depth };
    const rt = new THREE.WebGLRenderTarget(this.W, this.H, { type: THREE.HalfFloatType, depthBuffer: true });
    (this.r as unknown as { setRenderTargetFramebuffer(rt: THREE.WebGLRenderTarget, fb: WebGLFramebuffer): void })
      .setRenderTargetFramebuffer(rt, fb);
    this.msaaRT = rt;
  }

  /** Resolve (0,0,w,h) of the MSAA FBO into the scene target. */
  resolve(w: number, h: number, color: boolean, depth: boolean): void {
    if (!this.msaaGL) return;
    const gl = this.r.getContext() as WebGL2RenderingContext;
    const st = this.r.state;
    const dst = (this.r.properties.get(this.scene) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    if (!dst) return;
    st.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaGL.fb);
    st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
    st.disable(gl.SCISSOR_TEST);
    const mask = (color ? gl.COLOR_BUFFER_BIT : 0) | (depth ? gl.DEPTH_BUFFER_BIT : 0);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, mask, gl.NEAREST);
    st.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  private makeDirt(): void {
    this.pass(this.m.dirt, this.dirt, 1024, 1024);
    this.dirtReady = true;
  }

  /** Draw a fullscreen pass into (0,0,w,h) of `rt`. */
  pass(m: THREE.ShaderMaterial, rt: THREE.WebGLRenderTarget, w: number, h: number): void {
    rt.viewport.set(0, 0, w, h);
    rt.scissor.set(0, 0, w, h);
    rt.scissorTest = false;
    this.quad.material = m;
    this.r.setRenderTarget(rt);
    this.r.render(this.quad, this.cam);
  }

  /** Region transform vec4(scale.xy, maxUv.zw) for a (w,h) region of rt. */
  static xf(rt: THREE.WebGLRenderTarget, w: number, h: number, out: THREE.Vector4): THREE.Vector4 {
    const W = rt.width, H = rt.height;
    return out.set(w / W, h / H, (w - 0.5) / W, (h - 0.5) / H);
  }

  private disposeMsaa(): void {
    if (this.msaaGL) {
      const gl = this.r.getContext() as WebGL2RenderingContext;
      gl.deleteFramebuffer(this.msaaGL.fb);
      gl.deleteRenderbuffer(this.msaaGL.color);
      gl.deleteRenderbuffer(this.msaaGL.depth);
      this.msaaGL = null;
    }
    if (this.msaaRT) {
      // detach the external FBO before three's dispose tries to delete it
      (this.r as unknown as { setRenderTargetFramebuffer(rt: THREE.WebGLRenderTarget, fb?: WebGLFramebuffer): void })
        .setRenderTargetFramebuffer(this.msaaRT, undefined);
      this.msaaRT = null;
    }
  }

  private disposeSized(): void {
    if (!this.scene) return;
    this.scene.depthTexture?.dispose();
    for (const rt of [this.scene, this.linDepth, this.flare, this.ldr, this.edges, this.weights, this.aa, ...this.down, ...this.up]) rt.dispose();
    this.dof?.dispose();
    this.dof = null;
    this.down = [];
    this.up = [];
  }

  release(): void {
    if (--this.refs > 0) return;
    this.disposeSized();
    this.disposeMsaa();
    this.W = this.H = 0;
    this.msaa = 0;
    this.hist.dispose();
    this.dirt.dispose();
    this.areaTex.dispose();
    this.searchTex.dispose();
    for (const m of Object.values(this.m)) m.dispose();
    this.quad.geometry.dispose();
    PostShared.byRenderer.delete(this.r);
  }
}
