// SpaceX-webcast-style HUD, controls, captions, manual landing, summary, photo mode. OWNER: ui.
// Public API (used by App): new HUD(ctx, actions, domRoot); update(snap, views, dtReal).

import type { AppContext, ViewInfo } from '../core/context';
import type { BodyState, SimEvent, SimSnapshot } from '../core/types';
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
  LANDED: 'LANDED', LOST: 'SIGNAL LOST',
};

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

  constructor(private ctx: AppContext, private actions: AppActions, domRoot: HTMLElement) {
    const params = new URLSearchParams(location.search);
    this.hidden = params.get('hud') === '0';

    this.s1 = new StageTelemetry('left', 9, 10000, 150);
    this.s2 = new StageTelemetry('right', 1, 30000, 400);
    this.band = h('div', { class: 'band' },
      h('div', { class: 'band-bg' }),
      this.s1.el, this.timeline.el, this.s2.el);

    this.controls = new Controls(ctx, actions, {
      toggleHelp: () => this.setHelp(!this.help.open),
      openSummary: () => this.openSummary(),
      toggleReplay: () => this.toggleReplay(),
      toggleMute: () => this.toggleMute(),
      setWarp: (w) => this.setWarp(w),
    });
    this.manual = new ManualHud(actions);
    this.help = new HelpOverlay(() => this.setHelp(false));
    this.summary = new SummaryModal(actions, {
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

  private warpAllowed(w: number): boolean {
    const snap = this.snap;
    if (w <= 8) return true;
    if (!snap || snap.t < 0 || snap.countdownHeld) return false;
    if (this.manual.isActive) return false;
    // no coast warp during the powered ascent of the stack
    if (snap.bodies.S1.status === 'stacked' && snap.bodies.S1.engines.some((e) => e.on)) return false;
    let lead = Infinity;
    for (const m of snap.timeline) if (!m.done && m.t > snap.t) lead = Math.min(lead, m.t - snap.t);
    return lead > (w >= 100 ? 45 : 15);
  }

  private setWarp(w: number): void {
    if (!this.warpAllowed(w)) return;
    this.actions.setWarp(w);
  }

  private stepWarp(dir: 1 | -1): void {
    const cur = this.snap?.warp ?? 1;
    let i = WARP_LEVELS.findIndex((w) => w >= cur);
    if (i < 0) i = WARP_LEVELS.length - 1;
    if (dir < 0) { for (let j = i - 1; j >= 0; j--) if (WARP_LEVELS[j] < cur) return this.setWarp(WARP_LEVELS[j]); }
    else for (let j = i; j < WARP_LEVELS.length; j++) if (WARP_LEVELS[j] > cur && this.warpAllowed(WARP_LEVELS[j])) return this.actions.setWarp(WARP_LEVELS[j]);
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
    const useSim = simOutcome && simOutcome.toLowerCase() !== 'placeholder';
    const headline = useSim ? simOutcome.toUpperCase() : derived || 'MISSION IN PROGRESS';
    const bad = (b !== null && b !== 'success') || s2 === 'lost' || s2 === 'short';
    const clock = snap ? fmtClock(snap.t) : null;
    const sub = `${MISSION_NAME}  ·  SLC-4E VANDENBERG  ·  ${clock ? `${clock.sign} ${clock.body}` : ''}`;
    const lines = sum.lines.length ? sum.lines : this.fallbackLines();
    this.summary.show(headline, useSim && derived ? derived : sub, lines, this.canReplay(), bad);
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
      case 'KeyH': if ((this.snap?.t ?? 0) < IGNITION_TIME) a.toggleHold(); break;
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
      case 'COUNTDOWN_HOLD': this.evHeld = true; break;
      case 'COUNTDOWN_RESUME': case 'LIFTOFF': case 'IGNITION_SEQUENCE': this.evHeld = false; break;
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
  update(snap: SimSnapshot, views: ViewInfo[], dtReal: number): void {
    this.snap = snap;
    if (this.ctx.width !== this.lastW || this.ctx.height !== this.lastH) this.layout();

    if (this.pending.length) {
      const evs = this.pending.splice(0);
      for (const e of evs) this.handleEvent(e, snap.t - e.t > 5 || this.ctx.replay);
    }

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
      this.timeline.update(snap, { held, paused: snap.paused, warp: snap.warp });
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

    const cs: ControlState = {
      canLiftoff: snap.t < IGNITION_TIME && !this.ctx.replay,
      held,
      canHold: snap.t < IGNITION_TIME && !this.ctx.replay,
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
