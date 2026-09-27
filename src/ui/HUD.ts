// SpaceX-webcast-style HUD, controls, captions, manual landing, summary, photo mode. OWNER: ui.
// Public API (used by App): new HUD(ctx, actions, domRoot); update(snap, views, dtReal).

import type { AppContext, ViewInfo } from '../core/context';
import type { BodyState, SimEvent, SimSnapshot, TimelineMarker } from '../core/types';
import type { AppActions } from '../app/App';
import { MISSION_NAME, IGNITION_TIME } from '../core/constants';
import { StageTelemetry, type StageView } from './Telemetry';
import { Timeline } from './Timeline';
import { Captions } from './Captions';
import { Controls, WARP_LEVELS, type ControlState } from './Controls';
import { ManualHud } from './ManualHud';
import { HelpOverlay, PhotoPanel, SoundPrompt, SummaryModal } from './Overlays';
import { clamp, fmtClock, h, isTypingTarget, setText, toggleClass } from './util';
import './fonts.css';
import './hud.css';
import './panels.css';

const S1_PHASE: Record<string, string> = {
  COAST: 'COAST', FLIP: 'FLIP', ENTRY_BURN: 'ENTRY BURN', AERO: 'AERO DESCENT', LANDING_BURN: 'LANDING BURN',
  LANDED: 'LANDED', LOST: 'SIGNAL LOST', BOOST: 'BOOSTBACK BURN',
};

/** EOX requires this exact credit line (CC BY 4.0); see docs/assets/env.md */
export const CREDIT_EOX = 'Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)';
export const CREDITS_FULL: [string, string][] = [
  ['Terrain imagery', CREDIT_EOX + ', CC BY 4.0'],
  ['Earth imagery', 'NASA Earth Observatory: Blue Marble Next Generation, Black Marble 2016, Blue Marble clouds (public domain)'],
  ['Sky', 'NASA/Goddard SVS Deep Star Maps 2020 and CGI Moon Kit; Yale Bright Star Catalogue'],
  ['Elevation', 'Terrain Tiles: Mapzen / AWS Open Data; sources incl. USGS 3DEP/NED, SRTM, GMTED, ETOPO1'],
  ['Type', 'D-DIN by Datto, SIL Open Font License 1.1'],
  ['Voices', 'Generated with Kokoro-82M TTS (Apache-2.0)'],
];

type BoosterOutcome = 'success' | 'hard' | 'tipped' | 'offdeck' | 'splashdown' | 'rud' | null;

export class HUD {
  private root: HTMLDivElement;
  private band: HTMLDivElement;
  private s1: StageTelemetry;
  private s2: StageTelemetry;
  private timeline = new Timeline();
  private captions = new Captions();
  private controls: Controls;
  private manual: ManualHud;
  private help: HelpOverlay;
  private summary: SummaryModal;
  private photo: PhotoPanel;
  private sound: SoundPrompt | null;
  private badge: HTMLDivElement;
  private badgeMain: HTMLSpanElement;
  private badgeSub: HTMLSpanElement;
  private sumPill: HTMLButtonElement;
  private readonly hidden: boolean;

  private snap: SimSnapshot | null = null;
  private pending: SimEvent[] = [];
  private audioUnlocked = false;
  private touchdownSeen = false;
  private boosterOutcome: BoosterOutcome = null;
  private s2Outcome: 'orbit' | 'deployed' | 'lost' | 'short' | null = null;
  private missionEnded = false;
  /** hold state from COUNTDOWN_HOLD / RESUME events (fallback if the snapshot lags) */
  private evHeld = false;
  private summaryAutoShown = false;
  private lastW = 0;
  private lastH = 0;
  private wasPhoto = false;
  private prevBias = 0;
  private lastT = NaN;
  /** the user picked a coast warp (30×/100×): drop to 1× just before the next key event */
  /** warp the user picked; the sim clamps the running warp below it in front of key events */
  private userWarp = 1;
  private prevWarp = 1;
  private flashText = '';
  private flashUntil = 0;
  private realNow = 0;
  private aborted = false;
  private credit: HTMLDivElement;
  private capShift = -1;

  constructor(private ctx: AppContext, private actions: AppActions, domRoot: HTMLElement) {
    const params = new URLSearchParams(location.search);
    this.hidden = params.get('hud') === '0';

    this.s1 = new StageTelemetry('left', 9, 10000, 150);
    this.s2 = new StageTelemetry('right', 1, 30000, 400);
    this.credit = h('div', { class: 'credit', title: 'Imagery credits (full list in the ? help)' },
      h('a', { href: 'https://s2maps.eu', target: '_blank', rel: 'noopener', text: CREDIT_EOX.replace(' (', '\n(') }),
      h('span', { text: '  ·  Earth: NASA' }));
    this.band = h('div', { class: 'band' },
      h('div', { class: 'band-bg' }),
      this.s1.el, this.timeline.el, this.s2.el, this.credit);

    this.controls = new Controls(ctx, actions, {
      toggleHelp: () => this.setHelp(!this.help.open),
      openSummary: () => this.openSummary(),
      toggleReplay: () => this.toggleReplay(),
      toggleMute: () => this.toggleMute(),
      setWarp: (w) => this.setWarp(w),
    });
    this.manual = new ManualHud(actions);
    this.help = new HelpOverlay(() => this.setHelp(false), CREDITS_FULL);
    this.summary = new SummaryModal(actions, CREDIT_EOX + '  ·  Earth imagery: NASA', {
      replay: () => { this.summary.open = false; this.startReplay(); },
      close: () => { this.summary.open = false; },
    });
    this.photo = new PhotoPanel(ctx, actions);
    this.badgeMain = h('span', { class: 'bdg-main' });
    this.badgeSub = h('span', { class: 'bdg-sub' });
    this.badge = h('div', { class: 'badge' }, h('span', { class: 'bdg-dot' }), this.badgeMain, this.badgeSub);

    this.sound = new SoundPrompt(() => this.unlock());
    this.sumPill = h('button', { class: 'sum-pill', type: 'button', text: 'MISSION SUMMARY' });
    this.sumPill.addEventListener('mousedown', (e) => e.preventDefault());
    this.sumPill.addEventListener('click', () => this.openSummary());

    this.root = h('div', { class: 'f9ui' + (this.hidden ? ' hud-off' : '') },
      this.band, this.captions.el, this.captions.titleEl, this.manual.panel,
      this.badge, this.sumPill, this.controls.el, this.photo.el, this.sound.el, this.summary.el, this.help.el);
    domRoot.appendChild(this.root);

    // first interaction anywhere unlocks audio (autoplay policy)
    const unlockOnce = (e: Event) => {
      if (e instanceof KeyboardEvent && (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta')) return;
      this.unlock();
    };
    window.addEventListener('pointerdown', unlockOnce, { capture: true });
    window.addEventListener('keydown', unlockOnce, { capture: true });
    window.addEventListener('touchstart', unlockOnce, { capture: true, passive: true });
    this.detachUnlock = () => {
      window.removeEventListener('pointerdown', unlockOnce, { capture: true });
      window.removeEventListener('keydown', unlockOnce, { capture: true });
      window.removeEventListener('touchstart', unlockOnce, { capture: true });
    };

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.manual.releaseAll());
    ctx.events.on('*', (e) => this.pending.push(e));
    this.layout();
  }

  private detachUnlock: () => void;

  // ------------------------------------------------------------------ actions
  private unlock(): void {
    if (this.audioUnlocked) return;
    this.audioUnlocked = true;
    this.detachUnlock();
    this.actions.unlockAudio();
    this.sound?.hide();
    this.sound = null;
  }

  private toggleMute(): void {
    if (!this.audioUnlocked) { this.unlock(); return; }
    this.actions.setSetting('muted', !this.ctx.settings.muted);
  }

  private setHelp(open: boolean): void {
    this.help.open = open;
  }

  /** heuristic ceiling for a sim without `snapshot.maxWarp` */
  private heuristicMaxWarp(): number {
    const snap = this.snap!;
    if (snap.t < 0 || snap.countdownHeld) return 8;
    if (snap.bodies.S1.status === 'stacked' && snap.bodies.S1.engines.some((e) => e.on)) return 8;
    const lead = this.nextMarkerIn();
    return lead > 45 ? 100 : lead > 15 ? 30 : 8;
  }

  /** seconds of mission time until the next pending timeline marker */
  private nextMarkerIn(): number {
    const snap = this.snap;
    if (!snap) return Infinity;
    let lead = Infinity;
    for (const m of snap.timeline) if (!m.done && !m.cancelled && m.t > snap.t - 0.5) lead = Math.min(lead, m.t - snap.t);
    return lead;
  }

  private nextMarker(): TimelineMarker | null {
    const snap = this.snap;
    if (!snap) return null;
    let best: TimelineMarker | null = null;
    for (const m of snap.timeline) if (!m.done && !m.cancelled && m.t > snap.t - 0.5 && (!best || m.t < best.t)) best = m;
    return best;
  }

  private warpCeiling(): number {
    const snap = this.snap;
    if (!snap) return 8;
    let cap = typeof snap.maxWarp === 'number' && snap.maxWarp > 0 ? snap.maxWarp : this.heuristicMaxWarp();
    if (this.manual.isActive) cap = Math.min(cap, 8);
    return cap;
  }

  private warpAllowed(w: number): boolean {
    return w <= 1 || w <= this.warpCeiling();
  }

  private setWarp(w: number): void {
    if (!this.warpAllowed(w)) return;
    this.userWarp = w;
    this.actions.setWarp(w);
  }

  private stepWarp(dir: 1 | -1): void {
    const cur = this.snap?.warp ?? 1;
    if (dir < 0) {
      for (let j = WARP_LEVELS.length - 1; j >= 0; j--) if (WARP_LEVELS[j] < cur) return this.setWarp(WARP_LEVELS[j]);
    } else {
      for (const w of WARP_LEVELS) if (w > cur && this.warpAllowed(w)) return this.setWarp(w);
    }
  }

  /** the sim drops a running warp itself (to 1× within 5 s of every key event): say so on the clock */
  private updateWarpNotice(snap: SimSnapshot): void {
    const w = snap.warp, prev = this.prevWarp;
    this.prevWarp = w;
    if (snap.paused || this.ctx.replay || w >= prev || w >= this.userWarp) return;
    const m = this.nextMarker();
    this.flash(`TIME WARP ${w}×${m ? `  ·  ${m.label}` : ''}`);
    if (w <= 1) this.userWarp = 1;
  }

  private flash(text: string, secs = 3.2): void {
    this.flashText = text;
    this.flashUntil = this.realNow + secs;
  }

  private canReplay(): boolean {
    return this.touchdownSeen || !!this.snap?.timeline.some((m) => m.type === 'TOUCHDOWN' && m.done);
  }

  private startReplay(): void {
    if (!this.canReplay()) return;
    if (this.ctx.photoMode) this.actions.togglePhotoMode();
    this.summary.open = false;
    this.actions.startReplay();
  }

  private toggleReplay(): void {
    if (this.ctx.replay) this.actions.stopReplay();
    else this.startReplay();
  }

  private summaryReady(): boolean {
    if (this.missionEnded) return true;
    const snap = this.snap;
    const secoDone = !!snap?.timeline.some((m) => m.type === 'SECO' && m.done);
    const s2Known = secoDone || this.s2Outcome !== null;
    const s1 = snap?.bodies.S1.status;
    const s1Known = this.boosterOutcome !== null || s1 === 'landed' || s1 === 'tipped' || s1 === 'splashed' || s1 === 'destroyed';
    return s2Known && s1Known;
  }

  private openSummary(): void {
    const sum = this.actions.getSummary();
    const snap = this.snap;
    const b = this.boosterOutcome ?? (snap ? outcomeFromStatus(snap.bodies.S1) : null);
    const booster = b === 'success' ? 'BOOSTER LANDED' : b === 'hard' ? 'HARD LANDING' : b === 'tipped' ? 'BOOSTER TIPPED OVER'
      : b === 'offdeck' ? 'BOOSTER MISSED THE DECK' : b === 'splashdown' ? 'BOOSTER SPLASHDOWN' : b === 'rud' ? 'BOOSTER LOST' : '';
    const s2 = this.s2Outcome ?? (snap?.bodies.S2.status === 'orbit' ? 'orbit' : snap?.bodies.S2.status === 'deployed' ? 'deployed'
      : snap?.timeline.some((m) => m.type === 'SECO' && m.done) ? 'orbit' : null);
    const payload = s2 === 'deployed' ? 'STARLINK DEPLOYED' : s2 === 'orbit' ? 'PAYLOAD IN ORBIT'
      : s2 === 'lost' ? 'SECOND STAGE LOST' : s2 === 'short' ? 'ORBIT NOT REACHED' : '';
    const derived = [booster, payload].filter(Boolean).join(' · ');
    const simOutcome = (sum.outcome ?? '').trim();
    // the sim's verdict is final only after MISSION_END (before payload deploy it reads "failure")
    const useSim = simOutcome && simOutcome.toLowerCase() !== 'placeholder' && this.missionEnded;
    const headline = useSim ? simOutcome.toUpperCase() : derived || 'MISSION IN PROGRESS';
    const bad = (b !== null && b !== 'success') || s2 === 'lost' || s2 === 'short';
    const clock = snap ? fmtClock(snap.t) : null;
    const sub = `${MISSION_NAME}  ·  SLC-4E VANDENBERG → OCISLY  ·  ${clock ? `${clock.sign} ${clock.body}` : ''}`;
    const lines = sum.lines.length ? sum.lines : this.fallbackLines();
    // the sim's headline already says it all; add the derived line only if it adds information
    const extra = useSim && derived && bad ? `${derived}\n` : '';
    this.summary.show(headline, extra + sub, lines, this.canReplay(), bad);
  }

  private fallbackLines(): { label: string; value: string }[] {
    const snap = this.snap;
    if (!snap) return [];
    const out: { label: string; value: string }[] = [];
    for (const m of snap.timeline) if (m.done) { const c = fmtClock(m.t); out.push({ label: m.label, value: `${c.sign} ${c.body}` }); }
    return out;
  }

  // ------------------------------------------------------------------ keyboard
  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const tgt = e.target as HTMLElement | null;
    const onControl = !!tgt && (tgt.tagName === 'BUTTON' || tgt.tagName === 'INPUT');
    if (onControl && (e.key === ' ' || e.key === 'Enter')) return; // let the focused control activate
    if (onControl && tgt!.tagName === 'INPUT' && e.key.startsWith('Arrow')) return; // slider nudges

    if (this.manual.key(e, down)) { e.preventDefault(); return; }
    if (!down) return;
    if (e.repeat && !['BracketLeft', 'BracketRight'].includes(e.code)) return;

    const a = this.actions;
    const photo = this.ctx.photoMode;
    let handled = true;
    switch (e.code) {
      case 'Escape':
        if (this.help.open) this.setHelp(false);
        else if (this.summary.open) this.summary.open = false;
        else if (photo) a.togglePhotoMode();
        else if (this.ctx.replay) a.stopReplay();
        else a.cameraCommand('restore');
        break;
      case 'Space': if (!photo) a.togglePause(); break;
      case 'KeyL': if ((this.snap?.t ?? 0) < IGNITION_TIME) a.liftoffNow(); break;
      case 'KeyH': if (this.holdMode() !== 'none') a.toggleHold(); break;
      case 'KeyS': if (this.stageSepAllowed()) a.stageSeparation(); break;
      case 'KeyF': if (this.fairingSepAllowed()) a.fairingSeparation(); break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6':
        this.setWarp(WARP_LEVELS[Number(e.code.slice(5)) - 1]); break;
      case 'BracketLeft': this.stepWarp(-1); break;
      case 'BracketRight': this.stepWarp(1); break;
      case 'KeyC': a.cameraCommand('cycle'); break;
      case 'KeyP': a.togglePhotoMode(); break;
      case 'KeyR': this.toggleReplay(); break;
      case 'KeyM': this.toggleMute(); break;
      case 'KeyK': a.setSetting('manualLanding', !this.ctx.settings.manualLanding); break;
      case 'Enter': if (photo) void this.photo.capture(); else handled = false; break;
      case 'Slash': if (e.shiftKey || e.key === '?') this.setHelp(!this.help.open); else handled = false; break;
      default:
        if (e.key === '?') this.setHelp(!this.help.open);
        else handled = false;
    }
    if (handled) e.preventDefault();
  }

  private stageSepAllowed(): boolean {
    const s = this.snap;
    return !!s && s.t > 0 && s.bodies.S2.status === 'stacked' && s.bodies.S1.status === 'stacked';
  }
  private fairingSepAllowed(): boolean {
    const s = this.snap;
    return !!s && s.t > 0 && s.bodies.FAIRING_A.status === 'stacked';
  }

  /** H / HOLD button: hold ↔ resume before ignition; after TEA-TEB (T−3 … T−0) a hold is an abort
   * (engine shutdown, the sim recycles to T−60) */
  private holdMode(): 'hold' | 'resume' | 'abort' | 'none' {
    const s = this.snap;
    if (!s || this.ctx.replay || s.t >= 0 || this.aborted) return 'none';
    if (s.t < IGNITION_TIME) return s.countdownHeld || this.evHeld ? 'resume' : 'hold';
    return s.countdownHeld ? 'none' : 'abort';
  }

  // ------------------------------------------------------------------ events
  private handleEvent(e: SimEvent, stale: boolean): void {
    switch (e.type) {
      case 'TOUCHDOWN':
        if (e.body === undefined || e.body === 'S1') {
          this.touchdownSeen = true;
          this.boosterOutcome = (String(e.data?.outcome ?? 'success') as BoosterOutcome) ?? 'success';
        }
        break;
      case 'SPLASHDOWN': if (e.body === 'S1') this.boosterOutcome = 'splashdown'; break;
      case 'RUD':
        if (e.body === 'S1' && this.boosterOutcome === null) this.boosterOutcome = 'rud';
        if (e.body === 'S2') this.s2Outcome = 'lost';
        break;
      case 'ORBIT': case 'SECO': if (this.s2Outcome === null) this.s2Outcome = 'orbit'; break;
      case 'PAYLOAD_DEPLOY': this.s2Outcome = 'deployed'; break;
      case 'FLAMEOUT': if (e.body === 'S2' && this.s2Outcome === null) this.s2Outcome = 'short'; break;
      case 'MISSION_END': this.missionEnded = true; break;
      case 'COUNTDOWN_HOLD':
        this.evHeld = true;
        if (e.data?.abort) this.aborted = true;
        break;
      case 'COUNTDOWN_RESUME': case 'LIFTOFF': case 'IGNITION_SEQUENCE': this.evHeld = false; this.aborted = false; break;
      case 'WARP_CHANGED':
        break;
    }
    if (!stale) this.captions.onEvent(e);
    if (e.type === 'MISSION_END' && !this.summaryAutoShown && !stale) {
      this.summaryAutoShown = true;
      setTimeout(() => { if (!this.ctx.photoMode && !this.ctx.replay) this.openSummary(); }, 2500);
    }
  }

  // ------------------------------------------------------------------ layout
  private layout(): void {
    const W = this.ctx.width || window.innerWidth, H = this.ctx.height || window.innerHeight;
    this.lastW = W; this.lastH = H;
    const z = clamp(Math.min(W / 1600, H / 900), 0.74, 1.5);
    this.root.style.setProperty('--z', z.toFixed(4));
    const dw = W / z; // design width
    const narrow = dw < 1000;
    const compact = !narrow && dw < 1260;
    toggleClass(this.root, 'narrow', narrow);
    toggleClass(this.root, 'compact', compact);
    const stageW = narrow ? 0 : compact ? 250 : 356;
    const tlW = clamp(dw - 2 * stageW - 40, 360, 780);
    this.timeline.layout(Math.round(tlW));
  }

  // ------------------------------------------------------------------ frame
  /** the sim rebuilt its state (backward seek, abort recycle): forget the previous outcome */
  private resetMission(): void {
    this.touchdownSeen = false;
    this.boosterOutcome = null;
    this.s2Outcome = null;
    this.missionEnded = false;
    this.summaryAutoShown = false;
    this.userWarp = 1;
    this.summary.open = false;
    this.captions.clear();
  }

  /** keep lower-third captions clear of picture-in-picture viewports in the bottom-left */
  private placeCaptions(views: ViewInfo[]): void {
    const W = this.ctx.width, H = this.ctx.height;
    const z = Number(this.root.style.getPropertyValue('--z')) || 1;
    let x = 40 * z;
    if (this.root.classList.contains('narrow')) x = -1; // CSS handles the narrow layout
    else for (const v of views) {
      const r = v.rect;
      if (v.alpha < 0.05 || r.w >= W * 0.45 || r.x > W * 0.3 || r.y + r.h < H * 0.35) continue;
      x = Math.max(x, r.x + r.w + 18 * z);
    }
    x = Math.round(x);
    if (x === this.capShift) return;
    this.capShift = x;
    const el = this.captions.el;
    if (x < 0) { el.style.left = el.style.maxWidth = ''; toggleClass(el, 'tight', false); return; }
    const shifted = x > 40 * z + 1;
    // lengths on the zoomed element are scaled by --z, so convert screen px back to design px
    el.style.left = `${(x / z).toFixed(1)}px`;
    el.style.maxWidth = shifted ? `${Math.max(240, Math.min(560, (W / 2 - 185 * z - x) / z)).toFixed(0)}px` : '';
    toggleClass(el, 'tight', shifted);
  }

  update(snap: SimSnapshot, views: ViewInfo[], dtReal: number): void {
    this.snap = snap;
    this.realNow += dtReal;
    if (this.ctx.width !== this.lastW || this.ctx.height !== this.lastH) this.layout();
    if (!this.ctx.replay && snap.t < this.lastT - 2) this.resetMission();
    if (!this.ctx.replay) this.lastT = snap.t;

    if (this.pending.length) {
      const evs = this.pending.splice(0);
      // seek bursts are flagged by the sim; MAX_Q is emitted ~10 s after its (back-dated) peak
      for (const e of evs) this.handleEvent(e, e.seeking === true || snap.t - e.t > 30 || this.ctx.replay);
    }
    this.updateWarpNotice(snap);

    const photo = this.ctx.photoMode;
    if (photo !== this.wasPhoto) {
      if (photo) { this.prevBias = this.ctx.lighting.exposureBias; this.photo.bias = this.prevBias; }
      else this.ctx.lighting.exposureBias = this.prevBias;
      this.wasPhoto = photo;
      if (photo) this.captions.clear();
    }
    toggleClass(this.root, 'is-photo', photo);
    toggleClass(this.root, 'is-replay', this.ctx.replay);
    if (photo) this.photo.update(views);

    const held = (snap.countdownHeld || this.evHeld) && snap.t < 0;
    const abortState = held && (this.aborted || snap.t >= IGNITION_TIME);
    const b = snap.bodies;
    const sep = b.S1.status !== 'stacked' || b.S2.status !== 'stacked';
    const fairingOn = b.FAIRING_A.status === 'stacked';
    const s1View: StageView = {
      title: 'STAGE 1',
      status: stageStatus(b.S1, snap, this.ctx.settings.manualLanding),
      body: b.S1,
      silhouette: sep ? 'booster' : fairingOn ? 'stack' : 'stackNoFairing',
      lost: b.S1.status === 'destroyed' || b.S1.status === 'gone',
    };
    const s2View: StageView = {
      title: 'STAGE 2',
      status: stageStatus(b.S2, snap, false),
      body: b.S2,
      silhouette: sep ? (fairingOn ? 's2' : 's2NoFairing') : fairingOn ? 'stack' : 'stackNoFairing',
      lost: b.S2.status === 'destroyed' || b.S2.status === 'gone',
    };
    if (!this.hidden) {
      this.s1.update(s1View, dtReal);
      this.s2.update(s2View, dtReal);
      let state = '', alert = false;
      if (abortState) { state = 'ABORT  ·  RECYCLING TO T−60'; alert = true; }
      else if (held) state = 'COUNTDOWN HOLD';
      else if (this.realNow < this.flashUntil) state = this.flashText;
      this.timeline.update(snap, { held: held && !abortState, alert, state, paused: snap.paused, warp: snap.warp });
      this.placeCaptions(views);
    }
    this.captions.update(dtReal, photo);

    // manual landing (input runs even with ?hud=0)
    this.manual.update(snap, this.ctx.settings.manualLanding && !this.ctx.replay && !photo, dtReal);
    toggleClass(this.root, 'is-manual', this.manual.isActive);

    // badges: replay > paused > hold
    let badge = '', sub = '', kind = '';
    if (this.ctx.replay) { badge = 'INSTANT REPLAY'; sub = 'SLOW MOTION  ·  R OR ESC TO EXIT'; kind = 'rec'; }
    else if (snap.paused && !photo) { badge = 'PAUSED'; sub = 'SPACE TO RESUME'; kind = 'pause'; }
    setText(this.badgeMain, badge);
    setText(this.badgeSub, sub);
    toggleClass(this.badge, 'show', !!badge);
    this.badge.dataset.kind = kind;

    const hm = this.holdMode();
    const cs: ControlState = {
      canLiftoff: snap.t < IGNITION_TIME && !this.ctx.replay && !abortState,
      held,
      holdLabel: hm === 'abort' ? 'ABORT' : hm === 'resume' || (held && !abortState) ? 'RESUME' : abortState ? 'RECYCLING' : 'HOLD',
      holdKind: hm === 'abort' || abortState ? 'danger' : held ? 'active' : '',
      canHold: hm !== 'none',
      canStageSep: this.stageSepAllowed() && !this.ctx.replay,
      canFairingSep: this.fairingSepAllowed() && !this.ctx.replay,
      paused: snap.paused,
      warp: snap.warp,
      warpAllowed: (w) => this.warpAllowed(w),
      canReplay: this.canReplay(),
      replaying: this.ctx.replay,
      summaryReady: this.summaryReady(),
      muted: this.ctx.settings.muted,
      audioUnlocked: this.audioUnlocked,
      manualLanding: this.ctx.settings.manualLanding,
      sooty: this.ctx.settings.sootyBooster,
    };
    this.controls.update(cs);
    toggleClass(this.sumPill, 'show', cs.summaryReady && !this.summary.open && !this.ctx.replay && !this.manual.isActive);
  }
}

function outcomeFromStatus(s1: BodyState): BoosterOutcome {
  switch (s1.status) {
    case 'landed': return 'success';
    case 'tipped': return 'tipped';
    case 'splashed': return 'splashdown';
    case 'destroyed': return 'rud';
    default: return null;
  }
}

function stageStatus(bd: BodyState, snap: SimSnapshot, manual: boolean): string {
  switch (bd.status) {
    case 'stacked': return '';
    case 'landed': return 'LANDED';
    case 'tipped': return 'TIPPED OVER';
    case 'splashed': return 'SPLASHDOWN';
    case 'destroyed': return 'SIGNAL LOST';
    case 'orbit': return 'ORBIT';
    case 'deployed': return 'PAYLOAD DEPLOYED';
    case 'gone': return '';
    case 'free': {
      if (bd.id === 'S1') {
        const p = S1_PHASE[bd.phase ?? ''] ?? '';
        return manual && (bd.phase === 'AERO' || bd.phase === 'LANDING_BURN') ? `${p}  ·  MANUAL` : p;
      }
      return bd.engines.some((e) => e.on) ? '' : 'COAST';
    }
  }
  return '';
}
