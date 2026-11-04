// The animated hero. One clock drives one pure function, compute(t), that says where the camera is and how much of every layer
// shows. Play, pause, scrubbing, jumping to a chapter and the test screenshots all go through it, so what you scrub to is what plays.
// Things you do (pull her apart, turn the cloud, drag the eye wipe, drag the slider) sit on top of that and pause the story.
// Every figure comes from assets/data.json; the dots are a sample of the real Gaussians (assets/hero/cloud.*, see tools/make-hero.mjs).
import { CloudRenderer, parseCloud } from './cloud.js';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
const easeIO = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
const seg = (t, a, b) => clamp((t - a) / (b - a));
const bump = (t, a, b, c, d) => smooth(seg(t, a, b)) * (1 - smooth(seg(t, c, d))); // up between a and b, down between c and d
const int = (n) => Math.round(n).toLocaleString('en-US');
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else n.setAttribute(k, v); } n.append(...kids); return n; };
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

/* ------------------------------------------------------------------ the story ------------------------------------------------------------------ */
// cameras are square windows on the photo, in photo pixels: { x, y, w }
const CAMS = {
  photo: { x: 465, y: 0, w: 810 },   // the photo from its top edge
  wide: { x: 465, y: -80, w: 810 },  // the same, with room above the head for it to lift into
  face: { x: 620, y: 120, w: 400 },  // inside the 4x face crop
  eye: { x: 757, y: 173, w: 150 },   // inside the 6x window on her right eye
};
const PULL = 64; // photo pixels each half moves when she is pulled apart
const SAM = ['hair', 'face', 'neck', 'ear', 'headband', 'hand', 'dress', 'arm-left', 'arm-right'];
const SAM_LABEL = { 'arm-left': 'left arm', 'arm-right': 'right arm' };
const ORBIT = (t) => ({ yaw: 0.27 * Math.sin((t - 14.0) * 1.05), pitch: 0.05 * Math.sin((t - 14.0) * 0.7) }); // the slow turn while the cloud is on show

const CH = [
  { id: 'usual', t0: 0, t1: 5.4, settle: 5.2, label: 'The usual way', short: 'Usual way' },
  { id: 'split', t0: 5.4, t1: 12.0, settle: 11.9, label: 'Cut her into parts', short: 'Split' },
  { id: 'build', t0: 12.0, t1: 17.6, settle: 17.2, label: 'Build each on its own', short: 'Build' },
  { id: 'place', t0: 17.6, t1: 22.6, settle: 22.4, label: 'Put every part back', short: 'Place' },
  { id: 'eyes', t0: 22.6, t1: 27.0, settle: 26.9, label: 'Hand the eyes back', short: 'Eyes' },
  { id: 'try', t0: 27.0, t1: 30.2, settle: 30.2, label: 'Try it', short: 'Try it' },
];
const T_END = CH[CH.length - 1].t1;
const chapterIndex = (t) => { let k = 0; CH.forEach((c, i) => { if (t >= c.t0) k = i; }); return k; };

/** Interpolate the camera through keyframes [[t, cam], ...]: ease between neighbours, zoom in log space so it feels even. */
function camPath(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b] = keys[i], e = easeIO((t - t0) / (t1 - t0));
      if (a === b) return a;
      const w = Math.exp(lerp(Math.log(a.w), Math.log(b.w), e));
      const cx = lerp(a.x + a.w / 2, b.x + b.w / 2, e), cy = lerp(a.y + a.w / 2, b.y + b.w / 2, e);
      return { x: cx - w / 2, y: cy - w / 2, w };
    }
  }
  return keys[keys.length - 1][1];
}

/** 1 while the camera window sits inside `rect` (so the sharper picture covers all of it), fading out as it spills over. */
function fits(cam, rect) {
  const over = Math.max(rect.x - cam.x, cam.x + cam.w - (rect.x + rect.w), rect.y - cam.y, cam.y + cam.w - (rect.y + rect.h), 0);
  return clamp(1 - over / (0.06 * cam.w));
}

/* ------------------------------------------------------------------ build ---------------------------------------------------------------------- */
export async function createHero({ data, Compare, attachLens, sharpPct }) {
  const stage = $('#stage'), world = $('#st-world'), canvas = $('#st-cloud'), svg = $('#st-svg'), ui = $('#st-ui');
  const card = { no: $('#chap-no'), kick: $('#chap-kick'), title: $('#chap-title'), text: $('#chap-text'), metric: $('#chap-metric') };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const g = data.gaussians, mi = data.modelInput;
  const FACE = data.photo.face, EW = data.photo.eyeWindow, EYE = data.eyes[0]; // her right eye: the one the story looks at
  const TIERS = {
    full: { rect: { x: 0, y: 0, w: data.photo.w, h: data.photo.h }, nat: [data.photo.w, data.photo.h] },
    face: { rect: { x: FACE.x, y: FACE.y, w: FACE.w, h: FACE.h }, nat: [FACE.w * FACE.zoom, FACE.h * FACE.zoom] },
    eye: { rect: { x: EYE.cx - EW.w / 2, y: EYE.cy - EW.h / 2, w: EW.w, h: EW.h }, nat: [EW.w * EW.zoom, EW.h * EW.zoom] },
  };
  // each version of the scene is the same picture at up to three resolutions; `need` is the first chapter that shows it
  const VARIANTS = {
    photo: { full: ['full-photo', 0], face: ['face-photo', 0], eye: ['eye-right-photo', 0] },
    one: { full: ['full-one', 0], face: ['face-one', 0], eye: ['eye-right-one', 0] },
    aligned: { full: ['full-aligned', 3], face: ['face-aligned', 4], eye: ['eye-right-aligned', 4] },
    eyes: { full: ['full-eyes', 4], face: ['face-eyes', 4], eye: ['eye-right-eyes', 4] },
  };
  const layersInfo = await (await fetch('assets/hero/layers.json')).json();

  const imgs = [];
  let kick = () => {}; // wakes the drawing loop when a picture arrives (set once the loop exists)
  // The element exists from the start so the layout is fixed, but its file is only asked for by start(): one chapter before it is shown.
  const load = (src, rect, nat, need, cls = 'st-img') => {
    const img = el('img', { class: cls, alt: '', width: nat[0], height: nat[1], decoding: 'async' });
    const rec = { img, rect, nat, need, ok: false, failed: false, started: false, src, ready: null };
    rec.start = () => {
      if (rec.started) return rec.ready;
      rec.started = true; img.src = src;
      const done = () => { rec.ok = true; kick(); };
      rec.ready = new Promise((res) => {
        const fail = () => { if (img.complete && img.naturalWidth) done(); else { rec.failed = true; kick(); } res(); };
        if (img.decode) img.decode().then(() => { done(); res(); }, fail); else { img.addEventListener('load', () => { done(); res(); }); img.addEventListener('error', fail); }
      });
      return rec.ready;
    };
    imgs.push(rec);
    return rec;
  };
  const V = {};
  for (const [name, tiers] of Object.entries(VARIANTS)) {
    const gEl = el('div', { class: 'st-v', 'data-v': name }); world.append(gEl); V[name] = { el: gEl, tiers: {} };
    for (const [tier, [file, need]] of Object.entries(tiers)) { const rec = load(`assets/img/${file}.webp`, TIERS[tier].rect, TIERS[tier].nat, need); gEl.append(rec.img); V[name].tiers[tier] = rec; }
  }
  const edges = load('assets/img/photo-edges.png', TIERS.full.rect, TIERS.full.nat, 3); world.append(edges.img);
  const lay = {};
  for (const n of ['head', 'body']) { const L = layersInfo[n]; lay[n] = load(L.src, L.rect, [L.rect.w, L.rect.h], 1, 'st-img st-layer'); }
  world.append(lay.head.img, lay.body.img); // the body above the head: the hand has to cover the filled-in jaw while she is whole
  const outl = {};
  for (const [n, P] of Object.entries(layersInfo.parts)) { outl[n] = load(P.src, P.rect, [P.rect.w, P.rect.h], 1); outl[n].color = P.color; world.append(outl[n].img); }

  // ---- the ten features: a ring where the photo has it, a line to where the 3D scene puts it ----
  const FEAT = data.features.map((f) => {
    const gEl = svgEl('g'), line = svgEl('line', { class: 'err' }), dot = svgEl('circle', { class: 'dot', r: 4.5 }), ring = svgEl('circle', { class: 'ring', cx: f.x, cy: f.y, r: 13 });
    gEl.append(line, dot, ring); svg.append(gEl);
    return { f, g: gEl, line, dot, ring };
  });
  const tone = (px) => (px < 2 ? '#63d49c' : px < 10 ? '#f2b85b' : '#ff6b6b');

  // ---- overlays on the stage ----
  const pill = el('div', { class: 'st-pill' }), hint = el('div', { class: 'st-hint' });
  const ticker = el('div', { class: 'st-ticker' }), chips = {};
  for (const n of [...SAM, 'head', 'body']) { const c = el('span', { class: 'st-chip', style: `--c:${n === 'head' ? '#ff8b78' : n === 'body' ? '#4cc2bb' : outl[n].color}` }, SAM_LABEL[n] ?? n); ticker.append(c); chips[n] = c; }
  const wipe = el('div', { class: 'st-wipe', html: '<i></i>' }), wipeL = el('div', { class: 'st-wipe-l' }), wipeR = el('div', { class: 'st-wipe-r' });
  const handle = el('div', { class: 'st-handle', role: 'slider', tabindex: '0', 'aria-label': 'Pull the head and body apart', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '100' });
  const guide = el('div', { class: 'st-guide' });
  const tagHead = el('div', { class: 'st-tag head', html: `Head<small>${int(g.head)} Gaussians</small>` }), tagBody = el('div', { class: 'st-tag body', html: `Body<small>${int(g.body)} Gaussians</small>` });
  const tagJaw = el('div', { class: 'st-tag jaw', html: 'Jaw behind the hand<small>filled in with skin</small>' });
  const tip = el('div', { class: 'st-tip' }), spin = el('div', { class: 'st-load' });
  ui.append(pill, hint, wipe, wipeL, wipeR, guide, handle, tagHead, tagBody, tagJaw, tip, ticker, spin);

  const cmpRoot = $('#hero-cmp');
  const cmp = new Compare(cmpRoot, { pos: 0.98 });
  attachLens(cmp, { before: 'assets/img/face-one.webp', after: 'assets/img/face-eyes.webp', zoom: 2.2, natural: TIERS.face.nat, position: [(CAMS.face.x - FACE.x) / (FACE.w - FACE.h), 0.5] });

  // ---- the cloud: a sample of the real Gaussians ----
  let cloudR = null, cloudFail = false, cloudP = null;
  const loadCloud = () => (cloudP ??= (async () => {
    try {
      const [m, b] = await Promise.all([fetch('assets/hero/cloud.json').then((r) => r.json()), fetch('assets/hero/cloud.bin').then((r) => r.arrayBuffer())]);
      cloudR = new CloudRenderer(parseCloud(m, b));
    } catch (err) { cloudFail = true; console.error('[hero] the Gaussian sample did not load:', err); }
    kick();
  })());
  const ctx = canvas.getContext('2d');
  let frameImg = null, cloudPx = 0, stride = 1, msAvg = 0, lastDrawn = 0, lastMs = 0;
  const A = data.viewer.anchors, PIVOT = [0, 1, 2].map((i) => (A.head.center[i] + A.body.center[i]) / 2);

  /* ---------------------------------------------------------------- sizes ---------------------------------------------------------------------- */
  let S = stage.clientWidth || 640;
  const fitCanvas = () => {
    S = stage.clientWidth || S;
    cloudPx = clamp(Math.round(S), 320, 760);
    if (canvas.width !== cloudPx) { canvas.width = cloudPx; canvas.height = cloudPx; frameImg = ctx.createImageData(cloudPx, cloudPx); }
  };
  fitCanvas();

  /* ---------------------------------------------------------------- state ---------------------------------------------------------------------- */
  const U = { pull: null, yaw: 0, pitch: 0, wipe: null, cmpTouched: false, tipFeature: null }; // what the visitor has done
  const WORST = { fit: Math.max(...data.features.map((f) => Math.hypot(...f.shift.fit))), aligned: Math.max(...data.features.map((f) => Math.hypot(...f.shift.aligned))) };
  const EYE_SHIFT = data.eyeMetrics.one.right.shift; // where the one-object render puts her right eye, off the photo's, in photo pixels
  const EYE_SLIDE = (p) => [-EYE_SHIFT[0] * p, -EYE_SHIFT[1] * p];
  const sharp = { one: sharpPct('one', 'right'), aligned: sharpPct('aligned', 'right'), eyes: sharpPct('eyes', 'right') };

  function compute(t) {
    const s = {
      t, ch: chapterIndex(t), cam: CAMS.wide, fade: smooth(seg(t, 0, 0.6)),
      v: { photo: 1, one: 0, aligned: 0, eyes: 0 }, oneClip: null, eyesClip: null, oneShift: [0, 0],
      edges: 0, parts: {}, layers: { head: 0, body: 0, dyHead: 0, dyBody: 0 }, seamA: 0, jawA: 0,
      cloud: { a: 0, assemble: 1, morph: 0, yaw: 0, pitch: 0, lift: 0 },
      rings: 0, errT: 0, wipe: null, handle: 0, pull: 0, tags: 0, jawTag: 0,
      pill: '', hint: '', ticker: 0, chipOn: {}, finale: 0, cmpPos: null, metric: null,
    };
    const c = s.ch;

    /* 01  the usual way: one 3D object, and what it does to her eyes */
    if (c === 0) {
      s.cam = camPath(t, [[1.6, CAMS.photo], [2.8, CAMS.face], [2.9, CAMS.face], [3.9, CAMS.eye]]);
      s.v.one = smooth(seg(t, 0.8, 1.4));
      s.oneShift = EYE_SLIDE(easeIO(seg(t, 3.0, 3.9)));
      s.pill = t < 0.9 ? 'Photo' : t < 3.0 ? `The usual way: one 3D object <small>· ${int(g.oneObject)} Gaussians</small>` : t < 3.9 ? 'Sliding the 3D eye onto the photo’s' : 'Slid into place, so only the detail differs';
      const p = easeIO(seg(t, 3.9, 4.7));
      if (t > 3.8) { s.oneClip = p * 0.5; s.wipe = { pos: p * 0.5, l: 'Photo', r: 'One 3D object', a: smooth(seg(t, 3.9, 4.3)) }; }
      s.metric = { type: 'count', cur: lerp(100, sharp.one, p), unit: '%', label: "of the photo's eye sharpness, right eye" };
    }

    /* 02  cut her into parts */
    if (c === 1) {
      s.cam = camPath(t, [[5.9, CAMS.eye], [7.5, CAMS.photo], [10.2, CAMS.photo], [11.0, CAMS.wide]]);
      if (t < 5.9) { const p = easeIO(seg(t, 5.4, 5.9)); s.v.one = 1; s.oneShift = EYE_SLIDE(1); s.oneClip = lerp(0.5, 1, p); s.wipe = { pos: s.oneClip, l: 'Photo', r: 'One 3D object', a: 1 - p }; }
      s.v.photo = 1 - smooth(seg(t, 10.2, 10.9));
      const merge = smooth(seg(t, 9.4, 10.0)), pull = U.pull ?? easeIO(seg(t, 10.9, 11.7));
      let shown = 0;
      SAM.forEach((n, i) => {
        const a = smooth(seg(t, 7.3 + 0.2 * i, 7.6 + 0.2 * i));
        s.parts[n] = a * (1 - merge); s.chipOn[n] = a * (1 - merge);
        if (a > 0.5) shown++;
      });
      const tint = merge * lerp(0.9, 0.55, smooth(seg(t, 10.2, 10.8)));
      s.parts.head = tint; s.parts.body = tint; s.chipOn.head = merge; s.chipOn.body = merge;
      s.seamA = bump(t, 9.9, 10.2, 10.4, 10.9); s.jawA = bump(t, 10.2, 10.5, 10.7, 11.1) * 0.9;
      s.layers.head = s.layers.body = t > 10.1 ? 1 : 0;
      s.layers.dyHead = -PULL * pull; s.layers.dyBody = PULL * pull; s.pull = pull;
      s.handle = smooth(seg(t, 11.4, 11.9)); s.jawTag = bump(t, 11.2, 11.6, 11.8, 12.1) * (pull > 0.6 ? 1 : 0);
      s.ticker = smooth(seg(t, 7.0, 7.4)) * (1 - smooth(seg(t, 10.9, 11.3)));
      s.pill = t < 7.2 ? 'Back to the photo' : t < 9.4 ? 'SAM finds the parts' : t < 10.9 ? 'Regrouped: a head and a body' : 'Pulled apart';
      s.metric = merge > 0.5 ? { type: 'count', cur: 2, from: 9, unit: ' parts', label: 'a head and a body, from the nine SAM found' } : { type: 'count', cur: shown, unit: ' of 9', label: 'parts SAM has found so far' };
      s.hint = t > 11.5 && U.pull === null ? 'Drag the handle to pull her apart' : '';
    }

    /* 03  build each on its own: the real Gaussians, assembling */
    if (c === 2) {
      const lf = 1 - smooth(seg(t, 12.0, 12.6)), ramp = smooth(seg(t, 14.0, 15.2)), o = ORBIT(t);
      s.v.photo = 0; s.layers.head = s.layers.body = lf; s.layers.dyHead = -PULL; s.layers.dyBody = PULL; s.pull = 1;
      s.parts.head = s.parts.body = 0.55 * lf;
      s.cloud = { a: smooth(seg(t, 12.0, 12.4)), assemble: easeOut(seg(t, 12.3, 14.4)), morph: 0, lift: 1, yaw: o.yaw * ramp + U.yaw, pitch: o.pitch * ramp + U.pitch };
      s.tags = smooth(seg(t, 14.0, 14.6));
      s.pill = t < 14.0 ? 'Gaussians assemble <small>· a sample of the real ones</small>' : 'Drag to turn her <small>· a sample of the real Gaussians</small>';
      const bars = easeOut(seg(t, 14.5, 16.0));
      s.metric = { type: 'bars', label: "her face as a share of the width the 3D model is given", bars: [{ l: 'One object', v: mi.faceShareWhole * bars }, { l: 'Head alone', v: mi.faceShareHead * bars, up: true }] };
    }

    /* 04  put every part back where the photo has it: the Gaussians slide into place */
    if (c === 3) {
      s.cam = camPath(t, [[17.6, CAMS.wide], [18.6, CAMS.photo]]);
      const join = easeIO(seg(t, 17.6, 18.5)), slide = easeIO(seg(t, 19.0, 20.7)), rA = smooth(seg(t, 20.3, 21.1)), settle = 1 - smooth(seg(t, 17.6, 18.4)), o = ORBIT(17.6);
      s.cloud = { a: 1 - rA, assemble: 1, morph: slide, lift: 1 - join, yaw: (o.yaw + U.yaw) * settle, pitch: (o.pitch + U.pitch) * settle };
      s.v.photo = 0; s.v.aligned = rA;
      s.edges = smooth(seg(t, 17.9, 18.5)) * (1 - smooth(seg(t, 21.8, 22.4)));
      s.rings = smooth(seg(t, 18.1, 18.6)) * (1 - smooth(seg(t, 21.9, 22.5))); s.errT = slide;
      s.pill = t < 19.0 ? 'Placed by the silhouette: outlines match, features do not' : t < 20.7 ? 'Every Gaussian is nudged sideways in the photo’s view' : 'Pixel-aligned: features, outlines and the seam land';
      s.hint = s.rings > 0.8 && t < 21.8 ? 'Hover a ring to read its error' : '';
      const cur = Math.max(...data.features.map((f) => Math.hypot(lerp(f.shift.fit[0], f.shift.aligned[0], slide), lerp(f.shift.fit[1], f.shift.aligned[1], slide))));
      s.metric = { type: 'count', cur, from: WORST.fit, dec: 1, unit: ' px', label: "the worst of ten features, off the photo's" };
    }

    /* 05  hand the eyes back to the photo */
    if (c === 4) {
      s.cam = camPath(t, [[22.6, CAMS.photo], [23.6, CAMS.face], [23.8, CAMS.face], [24.6, CAMS.eye]]);
      s.v.photo = 0; s.v.aligned = 1; s.v.eyes = 1;
      const posE = U.wipe ?? lerp(1, 0, easeIO(seg(t, 24.7, 26.2)));
      s.eyesClip = posE;
      s.wipe = { pos: posE, l: 'Before', r: 'Eye corrector', a: smooth(seg(t, 24.5, 24.9)) };
      s.pill = t < 24.5 ? 'Close in on the right eye' : `The eye corrector <small>· ${int(data.eyeCorrector.addedGaussians)} Gaussians added, colours refitted</small>`;
      s.hint = t > 26.4 && U.wipe === null ? 'Drag across the eye' : '';
      s.metric = { type: 'count', cur: lerp(sharp.aligned, sharp.eyes, easeIO(1 - posE)), from: sharp.aligned, unit: '%', label: "of the photo's eye sharpness, right eye" };
    }

    /* 06  try it */
    if (c === 5) {
      s.cam = camPath(t, [[27.0, CAMS.eye], [28.0, CAMS.face]]);
      s.v.photo = 0; s.v.aligned = 1; s.v.eyes = 1;
      s.finale = smooth(seg(t, 27.8, 28.4));
      s.cmpPos = lerp(0.98, 0.5, easeIO(seg(t, 28.3, 29.7)));
      s.pill = 'One object against the split with the eye corrector';
      const grow = easeOut(seg(t, 28.2, 29.6));
      s.metric = { type: 'bars', label: "the right eye's sharpness, as a share of the photo's", bars: [{ l: 'One object', v: (sharp.one / 100) * grow }, { l: 'Split', v: (sharp.aligned / 100) * grow }, { l: 'Split + eyes', v: (sharp.eyes / 100) * grow, up: true }] };
    }
    return s;
  }

  /* ---------------------------------------------------------------- apply ---------------------------------------------------------------------- */
  const cache = new WeakMap();
  const setStyle = (node, key, value) => { let m = cache.get(node); if (!m) cache.set(node, (m = {})); if (m[key] !== value) { m[key] = value; if (key.startsWith('--')) node.style.setProperty(key, value); else node.style[key] = value; } };
  const setHTML = (node, html) => { let m = cache.get(node); if (!m) cache.set(node, (m = {})); if (m.html !== html) { m.html = html; node.innerHTML = html; } };
  const alpha = (node, a) => setStyle(node, 'opacity', clamp(a).toFixed(3));
  const show = (node, on, how = 'block') => setStyle(node, 'display', on ? how : 'none');
  function place(rec, cam, dx = 0, dy = 0) {
    const k = S / cam.w, sc = (rec.rect.w / rec.nat[0]) * k;
    setStyle(rec.img, 'transform', `translate(${((rec.rect.x + dx - cam.x) * k).toFixed(2)}px, ${((rec.rect.y + dy - cam.y) * k).toFixed(2)}px) scale(${sc.toFixed(5)})`);
  }
  const toStage = (cam, x, y) => [(x - cam.x) * (S / cam.w), (y - cam.y) * (S / cam.w)];

  let cloudActive = false, loading = false;
  function apply(s) {
    const cam = s.cam, k = S / cam.w;
    stage.dataset.chapter = CH[s.ch].id;
    alpha(world, s.fade);
    // versions: the coarse picture always, the sharper ones where the camera is inside their area
    for (const name of ['photo', 'one', 'aligned', 'eyes']) {
      const v = V[name], base = s.v[name], on = base > 0.001;
      alpha(v.el, base); show(v.el, on);
      if (!on) continue;
      const [ox, oy] = name === 'one' ? s.oneShift : [0, 0];
      for (const [tier, rec] of Object.entries(v.tiers)) { const R = TIERS[tier].rect; place(rec, cam, ox, oy); alpha(rec.img, tier === 'full' ? 1 : fits(cam, { x: R.x + ox, y: R.y + oy, w: R.w, h: R.h })); }
    }
    setStyle(V.one.el, 'clipPath', s.oneClip === null ? 'none' : `inset(0 0 0 ${(s.oneClip * 100).toFixed(2)}%)`);
    setStyle(V.eyes.el, 'clipPath', s.eyesClip === null ? 'none' : `inset(0 0 0 ${(s.eyesClip * 100).toFixed(2)}%)`);
    // the photo's edges
    alpha(edges.img, s.edges); show(edges.img, s.edges > 0.001); if (s.edges > 0.001) place(edges, cam);
    // her, cut in two
    for (const n of ['head', 'body']) {
      const L = lay[n], a = s.layers[n], dy = n === 'head' ? s.layers.dyHead : s.layers.dyBody;
      alpha(L.img, a); show(L.img, a > 0.001);
      if (a > 0.001) { place(L, cam, 0, dy); setStyle(L.img, 'filter', Math.abs(dy) > 1 ? `drop-shadow(0 ${(8 + Math.abs(dy) * 0.12).toFixed(1)}px ${(10 + Math.abs(dy) * 0.2).toFixed(1)}px rgba(0,0,0,.55))` : 'none'); }
    }
    // outlines of the parts; head and body outlines, the jaw patch and the seam travel with their layer
    for (const [n, rec] of Object.entries(outl)) {
      let a = s.parts[n] ?? 0, dy = 0;
      if (n === 'head') dy = s.layers.dyHead; else if (n === 'body') dy = s.layers.dyBody; else if (n === 'jaw') { a = s.jawA; dy = s.layers.dyHead; } else if (n === 'seam') { a = s.seamA; dy = s.layers.dyHead; }
      show(rec.img, a > 0.01); alpha(rec.img, a);
      if (a > 0.01) place(rec, cam, 0, dy);
    }
    // the Gaussians
    const cl = s.cloud;
    if (cl.a > 0.004 && cloudR) {
      const t0 = performance.now(), lift = (cl.lift ?? 0) * PULL;
      const view = { cam, yaw: cl.yaw, pitch: cl.pitch, pivot: PIVOT, dot: 1.15, minRadius: 0.9, stride, parts: { head: { assemble: cl.assemble, morph: cl.morph, lift: [0, -lift], alpha: 1, shade: 0.28 }, body: { assemble: cl.assemble, morph: cl.morph, lift: [0, lift], alpha: 1, shade: 0.28 } } };
      lastDrawn = cloudR.render(frameImg.data, cloudPx, cloudPx, view);
      ctx.putImageData(frameImg, 0, 0);
      lastMs = performance.now() - t0; msAvg = msAvg ? msAvg * 0.85 + lastMs * 0.15 : lastMs;
      if (msAvg > 22 && stride < 3) { stride++; msAvg = 0; } else if (msAvg > 0 && msAvg < 7 && stride > 1 && cl.assemble >= 1) { stride--; msAvg = 0; }
      cloudActive = true;
    } else if (cloudActive) { ctx.clearRect(0, 0, cloudPx, cloudPx); cloudActive = false; }
    alpha(canvas, cl.a); show(canvas, cl.a > 0.004);
    // the ten features
    svg.setAttribute('viewBox', `${cam.x.toFixed(2)} ${cam.y.toFixed(2)} ${cam.w.toFixed(2)} ${cam.w.toFixed(2)}`);
    alpha(svg, s.rings); show(svg, s.rings > 0.004);
    if (s.rings > 0.004) for (const F of FEAT) {
      const sh = [lerp(F.f.shift.fit[0], F.f.shift.aligned[0], s.errT), lerp(F.f.shift.fit[1], F.f.shift.aligned[1], s.errT)], m = Math.hypot(sh[0], sh[1]), col = tone(m);
      F.ring.setAttribute('stroke', col); F.ring.setAttribute('r', U.tipFeature === F.f.id ? 20 : 13);
      F.dot.setAttribute('fill', col); F.dot.setAttribute('cx', F.f.x + sh[0]); F.dot.setAttribute('cy', F.f.y + sh[1]);
      F.line.setAttribute('x1', F.f.x); F.line.setAttribute('y1', F.f.y); F.line.setAttribute('x2', F.f.x + sh[0]); F.line.setAttribute('y2', F.f.y + sh[1]); F.line.setAttribute('stroke', col);
      F.line.style.display = F.dot.style.display = m >= 1 ? '' : 'none';
    }
    // text and controls on the stage
    setHTML(pill, s.pill); alpha(pill, s.pill ? 1 : 0);
    setHTML(hint, s.hint); alpha(hint, s.hint ? 1 : 0);
    alpha(ticker, s.ticker); for (const [n, c] of Object.entries(chips)) setStyle(c, '--on', (s.chipOn[n] ?? 0).toFixed(2));
    const wp = s.wipe, wOn = !!wp && wp.a > 0.01;
    for (const n of [wipe, wipeL, wipeR]) show(n, wOn);
    if (wOn) { setStyle(wipe, 'left', `${(wp.pos * 100).toFixed(2)}%`); setStyle(wipe, '--kx', `${(clamp(wp.pos * S, 24, S - 24) - wp.pos * S).toFixed(1)}px`); alpha(wipe, wp.a); alpha(wipeL, wp.a); alpha(wipeR, wp.a); setHTML(wipeL, wp.l); setHTML(wipeR, wp.r); }
    // the handle on her neck, and the labels
    const showH = s.handle > 0.02 && s.ch === 1;
    show(handle, showH, 'grid'); show(guide, showH);
    if (showH) {
      const [, hy] = toStage(cam, 890, 520);
      setStyle(handle, 'left', `${toStage(cam, 890, 520)[0].toFixed(1)}px`); setStyle(handle, 'top', `${hy.toFixed(1)}px`); alpha(handle, s.handle);
      setStyle(guide, 'left', `${toStage(cam, 640, 0)[0].toFixed(1)}px`); setStyle(guide, 'width', `${(500 * k).toFixed(1)}px`); setStyle(guide, 'top', `${hy.toFixed(1)}px`); alpha(guide, s.handle * 0.7);
      handle.setAttribute('aria-valuenow', String(Math.round(s.pull * 100)));
    }
    for (const node of [tagHead, tagBody]) { show(node, s.tags > 0.01); alpha(node, s.tags); }
    if (s.tags > 0.01) {
      setStyle(tagHead, 'right', '14px'); setStyle(tagHead, 'top', `${(toStage(cam, 0, 250 - PULL)[1] - 18).toFixed(1)}px`);
      setStyle(tagBody, 'right', '14px'); setStyle(tagBody, 'top', `${(toStage(cam, 0, 540 + PULL)[1] - 18).toFixed(1)}px`);
    }
    show(tagJaw, s.jawTag > 0.01); alpha(tagJaw, s.jawTag);
    if (s.jawTag > 0.01) { const [jx, jy] = toStage(cam, 560, 410 - PULL); setStyle(tagJaw, 'left', `${clamp(jx - 50, 8, Math.max(8, S - tagJaw.offsetWidth - 8)).toFixed(1)}px`); setStyle(tagJaw, 'top', `${jy.toFixed(1)}px`); }
    show(spin, loading);
    // the slider, the last scene
    alpha(cmpRoot, s.finale); stage.classList.toggle('finale', s.finale > 0.9);
    { const fin = s.finale > 0.9; if (cmpRoot.inert === fin) cmpRoot.inert = !fin; } // the slider takes no focus until the last scene shows it
    if (s.cmpPos !== null && !U.cmpTouched) cmp.set(s.cmpPos);
    drawCard(s);
  }

  /* ---------------------------------------------------------------- the card ------------------------------------------------------------------- */
  const COPY = [
    { kick: 'The usual way', title: 'One 3D object for the whole person.', text: () => `Her face takes only about a third of the width the 3D model is given. Her eyes come out smeared: ${Math.round(sharp.one)}% as sharp as the photo’s.` },
    { kick: 'Cut her into parts', title: 'Nine parts, regrouped into two.', text: () => `SAM finds hair, face, neck, ear, headband, hand, dress and both arms. They are regrouped into a head and a body that overlap across the neck, in a band up to ${data.seamBandPx} px tall. The jaw behind the hand is filled in.` },
    { kick: 'Build each on its own', title: 'Each part gets its own 3D model.', text: () => `${int(g.head)} Gaussians each. Given the head alone, her face is ${Math.round(mi.faceShareHead * 100)}% of the width instead of ${Math.round(mi.faceShareWhole * 100)}%, about ${(mi.faceShareHead / mi.faceShareWhole).toFixed(1)}× larger. The dots are a sample of the real Gaussians.` },
    { kick: 'Put every part back', title: 'Exactly where the photo has it.', text: () => 'A silhouette cannot say where an eye is. Each part is fitted to the photo’s pixels, and every Gaussian is nudged sideways in the photo’s view until features, outlines and the seam land.' },
    { kick: 'Hand the eyes back', title: 'The photo is ground truth.', text: () => `At the photo’s own camera the head matches it. A thin layer of ${int(data.eyeCorrector.addedGaussians)} new Gaussians and a colour fit close the gaps around the eyes. Outside the eyes, no pixel moves by more than ${data.eyeCorrector.outside.maxChange} in 255.` },
    { kick: 'Try it', title: 'Drag the divider.', text: () => 'One object on the left, the split with the eye corrector on the right. Move over the face to magnify it.' },
  ];
  let shownCh = -1, mNodes = null;
  function drawCard(s) {
    if (s.ch !== shownCh) {
      shownCh = s.ch; mNodes = null;
      const cp = COPY[s.ch];
      card.no.textContent = String(s.ch + 1).padStart(2, '0'); card.kick.textContent = cp.kick; card.title.textContent = cp.title; card.text.textContent = cp.text();
      for (const n of [card.title, card.text]) { n.classList.remove('chap-in'); void n.offsetWidth; n.classList.add('chap-in'); }
      card.metric.replaceChildren();
    }
    const m = s.metric;
    card.metric.hidden = !m;
    if (!m) return;
    const sig = m.type + (m.bars ? m.bars.length : '');
    if (!mNodes || mNodes.sig !== sig) {
      card.metric.replaceChildren();
      if (m.type === 'count') {
        mNodes = { sig, from: el('span', { class: 'm-from' }), arrow: el('span', { class: 'm-arrow' }, '→'), cur: el('span', { class: 'm-cur' }), unit: el('span', { class: 'm-unit' }), label: el('span', { class: 'm-label' }) };
        card.metric.append(mNodes.from, mNodes.arrow, mNodes.cur, mNodes.unit, mNodes.label);
      } else {
        mNodes = { sig, label: el('span', { class: 'm-label' }), bars: m.bars.map((b) => { const fill = el('b'), val = el('span'); return { row: el('div', { class: `m-bar ${b.up ? 'up' : ''}` }, el('span', {}, b.l), el('i', {}, fill), val), fill, val }; }) };
        card.metric.append(el('div', { class: 'm-bars' }, ...mNodes.bars.map((b) => b.row)), mNodes.label);
      }
    }
    mNodes.label.textContent = m.label;
    if (m.type === 'count') {
      const hasFrom = m.from !== undefined, dec = m.dec ?? 0, f = (v) => v.toFixed(dec), u = m.unit.trim();
      mNodes.from.hidden = mNodes.arrow.hidden = !hasFrom;
      if (hasFrom) mNodes.from.textContent = f(m.from) + (u === '%' || u === 'px' ? m.unit : '');
      mNodes.cur.textContent = f(m.cur); mNodes.unit.textContent = m.unit;
    } else m.bars.forEach((b, i) => { mNodes.bars[i].fill.style.width = `${(b.v * 100).toFixed(1)}%`; mNodes.bars[i].val.textContent = `${Math.round(b.v * 100)}%`; });
  }

  /* ---------------------------------------------------------------- clock ---------------------------------------------------------------------- */
  const ctlPlay = $('#ctl-play'), ctlChips = $('#ctl-chips'), scrub = $('#ctl-scrub');
  let t = 0, playing = false, wasPlaying = false, visible = true, raf = 0, last = 0, dirty = true;
  const needCloud = (time) => time > 9.9 && time < CH[3].t1 - 1.2; // while it is on screen, plus a lead-in
  const wantCloud = (time) => time >= CH[0].t1 * 0.6 && time < CH[3].t1; // fetched once the story is settled in, so it has arrived by the time it is needed
  const lookAhead = (time) => { const c = chapterIndex(time); return c + (c < CH.length - 1 && (time - CH[c].t0) / (CH[c].t1 - CH[c].t0) > 0.4 ? 1 : 0); }
  const cmpImgs = [...cmpRoot.querySelectorAll('img[data-src]')]; // the finale's own pictures
  /** Ask for this chapter's files, and the next chapter's once this one is 40% through (and the cloud, when its turn is near). Cheap to call every frame. */
  function prefetch() {
    const c = lookAhead(t);
    for (const r of imgs) if (!r.started && r.need <= c) r.start();
    if (c >= 4) for (const i of cmpImgs) if (!i.getAttribute('src')) i.setAttribute('src', i.dataset.src);
    if (wantCloud(t)) loadCloud();
  }
  /** True while something that should be on screen at `time` has not arrived. */
  const waiting = (time) => {
    const c = chapterIndex(time), nearEnd = c < CH.length - 1 && time > CH[c].t1 - 1.4;
    let wait = false;
    for (const r of imgs) if (r.need <= c + (nearEnd ? 1 : 0) && !r.ok && !r.failed) { r.start(); wait = true; }
    if (needCloud(time + 1.4)) { loadCloud(); if (!cloudR && !cloudFail) wait = true; }
    return wait;
  };
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (playing && !waiting(t + 0.05)) { t += dt; if (t >= T_END) { t = T_END; setPlaying(false); } }
    render();
    if (playing || dirty) schedule();
  }
  function schedule() { if (!raf && visible) { dirty = false; raf = requestAnimationFrame((n) => { if (!playing) last = n; frame(n); }); } }
  function render() { prefetch(); loading = waiting(playing ? t + 0.05 : t); apply(compute(t)); updateControls(); }
  const requestRender = () => { dirty = true; schedule(); };
  kick = requestRender;

  function setPlaying(p) {
    if (p && t >= T_END - 0.01) { t = 0; clearUser(); }
    playing = p; ctlPlay.setAttribute('aria-pressed', String(p)); ctlPlay.setAttribute('aria-label', p ? 'Pause the story' : 'Play the story');
    ctlPlay.innerHTML = p ? '<svg viewBox="0 0 16 16"><rect x="3" y="2" width="3.4" height="12" rx="1"/><rect x="9.6" y="2" width="3.4" height="12" rx="1"/></svg>' : '<svg viewBox="0 0 16 16"><path d="M4 2.2v11.6a.7.7 0 0 0 1.07.6l9-5.8a.7.7 0 0 0 0-1.2l-9-5.8A.7.7 0 0 0 4 2.2z"/></svg>';
    if (p) { last = performance.now(); schedule(); }
  }
  function clearUser() { U.pull = null; U.yaw = 0; U.pitch = 0; U.wipe = null; U.cmpTouched = false; cmp.set(0.98); }
  function seek(time, { keepUser = false } = {}) {
    const prev = chapterIndex(t); t = clamp(time, 0, T_END);
    if (!keepUser && chapterIndex(t) !== prev) { U.pull = null; U.wipe = null; U.cmpTouched = false; }
    requestRender();
  }
  function go(i, { play = true } = {}) { clearUser(); seek(CH[i].t0); setPlaying(play); if (!play) seek(CH[i].settle); }

  /* ---------------------------------------------------------------- controls ------------------------------------------------------------------- */
  const chipEls = CH.map((c, i) => {
    const b = el('button', { type: 'button', class: 'ctl-chip', 'data-ch': c.id, 'aria-label': `Chapter ${i + 1}: ${c.label}` }, el('span', { class: 'n' }, String(i + 1).padStart(2, '0')), el('span', { class: 'l' }, c.short));
    b.addEventListener('click', () => go(i, { play: !reduced })); ctlChips.append(b); return b;
  });
  scrub.max = String(T_END); scrub.step = '0.01';
  scrub.addEventListener('input', () => { setPlaying(false); seek(Number(scrub.value), { keepUser: true }); });
  ctlPlay.addEventListener('click', () => setPlaying(!playing));
  $('#hero-ctl').addEventListener('keydown', (e) => {
    if (e.target === scrub) return;
    const i = chapterIndex(t);
    if (e.key === 'ArrowRight') { go(Math.min(CH.length - 1, i + 1), { play: false }); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { go(Math.max(0, i - 1), { play: false }); e.preventDefault(); }
  });
  function updateControls() {
    const i = chapterIndex(t);
    chipEls.forEach((b, k) => { b.setAttribute('aria-current', String(k === i)); b.style.setProperty('--fill', clamp(k < i ? 1 : k === i ? (t - CH[k].t0) / (CH[k].t1 - CH[k].t0) : 0).toFixed(3)); });
    scrub.value = String(t);
    scrub.setAttribute('aria-valuetext', `${CH[i].label}, ${t.toFixed(0)} of ${T_END.toFixed(0)} seconds`);
  }

  /* ---------------------------------------------------------------- what you can do on the stage ------------------------------------------------ */
  const takeOver = () => { if (playing) setPlaying(false); };
  { // pull her apart
    let drag = null;
    handle.addEventListener('pointerdown', (e) => { takeOver(); handle.setPointerCapture(e.pointerId); drag = { y: e.clientY, pull: compute(t).pull }; e.preventDefault(); });
    handle.addEventListener('pointermove', (e) => { if (!drag) return; U.pull = clamp(drag.pull - (e.clientY - drag.y) / (PULL * (S / CAMS.wide.w)), 0, 1); requestRender(); });
    const end = (e) => { drag = null; if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId); };
    handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', (e) => {
      const cur = U.pull ?? compute(t).pull, d = e.shiftKey ? 0.25 : 0.1;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') U.pull = clamp(cur + d, 0, 1); else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') U.pull = clamp(cur - d, 0, 1); else return;
      takeOver(); requestRender(); e.preventDefault();
    });
  }
  { // turn the cloud, and drag the eye wipe
    let drag = null;
    const xOf = (e) => clamp((e.clientX - stage.getBoundingClientRect().left) / S, 0.02, 0.98);
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.st-handle, .hero-cmp')) return;
      const ch = chapterIndex(t);
      if (ch === 2) drag = { kind: 'turn', x: e.clientX, y: e.clientY, yaw: U.yaw, pitch: U.pitch };
      else if (ch === 4 && compute(t).wipe?.a > 0.5) { drag = { kind: 'wipe' }; U.wipe = xOf(e); }
      if (drag) { takeOver(); stage.setPointerCapture(e.pointerId); requestRender(); }
    });
    stage.addEventListener('pointermove', (e) => {
      if (drag?.kind === 'turn') { U.yaw = clamp(drag.yaw + (e.clientX - drag.x) * 0.006, -0.7, 0.7); U.pitch = clamp(drag.pitch + (e.clientY - drag.y) * 0.004, -0.35, 0.35); requestRender(); }
      else if (drag?.kind === 'wipe') { U.wipe = xOf(e); requestRender(); }
      else if (chapterIndex(t) === 3) hoverRing(e);
    });
    const end = (e) => { drag = null; if (stage.hasPointerCapture?.(e.pointerId)) stage.releasePointerCapture(e.pointerId); };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    stage.addEventListener('pointerleave', () => { if (U.tipFeature) { U.tipFeature = null; show(tip, false); requestRender(); } });
  }
  function hoverRing(e) { // read the error of the ring under the pointer
    const s = compute(t); if (s.rings < 0.8) return;
    const r = stage.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    let best = null, bd = 26;
    for (const F of FEAT) { const [sx, sy] = toStage(s.cam, F.f.x, F.f.y), d = Math.hypot(sx - px, sy - py); if (d < bd) { bd = d; best = F; } }
    const id = best?.f.id ?? null;
    if (id !== U.tipFeature) { U.tipFeature = id; requestRender(); }
    if (best) {
      const sh = [lerp(best.f.shift.fit[0], best.f.shift.aligned[0], s.errT), lerp(best.f.shift.fit[1], best.f.shift.aligned[1], s.errT)], [sx, sy] = toStage(s.cam, best.f.x, best.f.y);
      setHTML(tip, `<b>${best.f.label}</b><span>${Math.hypot(sh[0], sh[1]).toFixed(1)} px off the photo’s</span>`);
      setStyle(tip, 'left', `${Math.min(S - 170, Math.max(8, sx + 20)).toFixed(0)}px`); setStyle(tip, 'top', `${Math.max(8, sy - 12).toFixed(0)}px`); show(tip, true);
    } else show(tip, false);
  }
  cmpRoot.addEventListener('pointerdown', () => { U.cmpTouched = true; takeOver(); });

  /* ---------------------------------------------------------------- start ---------------------------------------------------------------------- */
  new ResizeObserver(() => { fitCanvas(); requestRender(); }).observe(stage);
  new IntersectionObserver((es) => {
    const v = es[0].isIntersecting; if (v === visible) return;
    visible = v;
    if (!v) { wasPlaying = playing; if (raf) { cancelAnimationFrame(raf); raf = 0; } } else { last = performance.now(); if (wasPlaying) { wasPlaying = false; setPlaying(true); } else requestRender(); }
  }, { threshold: 0.25 }).observe(stage);

  const api = {
    CH, T_END, PULL, compute, go, cmp, user: U,
    preload: () => Promise.all([...imgs.map((r) => r.start()), loadCloud(), ...cmpImgs.map((i) => { if (!i.getAttribute('src')) i.setAttribute('src', i.dataset.src); return i.decode?.().catch(() => {}); })]),
    seek: (time) => { seek(time); render(); }, play: () => setPlaying(true), pause: () => setPlaying(false),
    state: () => ({ t, playing, loading, chapter: CH[chapterIndex(t)].id, visible, running: !!raf, cloud: { ready: !!cloudR, drawn: lastDrawn, ms: +lastMs.toFixed(1), stride, px: cloudPx }, images: { loaded: imgs.filter((r) => r.ok).length, failed: imgs.filter((r) => r.failed).length, total: imgs.length }, finale: stage.classList.contains('finale') }),
  };

  // the first scene needs its pictures; the rest load behind it, then the story starts
  render(); setPlaying(false);
  (async () => {
    await Promise.all(imgs.filter((r) => r.need === 0).map((r) => r.start()));
    t = reduced ? CH[5].settle : 0; render();
    if (reduced) stage.dataset.reduced = 'true'; else if (visible) setPlaying(true); else wasPlaying = true;
    window.__demo.heroReady = true;
  })();
  return api;
}
