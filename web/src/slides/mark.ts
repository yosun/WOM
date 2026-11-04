// The keyhole mark on a slide: the same dormant keyhole (keyhole.ts) the viewer shows while its world loads.
// As on the WOM logo it is a dark pane with a lit amber outline and a dot under it; the glow and the dot breathe, and
// now and then a glint rises along the outline (keyhole-light.ts). On a slide in a row it rests at an eighth of its
// size and sparkles, so it is not missed; it is a button on the front slide. When that slide flies up it grows to its
// full size, and this drawing becomes the keyhole in the viewer without a jump.
//
// The light follows the clock, so a mark animates by itself for as long as it is on the page and showing. The
// viewer's aperture draws the same moment of the same clock.
import type { ApertureGeo } from '../aperture.ts';
import { keyholeBox, keyholePath } from '../keyhole.ts';
import { createKeyholeLight } from '../keyhole-light.ts';

const NS = 'http://www.w3.org/2000/svg';
let marks = 0;

/** The least the keyhole's button is across on screen, px: a keyhole at rest is far smaller than a finger. */
const HIT_MIN = 56;

export interface MarkLook {
  /** 0..1: how much of the mark shows. 0 hides it; a slide coming back into its row fades it in. */
  glow: number;
  /** Screen pixels per unit of the mark, so the keyhole line keeps its width however large the slide is drawn. */
  px: number;
  /** 0..1: how much the keyhole sparkles (keyhole-light.ts). A keyhole at rest does; one grown to full size does not. Default 0. */
  sparkle?: number;
}

export interface KeyholeMark {
  svg: SVGSVGElement;
  set(geo: ApertureGeo, look: MarkLook): void;
}

function node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...kids: SVGElement[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  e.append(...kids);
  return e;
}

// ---------- one clock for every mark that is showing ----------

interface Live { svg: SVGSVGElement; showing: () => boolean; render: (t: number) => void }
const live = new Set<Live>();
let loop = 0;

function run() {
  loop = 0;
  const t = performance.now() / 1000;
  for (const m of live) {
    if (!m.svg.isConnected) live.delete(m);
    else if (m.showing()) m.render(t);
  }
  if (live.size) loop = requestAnimationFrame(run);
}

function keepRunning(m: Live) {
  live.add(m);
  if (!loop) loop = requestAnimationFrame(run);
}

/** A keyhole mark on a `w` × `h` surface. With `onPlay`, the keyhole is a button. */
export function createKeyholeMark(w: number, h: number, opts: { onPlay?: () => void; showing?: () => boolean } = {}): KeyholeMark {
  const id = `wom-keyhole${++marks}`;
  const light = createKeyholeLight(id);
  const plate = node('path', { fill: light.plateFill, opacity: 0 });
  const svg = node('svg', { class: 'keyhole-mark', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    node('defs', {}, ...light.defs, ...light.lineDefs), light.glow, plate, light.sheen, light.line);
  // The button is a disc round the keyhole and its dot, wide enough for a finger however small the keyhole rests.
  let hit: SVGCircleElement | null = null;
  if (opts.onPlay) {
    hit = node('circle', { class: 'keyhole-mark-hit', fill: 'transparent' });
    hit.addEventListener('click', (e) => { e.stopPropagation(); opts.onPlay?.(); });
    svg.append(hit);
  }
  let last = '';
  let amount = 0;
  let sparkle = 0;
  function render(t: number) {
    light.frame(t, amount, amount, amount, sparkle);
  }
  const self: Live = { svg, showing: opts.showing ?? (() => true), render };
  return {
    svg,
    set(geo, look) {
      const key = `${geo.cx.toFixed(1)},${geo.cy.toFixed(1)},${geo.size.toFixed(1)},${look.glow.toFixed(3)},${look.px.toFixed(3)}`;
      if (key !== last) {
        last = key;
        plate.setAttribute('d', keyholePath(geo));
        if (hit) {
          const box = keyholeBox(geo);
          hit.setAttribute('cx', (box.x + box.width / 2).toFixed(2));
          hit.setAttribute('cy', (box.y + box.height / 2).toFixed(2));
          hit.setAttribute('r', Math.max(0.62 * geo.size, HIT_MIN / 2 / Math.max(0.02, look.px)).toFixed(2));
        }
        light.fit(geo, look.px);
        amount = look.glow;
        plate.setAttribute('opacity', look.glow.toFixed(3));
      }
      sparkle = look.sparkle ?? 0;
      // Paint immediately, then let the clock carry the light on.
      render(performance.now() / 1000);
      keepRunning(self);
    },
  };
}
