// The live 3D viewer: the head and body as separate splat objects, the original single object, one orbit camera.
// Two canvases are stacked and the top one is clipped at the divider, so "one object | split" is a real wipe in 3D.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const BG = 0x0d0a0b;
const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const div = (cls, tag = 'div') => { const n = document.createElement(tag); n.className = cls; return n; };
const NS = 'http://www.w3.org/2000/svg';

// Camera presets: where to look, how far, how wide, and which way round (degrees).
const VIEWS = {
  face: { target: [-0.02, 0.07, -1.32], dist: 0.85, fov: 26, az: 0, el: 0 },
  eyes: { target: [-0.0425, 0.1065, -1.29], dist: 0.42, fov: 12, az: 0, el: 0 },
  bust: { target: [0, 0.01, -1.31], dist: 1.31, fov: 28, az: 0, el: 0 },
  side: { target: [-0.02, 0.07, -1.32], dist: 0.85, fov: 26, az: 52, el: 6 },
};
const EXPLODE = { head: 0.12, body: -0.07 }; // metres each part moves at full pull

export async function createViewer(stage, data, { onProgress } = {}) {
  const V = data.viewer, L = V.layout;
  const listeners = {};
  const on = (ev, fn) => { (listeners[ev] ??= []).push(fn); };
  const emit = (ev, ...a) => (listeners[ev] ?? []).forEach((f) => f(...a));

  // ---- two canvases, each with its own renderer and scene (same settings as the app's viewer) ----
  const canvas = (cls) => { const c = document.createElement('canvas'); c.className = cls; stage.append(c); return c; };
  const side = (c) => {
    const renderer = new THREE.WebGLRenderer({ canvas: c, antialias: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);
    return { renderer, scene, spark, camera: new THREE.PerspectiveCamera(26, 16 / 9, 0.02, 50) };
  };
  const cA = canvas('a'), cB = canvas('b');
  const A = side(cA), B = side(cB); // A: the split (underneath), B: the single object (on top, clipped)

  // ---- the parts ----
  const loaded = new Map();
  const total = Object.values(data.bytes.spz).reduce((a, b) => a + b, 0);
  const mesh = (name) => new SplatMesh({ url: `assets/splats/${name}.spz`, onProgress: (ev) => { loaded.set(name, ev?.loaded ?? 0); onProgress?.(Math.min(1, [...loaded.values()].reduce((a, b) => a + b, 0) / total)); } });
  const group = (p) => { const g = new THREE.Group(); g.position.fromArray(p.position); g.quaternion.fromArray(p.quaternion); g.scale.setScalar(p.scale); return g; };
  const mHead = mesh('head'), mHeadEyes = mesh('head-eyes'), mBody = mesh('body'), mOne = mesh('one-object');
  const gHead = group(L.head), gHeadEyes = group(L.head), gBody = group(L.body), gOne = group(L.one);
  gHead.add(mHead); gHeadEyes.add(mHeadEyes); gBody.add(mBody); gOne.add(mOne);
  const headWrap = new THREE.Group(), bodyWrap = new THREE.Group();
  headWrap.add(gHead, gHeadEyes); bodyWrap.add(gBody);
  A.scene.add(headWrap, bodyWrap); B.scene.add(gOne);
  await Promise.all([mHead, mHeadEyes, mBody, mOne].map((m) => m.initialized));

  // ---- overlay: vignette, orbit surface, labels, divider ----
  stage.append(div('v-vig'));
  const hit = div('v-hit'); stage.append(hit);
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'v-svg'); stage.append(svg);
  const parts = {
    head: { label: div('v-label'), line: document.createElementNS(NS, 'line'), dot: document.createElementNS(NS, 'circle') },
    body: { label: div('v-label'), line: document.createElementNS(NS, 'line'), dot: document.createElementNS(NS, 'circle') },
  };
  const headLabel = (withEyes) => { parts.head.label.innerHTML = `<b>Head</b><span>Its own 3D model: ${(withEyes ? data.gaussians.headEyes : data.gaussians.head).toLocaleString('en-US')} Gaussians</span>`; };
  headLabel(true); // the eye corrector is on at start
  parts.body.label.innerHTML = `<b>Body</b><span>Its own 3D model: ${data.gaussians.body.toLocaleString('en-US')} Gaussians</span>`;
  for (const p of Object.values(parts)) { svg.append(p.line, p.dot); p.dot.setAttribute('r', '4'); stage.append(p.label); p.label.style.opacity = '0'; }
  const tagL = div('v-tag'), tagR = div('v-tag'); tagL.style.left = '12px'; tagR.style.right = '12px'; stage.append(tagL, tagR);
  const handle = div('v-handle'); handle.setAttribute('role', 'slider'); handle.setAttribute('tabindex', '0'); handle.setAttribute('aria-label', 'Divider between one object and the split'); handle.append(document.createElement('i')); stage.append(handle);

  // ---- camera ----
  const camera = new THREE.PerspectiveCamera(26, 16 / 9, 0.02, 50);
  const controls = new OrbitControls(camera, hit);
  hit.style.touchAction = 'pan-y'; // vertical swipes still scroll the page on touch screens
  Object.assign(controls, { enablePan: false, enableZoom: false, enableDamping: true, dampingFactor: 0.09, rotateSpeed: 0.7, minDistance: 0.3, maxDistance: 2.2, minAzimuthAngle: -rad(85), maxAzimuthAngle: rad(85), minPolarAngle: rad(40), maxPolarAngle: rad(125) });
  const poseOf = (v) => {
    const az = rad(v.az), el = rad(v.el), t = new THREE.Vector3(...v.target);
    return { target: t, pos: new THREE.Vector3(t.x + v.dist * Math.sin(az) * Math.cos(el), t.y + v.dist * Math.sin(el), t.z + v.dist * Math.cos(az) * Math.cos(el)), fov: v.fov };
  };
  let viewName = 'face', tween = null, sway = true, swayT0 = 0, swayBase = null, interacted = false;
  const setView = (v) => { const p = poseOf(v); controls.target.copy(p.target); camera.position.copy(p.pos); camera.fov = p.fov; camera.updateProjectionMatrix(); controls.update(); };

  // ---- state ----
  let visible = false, mode = 'compare', eyes = true, explode = 0, pos = 0.5, showA = true, showB = true, raf = 0, until = 0, frames = 0, w = 1, h = 1;
  const tmp = new THREE.Vector3();
  const kick = (ms = 1600) => { until = Math.max(until, performance.now() + ms); if (!raf) raf = requestAnimationFrame(tick); };
  const syncCam = (S) => { S.camera.position.copy(camera.position); S.camera.quaternion.copy(camera.quaternion); S.camera.fov = camera.fov; S.camera.aspect = camera.aspect; S.camera.near = camera.near; S.camera.far = camera.far; S.camera.updateProjectionMatrix(); S.camera.updateMatrixWorld(); };
  const project = (x, y, z) => { tmp.set(x, y, z).project(camera); return [(tmp.x * 0.5 + 0.5) * w, (-tmp.y * 0.5 + 0.5) * h]; };

  function updateLabels() {
    const show = mode === 'split' && explode > 0.12;
    for (const [name, p] of Object.entries(parts)) {
      const on = show;
      p.label.style.opacity = on ? '1' : '0'; p.line.style.display = p.dot.style.display = on ? '' : 'none';
      if (!on) continue;
      const c = V.anchors[name].center, dy = EXPLODE[name] * explode;
      const [px, py] = project(c[0], c[1] + dy, c[2]), [qx, qy] = project(c[0] + 0.22, c[1] + dy, c[2]);
      const lw = p.label.offsetWidth || 190, x = clamp(qx, 8, w - lw - 8);
      p.label.style.left = `${x}px`; p.label.style.top = `${qy}px`; p.label.style.transform = 'translateY(-50%)';
      p.line.setAttribute('x1', px); p.line.setAttribute('y1', py); p.line.setAttribute('x2', x); p.line.setAttribute('y2', qy);
      p.dot.setAttribute('cx', px); p.dot.setAttribute('cy', py);
    }
  }

  function tick(now) {
    raf = 0;
    if (!visible) return; // off screen: draw nothing, wake up when it is seen again
    if (tween) {
      const k = clamp((now - tween.t0) / tween.ms, 0, 1), e = ease(k);
      controls.target.lerpVectors(tween.fromT, tween.to.target, e); camera.position.lerpVectors(tween.fromP, tween.to.pos, e);
      camera.fov = tween.fromF + (tween.to.fov - tween.fromF) * e; camera.updateProjectionMatrix();
      if (k >= 1) tween = null;
    } else if (sway && !interacted) {
      swayBase ??= camera.position.clone().sub(controls.target);
      if (!swayT0) swayT0 = now;
      const t = (now - swayT0) / 1000;
      if (t > 7) { sway = false; } else {
        const a = Math.sin(t * 0.9) * rad(5) * Math.min(1, t / 1.2) * Math.min(1, (7 - t) / 1.2);
        camera.position.copy(controls.target).add(swayBase.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a));
      }
    }
    const moved = controls.update();
    camera.updateMatrixWorld();
    if (showA) { syncCam(A); A.renderer.render(A.scene, A.camera); }
    if (showB) { syncCam(B); B.renderer.render(B.scene, B.camera); }
    updateLabels();
    frames++;
    if (moved || tween || (sway && !interacted) || now < until) raf = requestAnimationFrame(tick);
  }

  function resize() {
    w = stage.clientWidth; h = stage.clientHeight; if (!w || !h) return;
    for (const S of [A, B]) S.renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix(); kick();
  }

  function applyMode() {
    showA = mode === 'split' || mode === 'compare'; showB = mode === 'one' || mode === 'compare';
    cA.style.display = showA ? '' : 'none'; cB.style.display = showB ? '' : 'none';
    stage.style.setProperty('--pos', mode === 'one' ? '100%' : `${(pos * 100).toFixed(2)}%`);
    handle.style.display = mode === 'compare' ? '' : 'none';
    tagL.style.display = showB ? '' : 'none'; tagR.style.display = showA ? '' : 'none';
    tagL.textContent = 'One object'; tagR.textContent = eyes ? 'Split + eye corrector' : 'Split';
    kick();
  }

  // ---- interaction ----
  controls.addEventListener('start', () => { interacted = true; tween = null; if (viewName) { viewName = ''; emit('userMove'); } kick(); });
  controls.addEventListener('change', () => kick());
  hit.addEventListener('wheel', (e) => { // zoom only with Ctrl/Cmd (or a trackpad pinch), so the page still scrolls
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); interacted = true; tween = null;
    const off = camera.position.clone().sub(controls.target); off.setLength(clamp(off.length() * Math.exp(e.deltaY * 0.0018), controls.minDistance, controls.maxDistance));
    camera.position.copy(controls.target).add(off); controls.update(); kick();
  }, { passive: false });
  let drag = false;
  const setPos = (p) => { pos = clamp(p, 0.03, 0.97); handle.setAttribute('aria-valuenow', String(Math.round(pos * 100))); applyMode(); };
  handle.addEventListener('pointerdown', (e) => { drag = true; handle.setPointerCapture(e.pointerId); e.preventDefault(); });
  handle.addEventListener('pointermove', (e) => { if (!drag) return; const r = stage.getBoundingClientRect(); setPos((e.clientX - r.left) / r.width); });
  const endDrag = (e) => { drag = false; if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId); };
  handle.addEventListener('pointerup', endDrag); handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('keydown', (e) => { const s = e.shiftKey ? 0.1 : 0.02; if (e.key === 'ArrowLeft') setPos(pos - s); else if (e.key === 'ArrowRight') setPos(pos + s); else return; e.preventDefault(); });

  // ---- public API ----
  const api = {
    on,
    setMode(m) { mode = m; applyMode(); },
    setEyes(b) { eyes = !!b; gHeadEyes.visible = eyes; gHead.visible = !eyes; headLabel(eyes); applyMode(); },
    setExplode(t) {
      const was = explode; explode = clamp(t, 0, 1);
      headWrap.position.y = explode * EXPLODE.head; bodyWrap.position.y = explode * EXPLODE.body;
      if (was <= 0.02 && explode > 0.02 && (viewName === 'face' || viewName === 'eyes')) api.view('bust'); // make room for the gap
      kick();
    },
    setPos,
    view(name) {
      const v = VIEWS[name]; if (!v) return;
      viewName = name; interacted = true; sway = false;
      tween = { t0: performance.now(), ms: 900, fromT: controls.target.clone(), fromP: camera.position.clone(), fromF: camera.fov, to: poseOf(v) };
      emit('view', name); kick(2200);
    },
    state() {
      return {
        mode, eyes, explode, pos, view: viewName, frames, size: [w, h], visibleA: showA, visibleB: showB,
        loop: { visible, running: !!raf, tween: !!tween, sway: sway && !interacted, msUntil: Math.round(until - performance.now()) },
        camera: { position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov, distance: camera.position.distanceTo(controls.target) },
        splats: { head: mHead.numSplats, headEyes: mHeadEyes.numSplats, body: mBody.numSplats, one: mOne.numSplats },
      };
    },
  };

  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver((es) => { const v = es[0].isIntersecting; if (v && !visible) { visible = true; swayT0 = 0; kick(2000); } else visible = v; }, { threshold: 0.25 }).observe(stage);
  gHead.visible = false; gHeadEyes.visible = true;
  setView(VIEWS.face); resize(); applyMode();
  handle.setAttribute('aria-valuenow', '50');
  stage.classList.add('ready');
  kick(4000);
  return api;
}
