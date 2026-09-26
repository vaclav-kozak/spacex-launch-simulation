// Viewports, camera rigs, auto-director, tiling + labels. OWNER: cameras.
// Public API (used by App/HUD/audio): new ViewportManager(ctx, domRoot), views, update(snap, dt),
// primaryView(), applyUrlParams(params), command(cmd).
//
// Views are "stories": S1 (FALCON 9 stack -> FIRST STAGE), S2 (SECOND STAGE), FAIRING, REPLAY.
// Which stories are on screen is derived from the snapshot every frame (statuses + timeline), so
// it survives seeks. Tiles animate (rect tween + alpha) when a story starts or ends.
import * as THREE from 'three';
import type { AppContext, CameraMode, ViewInfo } from '../core/context';
import type { BodyId, SimEvent, SimEventType, SimSnapshot } from '../core/types';
import { IGNITION_TIME } from '../core/constants';
import { directorShot, MAJOR_EVENTS, type StoryKey } from './director';
import { makeRig, OrbitRig, SHAKE_PROFILE, type Rig, type RigInput } from './rigs';
import { Overlay, type ModeButton } from './overlay';
import { collapsedRect, HUD_BAND, pipRects, RectTween, ScalarTween, tileRects, type Rect } from './layout';
import { applyShake, bodyFraming, clamp, fmtInt, isStacked, RAD } from './util';
import { installFakeSim } from './fakeSim';

type Role = 'tile' | 'pip';

interface Story { key: StoryKey; focus: BodyId; label: string; role: Role }

interface VS {
  key: StoryKey;
  view: ViewInfo;
  rigs: Partial<Record<CameraMode, Rig>>;
  rig: Rig;
  shotKey: string;
  role: Role;
  removing: boolean;
  rectTween: RectTween;
  alphaTween: ScalarTween;
  shotStart: number;
  lockUntil: number;
  lockStart: number;
  forced: boolean;
  fovScale: number;
  seed: number;
  needsReset: boolean;
  fresh: boolean;
  userPicked: boolean;
  /** place at the target rect without animating on the next layout */
  jumpNext: boolean;
  /** currently laid out as a picture-in-picture thumbnail */
  isPip: boolean;
  saved?: { mode: CameraMode; preset: string; lockUntil: number; userPicked: boolean };
}

const MIN_SHOT = 2.8; // s real time
const USER_LOCK = 20; // s real time
const TWEEN = 1.0; // s rect transition
const STORY_ORDER: StoryKey[] = ['S1', 'S2', 'FAIRING', 'REPLAY'];
const MODE_LABEL: Record<CameraMode, string> = {
  chase: 'CHASE', onboard_down: 'ONBOARD', onboard_engine: 'ONBOARD', long_lens: 'LONG LENS', deck: 'DECK',
  orbit: 'ORBIT', pad: 'PAD', cinematic: 'CINEMATIC',
};
const CAMERA_MODES: CameraMode[] = ['chase', 'onboard_down', 'onboard_engine', 'long_lens', 'deck', 'orbit', 'pad', 'cinematic'];

function parseBody(s: string): BodyId | null {
  const u = s.toUpperCase();
  if (u === 'S1' || u === 'BOOSTER' || u === 'B' || u === 'STACK' || u === 'F9') return 'S1';
  if (u === 'S2' || u === 'SECOND') return 'S2';
  if (u === 'FAIRING' || u === 'FAIRING_A' || u === 'FA') return 'FAIRING_A';
  if (u === 'FAIRING_B' || u === 'FB') return 'FAIRING_B';
  if (u === 'PAYLOAD' || u === 'STARLINK') return 'PAYLOAD';
  if (u === 'SHIP' || u === 'OCISLY' || u === 'DECK') return 'SHIP';
  return null;
}
function parseMode(s: string | undefined): CameraMode | null {
  if (!s) return null;
  const l = s.toLowerCase();
  if (l === 'onboard') return 'onboard_down';
  if (l === 'longlens' || l === 'tracking') return 'long_lens';
  return (CAMERA_MODES as string[]).includes(l) ? (l as CameraMode) : null;
}

export class ViewportManager {
  readonly views: ViewInfo[] = [];
  private vs = new Map<string, VS>();
  private overlay: Overlay;
  private directorOn = true;
  private labelsOff = false;
  private solo: { focus: BodyId; mode: CameraMode | null; preset: string } | null = null;
  private maximized: string | null = null;
  private lastT = Number.NaN;
  private evLog = new Map<string, number>();
  private seenAt = new Map<string, number>();
  private wasReplay = false;
  private wasPhoto = false;
  private photoKey: StoryKey | null = null;
  private snap: SimSnapshot | null = null;
  private shakeClock = 0;
  private W = 0;
  private H = 0;
  private seedCounter = 1;
  private cutLayout = false;
  private readonly evT = (type: SimEventType): number | undefined => this.eventTime(type);

  constructor(private ctx: AppContext, private dom: HTMLElement) {
    this.overlay = new Overlay(dom, {
      click: (id) => this.onClick(id),
      dragStart: (id) => this.onDragStart(id),
      drag: (id, dx, dy, button) => this.onDrag(id, dx, dy, button),
      wheel: (id, dy) => this.onWheel(id, dy),
      mode: (id, mode) => this.onModeButton(id, mode),
    });
    ctx.events.on('*', (e) => this.onEvent(e));
    // no global key bindings: the UI owns the keyboard (Esc -> command('restore'), C -> 'cycle')
    // one view up front so App/HUD/audio have something before the first update
    this.ensureView({ key: 'S1', focus: 'S1', label: 'FALCON 9', role: 'tile' }, 0, true);
  }

  // ------------------------------------------------------------------ public API

  /** URL overrides: cam=<BODY>[:<mode>[:<preset>]] | cam=<mode>[:<preset>], director=0, hud=0,
   * labels=0, split=1 (keep tiling with cam=), camfake=1|splash|rud (dev harness). */
  applyUrlParams(params: URLSearchParams): void {
    if (params.get('director') === '0') this.directorOn = false;
    if (params.get('hud') === '0' || params.get('labels') === '0') this.labelsOff = true;
    const fake = params.get('camfake');
    if (fake && fake !== '0') installFakeSim(this.ctx, fake);
    const cam = params.get('cam');
    if (cam) {
      const parts = cam.split(':');
      let focus = parseBody(parts[0]);
      let mode: CameraMode | null, preset: string;
      if (focus) { mode = parseMode(parts[1]); preset = parts[2] ?? ''; }
      else { focus = 'S1'; mode = parseMode(parts[0]); preset = parts[1] ?? ''; }
      if (focus === 'SHIP' && !mode) mode = 'deck';
      // rebuild views on the first update with the forced mode, no transition animation
      for (const v of [...this.vs.values()]) this.dropView(v);
      this.cutLayout = true;
      if (params.get('split') === '1') {
        // keep the automatic tiling; force the mode on the matching view when it exists
        this.solo = null;
        this.pendingForce = { focus, mode, preset };
      } else {
        this.solo = { focus, mode, preset };
      }
    }
  }
  private pendingForce: { focus: BodyId; mode: CameraMode | null; preset: string } | null = null;

  /** 'cycle' | 'restore' | 'maximize:<id>' | 'mode:<CameraMode>' | 'fov:<+-deg>' | 'director:on|off|toggle' */
  command(cmd: string): void {
    const i = cmd.indexOf(':');
    const c = i < 0 ? cmd : cmd.slice(0, i);
    const arg = i < 0 ? '' : cmd.slice(i + 1);
    const p = this.primaryState();
    switch (c) {
      case 'cycle': {
        if (!p) return;
        const btns = this.modeButtons(p);
        const cur = btns.findIndex((b) => b.mode === this.buttonModeOf(p.view.mode));
        const next = btns[(cur + 1) % btns.length];
        if (next) this.userMode(p, next.mode);
        break;
      }
      case 'restore': this.maximized = null; break;
      case 'maximize': if (this.vs.has(arg) && this.aliveCount() > 1) this.maximized = arg; break;
      case 'mode': {
        const m = parseMode(arg);
        if (p && m) this.userMode(p, m);
        break;
      }
      case 'fov': {
        if (!p) return;
        const d = Number(arg);
        if (!Number.isFinite(d)) return;
        const fov = p.view.camera.fov;
        p.fovScale = clamp(p.fovScale * clamp((fov + d) / Math.max(0.1, fov), 0.5, 2), 0.05, 4);
        break;
      }
      case 'director':
        this.directorOn = arg === 'on' ? true : arg === 'off' ? false : !this.directorOn;
        if (this.directorOn) for (const v of this.vs.values()) if (!v.forced) v.lockUntil = 0;
        break;
    }
  }

  /** the view whose camera the audio listener uses (maximized, else largest visible) */
  primaryView(): ViewInfo | null {
    return this.primaryState()?.view ?? this.views[0] ?? null;
  }

  /** available mode buttons for a view (for UI integration) */
  modesFor(viewId: string): CameraMode[] {
    const v = this.vs.get(viewId);
    return v ? this.modeButtons(v).map((b) => b.mode) : [];
  }

  update(snap: SimSnapshot, dtReal: number): void {
    const ctx = this.ctx;
    const now = ctx.realTime;
    this.snap = snap;
    if (ctx.width !== this.W || ctx.height !== this.H) {
      const first = this.W === 0;
      this.W = ctx.width; this.H = ctx.height;
      if (!first) this.cutLayout = true;
    }

    // mission-time step; big jumps (seek, replay start, restart) are cuts
    let dtSim = Number.isNaN(this.lastT) ? 0 : snap.t - this.lastT;
    const jumpLimit = Math.max(3, snap.warp * dtReal * 3 + 0.5);
    let cut = false;
    if (!(dtSim >= 0) || dtSim > jumpLimit) { dtSim = 0; cut = true; }
    if (Number.isNaN(this.lastT)) { cut = true; this.cutLayout = true; }
    this.lastT = snap.t;
    this.shakeClock += Math.min(dtSim, dtReal * 1.2);
    if (cut) for (const v of this.vs.values()) v.needsReset = true;

    // replay / photo transitions (hard cuts)
    if (ctx.replay !== this.wasReplay) {
      this.wasReplay = ctx.replay;
      this.cutLayout = true;
      this.maximized = null;
    }
    if (ctx.photoMode !== this.wasPhoto) {
      this.wasPhoto = ctx.photoMode;
      this.cutLayout = true;
      if (ctx.photoMode) this.enterPhoto(snap, now);
      else this.exitPhoto(snap, now);
    }

    const stories = this.stories(snap);
    this.syncStories(stories, now, snap);
    this.layout(now);
    this.cutLayout = false;

    for (const v of this.vs.values()) {
      if (!v.removing) this.direct(v, snap, now);
      this.updateCamera(v, snap, dtSim, dtReal, now);
    }
    this.updateLabels(snap, now);
  }

  // ------------------------------------------------------------------ stories / tiling

  private eventTime(type: SimEventType): number | undefined {
    const s = this.snap;
    const m = s?.timeline.find((x) => x.type === type);
    if (m?.done) return m.t;
    const logged = this.evLog.get(type);
    if (logged !== undefined && (!s || logged <= s.t + 0.01)) return logged;
    return m?.t;
  }
  private eventDone(type: SimEventType): number | undefined {
    const s = this.snap;
    const m = s?.timeline.find((x) => x.type === type);
    if (m?.done) return m.t;
    const logged = this.evLog.get(type);
    return logged !== undefined && s && logged <= s.t + 0.01 ? logged : undefined;
  }
  /** mission time at which `cond` first became true (continuously), else undefined */
  private seen(key: string, cond: boolean, t: number): number | undefined {
    if (!cond) { this.seenAt.delete(key); return undefined; }
    let v = this.seenAt.get(key);
    if (v === undefined || v > t) { v = t; this.seenAt.set(key, v); }
    return v;
  }

  private onEvent(e: SimEvent): void {
    this.evLog.set(e.type, e.t);
    if (e.body) this.evLog.set(`${e.type}:${e.body}`, e.t);
    if (MAJOR_EVENTS.has(e.type)) {
      const now = this.ctx.realTime;
      for (const v of this.vs.values()) {
        if (!v.forced && v.lockUntil > now && now - v.lockStart > 4) v.lockUntil = 0;
      }
    }
  }

  private labelFor(focus: BodyId, snap: SimSnapshot): string {
    switch (focus) {
      case 'S1': return isStacked(snap) ? 'FALCON 9' : 'FIRST STAGE';
      case 'S2': return 'SECOND STAGE';
      case 'FAIRING_A': case 'FAIRING_B': return 'FAIRING';
      case 'PAYLOAD': return 'STARLINK';
      case 'SHIP': return 'OCISLY';
    }
  }

  private keyFor(focus: BodyId): StoryKey {
    return focus === 'S2' || focus === 'PAYLOAD' ? 'S2' : focus === 'FAIRING_A' || focus === 'FAIRING_B' ? 'FAIRING' : 'S1';
  }

  private stories(snap: SimSnapshot): Story[] {
    const t = snap.t;
    const b = snap.bodies;
    if (this.ctx.replay) return [{ key: 'REPLAY', focus: 'S1', label: 'REPLAY', role: 'tile' }];
    if (this.solo) {
      const f = this.solo.focus;
      return [{ key: this.keyFor(f), focus: f, label: this.labelFor(f, snap), role: 'tile' }];
    }
    const out: Story[] = [];
    const stacked = isStacked(snap);
    if (stacked) out.push({ key: 'S1', focus: 'S1', label: 'FALCON 9', role: 'tile' });
    else {
      const st = b.S1.status;
      let role: Role | null = 'tile';
      if (st === 'landed' || st === 'tipped') {
        const td = this.eventDone('TOUCHDOWN') ?? this.seen('s1land', true, t)!;
        const since = t - td;
        if (since > 18) {
          role = 'pip';
          const seco = this.eventDone('SECO');
          const secoDone = seco !== undefined && b.S2.thrust < 1;
          if (secoDone ? t - Math.max(seco!, td + 18) > 12 : since > 150) role = null;
        }
      } else this.seen('s1land', false, t);
      const ended = st === 'splashed' || st === 'destroyed' || st === 'gone';
      const te = this.seen('s1end', ended, t);
      if (te !== undefined && t - te > 7) role = null;
      if (role) out.push({ key: 'S1', focus: 'S1', label: 'FIRST STAGE', role });
      if (b.S2.status !== 'gone') out.push({ key: 'S2', focus: 'S2', label: 'SECOND STAGE', role: 'tile' });
    }
    const fa = b.FAIRING_A;
    const fFree = fa.status !== 'stacked' && fa.status !== 'gone';
    const fs = this.seen('fsep', fFree, t);
    if (fFree && fs !== undefined) {
      const sep = this.eventDone('FAIRING_SEP') ?? fs;
      let end = sep + 70;
      const pf = this.seen('parafoil', (fa.parafoil ?? 0) > 0.5, t);
      if (pf !== undefined) end = Math.min(end, pf + 20);
      if (fa.status !== 'free') end = Math.min(end, (this.seen('fend', true, t) ?? t) + 5);
      else this.seen('fend', false, t);
      if (t < end) out.push({ key: 'FAIRING', focus: 'FAIRING_A', label: 'FAIRING', role: 'tile' });
    }
    if (this.ctx.photoMode && this.photoKey) {
      const keep = out.find((s) => s.key === this.photoKey) ?? out[0];
      return keep ? [{ ...keep, role: 'tile' }] : out.slice(0, 1);
    }
    return out;
  }

  private newView(story: Story): ViewInfo {
    return {
      id: story.key, label: story.label,
      camera: new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 1e8),
      camWorldPos: new THREE.Vector3(), focus: story.focus, mode: 'chase',
      rect: { x: 0, y: 0, w: 0, h: 0 }, alpha: 0, shimmer: 0, shake: 0, onboard: false,
    };
  }

  private ensureView(story: Story, now: number, instant: boolean): VS {
    let v = this.vs.get(story.key);
    if (v && v.removing) {
      // came back while merging away: revive
      v.removing = false;
      v.alphaTween.set(now, v.view.alpha, 1, 0.6);
    }
    if (!v) {
      const view = this.newView(story);
      const rig = makeRig('chase');
      v = {
        key: story.key, view, rigs: { chase: rig }, rig, shotKey: '', role: story.role, removing: false,
        rectTween: new RectTween(), alphaTween: new ScalarTween(), shotStart: -1e9, lockUntil: 0, lockStart: 0,
        forced: false, fovScale: 1, seed: this.seedCounter++ * 7.31, needsReset: true, fresh: true, userPicked: false,
        jumpNext: instant, isPip: false,
      };
      v.alphaTween.set(now, instant ? 1 : 0, 1, instant ? 0 : 0.8);
      view.alpha = instant ? 1 : 0;
      this.vs.set(story.key, v);
      this.views.push(view);
      // forced mode from the URL
      const force = this.solo ?? this.pendingForce;
      if (force && this.keyFor(force.focus) === story.key && force.mode) {
        view.focus = force.focus;
        this.setShot(v, force.mode, force.preset, now);
        v.forced = true;
        v.lockUntil = Infinity;
      }
    }
    v.view.label = story.label;
    if (v.view.focus !== story.focus && !(v.forced && this.solo)) { v.view.focus = story.focus; v.needsReset = true; }
    v.role = story.role;
    return v;
  }

  private syncStories(stories: Story[], now: number, snap: SimSnapshot): void {
    const instant = this.cutLayout;
    const want = new Set(stories.map((s) => s.key));
    for (const s of stories) {
      const existed = this.vs.has(s.key) && !this.vs.get(s.key)!.removing;
      const v = this.ensureView(s, now, instant);
      if (!existed && !v.forced) {
        // first shot of a new view: let the director pick immediately
        v.shotStart = -1e9;
        this.direct(v, snap, now);
      }
    }
    for (const v of this.vs.values()) {
      if (!want.has(v.key) && !v.removing) {
        v.removing = true;
        if (this.maximized === v.key) this.maximized = null;
        if (instant) { v.alphaTween.set(now, 0, 0, 0); v.view.alpha = 0; }
        else {
          v.alphaTween.set(now, v.view.alpha, 0, 0.9);
          v.rectTween.set(now, v.view.rect, collapsedRect(v.view.rect, this.W, this.H, v.isPip), TWEEN);
        }
      }
    }
    if (this.maximized && (!this.vs.has(this.maximized) || this.aliveCount() < 2)) this.maximized = null;
  }

  private aliveCount(): number {
    let n = 0;
    for (const v of this.vs.values()) if (!v.removing) n++;
    return n;
  }

  private layout(now: number): void {
    const W = this.W, H = this.H;
    const alive = [...this.vs.values()].filter((v) => !v.removing)
      .sort((a, b) => STORY_ORDER.indexOf(a.key) - STORY_ORDER.indexOf(b.key));
    let tiles = alive.filter((v) => v.role === 'tile');
    let pips = alive.filter((v) => v.role === 'pip');
    if (tiles.length === 0 && pips.length) { tiles = [pips[0]]; pips = pips.slice(1); }
    const max = this.maximized ? tiles.find((v) => v.key === this.maximized) ?? pips.find((v) => v.key === this.maximized) : undefined;
    if (max) {
      pips = [...tiles, ...pips].filter((v) => v !== max);
      tiles = [max];
    }
    const tr = tileRects(tiles.length, W, H);
    const pr = pipRects(pips.length, W, H);
    const targets = new Map<VS, { r: Rect; pip: boolean }>();
    tiles.forEach((v, i) => targets.set(v, { r: tr[i], pip: false }));
    pips.forEach((v, i) => targets.set(v, { r: pr[i], pip: true }));

    for (const [v, { r, pip }] of targets) {
      v.isPip = pip;
      if (this.cutLayout || v.jumpNext) {
        v.rectTween.jump(r);
        v.jumpNext = false;
      } else if (!v.rectTween.sameTarget(r)) {
        const fresh = v.view.rect.w <= 0 && v.view.rect.h <= 0;
        const from = fresh ? collapsedRect(r, W, H, pip) : v.view.rect;
        v.rectTween.set(now, from, r, fresh && pip ? 0.7 : TWEEN);
      }
    }
    for (const v of [...this.vs.values()]) {
      v.rectTween.eval(now, v.view.rect);
      v.view.alpha = v.alphaTween.eval(now);
      if (v.removing && v.alphaTween.done(now) && (v.rectTween.done(now) || v.alphaTween.dur === 0)) this.dropView(v);
    }
    // render order: primary tile first (UI reads views[0]), other tiles, PiPs last (drawn on top)
    const primary = this.primaryState();
    this.views.sort((a, b) => this.renderRank(a, primary) - this.renderRank(b, primary));
  }

  private renderRank(view: ViewInfo, primary: VS | undefined): number {
    const v = this.vs.get(view.id);
    if (!v) return 99;
    if (v === primary) return -1;
    const pip = v.isPip ? 10 : 0;
    return pip + STORY_ORDER.indexOf(v.key) + (v.removing ? 0.5 : 0);
  }

  private dropView(v: VS): void {
    this.vs.delete(v.key);
    const i = this.views.indexOf(v.view);
    if (i >= 0) this.views.splice(i, 1);
    this.overlay.remove(v.key);
  }

  // ------------------------------------------------------------------ director + modes

  private resolveMode(focus: BodyId | null, mode: CameraMode): CameraMode {
    if (mode === 'onboard_down' || mode === 'onboard_engine') {
      if (focus === 'S1') return 'onboard_down';
      if (focus === 'S2' || focus === 'PAYLOAD') return 'onboard_engine';
      return focus === 'SHIP' ? 'deck' : 'chase';
    }
    return mode;
  }

  private setShot(v: VS, mode: CameraMode, preset: string, now: number, initOrbit = false): void {
    const m = this.resolveMode(v.view.focus, mode);
    let rig = v.rigs[m];
    if (!rig) rig = v.rigs[m] = makeRig(m);
    if (m === 'orbit' && initOrbit && this.snap && v.view.focus) (rig as OrbitRig).initFrom(v.view, this.snap, v.view.focus);
    rig.preset = preset;
    rig.reset();
    v.rig = rig;
    v.view.mode = m;
    v.shotKey = `${m}:${preset}`;
    v.shotStart = now;
    if (m !== 'orbit') v.fovScale = 1;
  }

  private userMode(v: VS, mode: CameraMode, preset = ''): void {
    const now = this.ctx.realTime;
    this.setShot(v, mode, preset, now, mode === 'orbit' && v.view.mode !== 'orbit');
    v.userPicked = true;
    if (!v.forced) { v.lockStart = now; v.lockUntil = now + USER_LOCK; }
  }

  private direct(v: VS, snap: SimSnapshot, now: number): void {
    if (v.forced) return;
    if (this.ctx.photoMode) return;
    if (!this.directorOn && v.key !== 'REPLAY') {
      if (!v.shotKey) this.setShot(v, 'chase', '', now);
      return;
    }
    if (now < v.lockUntil) return;
    const shot = directorShot(v.key, snap, this.evT);
    const mode = this.resolveMode(v.view.focus, shot.mode);
    const key = `${mode}:${shot.preset ?? ''}`;
    if (key === v.shotKey) return;
    if (!shot.urgent && now - v.shotStart < MIN_SHOT) return;
    this.setShot(v, mode, shot.preset ?? '', now);
    v.userPicked = false;
  }

  private enterPhoto(snap: SimSnapshot, now: number): void {
    const p = this.primaryState();
    if (!p) return;
    this.photoKey = p.key;
    this.maximized = null;
    p.saved = { mode: p.view.mode, preset: p.rig.preset, lockUntil: p.lockUntil, userPicked: p.userPicked };
    if (p.view.mode !== 'orbit') this.setShot(p, 'orbit', '', now, true);
    // photo panel reads views[0]
    const i = this.views.indexOf(p.view);
    if (i > 0) { this.views.splice(i, 1); this.views.unshift(p.view); }
    void snap;
  }

  private exitPhoto(snap: SimSnapshot, now: number): void {
    const p = this.photoKey ? this.vs.get(this.photoKey) : undefined;
    this.photoKey = null;
    if (p?.saved) {
      if (p.saved.mode !== 'orbit') this.setShot(p, p.saved.mode, p.saved.preset, now);
      p.lockUntil = p.saved.lockUntil;
      p.userPicked = p.saved.userPicked;
      p.saved = undefined;
      p.fovScale = 1;
    }
    void snap;
  }

  // ------------------------------------------------------------------ camera update

  private updateCamera(v: VS, snap: SimSnapshot, dtSim: number, dtReal: number, now: number): void {
    const view = v.view;
    if (view.alpha <= 0.001 && v.removing) return;
    if (!view.focus) return;
    if (v.needsReset) { v.rig.reset(); v.needsReset = false; }
    const aspect = Math.max(1, view.rect.w) / Math.max(1, view.rect.h);
    const inp: RigInput = { snap, focus: view.focus, dtSim, dtReal, time: now, aspect, evT: this.evT };
    v.rig.update(view, inp);
    const cam = view.camera;
    cam.position.set(0, 0, 0);
    cam.fov = clamp(cam.fov * v.fovScale, 0.05, 120);
    const prof = SHAKE_PROFILE[view.mode];
    const clock = this.shakeClock;
    if (prof.amp > 0) applyShake(cam.quaternion, view.shake * prof.amp, prof.freq, clock, v.seed);
    if (view.onboard || view.mode === 'deck') applyShake(cam.quaternion, view.shake * prof.amp * 0.8, 2.6, clock, v.seed + 20);
    if (view.mode === 'long_lens') applyShake(cam.quaternion, view.shake * cam.fov * RAD * 0.06, 10, clock, v.seed + 30);
    cam.near = view.onboard ? 0.03 : view.mode === 'long_lens' ? 1 : 0.1;
    cam.far = 1e8;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------------ input

  private stateById(id: string): VS | undefined { return this.vs.get(id); }

  private onClick(id: string): void {
    if (this.ctx.photoMode) return;
    if (this.aliveCount() < 2) return;
    this.maximized = this.maximized === id ? null : id;
  }

  private ensureOrbit(v: VS): OrbitRig {
    if (v.view.mode !== 'orbit') this.userMode(v, 'orbit');
    else if (!v.forced) { v.lockStart = this.ctx.realTime; v.lockUntil = this.ctx.realTime + USER_LOCK; }
    return v.rig as OrbitRig;
  }

  private onDragStart(id: string): void {
    const v = this.stateById(id);
    if (v) this.ensureOrbit(v);
  }

  private onDrag(id: string, dx: number, dy: number, button: number): void {
    const v = this.stateById(id);
    if (!v) return;
    const o = this.ensureOrbit(v);
    if (button === 2 || button === 1) o.panBy(dx, dy, v.view);
    else o.rotate(dx, dy);
  }

  private onWheel(id: string, dy: number): void {
    const v = this.stateById(id);
    if (!v || !this.snap || !v.view.focus) return;
    const o = this.ensureOrbit(v);
    const fr = bodyFraming(this.snap, v.view.focus);
    o.zoom(dy, Math.max(4, fr.size * 0.35));
  }

  private onModeButton(id: string, mode: CameraMode): void {
    const v = this.stateById(id);
    if (v) this.userMode(v, mode);
  }

  // ------------------------------------------------------------------ labels

  private primaryState(): VS | undefined {
    if (this.maximized) {
      const m = this.vs.get(this.maximized);
      if (m && !m.removing) return m;
    }
    let best: VS | undefined, area = -1;
    for (const v of this.vs.values()) {
      if (v.removing) continue;
      const a = v.view.rect.w * v.view.rect.h * (v.isPip ? 0.01 : 1) + v.view.alpha;
      if (a > area) { area = a; best = v; }
    }
    return best;
  }

  private buttonModeOf(m: CameraMode): CameraMode {
    return m === 'onboard_engine' ? 'onboard_down' : m;
  }

  private modeButtons(v: VS): ModeButton[] {
    const f = v.view.focus;
    const snap = this.snap;
    const b = (mode: CameraMode, label = MODE_LABEL[mode]): ModeButton => ({ mode, label });
    if (f === 'SHIP') return [b('deck'), b('long_lens'), b('orbit')];
    if (f === 'FAIRING_A' || f === 'FAIRING_B') return [b('chase'), b('long_lens'), b('orbit')];
    if (f === 'S2' || f === 'PAYLOAD') return [b('chase'), b('onboard_down'), b('long_lens'), b('orbit')];
    const out = [b('chase'), b('onboard_down'), b('long_lens')];
    if (snap) {
      const s1 = snap.bodies.S1;
      if (isStacked(snap) && s1.altitude < 6000) out.unshift(b('pad'));
      if (!isStacked(snap) || v.key === 'REPLAY') out.push(b('deck'));
    }
    out.push(b('orbit'));
    return out;
  }

  private phaseText(v: VS, snap: SimSnapshot): string {
    const f = v.view.focus;
    const t = snap.t;
    if (f === 'S1') {
      const s1 = snap.bodies.S1;
      switch (s1.status) {
        case 'landed': return 'LANDED';
        case 'tipped': return 'TIPPED OVER';
        case 'splashed': return 'SPLASHDOWN';
        case 'destroyed': return 'VEHICLE LOST';
        case 'gone': return 'SIGNAL LOST';
      }
      switch (s1.phase) {
        case 'PRELAUNCH': return snap.countdownHeld ? 'HOLD' : t < IGNITION_TIME ? 'COUNTDOWN' : 'IGNITION';
        case 'ASCENT': return s1.thrust > 1 ? (s1.dynPressure > 25_000 ? 'MAX-Q' : 'ASCENT') : 'MECO';
        case 'COAST': return isStacked(snap) ? 'MECO' : 'COAST';
        case 'FLIP': return 'FLIP';
        case 'ENTRY_BURN': return 'ENTRY BURN';
        case 'AERO': return 'AERO GUIDANCE';
        case 'LANDING_BURN': return 'LANDING BURN';
        case 'LANDED': return 'LANDED';
        case 'LOST': return 'VEHICLE LOST';
      }
      return '';
    }
    if (f === 'S2' || f === 'PAYLOAD') {
      const s2 = snap.bodies.S2;
      if (snap.bodies.PAYLOAD.status === 'deployed') return 'DEPLOYED';
      if (s2.status === 'destroyed') return 'VEHICLE LOST';
      if (s2.thrust > 1) return 'MVAC BURN';
      if (this.eventDone('SECO') !== undefined || s2.status === 'orbit') return s2.status === 'orbit' ? 'ORBIT' : 'SECO';
      return s2.status === 'stacked' ? 'STACKED' : 'SEPARATION';
    }
    if (f === 'FAIRING_A' || f === 'FAIRING_B') {
      const fa = snap.bodies[f];
      if (fa.status === 'splashed') return 'SPLASHDOWN';
      return (fa.parafoil ?? 0) > 0.5 ? 'PARAFOIL' : 'FREEFALL';
    }
    return '';
  }

  private camText(v: VS): string {
    const d = v.rig.describe();
    const m = v.view.mode;
    const base = m === 'onboard_down' ? 'ONBOARD' : m === 'onboard_engine' ? 'ENGINE CAM' : MODE_LABEL[m];
    return d ? `${base} · ${d}` : base;
  }

  private updateLabels(snap: SimSnapshot, now: number): void {
    this.overlay.setLabelsHidden(this.labelsOff || this.ctx.photoMode);
    const alive = this.aliveCount();
    const H = this.H;
    for (const v of this.vs.values()) {
      const view = v.view;
      const el = this.overlay.get(v.key);
      const pip = v.isPip;
      el.setRect(view.rect.x, view.rect.y, view.rect.w, view.rect.h, view.alpha, pip ? 3 : v.removing ? 1 : 2);
      const f = view.focus ?? 'S1';
      const b = snap.bodies[f];
      const altKm = Math.max(0, b.altitude) / 1000;
      const bottomLimited = view.rect.y + 120 > H - HUD_BAND;
      el.update({
        name: view.label,
        speed: fmtInt(b.speedInertial * 3.6),
        alt: altKm < 100 ? altKm.toFixed(1) : fmtInt(altKm),
        phase: this.phaseText(v, snap),
        cam: this.camText(v),
        modes: this.modeButtons(v),
        activeMode: this.buttonModeOf(view.mode),
        compact: pip || view.rect.w < 480 || bottomLimited,
        single: alive < 2 && !this.ctx.replay,
        pip,
        canMax: alive > 1 && this.maximized !== v.key,
        isMax: alive > 1 && this.maximized === v.key,
        fade: view.alpha,
      });
    }
    void now;
  }
}
