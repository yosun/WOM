// Small charts for the dashboard, drawn with CSS and SVG so the application needs no chart library.
// Colour is never the only carrier: every bar and cell also prints its number.
import type { Tone } from '../core/types.ts';
import { h } from './dom.ts';
import { clamp01, DASH, isNum } from './format.ts';

export type { Tone };

const SVG_NS = 'http://www.w3.org/2000/svg';
type Kid = Node | string | number | null | undefined | false;

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, ...kids: Kid[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// ---------- colour ----------

export const TONE_COLOR: Record<Tone, string> = { good: 'var(--ok)', fair: 'var(--accent)', poor: 'var(--bad)', info: 'var(--run)', muted: 'var(--muted)' };

// value, hue, saturation %, lightness %
const STOPS: [number, number, number, number][] = [
  [0.15, 6, 72, 62],
  [0.55, 38, 76, 62],
  [0.9, 140, 48, 60],
];

/** A background colour for how good a score is, 0 (worst) to 1 (best): coral, then amber, then green. */
export function heat(v: number | null | undefined, alpha = 0.3): string {
  if (!isNum(v)) return 'transparent';
  const x = Math.min(STOPS[STOPS.length - 1][0], Math.max(STOPS[0][0], v));
  let i = 0;
  while (i < STOPS.length - 2 && x > STOPS[i + 1][0]) i++;
  const [v0, h0, s0, l0] = STOPS[i];
  const [v1, h1, s1, l1] = STOPS[i + 1];
  const t = (x - v0) / (v1 - v0);
  return `hsl(${(h0 + (h1 - h0) * t).toFixed(0)} ${(s0 + (s1 - s0) * t).toFixed(0)}% ${(l0 + (l1 - l0) * t).toFixed(0)}% / ${alpha})`;
}

// ---------- bars ----------

/**
 * A number with a bar behind it, for tables. The bar is as long as `v` is of `max` and coloured by `goodness`
 * (0 worst to 1 best; by default `v` itself, for a score that runs from 0 to 1).
 */
export function meter(v: number | null | undefined, o: { max?: number; text?: string; alpha?: number; goodness?: number | null } = {}) {
  const max = o.max ?? 1;
  const good = o.goodness === undefined ? v : o.goodness;
  return h('div.meter',
    h('span.meter-track', isNum(v) ? h('i', { style: `width:${(clamp01(v / max) * 100).toFixed(1)}%;background:${heat(good, o.alpha ?? 0.8)}` }) : null),
    h('span.meter-num', o.text ?? (isNum(v) ? v.toFixed(2) : DASH)),
  );
}

export interface Part {
  label: string;
  value: number;
  color: string;
  /** What to print inside the segment; defaults to the value. */
  text?: string;
}

/** One bar split into parts that add up to the whole. */
export function stack(parts: Part[], o: { total?: number; unit?: string; totalText?: string } = {}) {
  const total = o.total ?? parts.reduce((a, p) => a + p.value, 0);
  const unit = o.unit ?? '';
  return h('div.stack', { role: 'img', 'aria-label': parts.map((p) => `${p.label} ${p.text ?? `${p.value}${unit}`}`).join(', ') },
    total > 0
      ? parts.filter((p) => p.value > 0).map((p) => h('span', { style: `flex:${p.value} 1 0;background:${p.color}`, title: `${p.label}: ${p.text ?? `${p.value}${unit}`} of ${o.totalText ?? `${total}${unit}`}` }, p.text ?? String(p.value)))
      : h('span.stack-empty', 'nothing yet'),
  );
}

export interface HBar {
  label: Kid | Kid[];
  value: number;
  text: string;
  sub?: string;
  color?: string;
  title?: string;
}

/** Labelled horizontal bars that share one scale. */
export function hbars(rows: HBar[], o: { max?: number } = {}) {
  const max = o.max ?? Math.max(...rows.map((r) => r.value), 1e-9);
  return h('ul.hbars', rows.map((r) => h('li', { title: r.title },
    h('span.hbar-label', r.label),
    h('span.hbar-track', h('i', { style: `width:${(clamp01(r.value / max) * 100).toFixed(1)}%;background:${r.color ?? 'var(--accent)'}` })),
    h('span.hbar-value', r.text, r.sub ? h('small', r.sub) : null),
  )));
}

/** One column per label, as tall as its value. */
export function columns(rows: { label: string; value: number; text: string; title?: string }[]) {
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  return h('div.colchart', rows.map((r) => h('div.colbar', { title: r.title },
    h('b', r.text),
    h('span.colbar-track', h('i', { style: `height:${(clamp01(r.value / max) * 100).toFixed(1)}%` })),
    h('small', r.label),
  )));
}

/**
 * A bar that grows left of the middle for negative values and right of it for positive ones. With `better`,
 * left is bad (coral) and right is good (green); without it the two sides are just directions.
 */
export function diverge(v: number | null | undefined, maxAbs: number, text: string, better = false) {
  const w = isNum(v) ? clamp01(Math.abs(v) / maxAbs) * 50 : 0;
  const side = isNum(v) && v < 0 ? (better ? 'bad' : 'neg') : (better ? 'good' : 'pos');
  return h('div.diverge',
    h('span.diverge-track', isNum(v) ? h('i', { class: side, style: v < 0 ? `right:50%;width:${w}%` : `left:50%;width:${w}%` }) : null),
    h('span.diverge-num', text),
  );
}

export function legend(items: { label: string; color: string; title?: string; hollow?: boolean }[]) {
  return h('ul.legend', items.map((i) => h('li', { title: i.title }, h('i', { style: i.hollow ? `border:2px solid ${i.color}` : `background:${i.color}` }), i.label)));
}

// ---------- scatter ----------

export interface ScatterPoint {
  /** Printed beside the dot; leave empty to label a group of dots once. */
  label: string;
  x: number;
  y: number;
  /** Dot radius in chart units; scaled with the number of cases a point is based on. */
  r?: number;
  color: string;
  /** Drawn as a ring, for a second variant of the same thing (another depth model). */
  hollow?: boolean;
  /** Dots of one group are the same thing seen twice, so one label serves them. */
  group?: string;
  /** Hover text. */
  title: string;
}

export interface ScatterOptions {
  width?: number;
  height?: number;
  xLabel: string;
  yLabel: string;
  xScale?: 'linear' | 'log';
  xFormat: (v: number) => string;
  yFormat: (v: number) => string;
  /** Where to put the ticks on x; by default they are chosen from the range. */
  xTicks?: number[];
  /** A horizontal line to compare against, such as the free baseline. */
  ref?: { y: number; label: string };
  ariaLabel: string;
}

function niceTicks(lo: number, hi: number, target = 5): number[] {
  const range = hi - lo;
  if (!(range > 0)) return [lo];
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toFixed(10)));
  return out;
}

function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
    for (const m of [1, 3]) {
      const v = m * 10 ** k;
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(Number(v.toPrecision(3)));
    }
  }
  return out;
}

interface Box { x0: number; y0: number; x1: number; y1: number }
/** Boxes that only touch, or cross by a pixel or two, do not count: text boxes are taller than the ink. */
const overlaps = (a: Box, b: Box) => a.x0 + 1 < b.x1 && a.x1 - 1 > b.x0 && a.y0 + 2 < b.y1 && a.y1 - 2 > b.y0;

interface Dot { cx: number; cy: number; r: number; group?: string }

/**
 * Put each label beside its dot where it covers no other label or dot, trying eight spots around it, then
 * further out. A label that ends up away from its dot gets a leader line, so it never reads as another dot's.
 */
function placeLabels(dots: Dot[], labelled: { dot: number; text: string }[], bounds: Box, fixed: Box[] = [], line?: Box) {
  const dotBoxes: Box[] = dots.map((p) => ({ x0: p.cx - p.r, y0: p.cy - p.r, x1: p.cx + p.r, y1: p.cy + p.r }));
  // Labels already on the chart (the reference line's) count as taken from the start.
  const taken: Box[] = [...fixed];
  return labelled.map(({ dot: i, text }) => {
    const p = dots[i];
    const w = text.length * 6.4 + 2, lh = 13;
    const spots: { dx: number; dy: number; anchor: 'start' | 'middle' | 'end'; far: boolean }[] = [];
    for (const extra of [0, 14, 28]) {
      const g = p.r + 4 + extra, far = extra > 0;
      spots.push(
        { dx: g, dy: 4, anchor: 'start', far }, { dx: -g, dy: 4, anchor: 'end', far },
        { dx: 0, dy: -g, anchor: 'middle', far }, { dx: 0, dy: g + lh - 3, anchor: 'middle', far },
        { dx: g, dy: -g + 5, anchor: 'start', far }, { dx: g, dy: g + 9, anchor: 'start', far },
        { dx: -g, dy: -g + 5, anchor: 'end', far }, { dx: -g, dy: g + 9, anchor: 'end', far },
      );
    }
    let pick = spots[0], pickBox: Box = { x0: 0, y0: 0, x1: 0, y1: 0 }, bestScore = Infinity;
    for (const s of spots) {
      const x = p.cx + s.dx;
      const x0 = s.anchor === 'start' ? x : s.anchor === 'end' ? x - w : x - w / 2;
      const box: Box = { x0, y0: p.cy + s.dy - lh + 3, x1: x0 + w, y1: p.cy + s.dy + 3 };
      let score = s.far ? 1 : 0;
      if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1) score += 1000;
      for (const t of taken) if (overlaps(box, t)) score += 100;
      dotBoxes.forEach((d, j) => { if (j !== i && overlaps(box, d)) score += 50; });
      // A label must read as belonging to its own dot: no dot of another group may be as close to the text.
      const gapTo = (q: Dot) => Math.hypot(Math.max(box.x0 - q.cx, 0, q.cx - box.x1), Math.max(box.y0 - q.cy, 0, q.cy - box.y1)) - q.r;
      if (dots.some((q, j) => j !== i && !(p.group && q.group === p.group) && gapTo(q) <= gapTo(p) + 1)) score += 80;
      // Sitting on the reference line is allowed when nothing better is free, but not preferred.
      if (line && overlaps(box, line)) score += 20;
      if (score < bestScore) { pick = s; pickBox = box; bestScore = score; }
      if (score === 0) break;
    }
    taken.push(pickBox);
    return { dot: i, x: p.cx + pick.dx, y: p.cy + pick.dy, anchor: pick.anchor, far: pick.far };
  });
}

export function scatter(points: ScatterPoint[], o: ScatterOptions): SVGSVGElement {
  const W = o.width ?? 980, H = o.height ?? 420;
  const m = { l: 68, r: 24, t: 18, b: 54 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const log = o.xScale === 'log';

  const xs = points.map((p) => p.x);
  const positive = xs.filter((x) => x > 0);
  const x0 = log ? Math.min(0.1, (positive.length ? Math.min(...positive) : 0.1) / 1.6) : 0;
  const x1 = log ? Math.max(...xs, 1) * 1.8 : Math.max(...xs, 0.001) * 1.18;
  const ys = [...points.map((p) => p.y), ...(o.ref ? [o.ref.y] : [])];
  const spread = Math.max(Math.max(...ys) - Math.min(...ys), 0.05);
  const y0 = Math.min(...ys) - spread * 0.08, y1 = Math.max(...ys) + spread * 0.1;

  const lx0 = Math.log10(x0), lx1 = Math.log10(x1);
  const sx = (x: number) => m.l + (log ? (Math.log10(Math.max(x, x0)) - lx0) / (lx1 - lx0) : (x - x0) / (x1 - x0)) * pw;
  const sy = (y: number) => m.t + (1 - (y - y0) / (y1 - y0)) * ph;

  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.ariaLabel });
  root.append(svg('title', {}, o.ariaLabel));

  for (const t of niceTicks(y0, y1, 6)) {
    root.append(
      svg('line', { class: t === 0 ? 'axis' : 'grid', x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t) }),
      svg('text', { class: 'tick', x: m.l - 9, y: sy(t) + 4, 'text-anchor': 'end' }, o.yFormat(t)),
    );
  }
  for (const t of o.xTicks?.filter((v) => v >= x0 && v <= x1) ?? (log ? logTicks(x0, x1) : niceTicks(x0, x1, 6))) {
    root.append(
      svg('line', { class: 'grid', x1: sx(t), x2: sx(t), y1: m.t, y2: m.t + ph }),
      svg('text', { class: 'tick', x: sx(t), y: m.t + ph + 18, 'text-anchor': 'middle' }, o.xFormat(t)),
    );
  }
  root.append(
    svg('text', { class: 'axis-title', x: m.l + pw / 2, y: H - 8, 'text-anchor': 'middle' }, o.xLabel),
    svg('text', { class: 'axis-title', transform: `translate(15 ${m.t + ph / 2}) rotate(-90)`, 'text-anchor': 'middle' }, o.yLabel),
  );
  const dots: Dot[] = points.map((p) => ({ cx: sx(p.x), cy: sy(p.y), r: p.r ?? 6, group: p.group }));

  // The reference line's label goes above the line (else below it) at the first spot, from the right end
  // inwards, that no dot is in; point labels then keep clear of it.
  const fixed: Box[] = [];
  let line: Box | undefined;
  if (o.ref) {
    const ly = sy(o.ref.y);
    const w = o.ref.label.length * 6.4 + 2;
    const free = (b: Box) => dots.every((d) => !overlaps(b, { x0: d.cx - d.r - 2, y0: d.cy - d.r - 2, x1: d.cx + d.r + 2, y1: d.cy + d.r + 2 }));
    let spot: { box: Box; x: number; anchor: 'start' | 'end'; y: number } | undefined;
    search: for (const above of [true, false]) {
      for (let right = W - m.r - 4; right - w >= m.l + 4; right -= 24) {
        const box: Box = { x0: right - w, y0: above ? ly - 18 : ly + 5, x1: right, y1: above ? ly - 4 : ly + 19 };
        if (free(box)) { spot = { box, x: right, anchor: 'end', y: above ? ly - 6 : ly + 16 }; break search; }
      }
    }
    // Nowhere is free: the right end above the line, over whatever is there.
    spot ??= { box: { x0: W - m.r - 4 - w, y0: ly - 18, x1: W - m.r - 4, y1: ly - 4 }, x: W - m.r - 4, anchor: 'end', y: ly - 6 };
    fixed.push(spot.box);
    line = { x0: m.l, y0: ly - 1.5, x1: W - m.r, y1: ly + 1.5 };
    root.append(
      svg('line', { class: 'ref', x1: m.l, x2: W - m.r, y1: ly, y2: ly }),
      svg('text', { class: 'ref-label', x: spot.x, y: spot.y, 'text-anchor': spot.anchor }, o.ref.label),
    );
  }

  const labels = placeLabels(dots, points.flatMap((p, dot) => (p.label ? [{ dot, text: p.label }] : [])), { x0: m.l, y0: m.t, x1: W - m.r, y1: m.t + ph + 4 }, fixed, line);
  for (const l of labels) {
    if (l.far) root.append(svg('line', { class: 'leader', x1: dots[l.dot].cx, y1: dots[l.dot].cy, x2: l.x, y2: l.y - 4 }));
  }
  points.forEach((p, i) => {
    const style = p.hollow ? `fill:#1b1815;stroke:${p.color};stroke-width:2.4px` : `fill:${p.color}`;
    root.append(svg('circle', { class: 'pt', cx: dots[i].cx, cy: dots[i].cy, r: dots[i].r, style, tabindex: 0, 'aria-label': p.title }, svg('title', {}, p.title)));
  });
  for (const l of labels) root.append(svg('text', { class: 'lbl', x: l.x, y: l.y, 'text-anchor': l.anchor }, points[l.dot].label));
  return root;
}
