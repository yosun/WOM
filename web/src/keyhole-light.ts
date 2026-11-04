// The keyhole before its world has loaded (the dormant look), drawn like the keyhole in the WOM logo: what a slide's
// keyhole and the viewer's aperture show while there is nothing to see through it yet.
//
//   plate  the inside of the keyhole: an opaque, dark pane;
//   glow   the light the outline throws, out onto the picture round it and in onto the pane; it breathes slowly;
//   line   the outline: an amber line with a cream core, like a lit filament;
//   dot    the dot under the keyhole: a status light that breathes with the glow;
//   glint  every few seconds a light rises from the middle of the base up both sides and meets at the top;
//   sparkle  while the keyhole is small (at rest, before it is tapped) a few thin stars of light catch on its outline
//          one after another, so an eighth of its size is still not missed.
//
// One hue and slow motion, so it reads as precise, calm technology.
//
// Everything is a function of the clock (performance.now) and the keyhole, never of when it was drawn or by whom.
// The mark on a slide (slides/mark.ts), on the slide's cover and in the viewer (aperture.ts) show the same moment,
// so a slide that flies into the viewer keeps the light it had and nothing jumps. With reduced motion the light
// holds still: no glint and no breath.
import { keyholeBox, keyholeDot, keyholeHalves, keyholeHeart, keyholePath, type KeyholeGeo } from './keyhole.ts';

const NS = 'http://www.w3.org/2000/svg';

/** How the dormant keyhole looks. Lengths marked "heights" are fractions of the keyhole's height. */
export const KEYHOLE_LOOK = {
  /** The pane inside the keyhole: its colours from the middle of the head outward, and how far (heights) they reach. */
  plate: { reach: 0.8, stops: [{ at: 0, color: '#0b0708' }, { at: 1, color: '#170d0a' }] },
  /** The outline: an amber line with a cream core (heights), never thinner on screen than `minPx`. */
  line: { color: '#ff9c2a', width: 0.016, core: '#fff5df', coreWidth: 0.0098, minPx: 1.4 },
  /** The light the outline throws: close and soft outside, and inward onto the pane. `blur` and `width` in heights. */
  glow: {
    color: '#ff9a2e',
    tight: { blur: 0.007, width: 0.024, alpha: 0.8 },
    wide: { blur: 0.038, width: 0.032, alpha: 0.42 },
    inner: { blur: 0.024, width: 0.034, alpha: 0.6 },
  },
  /**
   * The dot: cream with an amber rim, in a dark socket `socket` times its radius. At the bottom of a breath the dot
   * is lit `low` and its glow `glowLow` (0..1), so it dims to amber and never to grey.
   */
  dot: { color: '#fff5df', rim: '#ff9c2a', socket: 1.6, low: 0.55, glowLow: 0.4 },
  /** The glint: how often (s), how long one rise takes (s), its tail (a share of a side), its width (× the core), how bright. */
  glint: { color: '#ffffff', glow: '#ffc46b', every: 6.8, lasts: 2.6, tail: 0.22, width: 1.5, alpha: 0.95 },
  /** How far the glow dims between breaths (0..1), and the length of a breath (s). */
  breath: { depth: 0.22, period: 5.6 },
  /**
   * The least the glow is on screen, px. A keyhole at rest is a few dozen px tall, and by its height alone its
   * glow would be thinner than its own line.
   */
  glowMin: { tight: { blur: 0.8, width: 1.6 }, wide: { blur: 3.2, width: 2.4 }, inner: { blur: 1.6, width: 2.2 } },
  /**
   * The sparkle of a keyhole at rest. Each star catches at (x, y) from the keyhole's middle and reaches `reach` at its
   * brightest (heights; never under `minReach` px), comes every `every` s, is lit for `show` of that, and starts `at`
   * (0..1) of the way into it. With reduced motion the stars hold still, at `still` (0 leaves a star out).
   */
  sparkle: {
    color: '#fffaf0',
    glow: '#ffbd66',
    minReach: 10,
    /** A star's arms run this many times as far across as up: a glint on glass is wider than it is tall. */
    wide: 1.5,
    /**
     * The lantern: a soft light round the whole keyhole, `reach` heights out (never under `minReach` px), at most
     * `alpha` bright, swelling and ebbing every `every` s. It is what keeps the keyhole seen between the stars.
     */
    halo: { reach: 1.05, minReach: 20, alpha: 0.5, every: 2.8, low: 0.55, color: '#ffb25a' },
    stars: [
      { x: 0.15, y: -0.455, reach: 0.9, every: 2.1, show: 0.5, at: 0, still: 0.85 },
      { x: 0, y: 0.605, reach: 0.66, every: 2.1, show: 0.46, at: 0.36, still: 0.7 },
      { x: -0.19, y: 0.5, reach: 0.7, every: 2.1, show: 0.46, at: 0.68, still: 0 },
      { x: -0.17, y: -0.38, reach: 0.46, every: 2.1, show: 0.4, at: 0.17, still: 0 },
    ],
  },
} as const;

export type KeyholeLook = typeof KEYHOLE_LOOK;

export interface KeyholeLight {
  /** Gradients, filters and a clip for `glow` and `sheen`; put them in the `<defs>` of the SVG that holds those. */
  defs: SVGElement[];
  /** The filters `line` needs; put them in the `<defs>` of the SVG that holds `line`. */
  lineDefs: SVGElement[];
  /** What the plate is filled with. */
  plateFill: string;
  /** Behind the plate: the light the outline throws on the picture round it. */
  glow: SVGGElement;
  /** Over the plate: the light the outline throws inward, held inside the keyhole. */
  sheen: SVGGElement;
  /** Over everything: the outline, the dot and the glint. */
  line: SVGGElement;
  /** Lay the light out for a keyhole at `geo`; `px` is how many screen px one unit of the drawing is. */
  fit(geo: KeyholeGeo, px: number): void;
  /**
   * Show the light at time `t` (seconds). Each amount is 0..1: how much of the plate's light shows (the glow
   * outside and in), of the outline and its dot, of the glint on it, and of the sparkle round it (a keyhole at rest).
   */
  frame(t: number, plate: number, line: number, glint: number, sparkle?: number): void;
}

function node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: SVGElement[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  e.append(...kids);
  return e;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const f2 = (n: number) => n.toFixed(2);
const f3 = (n: number) => n.toFixed(3);

/** Layers in the glint's tail on each side: each a short stretch a little fainter than the one before. */
const CORE_STEPS = 7, GLOW_STEPS = 3;

export function createKeyholeLight(id: string, look: KeyholeLook = KEYHOLE_LOOK): KeyholeLight {
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let size = 0;
  let fitted = false;
  let plateShown = false, lineShown = false, glintShown = false, sparkleShown = false;

  // ---------- plate ----------
  const plateGrad = node('radialGradient', { id: `${id}-plate`, gradientUnits: 'userSpaceOnUse' },
    ...look.plate.stops.map((s) => node('stop', { offset: s.at, 'stop-color': s.color })));

  // ---------- glow: the outline blurred, outside (behind the plate) and inside (over it, clipped to the keyhole) ----------
  const glowStroke = { fill: 'none', stroke: look.glow.color, 'stroke-linejoin': 'round' } as const;
  const blurFilter = (name: string) => {
    const blur = node('feGaussianBlur', { stdDeviation: 1 });
    return { blur, filter: node('filter', { id: `${id}-${name}`, filterUnits: 'userSpaceOnUse' }, blur) };
  };
  const wideF = blurFilter('glow-wide'), tightF = blurFilter('glow-tight'), innerF = blurFilter('glow-in');
  const wide = node('path', { ...glowStroke, opacity: look.glow.wide.alpha });
  const tight = node('path', { ...glowStroke, opacity: look.glow.tight.alpha });
  const inner = node('path', { ...glowStroke, opacity: look.glow.inner.alpha });
  const glow = node('g', { 'pointer-events': 'none', display: 'none' },
    node('g', { filter: `url(#${id}-glow-wide)` }, wide), node('g', { filter: `url(#${id}-glow-tight)` }, tight));
  const clipShape = node('path');
  const clip = node('clipPath', { id: `${id}-hold` }, clipShape);
  const sheen = node('g', { 'clip-path': `url(#${id}-hold)`, 'pointer-events': 'none', display: 'none' },
    node('g', { filter: `url(#${id}-glow-in)` }, inner));

  // ---------- line: the outline, the dot, and the glint that rises along both sides ----------
  const miter = { fill: 'none', 'stroke-linejoin': 'miter', 'stroke-miterlimit': 6 } as const;
  const hair = node('path', { ...miter, stroke: look.line.color });
  const core = node('path', { ...miter, stroke: look.line.core });
  // The dot sits in a small dark socket, the keyhole's own dark, so it reads on a pale picture as on the logo.
  const dotF = blurFilter('dot');
  const dotSocket = node('circle', { fill: look.plate.stops[0].color });
  const dotGlow = node('circle', { fill: look.glow.color, filter: `url(#${id}-dot)` });
  const dotDisk = node('circle', { fill: look.dot.color, stroke: look.dot.rim });
  const dot = node('g', {}, dotSocket, dotGlow, dotDisk);
  const glintF = blurFilter('glint');
  // Butt ends: the stretches of the tail overlap a little, and round ends would bead where they do.
  const open = { fill: 'none', 'stroke-linejoin': 'round', pathLength: 1, opacity: 0 } as const;
  const tail = (n: number, stroke: string) => Array.from({ length: 2 * n }, () => node('path', { ...open, stroke }));
  const glintGlow = tail(GLOW_STEPS, look.glint.glow);
  const glintCore = tail(CORE_STEPS, look.glint.color);
  const glintLayer = node('g', { display: 'none' }, node('g', { filter: `url(#${id}-glint)` }, ...glintGlow), ...glintCore);

  // ---------- sparkle: thin four-pointed stars that catch on the outline of a keyhole at rest ----------
  // A star is a pinched cross (arms of length 1, a waist of 0.09), a soft halo behind it and a smaller cross turned a
  // quarter-way round. Gradients, not filters: a few circles are all the halos need.
  const sp = look.sparkle;
  const sparkGrad = node('radialGradient', { id: `${id}-spark` },
    node('stop', { offset: 0, 'stop-color': '#fff7e6', 'stop-opacity': 1 }),
    node('stop', { offset: 0.2, 'stop-color': sp.glow, 'stop-opacity': 0.6 }),
    node('stop', { offset: 1, 'stop-color': sp.glow, 'stop-opacity': 0 }));
  // The lantern sits in `glow`, behind the plate, so the pane stays dark and the light falls on the picture round it.
  const haloGrad = node('radialGradient', { id: `${id}-halo` },
    node('stop', { offset: 0, 'stop-color': sp.halo.color, 'stop-opacity': 0.95 }),
    node('stop', { offset: 0.35, 'stop-color': sp.halo.color, 'stop-opacity': 0.42 }),
    node('stop', { offset: 1, 'stop-color': sp.halo.color, 'stop-opacity': 0 }));
  const halo = node('circle', { fill: `url(#${id}-halo)`, opacity: 0 });
  glow.append(halo);
  const STAR = 'M0,-1Q0.015,-0.12 0.09,-0.09Q0.12,-0.015 1,0Q0.12,0.015 0.09,0.09Q0.015,0.12 0,1Q-0.015,0.12 -0.09,0.09Q-0.12,0.015 -1,0Q-0.12,-0.015 -0.09,-0.09Q-0.015,-0.12 0,-1Z';
  const stars = sp.stars.map(() => ({
    halo: node('circle', { fill: `url(#${id}-spark)`, opacity: 0 }),
    major: node('path', { d: STAR, fill: sp.color, opacity: 0 }),
    minor: node('path', { d: STAR, fill: sp.color, opacity: 0 }),
    x: 0,
    y: 0,
    reach: 0,
    on: false,
  }));
  const sparkleLayer = node('g', { display: 'none' }, ...stars.flatMap((s) => [s.halo, s.major, s.minor]));
  const line = node('g', { 'pointer-events': 'none', display: 'none' }, hair, core, glintLayer, dot, sparkleLayer);

  const defs: SVGElement[] = [plateGrad, wideF.filter, tightF.filter, innerF.filter, clip, haloGrad];
  const lineDefs: SVGElement[] = [dotF.filter, glintF.filter, sparkGrad];

  /** How lit the glow is at `t`: 1 at the top of a breath, 1 - depth at the bottom. */
  const breath = (t: number) => (calm ? 1 : 1 - (look.breath.depth * (1 - Math.cos((t * 2 * Math.PI) / look.breath.period))) / 2);
  const show = (g: SVGElement, on: boolean) => g.setAttribute('display', on ? 'inline' : 'none');
  /** Set a filter's region to a box grown by `room` on every side. */
  const region = (f: SVGFilterElement, box: { x: number; y: number; width: number; height: number }, room: number) => {
    f.setAttribute('x', f2(box.x - room)); f.setAttribute('y', f2(box.y - room));
    f.setAttribute('width', f2(box.width + 2 * room)); f.setAttribute('height', f2(box.height + 2 * room));
  };

  return {
    defs,
    lineDefs,
    plateFill: `url(#${id}-plate)`,
    glow,
    sheen,
    line,

    fit(g, pxPerUnit) {
      const px = Math.max(0.02, pxPerUnit);
      const s = (size = g.size);
      const d = keyholePath(g);
      for (const p of [wide, tight, inner, hair, core, clipShape]) p.setAttribute('d', d);
      const halves = keyholeHalves(g);
      [glintGlow, glintCore].forEach((paths) => paths.forEach((p, i) => p.setAttribute('d', i % 2 ? halves.right : halves.left)));
      const eye = keyholeHeart(g);
      plateGrad.setAttribute('cx', f2(eye.x)); plateGrad.setAttribute('cy', f2(eye.y)); plateGrad.setAttribute('r', f2(look.plate.reach * s));

      // The glow in drawing units: by the keyhole's height, but never thinner on screen than `glowMin`.
      const gl = look.glow, gm = look.glowMin;
      const glowOf = (k: 'wide' | 'tight' | 'inner') => ({ blur: Math.max(gl[k].blur * s, gm[k].blur / px), width: Math.max(gl[k].width * s, gm[k].width / px) });
      const gWide = glowOf('wide'), gTight = glowOf('tight'), gInner = glowOf('inner');
      wide.setAttribute('stroke-width', f2(gWide.width));
      tight.setAttribute('stroke-width', f2(gTight.width));
      inner.setAttribute('stroke-width', f2(gInner.width));
      wideF.blur.setAttribute('stdDeviation', f2(gWide.blur));
      tightF.blur.setAttribute('stdDeviation', f2(gTight.blur));
      innerF.blur.setAttribute('stdDeviation', f2(gInner.blur));

      const lineW = Math.max(look.line.minPx / px, look.line.width * s);
      const coreW = Math.max((0.55 * look.line.minPx) / px, look.line.coreWidth * s);
      hair.setAttribute('stroke-width', f3(lineW));
      core.setAttribute('stroke-width', f3(coreW));
      const glintW = coreW * look.glint.width;
      for (const p of glintCore) p.setAttribute('stroke-width', f3(glintW));
      for (const p of glintGlow) p.setAttribute('stroke-width', f3(glintW * 3));
      const glintBlur = Math.max(1 / px, 1.2 * glintW);
      glintF.blur.setAttribute('stdDeviation', f2(glintBlur));

      const dt = keyholeDot(g);
      const dotR = Math.max(look.line.minPx / px, dt.r);
      for (const c of [dotSocket, dotGlow, dotDisk]) { c.setAttribute('cx', f2(dt.x)); c.setAttribute('cy', f2(dt.y)); }
      dotDisk.setAttribute('r', f2(dotR));
      dotDisk.setAttribute('stroke-width', f3(Math.min(lineW * 0.5, dotR * 0.4)));
      dotSocket.setAttribute('r', f2(dotR * look.dot.socket));
      dotGlow.setAttribute('r', f2(dotR * 1.3));
      dotF.blur.setAttribute('stdDeviation', f2(dotR * 0.45));

      // Room for the blurs round the keyhole and its dot.
      const box = keyholeBox(g);
      region(wideF.filter, box, gWide.blur * 3.4 + gWide.width + 4);
      region(tightF.filter, box, gTight.blur * 3.4 + gTight.width + 4);
      region(innerF.filter, box, 4);
      region(glintF.filter, box, 3.4 * glintBlur + 2 * glintW + 2);
      region(dotF.filter, { x: dt.x - dotR, y: dt.y - dotR, width: 2 * dotR, height: 2 * dotR }, dotR * 1.8 + 2);

      // Where the stars catch, and how far they reach: by the keyhole's height, never under `minReach` px.
      stars.forEach((star, i) => {
        const def = sp.stars[i];
        star.x = g.cx + def.x * s;
        star.y = g.cy + def.y * s;
        star.reach = Math.max(sp.minReach / px, def.reach * s);
      });
      // The lantern is centred on the keyhole and its dot.
      halo.setAttribute('cx', f2(box.x + box.width / 2)); halo.setAttribute('cy', f2(box.y + box.height / 2));
      halo.setAttribute('r', f2(Math.max(sp.halo.minReach / px, sp.halo.reach * s)));
      fitted = s > 0;
    },

    frame(t, plate, lineAmount, glintAmount, sparkleAmount = 0) {
      if (!fitted) return;
      const b = breath(t);
      const showPlate = plate > 0.004;
      if (showPlate !== plateShown) { plateShown = showPlate; show(glow, showPlate); show(sheen, showPlate); }
      if (showPlate) {
        glow.setAttribute('opacity', f3(plate * b));
        sheen.setAttribute('opacity', f3(plate * b));
      }

      const showLine = lineAmount > 0.004;
      if (showLine !== lineShown) { lineShown = showLine; show(line, showLine); }
      if (showLine) {
        line.setAttribute('opacity', f3(lineAmount));
        hair.setAttribute('opacity', f3(0.86 + 0.14 * b));
        // The dot breathes deeper than the glow, like a standby light.
        const depth = look.breath.depth;
        const lift = calm ? 1 : (b - (1 - depth)) / depth;
        dotDisk.setAttribute('opacity', f3(look.dot.low + (1 - look.dot.low) * lift));
        dotGlow.setAttribute('opacity', f3(look.dot.glowLow + (1 - look.dot.glowLow) * lift));
      }

      // The glint: every so often it rises from the middle of the base up both sides and meets at the top.
      const gl = look.glint;
      const cycle = t / gl.every;
      const u = ((cycle - Math.floor(cycle)) * gl.every) / gl.lasts;
      const showGlint = showLine && !calm && glintAmount > 0.004 && u < 1 && size > 0;
      if (showGlint !== glintShown) { glintShown = showGlint; show(glintLayer, showGlint); }
      if (showGlint) {
        const fade = glintAmount * smooth(0, 0.12, u) * (1 - smooth(0.78, 1, u));
        const head = easeInOut(u) * (1 + gl.tail);
        const tailOf = (paths: SVGPathElement[], steps: number, weight: number) => {
          const step = gl.tail / steps;
          for (let i = 0; i < steps; i++) {
            const start = head - (i + 1) * step;
            const alpha = f3(gl.alpha * weight * fade * (1 - i / steps) ** 1.6);
            for (const p of [paths[2 * i], paths[2 * i + 1]]) {
              p.setAttribute('stroke-dasharray', `${(step * 1.04).toFixed(4)} 3`);
              p.setAttribute('stroke-dashoffset', (-start).toFixed(4));
              p.setAttribute('opacity', alpha);
            }
          }
        };
        tailOf(glintGlow, GLOW_STEPS, 0.55);
        tailOf(glintCore, CORE_STEPS, 1);
      }

      // The sparkle: a lantern's light swells and ebbs round the keyhole, and each star swells and fades in turn, a
      // short flash of light on the outline.
      const showSparkle = showLine && sparkleAmount > 0.004;
      if (showSparkle !== sparkleShown) { sparkleShown = showSparkle; show(sparkleLayer, showSparkle); }
      const swell = calm ? 0.8 : sp.halo.low + (1 - sp.halo.low) * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / sp.halo.every));
      halo.setAttribute('opacity', showSparkle ? f3(sparkleAmount * sp.halo.alpha * swell) : '0');
      if (showSparkle) {
        stars.forEach((star, i) => {
          const def = sp.stars[i];
          const cycle = t / def.every + def.at;
          const u = (cycle - Math.floor(cycle)) / def.show;
          const k = sparkleAmount * (calm ? def.still : u < 1 ? Math.sin(Math.PI * u) ** 1.5 : 0);
          if (k < 0.004) {
            if (star.on) { star.on = false; for (const e of [star.halo, star.major, star.minor]) e.setAttribute('opacity', '0'); }
            return;
          }
          star.on = true;
          const r = star.reach * k ** 0.7;
          const at = `translate(${f2(star.x)} ${f2(star.y)})`;
          star.halo.setAttribute('cx', f2(star.x)); star.halo.setAttribute('cy', f2(star.y));
          star.halo.setAttribute('r', f2(0.7 * r)); star.halo.setAttribute('opacity', f3(0.9 * k));
          star.major.setAttribute('transform', `${at} scale(${f3(r * sp.wide)} ${f3(r)})`); star.major.setAttribute('opacity', f3(Math.min(1, 1.25 * k)));
          star.minor.setAttribute('transform', `${at} rotate(45) scale(${f3(0.5 * r)})`); star.minor.setAttribute('opacity', f3(0.8 * k));
        });
      }
    },
  };
}
