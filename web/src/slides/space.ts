// The slide space: parallel image planes inside one open-ended temporal prism. X is time, Y is up,
// and Z is image width. Browsing translates the camera; zoom contracts the uniform temporal spacing.
// Wheel/pinch contracts the temporal spacing and reveals the collection. Selecting a plane slides it
// along Z while the archive retreats into the corner. Press that extracted image (or Enter) to
// continue the original keyhole flight into the viewer's photo frame (aperture.ts). `onPlay` hands
// it over with the original cover (handoff.ts); returning restores the extracted selection.
//
// It is drawn with CSS 3D: every slide is a DOM element placed by three.js's CSS3DRenderer, so images stay
// sharp and slides are ordinary buttons. The floor (a 2D canvas) and the timeline (an SVG) are drawn from the
// same camera. The camera stays put while a slide flies: the slide turns to face it, so the slide lands in a
// rectangle defined on the screen rather than somewhere in the row.
//
// A space is any list of slides (see spaces.ts for the sub spaces the app opens); call createSlideSpace with
// another list to get another stack. The flight ends at the viewer's frame for the window, so a space that
// plays slides should fill the window.
import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { apertureGeometry, type ApertureGeo } from '../aperture.ts';
import { restingKeyhole } from '../keyhole.ts';
import type { SlideDoc } from '../api.ts';
import { h } from '../dom.ts';
import { paintBackdrop, photoFrame, type PhotoRect } from '../frame.ts';
import { buildCover, removeCover } from './handoff.ts';
import { createKeyholeMark, type KeyholeMark, type MarkLook } from './mark.ts';
import { worldHref } from '../routes.ts';
import { slideKey } from './spaces.ts';

export interface SlideSpaceOptions {
  title: string;
  /** Spaces above this one, outermost first: links in the top bar; the last one is where Esc goes. */
  trail?: { title: string; href: string }[];
  slides: SlideDoc[];
  /** Which date lays the slides out: the memory's (default) or when each slide was made. */
  time?: 'taken' | 'created';
  /** Key (`<world>.<slide>`) of the slide to start on; otherwise the newest. */
  selected?: string;
  /** A slide was played. It now faces the camera where the viewer will show it, and `cover` shows it there. */
  onPlay: (slide: SlideDoc, cover: HTMLElement) => void;
  /** The slide in front changed, and the row came to rest on it. */
  onSelect?: (slide: SlideDoc) => void;
  /** Open this image's video prompt and generated takes. */
  onAnimate?: (slide: SlideDoc) => void;
  /** Links to smaller spaces (every way into a world, one year); return null to offer none. */
  subspaceHref?: (kind: 'world' | 'year', value: string) => string | null;
  /** Remove a slide made inside a world. Resolves true when it is gone. */
  onDelete?: (slide: SlideDoc) => Promise<boolean>;
  /** Shown instead of the row when there are no slides. */
  empty?: HTMLElement;
}

export interface SlideSpace {
  el: HTMLElement;
  /** Bring the slide with this key to the front. */
  select(key: string): void;
  /** Pull out the focused slide; activate it again to enter its world. */
  play(): void;
  /** Bring a slide back from its world: it starts full screen, facing the camera, and flies back into the row. */
  returnFrom(key: string, cover: HTMLElement | null): boolean;
  dispose(): void;
}

// ---------- the scene, in CSS pixels at the depth where one unit is one screen pixel ----------

const SLIDE_H = 300;
/** Every resting image lies in YZ, with the same normal along -X. Flights use their own object. */
const RESTING_ROTATION = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
/** Height of the timeline where it runs through the slides. */
const LINE_Y = SLIDE_H * 0.36;
/** The timeline runs on this far past the first and last slide. */
const LINE_EXT = 260;
// Keep the temporal vanishing point in the desktop viewport, so the volume recedes into view.
const FOV = 42;
/** A restrained oblique view along +X, slightly downward, fixed throughout browsing. */
const AZIMUTH = THREE.MathUtils.degToRad(24);
const ELEVATION = THREE.MathUtils.degToRad(6);
/** Slides further than this from the one in front are not drawn. */
const VISIBLE = 70;
/** Pixels of dragging per slide. */
const DRAG_PX = 64;
/** Wheel pixels per slide. */
const WHEEL_PX = 110;
const FLIGHT_MS = 1150;
const RETURN_MS = 1000;

const clamp = THREE.MathUtils.clamp;
const clamp01 = (x: number) => clamp(x, 0, 1);
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Between two keyholes. The size grows by the same factor each moment, so a keyhole an eighth of its size grows evenly to the eye. */
const lerpGeo = (a: ApertureGeo, b: ApertureGeo, t: number): ApertureGeo => ({
  cx: lerp(a.cx, b.cx, t),
  cy: lerp(a.cy, b.cy, t),
  size: a.size > 0 && b.size > 0 ? a.size * (b.size / a.size) ** t : lerp(a.size, b.size, t),
});

/** Deterministic noise for the light on the floor, so it stays put as the row moves. */
function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Item {
  doc: SlideDoc;
  key: string;
  index: number;
  date: Date;
  /** Element size: every slide is SLIDE_H tall and as wide as its image's shape. */
  w: number;
  aspect: number;
  obj: CSS3DObject;
  el: HTMLElement;
  img: HTMLImageElement;
  mark: KeyholeMark | null;
  pull: number;
  fog: number;
  /** The full-size image, once decoded. */
  full: Promise<HTMLImageElement | null> | null;
}

interface Flight {
  item: Item;
  el: HTMLElement;
  obj: CSS3DObject;
  img: HTMLImageElement;
  frameEl: HTMLElement;
  mark: KeyholeMark;
  rect: PhotoRect;
  /** Scale that makes the rect-sized element as large as the slide in the row. */
  s: number;
  from: { p: THREE.Vector3; q: THREE.Quaternion };
  to: { p: THREE.Vector3; q: THREE.Quaternion };
  geo: { from: ApertureGeo; to: ApertureGeo };
  look: { from: MarkLook; to: MarkLook };
  t0: number;
  ms: number;
  /** 1 while flying up to the camera, -1 while flying back into the row. */
  dir: 1 | -1;
  done: () => void;
}

/**
 * The automation API of a space (`window.__wom.space` with ?debug), for agents and scripts. It lives on the
 * space page; the viewer has its own (`window.__wom.viewer`, see observe.ts), because the two are different pages.
 */
export interface SpaceApi {
  /**
   * Where the row is. `mode` is 'browse' at rest, 'flying' while a slide plays or comes back, and 'gone' once a
   * played slide has been handed to the viewer; `focus` is the slide index the row is at now (a fraction while it
   * moves) and `target` the one it is heading for; `current` and `key` are the slide in front (-1 / null when
   * there are none); `isolate` is 0..1, how far the rest of the space has faded around a flying slide.
   */
  state(): { mode: 'browse' | 'flying' | 'gone'; focus: number; target: number; current: number; key: string | null; isolate: number; count: number; zoom: number; zoomTarget: number; extracted: string | null; extraction: number; extractionTarget: number };
  /** The key (`<world>.<slide>`) of every slide, oldest first. */
  keys(): string[];
  /** Actual resting frame transforms and camera pose, for geometry checks (?debug only). */
  geometry(): {
    spacing: number;
    restingSpacing: number;
    crossSection: { height: number; width: number };
    camera: { position: number[]; quaternion: number[] };
    frames: { key: string; position: number[]; quaternion: number[] }[];
  };
  /** Bring the slide with this key to the front. Does nothing for a key that is not in this space, or unless the space is at rest ('browse'). */
  select(key: string): void;
  /** Contract the archive into an overview (1) or expand into a close view (0). */
  zoom(amount: number): void;
  extract(key: string): void;
  dismiss(): void;
  /** Pull out the focused slide, or enter its world once extraction is complete. */
  play(): void;
  /** The slide that is flying: how far along (`u`, 0..1), which way (1 up to the camera, -1 back into the row), the box it fills on screen now, and the frame it lands in. Null when none flies. */
  flight(): { u: number; dir: 1 | -1; box: { x: number; y: number; width: number; height: number }; rect: PhotoRect } | null;
}

const fmtDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const fmtDayShort = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

export function createSlideSpace(mount: HTMLElement, opts: SlideSpaceOptions): SlideSpace {
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const debug = new URLSearchParams(location.search).has('debug');
  const speed = calm ? 0.45 : 1;
  const time = opts.time ?? 'taken';
  const dateOf = (s: SlideDoc) => new Date(time === 'created' ? s.createdAt : s.takenAt);
  // Stable sort: equal timestamps keep their incoming order. Both kinds of space use this chronology.
  const docs = [...opts.slides].sort((a, b) => dateOf(a).getTime() - dateOf(b).getTime());
  // One fixed cross-section and uniform spacing for this entire space, independent of focus and viewport.
  const prismWidth = Math.max(SLIDE_H * 16 / 9, ...docs.map((s) => Math.round(SLIDE_H * s.image.width / s.image.height))) + 80;
  const prismHeight = SLIDE_H + 48;
  // At the preceding plane, the sightline to focus passes outside the cross-section. This keeps
  // the resting keyhole exposed at every viewport size without moving or turning any image.
  const spacing = prismWidth / (2 * Math.tan(AZIMUTH));
  const baseX = (i: number) => i * spacing;
  let overview = 0, overviewTarget = 0;
  const density = () => Math.exp(-2.12 * overview);
  const temporalX = (i: number) => baseX(i) * density();
  const perWorld = new Map<string, number>();
  for (const s of docs) perWorld.set(s.world, (perWorld.get(s.world) ?? 0) + 1);

  // ---------- DOM ----------
  const root = h('div.space', { tabIndex: 0, 'aria-label': `${opts.title}: slides` });
  const bg = h('div.space-bg', ...[0, 1, 2, 3, 4, 5].map((i) => h('span', { class: `bokeh b${i}` })));
  const floor = h('canvas.space-floor') as HTMLCanvasElement;
  const bars = h('canvas.space-bars') as HTMLCanvasElement;
  const renderer = new CSS3DRenderer();
  renderer.domElement.classList.add('space-3d');
  // A separate viewport lets the same selected plane leave the archive without shrinking with it.
  const selectionRenderer = new CSS3DRenderer();
  selectionRenderer.domElement.classList.add('space-3d', 'space-extracted-3d');
  selectionRenderer.domElement.style.pointerEvents = 'none';
  const SVG = 'http://www.w3.org/2000/svg';
  const svgNode = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  const tl = svgNode('svg', { class: 'space-timeline', 'aria-hidden': 'true' });
  const tlMaskPoly = svgNode('polygon', { fill: '#000', 'fill-opacity': 0 });
  const tlMask = svgNode('mask', { id: 'space-tl-mask', maskUnits: 'userSpaceOnUse' });
  const tlMaskRect = svgNode('rect', { fill: '#fff', x: 0, y: 0 });
  tlMask.append(tlMaskRect, tlMaskPoly);
  const tlGlowFilter = svgNode('filter', { id: 'space-tl-glow', x: '-20%', y: '-20%', width: '140%', height: '140%' });
  tlGlowFilter.append(svgNode('feGaussianBlur', { stdDeviation: 3 }));
  const tlDefs = svgNode('defs');
  tlDefs.append(tlMask, tlGlowFilter);
  const tlGroup = svgNode('g', { mask: 'url(#space-tl-mask)' });
  const tlGlow = svgNode('line', { class: 'tl-glow', filter: 'url(#space-tl-glow)' });
  const tlLine = svgNode('line', { class: 'tl-line' });
  const tlDots = svgNode('g', { class: 'tl-dots' });
  const tlEnds = [svgNode('circle', { class: 'tl-end', r: 3.4 }), svgNode('circle', { class: 'tl-end', r: 3.4 })];
  tlGroup.append(tlGlow, tlLine, tlDots, ...tlEnds);
  tl.append(tlDefs, tlGroup);
  const labels = h('div.space-labels');

  const trail = (opts.trail ?? []).map((t) => h('a.space-crumb', { href: t.href }, t.title));
  const backHref = opts.trail?.length ? opts.trail[opts.trail.length - 1].href : '#/';
  const top = h('header.space-top',
    h('a.space-back', { href: backHref, title: opts.trail?.length ? `Back to ${opts.trail[opts.trail.length - 1].title}` : 'Home' }, '←'),
    h('div.space-titles', h('div.space-trail', trail.flatMap((a, i) => (i ? [h('span.sep', '/'), a] : [a]))), h('h1', opts.title)),
    h('div.spacer'),
    h('span.space-count', `${docs.length} slide${docs.length === 1 ? '' : 's'}`),
    h('a.button', { href: '#/' }, 'New memory'),
  );
  const infoTitle = h('h2');
  const infoMeta = h('p.space-meta');
  const infoCaption = h('p.space-caption');
  const info = h('section.space-info', { 'aria-live': 'polite' }, infoTitle, infoMeta, infoCaption);
  const infoActions = h('nav.space-actions', { 'aria-label': 'Actions for the selected slide' });
  const hint = h('div.space-hint', 'Scroll or pinch to zoom · Drag or ← → through time · Click a memory to pull it out');
  const archive = h('div.space-archive', { 'aria-label': 'Memory archive' }, floor, renderer.domElement, tl, labels);
  const zoomRange = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: '1', 'aria-label': 'Archive overview' });
  const closeView = h('button', { type: 'button', title: 'Expand the planes for a closer view' }, '+');
  const overviewView = h('button', { type: 'button', title: 'Contract the planes and see the whole archive' }, '−');
  const zoomControls = h('nav.space-zoom', { 'aria-label': 'Archive view' }, overviewView, h('span', 'Overview'), zoomRange, h('span', 'Close'), closeView);
  zoomRange.addEventListener('input', () => setZoom(1 - Number(zoomRange.value)));
  closeView.addEventListener('click', () => setZoom(0));
  overviewView.addEventListener('click', () => setZoom(1));
  const selectionTitle = h('h2');
  const selectionDate = h('p');
  const putBack = h('button.space-put-back', { type: 'button' }, '↖ Back to archive');
  putBack.addEventListener('click', () => dismissSelection());
  const selectionInfo = h('section.space-selected-info', { hidden: true }, putBack, selectionTitle, selectionDate, h('span', 'Click the image or keyhole to step inside'));
  archive.addEventListener('click', (e) => { if (selection && mode === 'browse') { e.preventDefault(); e.stopPropagation(); dismissSelection(); } }, true);
  root.append(bg, archive, bars, selectionRenderer.domElement, top, zoomControls, selectionInfo);
  if (debug) root.append(info);
  root.append(infoActions, hint);
  mount.append(root);

  if (!docs.length) {
    root.classList.add('is-empty');
    info.hidden = true;
    infoActions.hidden = true;
    hint.hidden = true;
    zoomControls.hidden = true;
    root.append(opts.empty ?? h('div.space-empty', h('h2', 'Nothing to step into yet'), h('p', 'Make a world from a photo and it appears here as a slide.'), h('a.button.primary', { href: '#/' }, 'Make a world')));
  }

  // ---------- three.js: the camera and the slides ----------
  const scene = new THREE.Scene();
  const selectionScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 50000);
  const selectionCamera = camera.clone();
  let vw = 1, vh = 1, fpx = 1, distance = 1400, dpr = 1;
  const items: Item[] = docs.map((doc, index) => makeItem(doc, index));
  for (const it of items) scene.add(it.obj);

  function makeItem(doc: SlideDoc, index: number): Item {
    const aspect = doc.image.width / doc.image.height;
    const w = Math.round(SLIDE_H * aspect);
    const img = h('img.slide-img', { src: doc.image.thumb, alt: '', draggable: false, decoding: 'async' });
    const reflection = h('div.slide-reflection', h('img', { src: doc.image.thumb, alt: '', draggable: false, decoding: 'async' }));
    const face = h('div.slide-face', img, h('span.slide-sheen'));
    const date = dateOf(doc);
    const el = h('div.slide', {
      role: 'button',
      'aria-label': `${doc.worldTitle}, ${doc.kind === 'photo' ? 'the photo' : doc.title}, ${fmtDay.format(date)}`,
      style: { width: `${w}px`, height: `${SLIDE_H}px` },
    }, reflection, face, h('span.slide-glow'));
    const obj = new CSS3DObject(el);
    obj.position.set(baseX(index), SLIDE_H / 2, 0);
    obj.quaternion.copy(RESTING_ROTATION);
    const it: Item = { doc, key: slideKey(doc.world, doc.id), index, date, w, aspect, obj, el, img, mark: null, pull: -1, fog: -1, full: null };
    el.addEventListener('click', () => {
      if (suppressClick || mode !== 'browse') return;
      if (selection?.item === it) { if (selection.amount === 1 && selection.target === 1) play(); }
      else extractItem(it);
    });
    return it;
  }

  /** The keyhole mark, made when it first comes to the front. */
  function markOf(it: Item): KeyholeMark {
    if (!it.mark) {
      it.mark = createKeyholeMark(it.w, SLIDE_H, { onPlay: () => { if (!suppressClick && mode === 'browse') { if (selection?.item === it) play(); else extractItem(it); } }, showing: () => it.el.classList.contains('is-front') });
      it.mark.svg.classList.add('slide-mark');
      it.el.querySelector('.slide-face')?.append(it.mark.svg);
    }
    return it.mark;
  }

  /**
   * The keyhole as it rests on a slide in the row: an eighth of its full size (keyhole.ts) until it is tapped. `k`
   * converts to another unit (the flyer's), `px` is how many screen px one unit of the row is.
   */
  const restGeo = (it: Item, k = 1, px = 1): ApertureGeo => {
    const g = restingKeyhole(apertureGeometry({ w: it.w, h: SLIDE_H, photo: { x: 0, y: 0, w: it.w, h: SLIDE_H } }), px);
    return { cx: g.cx * k, cy: g.cy * k, size: g.size * k };
  };
  /** Screen px per unit for a slide in the row. */
  const rowPx = (it: Item) => clamp(fpx / -tmp.copy(it.obj.position).applyMatrix4((selection?.item === it ? selectionCamera : camera).matrixWorldInverse).z, 0.02, 5);

  /** The full-size image, so the slide in front (and the one that flies) is sharp. */
  function fullImage(it: Item): Promise<HTMLImageElement | null> {
    if (!it.full) {
      const img = new Image();
      img.decoding = 'async';
      img.src = it.doc.image.url;
      it.full = img.decode().then(() => {
        if (!disposed) it.img.src = it.doc.image.url;
        return img;
      }).catch(() => null);
    }
    return it.full;
  }

  // ---------- state ----------
  const newest = items.length ? items.reduce((a, b) => (b.doc.createdAt > a.doc.createdAt ? b : a)) : null;
  const start = items.find((it) => it.key === opts.selected) ?? newest;
  let focus = start?.index ?? 0;
  let target = focus;
  let current = -1;
  let settledOn = -1;
  let mode: 'browse' | 'flying' | 'gone' = 'browse';
  /** 0..1: how far the rest of the space has faded away around a flying slide. */
  let isolate = 0;
  let barsAlpha = 0;
  let flight: Flight | null = null;
  let disposed = false;
  let raf = 0;
  let last = performance.now();
  let suppressClick = false;
  let snapTimer = 0;
  let selection: { item: Item; from: THREE.Vector3; cameraPosition: THREE.Vector3; cameraQuaternion: THREE.Quaternion; amount: number; target: 0 | 1; after?: () => void } | null = null;

  function setZoom(amount: number) {
    if (mode !== 'browse' || !Number.isFinite(amount)) return;
    if (selection) { dismissSelection(() => setZoom(amount)); return; }
    overviewTarget = clamp01(amount);
    zoomRange.value = String(1 - overviewTarget);
    kick();
  }

  function extractItem(it: Item, immediate = false) {
    if (mode !== 'browse' || !items.length) return;
    if (selection) {
      if (selection.item !== it) dismissSelection(() => extractItem(it));
      return;
    }
    clearTimeout(snapTimer);
    target = focus;
    overviewTarget = overview;
    placeCamera();
    placeSlides();
    selectionCamera.copy(camera);
    selection = { item: it, from: it.obj.position.clone(), cameraPosition: camera.position.clone(), cameraQuaternion: camera.quaternion.clone(), amount: immediate ? 1 : 0, target: 1 };
    selectionScene.add(it.obj);
    it.el.classList.add('is-extracted');
    it.el.setAttribute('aria-label', `Enter ${it.doc.worldTitle}`);
    selectionTitle.textContent = it.doc.worldTitle;
    selectionDate.textContent = `${fmtDay.format(it.date)} · ${it.doc.kind === 'photo' ? 'The photo' : it.doc.title}`;
    void fullImage(it);
    updateExtraction();
    kick();
  }

  function dismissSelection(after?: () => void) {
    if (!selection || mode !== 'browse') return;
    selection.target = 0;
    selection.after = after;
    kick();
  }

  function updateExtraction() {
    const s = selection;
    const amount = s?.amount ?? 0;
    const small = vw < 760;
    const scale = lerp(1, small ? 0.28 : 0.3, amount);
    archive.style.transform = `translate(${(amount * 18).toFixed(2)}px, ${(amount * (small ? 80 : 86)).toFixed(2)}px) scale(${scale.toFixed(5)})`;
    archive.classList.toggle('is-condensed', amount > 0.01);
    root.classList.toggle('has-extracted', !!s);
    const entryButton = infoActions.querySelector('button.primary');
    if (entryButton) entryButton.textContent = s ? 'Enter world' : 'Pull out';
    selectionInfo.hidden = !s || amount < 0.95 || s.target === 0;
    zoomControls.hidden = !items.length || !!s;
    hint.hidden = !!s || !items.length;
    if (!s) return;
    // This is the original plane, not a copy: extraction changes only Z, never X/Y or quaternion.
    s.item.obj.position.copy(s.from);
    s.item.obj.position.z += prismWidth * 1.05 * amount;
    s.item.obj.quaternion.copy(RESTING_ROTATION);
    const height = Math.min(vh * (small ? 0.43 : vh < 540 ? 0.46 : 0.6), vw * (small ? 0.9 : 0.66) / s.item.aspect);
    const depth = fpx * SLIDE_H / Math.max(1, height);
    const cx = small ? 0.5 : 0.59, cy = small ? 0.59 : vh < 540 ? 0.46 : 0.52;
    const end = new THREE.Vector3(s.from.x - depth, s.from.y + (cy - 0.5) * vh * depth / fpx, s.from.z + prismWidth * 1.05 + (0.5 - cx) * vw * depth / fpx);
    selectionCamera.position.lerpVectors(s.cameraPosition, end, amount);
    // Moving the preview camera gives the extracted image a readable view while its own pose stays parallel.
    selectionCamera.quaternion.slerpQuaternions(s.cameraQuaternion, RESTING_ROTATION, amount);
    selectionCamera.updateMatrixWorld();
  }

  /** Only deliberate zoom changes resting spacing; focus never spreads or rotates the planes. */
  function placeSlides() {
    for (const it of items) {
      const extracted = selection?.item === it;
      if (!extracted) it.obj.position.x = temporalX(it.index);
      const d = it.index - focus;
      const ad = Math.abs(d);
      it.obj.visible = extracted || overview > 0.01 || ad < VISIBLE;
      if (!it.obj.visible) continue;
      const near = Math.max(0, 1 - ad);
      const pull = extracted ? 1 : near * near * (3 - 2 * near);
      // Slides far along the row fade into the dark.
      const fog = extracted ? 1 : lerp(1 - smooth(10, 34, ad), 0.9, overview);
      if (Math.abs(pull - it.pull) > 0.004) {
        it.pull = pull;
        it.el.style.setProperty('--pull', pull.toFixed(3));
      }
      it.el.classList.toggle('is-front', extracted || (!selection && pull > 0.5));
      it.el.tabIndex = extracted || (!selection && pull > 0.5) ? 0 : -1;
      // A slide in flight is drawn by its flyer; its place in the row stays empty until it lands.
      const shown = flight?.item === it ? 0 : fog * (1 - isolate);
      if (Math.abs(shown - it.fog) > 0.004 || (shown === 0 && it.fog !== 0)) {
        it.fog = shown;
        it.el.style.opacity = shown.toFixed(3);
        it.el.style.visibility = shown < 0.005 ? 'hidden' : '';
      }
    }
  }

  const cameraDirection = new THREE.Vector3(Math.cos(AZIMUTH) * Math.cos(ELEVATION), -Math.sin(ELEVATION), -Math.sin(AZIMUTH) * Math.cos(ELEVATION));
  const cameraTarget = new THREE.Vector3();
  /** At each zoom level, chronological traversal translates the camera along X without orbiting. */
  function placeCamera() {
    if (selection) return;
    const az = lerp(AZIMUTH, THREE.MathUtils.degToRad(58), overview);
    const elevation = lerp(ELEVATION, THREE.MathUtils.degToRad(18), overview);
    cameraDirection.set(Math.cos(az) * Math.cos(elevation), -Math.sin(elevation), -Math.sin(az) * Math.cos(elevation));
    const length = temporalX(Math.max(0, items.length - 1));
    cameraTarget.set(lerp(temporalX(focus), length / 2, overview), SLIDE_H / 2, 0);
    // Fit the widest image on a narrow viewport without reframing as different images receive focus.
    const across = prismWidth / (0.72 * 2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * camera.aspect);
    // Fit all eight corners of the finite archive at overview. No extra frames or wrapping.
    const right = new THREE.Vector3(Math.sin(az), 0, Math.cos(az));
    const up = new THREE.Vector3().crossVectors(right, cameraDirection);
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    let fit = Math.max(distance, across);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const corner = new THREE.Vector3(sx * (length / 2 + 60), sy * prismHeight / 2, sz * prismWidth / 2);
      fit = Math.max(fit, Math.abs(corner.dot(right)) / (tan * camera.aspect * 0.78) - corner.dot(cameraDirection), Math.abs(corner.dot(up)) / (tan * 0.7) - corner.dot(cameraDirection));
    }
    const back = lerp(Math.max(distance, across), fit, overview);
    camera.position.copy(cameraTarget).addScaledVector(cameraDirection, -back);
    const far = Math.max(50000, back + length * 2 + prismWidth);
    if (camera.far !== far) { camera.far = far; camera.updateProjectionMatrix(); }
    camera.lookAt(cameraTarget);
    camera.updateMatrixWorld();
  }

  // ---------- projecting onto the 2D layers ----------
  const tmp = new THREE.Vector3();
  const NEAR = 20;
  interface Pt { x: number; y: number; depth: number }

  function toCamera(p: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(p).applyMatrix4(camera.matrixWorldInverse);
  }
  function camToScreen(c: THREE.Vector3): Pt {
    const depth = -c.z;
    return { x: vw / 2 + (c.x * fpx) / depth, y: vh / 2 - (c.y * fpx) / depth, depth };
  }
  function project(p: THREE.Vector3): Pt | null {
    toCamera(p, tmp);
    return tmp.z > -NEAR ? null : camToScreen(tmp);
  }
  const ca = new THREE.Vector3(), cb = new THREE.Vector3();
  /** A segment on screen, cut where it passes behind the camera. */
  function segment(a: THREE.Vector3, b: THREE.Vector3): [Pt, Pt] | null {
    toCamera(a, ca);
    toCamera(b, cb);
    const za = -ca.z, zb = -cb.z;
    if (za < NEAR && zb < NEAR) return null;
    if (za < NEAR) ca.lerp(cb, (NEAR - za) / (zb - za));
    else if (zb < NEAR) cb.lerp(ca, (NEAR - zb) / (za - zb));
    return [camToScreen(ca), camToScreen(cb)];
  }

  // ---------- the floor ----------
  const fctx = floor.getContext('2d');
  const TILE = 120;

  /** A circle lying on the floor, drawn as the ellipse it projects to, filled with a soft radial light. */
  function floorLight(ctx: CanvasRenderingContext2D, x: number, z: number, r: number, color: string, alpha: number) {
    const c = project(tmp.set(x, 0, z));
    if (!c || alpha <= 0.002) return;
    const px = project(new THREE.Vector3(x + r, 0, z)), pz = project(new THREE.Vector3(x, 0, z + r));
    if (!px || !pz) return;
    ctx.save();
    ctx.setTransform(dpr * (px.x - c.x), dpr * (px.y - c.y), dpr * (pz.x - c.x), dpr * (pz.y - c.y), dpr * c.x, dpr * c.y);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, color.replace('A', alpha.toFixed(3)));
    g.addColorStop(0.55, color.replace('A', (alpha * 0.45).toFixed(3)));
    g.addColorStop(1, color.replace('A', '0'));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawFloor() {
    if (!fctx) return;
    const ctx = fctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, floor.width, floor.height);
    floor.style.opacity = (1 - isolate).toFixed(3);
    if (!items.length || isolate >= 0.999) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fx = temporalX(focus);
    const x0 = Math.floor((fx - 2600) / TILE) * TILE, x1 = fx + 3800;
    const z0 = -2400, z1 = 1100;

    // The floor's surface, a little lighter than the room, fading out far away.
    const corners = [new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 0, z0), new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x0, 0, z1)];
    const poly: Pt[] = [];
    for (let i = 0; i < 4; i++) {
      const s = segment(corners[i], corners[(i + 1) % 4]);
      if (s) poly.push(s[0], s[1]);
    }
    const base = project(tmp.set(fx, 0, 160));
    if (poly.length > 2 && base) {
      const top = Math.min(...poly.map((p) => p.y));
      const g = ctx.createLinearGradient(0, top, 0, vh);
      g.addColorStop(0, 'rgba(24, 20, 17, 0)');
      g.addColorStop(0.25, 'rgba(24, 20, 17, 0.55)');
      g.addColorStop(1, 'rgba(14, 12, 10, 0.9)');
      ctx.fillStyle = g;
      ctx.beginPath();
      poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    }

    // Tiles, world-anchored, fading with distance from the slide in front.
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 236, 210, 0.075)';
    ctx.beginPath();
    for (let x = x0; x <= x1; x += TILE) {
      const s = segment(tmp.set(x, 0, z0).clone(), new THREE.Vector3(x, 0, z1));
      if (s) { ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); }
    }
    for (let z = z0; z <= z1; z += TILE) {
      const s = segment(new THREE.Vector3(x0, 0, z), new THREE.Vector3(x1, 0, z));
      if (s) { ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); }
    }
    ctx.stroke();
    if (base) {
      ctx.globalCompositeOperation = 'destination-in';
      const fade = ctx.createRadialGradient(base.x, base.y, 0, base.x, base.y, Math.max(vw, vh) * 0.75);
      fade.addColorStop(0, 'rgba(0,0,0,1)');
      fade.addColorStop(0.55, 'rgba(0,0,0,0.6)');
      fade.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, vw, vh);
    }
    ctx.restore();

    // Dappled sunlight, as if through leaves: soft warm patches, fixed to the floor.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const CELL = 280;
    for (let k = Math.floor((fx - 1800) / CELL); k <= Math.ceil((fx + 3000) / CELL); k++) {
      const r = rand(k * 7919 + 13);
      const spots = 1 + Math.floor(r() * 2.4);
      for (let s = 0; s < spots; s++) {
        const x = k * CELL + r() * CELL, z = -900 + r() * 1700, rad = 40 + r() * 120;
        const away = 1 - smooth(900, 2600, Math.abs(x - fx));
        floorLight(ctx, x, z, rad, 'rgba(255, 186, 112, A)', (0.06 + r() * 0.15) * away);
      }
    }
    // Warm light where the row stands, and under the slide in front.
    if (items.length) {
      const s = segment(new THREE.Vector3(items[0].obj.position.x - 120, 0, 0), new THREE.Vector3(items[items.length - 1].obj.position.x + 120, 0, 0));
      if (s) {
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(255, 196, 120, 0.06)';
        ctx.lineWidth = 16;
        ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 214, 160, 0.14)';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); ctx.stroke();
      }
      const front = items[clamp(Math.round(focus), 0, items.length - 1)];
      floorLight(ctx, front.obj.position.x, front.obj.position.z, front.w * 0.75, 'rgba(255, 200, 130, A)', 0.2 * Math.max(0, front.pull));
    }
    ctx.restore();
    drawPrism(ctx);
  }

  /** Four longitudinal edges and faint side panes: one continuous volume, with no end caps or frame boxes. */
  function drawPrism(ctx: CanvasRenderingContext2D) {
    const x0 = camera.position.x - spacing * 2;
    const x1 = temporalX(focus) + spacing * density() * 45;
    const bottom = (SLIDE_H - prismHeight) / 2, top = bottom + prismHeight;
    const left = -prismWidth / 2, right = prismWidth / 2;
    const edges = [[bottom, left], [top, left], [top, right], [bottom, right]];
    ctx.save();
    ctx.lineWidth = 1;
    for (let i = 0; i < edges.length; i++) {
      const [y, z] = edges[i], [ny, nz] = edges[(i + 1) % edges.length];
      const a = new THREE.Vector3(x0, y, z), b = new THREE.Vector3(x1, y, z);
      const rail = segment(a, b);
      if (!rail) continue;
      // The clipped near point can be thousands of screen pixels away. Anchor the fade around
      // focus instead, so all four guides remain legible as they converge into temporal depth.
      const anchor = project(new THREE.Vector3(temporalX(focus), y, z)) ?? rail[0];
      const fade = ctx.createLinearGradient(anchor.x, anchor.y, rail[1].x, rail[1].y);
      fade.addColorStop(0, 'rgba(214, 232, 233, 0.28)');
      fade.addColorStop(0.75, 'rgba(214, 232, 233, 0.09)');
      fade.addColorStop(1, 'rgba(214, 232, 233, 0)');
      ctx.strokeStyle = fade;
      ctx.beginPath();
      ctx.moveTo(rail[0].x, rail[0].y); ctx.lineTo(rail[1].x, rail[1].y);
      ctx.stroke();
      const corners = [a, b, new THREE.Vector3(x1, ny, nz), new THREE.Vector3(x0, ny, nz)];
      const poly: Pt[] = [];
      for (let j = 0; j < corners.length; j++) {
        const s = segment(corners[j], corners[(j + 1) % corners.length]);
        if (s) poly.push(...s);
      }
      if (poly.length < 3) continue;
      // Only longitudinal panes: their distant cutoff fades away, with no transverse end wall.
      const glass = ctx.createLinearGradient(anchor.x, anchor.y, rail[1].x, rail[1].y);
      glass.addColorStop(0, 'rgba(178, 211, 217, 0.009)');
      glass.addColorStop(1, 'rgba(178, 211, 217, 0)');
      ctx.fillStyle = glass;
      ctx.beginPath();
      poly.forEach((p, j) => j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // ---------- the timeline ----------
  interface Label { el: HTMLElement; at: () => THREE.Vector3; align: 'start' | 'end' | 'middle'; width: number }
  const tlLabels: Label[] = [];
  const dots: SVGCircleElement[] = items.map(() => svgNode('circle', { class: 'tl-dot', r: 2 }));
  tlDots.append(...dots);

  function buildLabels() {
    if (!items.length) return;
    const first = items[0].date, lastD = items[items.length - 1].date;
    const sameYear = first.getFullYear() === lastD.getFullYear();
    const sameMonth = sameYear && first.getMonth() === lastD.getMonth();
    const sameDay = sameMonth && first.getDate() === lastD.getDate();
    const fmt = (d: Date) => (!sameYear ? String(d.getFullYear()) : !sameMonth ? fmtMonth.format(d) : !sameDay ? fmtDayShort.format(d) : fmtDay.format(d));
    const label = (text: string, year: number, at: () => THREE.Vector3, align: Label['align']) => {
      const href = opts.subspaceHref?.('year', String(year)) ?? null;
      const el = href ? h('a.tl-label', { href, title: `Every memory from ${year}` }, text) : h('span.tl-label', text);
      labels.append(el);
      tlLabels.push({ el, at, align, width: 0 });
    };
    label(fmt(first), first.getFullYear(), () => lineEnd(-1), 'start');
    if (!sameDay) label(fmt(lastD), lastD.getFullYear(), () => lineEnd(1), 'end');
    // A year mark where the row crosses into a new year.
    for (let i = 1; i < items.length; i++) {
      const y = items[i].date.getFullYear();
      if (y !== items[i - 1].date.getFullYear() && i !== items.length - 1) {
        const it = items[i];
        label(String(y), y, () => new THREE.Vector3(temporalX(it.index) - spacing * density() / 2, LINE_Y, 0), 'middle');
      }
    }
  }
  buildLabels();

  /** Where the timeline ends, a little past the first (-1) or the last (1) slide as they stand now. */
  function lineEnd(side: -1 | 1) {
    const it = side < 0 ? items[0] : items[items.length - 1];
    return new THREE.Vector3(it.obj.position.x + side * LINE_EXT, LINE_Y, 0);
  }

  /** An end label's anchor moved along the line on screen `s` until all of the label is inside the screen. */
  function keepOnScreen(q: Pt, s: [Pt, Pt], l: Label): Pt {
    const M = 14;
    const w = (l.width ||= l.el.offsetWidth);
    if (!w) return q;
    const lo = M + (l.align === 'end' ? w : 0), hi = vw - M - (l.align === 'start' ? w : 0);
    if ((q.x >= lo && q.x <= hi) || lo > hi || Math.abs(s[1].x - s[0].x) < 1) return q;
    const x = clamp(q.x, lo, hi);
    return { x, y: lerp(s[0].y, s[1].y, (x - s[0].x) / (s[1].x - s[0].x)), depth: q.depth };
  }

  /** Whether a screen point is inside a convex quad (the slide in front, on screen). */
  function inside(q: Pt[], x: number, y: number) {
    let sign = 0;
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length];
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c !== 0) {
        if (sign && Math.sign(c) !== sign) return false;
        sign = Math.sign(c);
      }
    }
    return true;
  }

  function drawTimeline() {
    tl.style.opacity = labels.style.opacity = (1 - isolate).toFixed(3);
    if (!items.length || isolate >= 0.999) return;
    const a = lineEnd(-1), b = lineEnd(1);
    const s = segment(a, b);
    for (const line of [tlLine, tlGlow]) {
      if (!s) { line.setAttribute('visibility', 'hidden'); continue; }
      line.removeAttribute('visibility');
      line.setAttribute('x1', s[0].x.toFixed(1)); line.setAttribute('y1', s[0].y.toFixed(1));
      line.setAttribute('x2', s[1].x.toFixed(1)); line.setAttribute('y2', s[1].y.toFixed(1));
    }
    [a, b].forEach((p, i) => {
      const q = project(p);
      tlEnds[i].setAttribute('visibility', q ? 'visible' : 'hidden');
      if (q) { tlEnds[i].setAttribute('cx', q.x.toFixed(1)); tlEnds[i].setAttribute('cy', q.y.toFixed(1)); }
    });
    // A dot where each slide stands on the line; the one in front has left its dot behind, lit.
    items.forEach((it, i) => {
      const dot = dots[i];
      const q = it.obj.visible ? project(tmp.set(it.obj.position.x, LINE_Y, 0)) : null;
      if (!q) { dot.setAttribute('visibility', 'hidden'); return; }
      dot.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', q.x.toFixed(1));
      dot.setAttribute('cy', q.y.toFixed(1));
      dot.setAttribute('r', clamp((2.4 * fpx) / q.depth, 0.8, 4.2).toFixed(2));
      dot.setAttribute('opacity', (it.fog * (0.45 + 0.55 * Math.max(0, it.pull))).toFixed(3));
    });
    // The slide in front stands between the line and the camera: hide the line behind it.
    const front = items[clamp(Math.round(focus), 0, items.length - 1)];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => project(new THREE.Vector3((sx * front.w) / 2, (sy * SLIDE_H) / 2, 0).applyMatrix4(front.obj.matrixWorld)));
    const quad = corners.every(Boolean) ? (corners as Pt[]) : null;
    if (quad) {
      tlMaskPoly.setAttribute('points', quad.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
      tlMaskPoly.setAttribute('fill-opacity', (selection ? 0 : 0.92 * Math.max(0, front.pull)).toFixed(3));
    }
    // Labels sit on the line above where they mark; one behind the slide in front is hidden with the line.
    // The dates at the ends stay on screen: past an edge, they sit where the line leaves the screen. A year
    // mark that would overlap them, or an earlier year mark, gives way.
    const placed: { l: Label; q: Pt; x0: number; x1: number }[] = [];
    for (const l of tlLabels) {
      const at = project(l.at());
      const q = at && s && l.align !== 'middle' ? keepOnScreen(at, s, l) : at;
      if (!q || (!selection && quad !== null && front.pull > 0.4 && inside(quad, q.x, q.y))) {
        l.el.style.visibility = 'hidden';
        continue;
      }
      const w = (l.width ||= l.el.offsetWidth);
      const x0 = l.align === 'start' ? q.x : l.align === 'end' ? q.x - w : q.x - w / 2;
      placed.push({ l, q, x0, x1: x0 + w });
    }
    placed.sort((a, b) => Number(a.l.align === 'middle') - Number(b.l.align === 'middle'));
    const shown: typeof placed = [];
    for (const p of placed) {
      const clash = shown.some((o) => o.x0 < p.x1 + 8 && p.x0 < o.x1 + 8 && Math.abs(o.q.y - p.q.y) < 22);
      p.l.el.style.visibility = clash ? 'hidden' : '';
      if (clash) continue;
      shown.push(p);
      const dx = p.l.align === 'start' ? '0%' : p.l.align === 'end' ? '-100%' : '-50%';
      p.l.el.style.transform = `translate(${p.q.x.toFixed(1)}px, ${p.q.y.toFixed(1)}px) translate(${dx}, -170%)`;
    }
  }

  // ---------- the slide in front: what it is, and what can be done with it ----------
  function showInfo(it: Item) {
    infoTitle.textContent = it.doc.worldTitle;
    infoMeta.textContent = `${fmtDay.format(it.date)} · ${it.doc.kind === 'photo' ? 'The photo' : `${it.doc.title}, a view inside the world`}`;
    infoCaption.textContent = it.doc.caption ?? '';
    infoCaption.hidden = !it.doc.caption;
    infoActions.replaceChildren();
    const playBtn = h('button.primary', { type: 'button', title: 'Pull out this memory, then press again to enter (Enter)' }, selection ? 'Enter world' : 'Pull out');
    playBtn.addEventListener('click', () => play());
    infoActions.append(playBtn);
    if (opts.onAnimate) {
      const animate = h('button', { type: 'button', title: 'Animate this image or play its generated videos' }, 'Film');
      animate.addEventListener('click', () => opts.onAnimate?.(it.doc));
      infoActions.append(animate);
    }
    infoActions.append(h('a.button', { href: worldHref(it.doc.world, { build: true, query: 'refine=1' }), title: 'Refine this world and its objects' }, 'Refine'));
    const ways = perWorld.get(it.doc.world) ?? 1;
    const href = ways > 1 ? opts.subspaceHref?.('world', it.doc.world) : null;
    const extras = h('div.space-more-menu');
    if (href) extras.append(h('a', { href, title: 'Every way into this world, as its own stack' }, `All ${ways} ways in`));
    if (it.doc.kind === 'view' && opts.onDelete) {
      const del = h('button', { type: 'button', title: 'Remove this slide (the world stays)' }, 'Remove slide');
      del.addEventListener('click', async () => {
        del.disabled = true;
        try {
          if (!(await opts.onDelete!(it.doc))) del.disabled = false;
        } catch {
          del.disabled = false;
        }
      });
      extras.append(del);
    }
    if (extras.childElementCount) {
      const more = h('details.space-more', h('summary', { 'aria-label': 'More slide actions', title: 'More slide actions' }, '…'), extras);
      more.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && more.open) {
          event.preventDefault();
          event.stopPropagation();
          more.open = false;
          more.querySelector('summary')?.focus();
        }
      });
      infoActions.append(more);
    }
    infoActions.append(h('a.button.space-metrics', { href: worldHref(it.doc.world, { build: true }), title: 'Generation facts and evaluation for this world' }, 'WOMetrics'));
  }

  // ---------- frame loop ----------
  function kick() {
    if (!raf && !disposed) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  function tick() {
    raf = 0;
    if (disposed) return;
    // performance.now rather than the frame's timestamp: the flights start from it (and tests slow it down).
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    let moving = false;
    if (mode === 'browse') {
      const k = 1 - Math.exp(-dt * (drag?.moved ? 20 : 8.5));
      if (!selection && Math.abs(target - focus) > 0.0005) { focus += (target - focus) * k; moving = true; } else if (!selection) focus = target;
      if (!selection && Math.abs(overviewTarget - overview) > 0.0001) { overview += (overviewTarget - overview) * (1 - Math.exp(-dt * 9 / speed)); moving = true; } else if (!selection) overview = overviewTarget;
      if (Math.abs(overviewTarget - overview) < 0.0001) overview = overviewTarget;
      if (selection) {
        if (Math.abs(selection.target - selection.amount) > 0.0001) { selection.amount += (selection.target - selection.amount) * (1 - Math.exp(-dt * 9 / speed)); moving = true; }
        else selection.amount = selection.target;
        if (Math.abs(selection.target - selection.amount) < 0.0001) selection.amount = selection.target;
        if (selection.amount === 0 && selection.target === 0) {
          const s = selection;
          s.item.obj.position.copy(s.from);
          s.item.el.classList.remove('is-extracted');
          s.item.el.setAttribute('aria-label', `${s.item.doc.worldTitle}, ${fmtDay.format(s.item.date)}`);
          scene.add(s.item.obj);
          selection = null;
          s.after?.();
        }
      }
    }
    updateExtraction();
    if (flight) { stepFlight(now); moving = true; }

    placeCamera();
    placeSlides();
    renderer.render(scene, camera);
    selectionRenderer.render(selectionScene, selection ? selectionCamera : camera);
    drawFloor();
    drawTimeline();
    for (const el of [top, info, infoActions, hint, zoomControls, selectionInfo]) {
      el.style.opacity = (1 - isolate).toFixed(3);
      el.style.pointerEvents = isolate > 0.01 ? 'none' : '';
    }
    bg.style.opacity = (1 - isolate).toFixed(3);
    bars.style.opacity = barsAlpha.toFixed(3);

    // The slide in front: its mark, its sharp image, the info about it.
    if (items.length) {
      const front = selection?.item.index ?? clamp(Math.round(focus), 0, items.length - 1);
      if (front !== current) {
        current = front;
        showInfo(items[current]);
      }
      const it = items[current];
      if (it.pull > 0.02 && (!flight || flight.item !== it)) {
        const px = rowPx(it);
        markOf(it).set(restGeo(it, 1, px), { glow: 1, px, sparkle: 1 });
      }
      if (!moving && mode === 'browse' && settledOn !== current) {
        settledOn = current;
        void fullImage(it);
        opts.onSelect?.(it.doc);
      }
    }
    if (moving && !raf) raf = requestAnimationFrame(tick);
  }

  // ---------- size ----------
  function resize() {
    vw = Math.max(1, mount.clientWidth || window.innerWidth);
    vh = Math.max(1, mount.clientHeight || window.innerHeight);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    renderer.setSize(vw, vh);
    selectionRenderer.setSize(vw, vh);
    camera.aspect = vw / vh;
    camera.updateProjectionMatrix();
    selectionCamera.aspect = camera.aspect;
    selectionCamera.updateProjectionMatrix();
    fpx = (camera.projectionMatrix.elements[5] * vh) / 2;
    // Leave room around the focused plane for the prism and the planes receding beyond it.
    // Narrow screens step back further to fit the same cross-section (see placeCamera).
    distance = SLIDE_H / (0.34 * 2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
    floor.width = Math.round(vw * dpr);
    floor.height = Math.round(vh * dpr);
    tl.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    tl.setAttribute('width', String(vw));
    tl.setAttribute('height', String(vh));
    tlMaskRect.setAttribute('width', String(vw));
    tlMaskRect.setAttribute('height', String(vh));
    kick();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(mount);
  resize();

  // ---------- moving through the row ----------
  function goTo(i: number) {
    if (!items.length || mode !== 'browse') return;
    if (selection) { dismissSelection(() => goTo(i)); return; }
    target = clamp(Math.round(i), 0, items.length - 1);
    kick();
  }

  const onWheel = (e: WheelEvent) => {
    if ((e.target as Element).closest('.space-actions, .space-top, .space-info, .space-zoom, .space-selected-info')) return;
    e.preventDefault();
    if (mode !== 'browse' || !items.length) return;
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? vh : 1;
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      setZoom(overviewTarget + e.deltaY * unit / (e.ctrlKey ? 360 : 900));
      return;
    }
    if (selection) return;
    target = clamp(target + e.deltaX * unit / WHEEL_PX, 0, items.length - 1);
    clearTimeout(snapTimer);
    snapTimer = window.setTimeout(() => { target = Math.round(target); kick(); }, 160);
    kick();
  };

  let drag: { id: number; x: number; t0: number; moved: boolean; lastX: number; lastT: number; v: number } | null = null;
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; zoom: number } | null = null;
  const touchDistance = () => { const p = [...touches.values()]; return Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y); };
  const onDown = (e: PointerEvent) => {
    if (mode !== 'browse' || e.button !== 0 || !items.length) return;
    if ((e.target as Element).closest('a, button, input, .space-info, .space-actions, .space-top, .space-zoom, .space-selected-info')) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        for (const id of touches.keys()) root.setPointerCapture(id);
        pinch = { distance: Math.max(1, touchDistance()), zoom: overviewTarget };
        drag = null;
        target = Math.round(focus);
        root.classList.remove('dragging');
        suppressClick = true;
        return;
      }
    }
    if (selection || pinch) return;
    drag = { id: e.pointerId, x: e.clientX, t0: target, moved: false, lastX: e.clientX, lastT: performance.now(), v: 0 };
  };
  const onMove = (e: PointerEvent) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) {
      if (touches.size === 2) setZoom(pinch.zoom - Math.log(Math.max(1, touchDistance()) / pinch.distance) / 1.5);
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 6) {
      drag.moved = true;
      root.setPointerCapture(e.pointerId);
      root.classList.add('dragging');
    }
    if (!drag.moved) return;
    const now = performance.now();
    const dtm = Math.max(1, now - drag.lastT);
    drag.v = 0.7 * drag.v + 0.3 * ((e.clientX - drag.lastX) / dtm);
    drag.lastX = e.clientX;
    drag.lastT = now;
    target = clamp(drag.t0 - dx / DRAG_PX, -0.35, items.length - 1 + 0.35);
    kick();
  };
  const onUp = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (pinch) {
      if (!touches.size) { pinch = null; window.setTimeout(() => { suppressClick = false; }, 250); }
      drag = null;
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) {
      // A flick carries on a little; then the row settles on a slide.
      const fling = e.type !== 'pointercancel' && Math.abs(drag.v) > 0.25 ? -drag.v * 4.2 : 0;
      target = clamp(Math.round(target + fling), 0, items.length - 1);
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      root.classList.remove('dragging');
    }
    drag = null;
    kick();
  };

  const onKey = (e: KeyboardEvent) => {
    if (mode !== 'browse' || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement)?.closest('input, select, textarea, summary')) return;
    const at = selection?.item.index ?? Math.round(target);
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowUp': goTo(at - 1); break;
      case 'ArrowRight': case 'ArrowDown': goTo(at + 1); break;
      case 'Home': goTo(0); break;
      case 'End': goTo(items.length - 1); break;
      case 'PageUp': goTo(at - 8); break;
      case 'PageDown': goTo(at + 8); break;
      case 'Enter': case ' ':
        if ((e.target as HTMLElement)?.closest('a, button') && e.target !== root) return;
        play();
        break;
      case 'Escape':
        if (selection) { dismissSelection(); e.preventDefault(); return; }
        if (opts.trail?.length) location.hash = backHref;
        return;
      case '+': case '=': setZoom(overviewTarget - 0.15); break;
      case '-': case '_': setZoom(overviewTarget + 0.15); break;
      default: return;
    }
    e.preventDefault();
  };

  root.addEventListener('wheel', onWheel, { passive: false });
  let gestureZoom = 0;
  const onGestureStart = (e: Event) => { e.preventDefault(); gestureZoom = overviewTarget; drag = null; clearTimeout(snapTimer); root.classList.remove('dragging'); suppressClick = true; };
  const onGestureChange = (e: Event) => { e.preventDefault(); setZoom(gestureZoom - Math.log(Math.max(0.01, (e as Event & { scale: number }).scale)) / 1.5); };
  const onGestureEnd = (e: Event) => { e.preventDefault(); window.setTimeout(() => { suppressClick = false; }, 250); };
  root.addEventListener('gesturestart', onGestureStart, { passive: false });
  root.addEventListener('gesturechange', onGestureChange, { passive: false });
  root.addEventListener('gestureend', onGestureEnd, { passive: false });
  root.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('keydown', onKey);

  // ---------- flights ----------

  /** Where a slide of `aspect` ends up: the viewer's frame for it, facing the camera at the slide's own size. */
  function screenPose(rect: PhotoRect, s: number) {
    // At distance fpx * s, an element of the rect's size scaled by s is drawn at exactly the rect's size.
    const view = selection ? selectionCamera : camera;
    const p = new THREE.Vector3(rect.x + rect.w / 2 - vw / 2, -(rect.y + rect.h / 2 - vh / 2), -fpx * s).applyMatrix4(view.matrixWorld);
    return { p, q: view.quaternion.clone() };
  }

  /** The slide in flight: as large as its frame in the viewer, scaled down by `s` to its size in the row. */
  function makeFlyer(it: Item, rect: PhotoRect, s: number) {
    const img = h('img.slide-img', { src: it.img.src, alt: '', draggable: false });
    const frameEl = h('span.slide-frame');
    const mark = createKeyholeMark(rect.w, rect.h);
    mark.svg.classList.add('slide-mark');
    const face = h('div.slide-face', img, mark.svg);
    const el = h('div.slide.flying', { style: { width: `${rect.w}px`, height: `${rect.h}px` } }, face, frameEl);
    el.style.setProperty('--s', s.toFixed(4));
    const obj = new CSS3DObject(el);
    selectionScene.add(obj);
    return { el, obj, img, frameEl, mark };
  }

  function paintBars(it: Item, rect: PhotoRect, img: HTMLImageElement) {
    if (rect.x < 0.5 && rect.y < 0.5) return;
    try { paintBackdrop(bars, img, it.aspect); } catch { /* the bars stay dark */ }
  }

  function stepFlight(now: number) {
    const f = flight!;
    const u = clamp01((now - f.t0) / f.ms);
    // u runs from the row to the camera when entering and from the camera to the row when returning.
    const v = f.dir === 1 ? u : 1 - u;
    const e = easeInOut(v);
    const er = f.dir === 1 ? easeOut(Math.min(1, v / 0.78)) : 1 - easeOut(Math.min(1, (1 - v) / 0.78));
    f.obj.position.lerpVectors(f.from.p, f.to.p, e);
    // A little arc upward, so the slide lifts out of the row rather than sliding across the floor.
    f.obj.position.y += Math.sin(Math.PI * e) * SLIDE_H * 0.1;
    f.obj.quaternion.slerpQuaternions(f.from.q, f.to.q, er);
    f.obj.scale.setScalar(f.s);
    // The mark: the keyhole as it rests in the row (an eighth of its size, sparkling) grows over the whole flight to
    // the keyhole the viewer shows while its world loads at the camera. The sparkle is gone by the time it is half grown.
    const m = smooth(0.04, 1, v);
    f.obj.updateMatrixWorld();
    const depth = Math.max(1, -tmp.copy(f.obj.position).applyMatrix4((selection ? selectionCamera : camera).matrixWorldInverse).z);
    f.mark.set(lerpGeo(f.geo.from, f.geo.to, m), {
      glow: lerp(f.look.from.glow, f.look.to.glow, m),
      px: Math.max(0.02, (fpx * f.s) / depth),
      sparkle: lerp(f.look.from.sparkle ?? 0, f.look.to.sparkle ?? 0, smooth(0, 0.5, m)),
    });
    f.frameEl.style.opacity = (1 - smooth(0.15, 0.85, v)).toFixed(3);
    isolate = smooth(0, f.dir === 1 ? 0.5 : 0.75, v);
    barsAlpha = smooth(0.55, 1, v);
    if (u >= 1) {
      const done = f.done;
      flight = null;
      done();
    }
  }

  function play() {
    if (mode !== 'browse' || !items.length || current < 0) return;
    if (!selection) { extractItem(items[current]); return; }
    if (selection.amount !== 1 || selection.target !== 1) return;
    const it = selection.item;
    // Settle on the slide in front first, so it flies from where it stands, and hold the camera still: the
    // slide lands on a rectangle of the screen, computed now.
    focus = target = it.index;
    placeCamera();
    placeSlides();
    mode = 'flying';
    clearTimeout(snapTimer);
    const rect = photoFrame(window.innerWidth, window.innerHeight, it.aspect);
    const s = SLIDE_H / rect.h;
    const fly = makeFlyer(it, rect, s);
    const full = fullImage(it);
    void full.then((img) => {
      if (img) fly.img.src = img.src;
      paintBars(it, rect, img ?? it.img);
    });
    it.obj.updateMatrixWorld();
    const local = rect.h / SLIDE_H;
    const end = apertureGeometry({ w: window.innerWidth, h: window.innerHeight, photo: rect });
    flight = {
      item: it,
      ...fly,
      rect,
      s,
      from: { p: it.obj.position.clone(), q: it.obj.quaternion.clone() },
      to: screenPose(rect, s),
      geo: { from: restGeo(it, local, rowPx(it)), to: { cx: end.cx - rect.x, cy: end.cy - rect.y, size: end.size } },
      look: { from: { glow: 1, px: 1, sparkle: 1 }, to: { glow: 1, px: 1, sparkle: 0 } },
      t0: performance.now(),
      ms: FLIGHT_MS * speed,
      dir: 1,
      done: () => {
        // Hold the slide where it landed until its full image is ready (it usually is), then hand it over.
        void Promise.race([full, new Promise<null>((r) => setTimeout(() => r(null), 1500))]).then((img) => {
          if (disposed) return;
          mode = 'gone';
          const cover = buildCover({ image: img ?? fly.img, aspect: it.aspect, dormant: true, w: window.innerWidth, h: window.innerHeight });
          opts.onPlay(it.doc, cover);
        });
      },
    };
    kick();
  }

  function returnFrom(key: string, cover: HTMLElement | null): boolean {
    const it = items.find((x) => x.key === key);
    if (!it || mode !== 'browse') return false;
    focus = target = it.index;
    settledOn = it.index;
    extractItem(it, true);
    isolate = 1;
    barsAlpha = 1;
    placeCamera();
    placeSlides();
    renderer.render(scene, camera);
    mode = 'flying';
    const rect = photoFrame(window.innerWidth, window.innerHeight, it.aspect);
    const s = SLIDE_H / rect.h;
    const fly = makeFlyer(it, rect, s);
    fly.img.src = it.doc.image.url;
    // The bars around an image shown whole: from the cover's copy of the image, which is decoded already.
    const shown = cover?.querySelector('img');
    if (shown) paintBars(it, rect, shown);
    void fullImage(it);
    it.obj.updateMatrixWorld();
    const local = rect.h / SLIDE_H;
    const end = apertureGeometry({ w: window.innerWidth, h: window.innerHeight, photo: rect });
    flight = {
      item: it,
      ...fly,
      rect,
      s,
      from: { p: it.obj.position.clone(), q: it.obj.quaternion.clone() },
      to: screenPose(rect, s),
      geo: { from: restGeo(it, local, rowPx(it)), to: { cx: end.cx - rect.x, cy: end.cy - rect.y, size: end.size } },
      // The viewer's photo has no mark; the keyhole comes up as the slide settles back in the row, shrinking to its
      // resting size and sparkling again.
      look: { from: { glow: 1, px: 1, sparkle: 1 }, to: { glow: 0, px: 1, sparkle: 0 } },
      t0: performance.now(),
      ms: RETURN_MS * speed,
      dir: -1,
      done: () => {
        it.el.style.visibility = '';
        fly.obj.removeFromParent();
        barsAlpha = 0;
        isolate = 0;
        mode = 'browse';
        root.focus({ preventScroll: true });
        kick();
      },
    };
    // The cover goes once the flying slide is drawn underneath it.
    if (cover) requestAnimationFrame(() => requestAnimationFrame(() => removeCover(cover, 120)));
    kick();
    return true;
  }

  // ---------- automation (?debug) ----------
  const api: SpaceApi = {
    state: () => ({ mode, focus, target, current, key: items[current]?.key ?? null, isolate, count: items.length, zoom: overview, zoomTarget: overviewTarget, extracted: selection?.item.key ?? null, extraction: selection?.amount ?? 0, extractionTarget: selection?.target ?? 0 }),
    keys: () => items.map((it) => it.key),
    geometry: () => ({
      spacing: spacing * density(),
      restingSpacing: spacing,
      crossSection: { height: prismHeight, width: prismWidth },
      camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() },
      frames: items.map((it) => ({ key: it.key, position: it.obj.position.toArray(), quaternion: it.obj.quaternion.toArray() })),
    }),
    select: (key: string) => { const it = items.find((x) => x.key === key); if (it) goTo(it.index); },
    zoom: setZoom,
    extract: (key: string) => { const it = items.find((x) => x.key === key); if (it) extractItem(it); },
    dismiss: () => dismissSelection(),
    play,
    flight: () => (flight ? { u: clamp01((performance.now() - flight.t0) / flight.ms), dir: flight.dir, box: flight.el.getBoundingClientRect().toJSON(), rect: flight.rect } : null),
  };
  if (debug) Object.assign(((window as unknown as { __wom?: object }).__wom ??= {}), { space: api });

  root.focus({ preventScroll: true });
  kick();

  return {
    el: root,
    select: api.select,
    play,
    returnFrom,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      clearTimeout(snapTimer);
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}
