// The aperture: the keyhole that opens the memory (the photo) onto its world.
//
// It is drawn, not clipped. Two SVG layers sit over the 3D canvas:
//   surface  the photo (and the blurred bars around it) with the keyhole cut out, the light the keyhole throws
//            on the photo around it, and inside the keyhole an opaque dark pane (over a tinted copy of the
//            photo) that stands in for the world until the world is ready;
//   rim      everything that glows or moves: the outline with its dot and glint, the traced outline, the halo,
//            two inner walls that shift against the rim as the camera swings (so the opening has depth), and a
//            light that runs round the rim once it is lit.
//
// States, in the order a visitor sees them:
//   rest     a world opened on its own (not played from a slide) starts with the photo whole and the keyhole at an
//            eighth of its size, sparkling so it is not missed. The world loads underneath. wake(), from a tap on the
//            keyhole, grows it to its full size; a keyhole played from a slide has been tapped already and starts so.
//   loading  the keyhole of the WOM logo, dark inside with a lit outline (keyhole-light.ts); two lights rise from
//            its base along both sides as the world arrives and meet at the top of its head; the label says how far.
//   ready    ignite(): the outline lights and its dot stops breathing, the pane dissolves into the live scene,
//            the surround darkens. (Once the keyhole is awake: a tap that came before the world was loaded waits for
//            the world, one that came after waits for the keyhole to grow.)
//   enter    expand(): the keyhole grows about its head, like an iris, until the world fills the screen.
//   return   contract(): the same, backwards.
//
// This module only draws. The viewer owns the camera and decides when the state changes.
import { h } from './dom.ts';
import { keyholeBox, keyholeCover, keyholeDot, keyholeHalves, keyholeHeart, keyholePath, restingKeyhole, type KeyholeGeo } from './keyhole.ts';
import { createKeyholeLight, KEYHOLE_LOOK } from './keyhole-light.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
let instances = 0;

export interface ApertureLayout {
  /** The stage, in px. */
  w: number;
  h: number;
  /** Where the photo sits in the stage; it overflows the stage when it fills the screen. */
  photo: { x: number; y: number; w: number; h: number };
}

export interface Aperture {
  el: HTMLElement;
  /** True when the visitor asked for less motion: no idle animation, quicker changes. */
  readonly calm: boolean;
  /**
   * The photo it opens. `immediate` shows the aperture at once instead of fading it in: for a slide that
   * arrives already showing the dormant opening (see slides/handoff.ts).
   */
  setPhoto(url: string, opts?: { immediate?: boolean }): void;
  /** The blurred copy of the photo that fills the bars around a photo shown whole. */
  setBackdrop(url: string): void;
  layout(l: ApertureLayout): void;
  /** Label without a percentage ("Opening the memory…"). */
  setStatus(text: string): void;
  /** Loading progress, 0..1, with the label to show beside the percentage. Never goes backwards. */
  setProgress(fraction: number, text: string): void;
  fail(message: string): void;
  /** Resolves once the light has traced the whole outline. Needs frame() to be called. */
  charged(): Promise<void>;
  /** 'asleep' at its resting size, waiting for a tap; 'waking' while it grows; 'awake' at its full size. */
  stage(): 'asleep' | 'waking' | 'awake';
  /** The visitor tapped the resting keyhole: it grows to its full size. Does nothing once it has. */
  wake(): void;
  /** Loading → ready. Waits for the keyhole to be awake and grown. */
  ignite(): void;
  /** Ready → open: the keyhole grows past the viewport. */
  expand(ms: number, done: () => void): void;
  /** Open → ready: the keyhole comes back. */
  contract(ms: number, done: () => void): void;
  /** Jump to the open state (the world fills the screen). */
  open(): void;
  /** How far the camera has swung sideways / up-down, each -1..1; shifts the opening's inner walls. */
  setParallax(x: number, y: number): void;
  frame(now: number): void;
}

// ---------- geometry ----------
// The keyhole's own shape is in keyhole.ts; this is where it sits and how deep its walls are.

/** How far the two inner walls sit behind the rim, in units of the keyhole's height. */
const WALL1 = 0.022, WALL2 = 0.04;
/** Largest sideways shift of the deeper wall, in units of the height. It stays smaller than the wall's depth. */
const WALL_SHIFT_X = 0.018, WALL_SHIFT_Y = 0.014;

/** Where the keyhole sits: `size` is its height, (cx, cy) the middle of that height. */
export type ApertureGeo = KeyholeGeo;
type Geo = ApertureGeo;

const f2 = (n: number) => n.toFixed(2);

/** Where the opening sits for a layout: in the middle of the visible part of the photo, a little above its middle. */
export function apertureGeometry(l: ApertureLayout): ApertureGeo {
  const vx = Math.max(0, l.photo.x), vy = Math.max(0, l.photo.y);
  const vw = Math.min(l.w, l.photo.x + l.photo.w) - vx, vh = Math.min(l.h, l.photo.y + l.photo.h) - vy;
  const size = Math.min(vh * 0.5, vw * 1.05);
  return { cx: vx + vw / 2, cy: vy + vh * 0.47, size };
}

// ---------- small helpers ----------

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** The opening grows slowly and rushes past the frame. */
const rush = (t: number) => t ** 1.7;
/** The opening returns fast and settles gently. */
const settle = (t: number) => 1 - (1 - t) ** 1.7;
/** 0 → 1 → 0, for flashes. */
const flash = (t: number) => Math.sin(Math.PI * t);

function node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: SVGElement[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  e.append(...kids);
  return e;
}

/** Set an attribute or style property only when it changed: most of the overlay is still on most frames. */
const written = new WeakMap<object, Map<string, string>>();
function changed(e: object, key: string, value: string | number) {
  const v = typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : value;
  let m = written.get(e);
  if (!m) written.set(e, (m = new Map()));
  if (m.get(key) === v) return null;
  m.set(key, v);
  return v;
}
function put(e: Element, name: string, value: string | number) {
  const v = changed(e, name, value);
  if (v !== null) e.setAttribute(name, v);
}
function css(e: HTMLElement | SVGElement, prop: string, value: string | number) {
  const v = changed(e, `css:${prop}`, value);
  if (v !== null) e.style.setProperty(prop, v);
}

// ---------- colours ----------

const INK = '#0a0807';
const GLOW = '#ffb858';
const RIM = '#ffe9c4';
const HOT = '#fff6e4';
/** The light that rises along the outline while loading: whiter than the outline's core, so it reads on it. */
const TRACE = '#ffffff';
const BAD = '#f08a7a';
/** How dark the tinted photo behind a dimmed plate is. */
const LIT = { tint: 0.42 } as const;
/** The outline once the opening is lit: the same amber line with a cream core as before it lit, so it carries on. */
const LINE = KEYHOLE_LOOK.line;
/** How dark the surround is once the aperture is lit, and while the world is still loading. */
const VEIL = 0.74, VEIL_LOADING = 0.32;

/** wake: 0 at the keyhole's resting size, 1 at its full size. */
type Field = 'charge' | 'lit' | 'photoIn' | 'veil' | 'grow' | 'bloom' | 'status' | 'cta' | 'lap' | 'wake';

/**
 * `asleep`: the keyhole rests at its small size until `wake()`; without it, it starts at its full size (it has been
 * tapped already, on a slide). `onLit` is called when the light actually comes on, which, for a keyhole woken after its
 * world has loaded, is later than `ignite()`.
 */
export function createAperture(opts: { onEnter: () => void; asleep?: boolean; onLit?: () => void }): Aperture {
  const uid = `wom-ap${++instances}`;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const speed = calm ? 0.45 : 1;
  const asleep = opts.asleep === true;
  const state: Record<Field, number> = { charge: 0, lit: 0, photoIn: 1, veil: 0, grow: 0, bloom: 0, status: asleep ? 0 : 1, cta: 0, lap: -1, wake: asleep ? 0 : 1 };
  /** Where the keyhole is at its full size; `geo` is where it is drawn now, which is smaller while it rests or wakes. */
  const full: Geo = { cx: 0, cy: 0, size: 0 };
  const geo: Geo = { cx: 0, cy: 0, size: 0 };
  /** The share of its full size the keyhole rests at, and the one it is drawn at now. */
  let restK = 1, drawnK = NaN;
  /** `tapped`: wake() was called. `grown`: it has finished growing. */
  let tapped = !asleep, grown = !asleep;
  let igniteQueued = false;
  let W = 0, H = 0;
  let logReach = 0;
  let halfLength = 0;
  let laidOut = false;
  let chargeTarget = 0;
  let failed = false;
  let label = 'Opening the memory…';
  let showPercent = false;
  let hoverTarget = 0, hover = 0;
  let lapLength = 0.2, lapPeak = 1;
  /** The lit outline's widths and its dot's radius at rest, px: those of the line before it lit (keyhole-light.ts). */
  let lineWidth = 2, coreWidth = 1, dotRest = 2;
  let nextGlint = Infinity;
  let wideFilters: boolean | null = null;
  let last = performance.now();
  const par = { x: 0, y: 0 };

  // ---------- surface: the photo with the keyhole cut out ----------
  const backdropImg = node('image', { preserveAspectRatio: 'xMidYMid slice' });
  const photoImg = node('image', { preserveAspectRatio: 'none' });
  const photoInImg = node('image', { preserveAspectRatio: 'none' });
  const veil = node('rect', { fill: INK, opacity: 0 });
  const tint = node('rect', { fill: INK, opacity: LIT.tint });
  const outsidePath = node('path', { 'clip-rule': 'evenodd' });
  const insidePath = node('path');
  // Before the world loads the keyhole is an opaque dark pane (inside) whose outline throws a glow on the photo
  // around it (outside) and onto the pane; see keyhole-light.ts. All of it fades with `photoIn` when the world is
  // ready, and the live scene shows through.
  const light = createKeyholeLight(uid);
  const plate = node('path', { fill: light.plateFill });
  const outside = node('g', { 'clip-path': `url(#${uid}-out)` }, backdropImg, photoImg, veil, light.glow);
  const inside = node('g', { 'clip-path': `url(#${uid}-in)` }, photoInImg, tint, plate, light.sheen);
  const surface = node('svg', { class: 'aperture-layer' },
    node('defs', {}, node('clipPath', { id: `${uid}-out` }, outsidePath), node('clipPath', { id: `${uid}-in` }, insidePath), ...light.defs),
    outside, inside);

  // ---------- rim: light, depth and motion ----------
  const glowBlur = node('feGaussianBlur', { stdDeviation: 9 });
  const softBlur = node('feGaussianBlur', { stdDeviation: 3 });
  const dotBlur = node('feGaussianBlur', { stdDeviation: 3 });
  const glowFilter = node('filter', { id: `${uid}-glow`, filterUnits: 'userSpaceOnUse' }, glowBlur);
  const softFilter = node('filter', { id: `${uid}-soft`, filterUnits: 'userSpaceOnUse' }, softBlur);
  const dotFilter = node('filter', { id: `${uid}-dot`, filterUnits: 'userSpaceOnUse' }, dotBlur);
  const bloomGrad = node('radialGradient', { id: `${uid}-bloom`, gradientUnits: 'userSpaceOnUse' },
    node('stop', { offset: 0, 'stop-color': '#ffe2aa', 'stop-opacity': 0.5 }),
    node('stop', { offset: 0.6, 'stop-color': '#ffc878', 'stop-opacity': 0.14 }),
    node('stop', { offset: 1, 'stop-color': '#ffc878', 'stop-opacity': 0 }));

  // Crisp corners: the outline is stroked with mitres. Open lights (the traces) end in round caps.
  const sharp = { fill: 'none', 'stroke-linejoin': 'miter', 'stroke-miterlimit': 6 } as const;
  const sharpRound = { ...sharp, 'stroke-linecap': 'round' } as const;
  const bloom = node('path', { fill: `url(#${uid}-bloom)`, opacity: 0 });
  const wallA = node('path', { fill: INK, 'fill-rule': 'evenodd', opacity: 0 });
  const wallB = node('path', { fill: INK, 'fill-rule': 'evenodd', opacity: 0 });
  const ring1 = node('path', { ...sharp, stroke: RIM, 'stroke-width': 1, opacity: 0 });
  const ring2 = node('path', { ...sharp, stroke: RIM, 'stroke-width': 1, opacity: 0 });
  // The halo and the trace rise along both sides from the base, so each is two paths of the same length.
  const halos = [0, 1].map(() => node('path', { ...sharpRound, stroke: GLOW, filter: `url(#${uid}-glow)`, pathLength: 1, opacity: 0 }));
  const rimEdge = node('path', { ...sharp, stroke: LINE.color, opacity: 0 });
  const rim = node('path', { ...sharp, stroke: LINE.core, opacity: 0 });
  // The dot under the keyhole, lit: the dormant dot at the top of its breath, held there (the world is ready).
  const dotGlow = node('circle', { fill: KEYHOLE_LOOK.glow.color, filter: `url(#${uid}-dot)`, opacity: 0 });
  const dot = node('circle', { fill: KEYHOLE_LOOK.dot.color, stroke: KEYHOLE_LOOK.dot.rim, opacity: 0 });
  const traces = [0, 1].map(() => node('path', { ...sharpRound, stroke: TRACE, 'stroke-width': 2.4, pathLength: 1, opacity: 0 }));
  const glint = node('path', { ...sharpRound, stroke: HOT, 'stroke-width': 3, pathLength: 1, opacity: 0 });
  const headGlows = [0, 1].map(() => node('circle', { r: 6, fill: '#ffcf8a', filter: `url(#${uid}-soft)`, opacity: 0 }));
  const headDots = [0, 1].map(() => node('circle', { r: 2.4, fill: HOT, opacity: 0 }));
  const hit = node('path', { class: 'aperture-hit', 'aria-hidden': 'true' });
  const rimLayer = node('svg', { class: 'aperture-layer' },
    node('defs', {}, glowFilter, softFilter, dotFilter, bloomGrad, ...light.lineDefs),
    bloom, wallA, wallB, ring1, ring2, ...halos, light.line, rimEdge, rim, dotGlow, dot, ...traces, glint, ...headGlows, ...headDots, hit);

  // ---------- label and button ----------
  const statusEl = h('div.aperture-status', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Loading the world' }, label);
  const cta = h('button.enter-world', { type: 'button' }, 'Enter the world');
  // The tap that wakes a resting keyhole: a button over it, wider than a finger, however small it rests.
  const wakeBtn = h('button.keyhole-wake', { type: 'button', 'aria-label': 'Open the keyhole' });
  const root = h('div.aperture', surface, rimLayer, statusEl, cta, wakeBtn);
  if (asleep) root.classList.add('asleep');

  cta.addEventListener('click', () => opts.onEnter());
  hit.addEventListener('click', () => opts.onEnter());
  wakeBtn.addEventListener('click', () => wake());
  for (const t of [hit, cta, wakeBtn]) {
    t.addEventListener('pointerenter', () => { hoverTarget = 1; });
    t.addEventListener('pointerleave', () => { hoverTarget = 0; });
  }

  // ---------- timeline ----------
  interface Tween { field: Field; from: number; to: number; at: number; ms: number; ease: (t: number) => number; started: boolean }
  const tweens: Tween[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const chargeWaiters: (() => void)[] = [];

  function go(field: Field, to: number, ms: number, o: { delay?: number; ease?: (t: number) => number } = {}) {
    const i = tweens.findIndex((t) => t.field === field);
    if (i >= 0) tweens.splice(i, 1);
    tweens.push({ field, from: state[field], to, at: performance.now() + (o.delay ?? 0) * speed, ms: Math.max(1, ms * speed), ease: o.ease ?? easeInOut, started: false });
  }
  function after(ms: number, fn: () => void) { timers.push({ at: performance.now() + ms * speed, fn }); }
  function halt(...fields: Field[]) {
    for (let i = tweens.length - 1; i >= 0; i--) if (fields.includes(tweens[i].field)) tweens.splice(i, 1);
  }

  function step(now: number) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const t = tweens[i];
      if (now < t.at) continue;
      if (!t.started) { t.from = state[t.field]; t.started = true; }
      const p = Math.min(1, (now - t.at) / t.ms);
      state[t.field] = t.from + (t.to - t.from) * t.ease(p);
      if (p >= 1) tweens.splice(i, 1);
    }
    for (let i = timers.length - 1; i >= 0; i--) {
      if (now < timers[i].at) continue;
      const [{ fn }] = timers.splice(i, 1);
      fn();
    }
  }

  // ---------- drawing ----------
  function setFilterRegions(wide: boolean) {
    if (wideFilters === wide) return;
    wideFilters = wide;
    const pad = 80;
    const box = keyholeBox(geo);
    const x = wide ? -60 : box.x - pad, y = wide ? -60 : box.y - pad;
    const w = wide ? W + 120 : box.width + 2 * pad, hh = wide ? H + 120 : box.height + 2 * pad;
    for (const fl of [glowFilter, softFilter, dotFilter]) {
      fl.setAttribute('x', f2(x)); fl.setAttribute('y', f2(y)); fl.setAttribute('width', f2(w)); fl.setAttribute('height', f2(hh));
    }
  }

  /** The label and the button: these need no geometry, so an early failure still shows. */
  function paintWords() {
    const pct = Math.round(state.charge * 100);
    const text = failed ? label : showPercent ? `${label} · ${pct}%` : label;
    if (statusEl.textContent !== text) statusEl.textContent = text;
    if (!failed && showPercent) statusEl.setAttribute('aria-valuenow', String(pct));
    css(statusEl, 'opacity', state.status);
    css(cta, 'opacity', state.cta);
  }

  function draw(now: number) {
    paintWords();
    if (!laidOut) return;
    // A resting keyhole grows from its small size to its full size about its middle, by the same factor each moment
    // (even to the eye). The pointer on it lifts it a little.
    const sizeK = restK ** (1 - state.wake) * (1 + 0.16 * hover * (1 - state.wake));
    if (sizeK !== drawnK) { drawnK = sizeK; geo.size = full.size * sizeK; fitGeo(); }
    const { lit, grow, charge } = state;
    const t = now / 1000;
    const breath = calm ? 1 : 0.88 + 0.12 * Math.sin((t * 2 * Math.PI) / 3.6);
    const scale = Math.exp(grow * logReach) * (1 + 0.02 * hover * lit * (1 - grow));
    const away = 1 - smooth(0.93, 1, grow);
    setFilterRegions(grow > 0.002);

    const rimD = keyholePath(geo, scale);
    const sx = par.x * WALL_SHIFT_X * geo.size, sy = par.y * WALL_SHIFT_Y * geo.size;
    const w1 = keyholePath(geo, scale, WALL1, sx, sy), w2 = keyholePath(geo, scale, WALL2, sx * 2, sy * 2);

    // The surface: the photo with the opening cut out; inside it the photo stands in for the world.
    put(outsidePath, 'd', `M0,0H${W}V${H}H0Z${rimD}`);
    put(insidePath, 'd', rimD);
    put(veil, 'opacity', state.veil);
    put(inside, 'opacity', state.photoIn);

    // Depth: two walls behind the rim, shifted by how far the camera has swung. They come with the light:
    // the plate that fills the opening while the world loads is flat.
    const depth = lit * (1 - grow) * away;
    put(wallA, 'd', rimD + w1);
    put(wallB, 'd', w1 + w2);
    put(wallA, 'opacity', 0.3 * depth);
    put(wallB, 'opacity', 0.24 * depth);
    put(ring1, 'd', w1);
    put(ring2, 'd', w2);
    put(ring1, 'opacity', 0.4 * lit * (1 - 0.5 * grow) * away);
    put(ring2, 'opacity', 0.24 * lit * (1 - 0.5 * grow) * away);

    // Light: the halo follows the traced part while loading and the whole outline once lit, and grows with it.
    const dash = clamp01(Math.max(charge, lit));
    const halves = keyholeHalves(geo, scale);
    halos.forEach((halo, i) => {
      put(halo, 'd', i ? halves.right : halves.left);
      put(halo, 'stroke-dasharray', dash >= 0.999 ? '1 1' : `${dash.toFixed(4)} 1`);
      put(halo, 'opacity', (0.36 * clamp01(charge * 8) * (1 - lit) + 0.8 * lit * breath) * away);
    });
    // The pane with the light on it: full strength while the world loads (the glow and the dot breathe, a glint
    // rises now and then), gone once it is ready. All of it follows the clock, as a slide's keyhole does
    // (slides/mark.ts), so the keyhole a slide flies up with is the one that carries on here. The glint gives way
    // to the trace as soon as the world starts to arrive.
    put(plate, 'd', rimD);
    put(plate, 'opacity', failed ? 0.28 : 1);
    const dormantLine = failed ? 0.5 : 1 - lit;
    // The sparkle goes as the keyhole grows: it is for a keyhole too small to be missed otherwise.
    const sparkle = failed ? 0 : (1 - smooth(0.12, 0.6, state.wake)) * (1 - lit);
    light.frame(t, failed ? 0 : state.photoIn, dormantLine, failed ? 0 : (1 - smooth(0, 0.06, charge)) * (1 - lit), sparkle);
    // Lit, the same line carries on here, where it can grow with the opening.
    const wider = smooth(0, 0.5, grow);
    for (const [p, width] of [[rimEdge, lineWidth + 1.6 * wider], [rim, coreWidth + 1.2 * wider]] as const) {
      put(p, 'd', rimD);
      put(p, 'opacity', lit * away);
      put(p, 'stroke-width', width);
    }
    // And its dot, steady now, travelling with the keyhole as it grows.
    const at = keyholeDot(geo, scale);
    const dotR = Math.max(LINE.minPx, at.r), k = dotR / dotRest;
    for (const c of [dot, dotGlow]) { put(c, 'cx', at.x); put(c, 'cy', at.y); }
    put(dot, 'r', dotR);
    put(dot, 'stroke-width', Math.min(0.5 * lineWidth, 0.4 * dotRest) * k);
    put(dotGlow, 'r', 1.3 * dotR);
    put(dotBlur, 'stdDeviation', 0.45 * dotR);
    put(dot, 'opacity', lit * away);
    put(dotGlow, 'opacity', lit * away);

    // The trace: charge, rising along both sides from the base to the top of the head.
    const charging = !failed && charge > 0.004 && charge < 0.999 && lit < 0.5 && halfLength > 0;
    traces.forEach((trace, i) => {
      put(trace, 'stroke', failed ? BAD : TRACE);
      put(trace, 'stroke-dasharray', charge >= 0.999 ? '1 1' : `${charge.toFixed(4)} 1`);
      put(trace, 'opacity', charge > 0.004 ? 1 - lit : 0);
      if (charging) {
        const p = trace.getPointAtLength(charge * halfLength);
        put(headGlows[i], 'cx', p.x); put(headGlows[i], 'cy', p.y); put(headDots[i], 'cx', p.x); put(headDots[i], 'cy', p.y);
      }
      put(headGlows[i], 'opacity', charging ? 0.85 : 0);
      put(headDots[i], 'opacity', charging ? 1 : 0);
    });

    // A bright stretch of light running round the outline: once on ignition, now and then when idle.
    if (!calm && lit > 0.99 && grow < 0.001 && state.lap < 0 && now >= nextGlint) {
      lapLength = 0.1; lapPeak = 0.75;
      state.lap = 0;
      go('lap', 1, 2400);
      after(2400, () => { state.lap = -1; nextGlint = performance.now() + 6500; });
    }
    if (state.lap >= 0) {
      put(glint, 'd', rimD);
      put(glint, 'stroke-dasharray', `${lapLength} ${1 - lapLength}`);
      put(glint, 'stroke-dashoffset', -state.lap);
      put(glint, 'opacity', lapPeak * Math.sin(Math.PI * clamp01(state.lap)) ** 0.5 * away);
    } else {
      put(glint, 'opacity', 0);
    }

    // The flash inside the opening when it lights.
    put(bloom, 'd', rimD);
    put(bloom, 'opacity', state.bloom);
  }

  // ---------- the public side ----------
  function layoutAll(l: ApertureLayout) {
    if (!l.w || !l.h) return;
    W = l.w; H = l.h;
    for (const s of [surface, rimLayer]) {
      s.setAttribute('width', String(W)); s.setAttribute('height', String(H)); s.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    for (const [k, v] of [['x', 0], ['y', 0], ['width', W], ['height', H]] as const) {
      backdropImg.setAttribute(k, String(v));
    }
    for (const img of [photoImg, photoInImg]) {
      img.setAttribute('x', String(l.photo.x)); img.setAttribute('y', String(l.photo.y));
      img.setAttribute('width', String(l.photo.w)); img.setAttribute('height', String(l.photo.h));
    }
    for (const r of [veil, tint]) { r.setAttribute('width', String(W)); r.setAttribute('height', String(H)); }
    // The opening sits on the visible part of the photo, at its full size. A resting keyhole is drawn smaller about the
    // same middle (`geo`), and grows into it.
    Object.assign(full, apertureGeometry(l));
    logReach = Math.log(keyholeCover(full, W, H));
    restK = full.size > 0 ? restingKeyhole(full).size / full.size : 1;
    drawnK = restK ** (1 - state.wake) * (1 + 0.16 * hover * (1 - state.wake));
    Object.assign(geo, full);
    geo.size = full.size * drawnK;
    fitGeo();
    laidOut = true;
  }

  /**
   * Everything that follows the size and place the keyhole is drawn at: the shapes the lights run along, the widths
   * of the lines, the blurs, the label under it and the button over it. Called again each frame it grows.
   */
  function fitGeo() {
    const rest = keyholePath(geo, 1);
    const halves = keyholeHalves(geo, 1);
    hit.setAttribute('d', rest);
    // A thin shape is hard to hit: the invisible stroke widens the button.
    hit.setAttribute('stroke-width', f2(0.1 * geo.size));
    [halves.left, halves.right].forEach((d, i) => traces[i].setAttribute('d', d));
    halfLength = traces[0].getTotalLength();
    light.fit(geo, 1);
    const eye = keyholeHeart(geo);
    bloomGrad.setAttribute('cx', f2(eye.x)); bloomGrad.setAttribute('cy', f2(eye.y)); bloomGrad.setAttribute('r', f2(geo.size * 0.5));
    for (const halo of halos) halo.setAttribute('stroke-width', f2(0.034 * geo.size));
    lineWidth = Math.max(LINE.minPx, LINE.width * geo.size);
    coreWidth = Math.max(0.55 * LINE.minPx, LINE.coreWidth * geo.size);
    dotRest = Math.max(LINE.minPx, keyholeDot(geo).r);
    // The light that rises while loading is a little wider than the line's core, so the core turns white behind it.
    // On a keyhole at rest these least sizes shrink with it, or the light would be bigger than the outline it runs on.
    const fine = Math.min(1, Math.max(0.45, geo.size / 160));
    for (const trace of traces) trace.setAttribute('stroke-width', f2(Math.max(2.4 * fine, coreWidth * 1.25)));
    for (const c of headDots) c.setAttribute('r', f2(Math.max(2.4 * fine, coreWidth * 0.9)));
    for (const c of headGlows) c.setAttribute('r', f2(Math.max(6 * fine, coreWidth * 2.4)));
    glint.setAttribute('stroke-width', f2(Math.max(3 * fine, coreWidth * 1.3)));
    glowBlur.setAttribute('stdDeviation', f2(0.02 * geo.size));
    softBlur.setAttribute('stdDeviation', f2(Math.max(2.5 * fine, 0.007 * geo.size)));
    // Under the keyhole's dot.
    const labelTop = `${f2(geo.cy + geo.size * 0.69)}px`;
    statusEl.style.top = labelTop; statusEl.style.bottom = 'auto';
    cta.style.top = labelTop;
    // The tap on a resting keyhole: a disc over it and its dot.
    if (!tapped) {
      const box = keyholeBox(geo);
      const d = Math.max(56, 1.2 * box.height);
      Object.assign(wakeBtn.style, { left: `${f2(box.x + box.width / 2)}px`, top: `${f2(box.y + box.height / 2)}px`, width: `${f2(d)}px`, height: `${f2(d)}px` });
    }
    wideFilters = null;
  }

  function setOpenState() {
    tweens.length = 0;
    timers.length = 0;
    Object.assign(state, { charge: 1, lit: 1, photoIn: 0, veil: 0, grow: 1, bloom: 0, status: 0, cta: 0, lap: -1, wake: 1 });
    chargeTarget = 1;
    tapped = grown = true;
    igniteQueued = false;
    root.classList.remove('ready', 'asleep');
  }

  /** The visitor tapped the resting keyhole: it grows to its full size, and the world's light waits for it. */
  function wake() {
    if (tapped) return;
    tapped = true;
    root.classList.remove('asleep');
    hoverTarget = 0;
    go('wake', 1, 1000, { ease: easeInOut });
    // The label comes back as the keyhole nears its size, unless the light is about to come on.
    if (!igniteQueued) go('status', 1, 420, { delay: 560 });
    after(1000, () => {
      grown = true;
      if (igniteQueued) { igniteQueued = false; startIgnite(); }
    });
  }

  function startIgnite() {
    root.classList.add('ready');
    showPercent = false;
    lapLength = 0.22; lapPeak = 1;
    state.lap = 0;
    go('lap', 1, 1000);
    after(1000, () => { state.lap = -1; nextGlint = performance.now() + 4200; });
    go('lit', 1, 700, { ease: easeOut });
    go('veil', VEIL, 900, { delay: 100 });
    go('photoIn', 0, 650, { delay: 180 });
    go('bloom', 1, 950, { delay: 140, ease: flash });
    go('status', 0, 280);
    go('cta', 1, 520, { delay: 650 });
    cta.focus({ preventScroll: true });
    opts.onLit?.();
  }

  return {
    el: root,
    calm,
    setPhoto(url, o = {}) {
      photoImg.setAttribute('href', url);
      photoInImg.setAttribute('href', url);
      if (o.immediate) root.classList.add('instant');
      root.classList.add('has-photo');
    },
    setBackdrop(url) { backdropImg.setAttribute('href', url); },
    layout: layoutAll,
    setStatus(text) { label = text; showPercent = false; },
    setProgress(fraction, text) {
      label = text; showPercent = true;
      chargeTarget = Math.max(chargeTarget, clamp01(fraction));
    },
    fail(message) {
      failed = true; label = message; showPercent = false;
      root.classList.add('failed');
      // The message has to be read: a resting keyhole opens for it.
      wake();
      go('status', 1, 300);
    },
    charged() {
      if (state.charge >= 0.999) return Promise.resolve();
      return new Promise<void>((resolve) => { chargeWaiters.push(resolve); });
    },
    stage: () => (!tapped ? 'asleep' : grown ? 'awake' : 'waking'),
    wake,
    ignite() {
      // A keyhole that has not been tapped, or is still growing, lights as soon as it has grown.
      if (!grown) { igniteQueued = true; return; }
      startIgnite();
    },
    expand(ms, done) {
      // Whatever it was doing, it opens from its full size.
      halt('wake');
      state.wake = 1;
      tapped = grown = true;
      igniteQueued = false;
      root.classList.remove('ready', 'asleep');
      hoverTarget = 0;
      halt('lap');
      state.lap = -1;
      go('grow', 1, ms, { ease: rush });
      go('lit', 1, 150);
      go('photoIn', 0, 150);
      go('veil', 0, ms * 0.65, { delay: ms * 0.3 });
      go('bloom', 0.5, ms * 0.5, { ease: flash });
      go('status', 0, 200);
      go('cta', 0, 220);
      after(ms, done);
    },
    contract(ms, done) {
      setOpenState();
      go('grow', 0, ms, { ease: settle });
      go('veil', VEIL, ms * 0.6, { delay: ms * 0.2 });
      go('cta', 1, ms * 0.35, { delay: ms * 0.65 });
      after(ms, () => {
        root.classList.add('ready');
        nextGlint = performance.now() + 3500;
        done();
        cta.focus({ preventScroll: true });
      });
    },
    open: setOpenState,
    setParallax(x, y) { par.x = calm ? 0 : x; par.y = calm ? 0 : y; },
    frame(now) {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      step(now);
      // The trace chases the real progress: smoothly, and never slower than a sweep of about two seconds.
      const diff = chargeTarget - state.charge;
      if (diff > 0 && !failed) state.charge = Math.min(chargeTarget, state.charge + Math.max(diff * (1 - Math.exp(-4 * dt)), Math.min(diff, 0.45 * dt)));
      // The surround darkens as the world arrives, once the keyhole has been tapped: a resting keyhole leaves the photo as it is.
      if (state.lit < 0.01 && state.grow === 0) state.veil = VEIL_LOADING * smooth(0, 1, state.charge) * smooth(0.3, 1, state.wake);
      hover += (hoverTarget - hover) * (1 - Math.exp(-9 * dt));
      draw(now);
      if (state.charge >= 0.999) while (chargeWaiters.length) chargeWaiters.pop()?.();
    },
  };
}
