// The world viewer.
//
//  1. "photo"  – the memory is shown immediately, framed exactly like the reconstructed camera, while
//                the world loads underneath it.
//  2. "portal" – once everything is loaded, a veil darkens the photo and a play-button-shaped hole opens
//                onto the live 3D world (it breathes slightly so you can see it is 3D). ENTER THE WORLD.
//  3. "inside" – the photo is removed and SparkControls take over: W A S D to walk, drag to look.
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { SparkControls, SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { api, type LayoutOverride, type SceneDoc } from './api.ts';
import { clear, h, toast } from './dom.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface ObjectEntry {
  id: string;
  name: string;
  kind: 'splat' | 'mesh';
  group: THREE.Group;
  base: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: number };
  row?: HTMLElement;
  visible: boolean;
}

type Phase = 'photo' | 'portal' | 'entering' | 'inside' | 'returning';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A rounded triangle pointing right (a play button), as an SVG path. */
function playPath(cx: number, cy: number, size: number) {
  const pts: [number, number][] = [
    [cx - 0.4 * size, cy - 0.5 * size],
    [cx + 0.48 * size, cy],
    [cx - 0.4 * size, cy + 0.5 * size],
  ];
  const r = 0.13 * size;
  let d = '';
  for (let i = 0; i < 3; i++) {
    const p = pts[(i + 2) % 3], v = pts[i], q = pts[(i + 1) % 3];
    const d1 = Math.hypot(p[0] - v[0], p[1] - v[1]), d2 = Math.hypot(q[0] - v[0], q[1] - v[1]);
    const a = [v[0] + ((p[0] - v[0]) * r) / d1, v[1] + ((p[1] - v[1]) * r) / d1];
    const b = [v[0] + ((q[0] - v[0]) * r) / d2, v[1] + ((q[1] - v[1]) * r) / d2];
    d += `${i === 0 ? 'M' : 'L'}${a[0].toFixed(1)},${a[1].toFixed(1)} Q${v[0].toFixed(1)},${v[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)} `;
  }
  return `${d}Z`;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function renderViewer(root: HTMLElement, id: string): () => void {
  clear(root);
  let disposed = false;
  let phase: Phase = 'photo';

  // ---------- DOM ----------
  const stage = h('div.stage');
  // A tiny, darkened copy of the photo, upscaled smoothly: it fills the letterbox bars around a
  // whole (not full-bleed) photo, and the same pixels are the 3D scene's background, so nothing jumps
  // when the world takes over the bars.
  const backdrop = h('canvas.memory-backdrop') as HTMLCanvasElement;
  const photo = h('img.memory-photo', { alt: 'The original photo', draggable: false });
  const progressBar = h('div.load-bar-fill');
  const progressText = h('span', 'Opening the memory…');
  const loading = h('div.load', h('div.load-bar', progressBar), progressText);

  // Portal overlay: dimmed photo with a play-shaped hole onto the live world.
  const portalSvg = svg('svg', { class: 'portal-svg' });
  const defs = svg('defs');
  const mask = svg('mask', { id: 'wom-hole', maskUnits: 'userSpaceOnUse' });
  const maskRect = svg('rect', { fill: 'white' });
  const holeGroup = svg('g');
  const holePath = svg('path', { fill: 'black' });
  holeGroup.append(holePath);
  mask.append(maskRect, holeGroup);
  const glowFilter = svg('filter', { id: 'wom-glow', x: '-60%', y: '-60%', width: '220%', height: '220%' });
  glowFilter.append(svg('feGaussianBlur', { stdDeviation: 14 }));
  defs.append(mask, glowFilter);
  const veilGroup = svg('g', { mask: 'url(#wom-hole)' });
  const portalPhoto = svg('image', { preserveAspectRatio: 'none' });
  const veil = svg('rect', { fill: '#0a0807', opacity: 0 });
  veilGroup.append(portalPhoto, veil);
  const rimGroup = svg('g', { opacity: 0 });
  const glow = svg('path', { fill: 'none', stroke: '#ffbf6b', 'stroke-width': 18, filter: 'url(#wom-glow)', opacity: 0.9 });
  const rim = svg('path', { fill: 'none', stroke: '#ffe4b8', 'stroke-width': 2.5, 'stroke-linejoin': 'round' });
  const hitArea = svg('path', { fill: 'transparent', style: 'cursor:pointer; pointer-events: all' });
  rimGroup.append(glow, rim, hitArea);
  portalSvg.append(defs, veilGroup, rimGroup);
  const enterBtn = h('button.enter-world', { type: 'button' }, 'Enter the world');
  const portal = h('div.portal', portalSvg, enterBtn);
  portal.hidden = true;

  const titleEl = h('h1');
  const backBtn = h('button', { title: 'Return to the original photo (P)' }, 'Back to the memory');
  const panelBtn = h('button', { title: 'Layers and objects' }, 'Layers');
  const top = h('header.viewer-top', h('a.back', { href: '#/' }, '←'), titleEl, h('div.spacer'), backBtn, panelBtn, h('a.button', { href: `#/world/${id}/build` }, 'Build details'));
  const panel = h('aside.side');
  const hint = h('div.hint', 'W A S D to walk · drag to look · Q / E down and up · Shift to run · scroll to glide');
  const view = h('main.viewer', stage, top, panel, hint, portal, loading);
  stage.append(backdrop, photo);
  root.append(view);

  // ---------- three.js + Spark ----------
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  backdrop.after(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#050404');
  let backdropTex: THREE.CanvasTexture | null = null;
  const camera = new THREE.PerspectiveCamera(50, 1, 0.02, 4000);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const objectsRoot = new THREE.Group();
  scene.add(objectsRoot);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  scene.add(hemi, sun);

  // Spark's controls: FPS keys (W A S D, Q / E, arrows, Shift) and pointer look / slide / scroll.
  const controls = new SparkControls({ canvas: renderer.domElement });
  controls.fpsMovement.enable = false;
  controls.pointerControls.enable = false;

  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.8);
  scene.add(gizmo.getHelper());
  let editing = false;

  let doc: SceneDoc | null = null;
  let world: SplatMesh | null = null;
  let relief: THREE.Object3D | null = null;
  const objects: ObjectEntry[] = [];
  let selected: ObjectEntry | null = null;
  let photoAspect = 1.5;
  let photoFovY = 50;
  let sceneDepth = 4;
  const photoRect = { x: 0, y: 0, w: 0, h: 0 };
  const hole = { cx: 0, cy: 0, size: 0, scale: 0 };
  /** 1 = the canvas is clipped to the photo (letterboxed photo), 0 = the world fills the viewport. */
  let clipT = 1;
  const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

  // ---------- layout ----------
  function layout() {
    const w = stage.clientWidth, hgt = stage.clientHeight;
    if (!w || !hgt) return;
    renderer.setSize(w, hgt, false);
    const viewAspect = w / hgt;
    camera.aspect = viewAspect;
    // Full-bleed ("cover") when that crops little of the photo, else the whole photo ("contain") with
    // blurred bars. Either way the camera sees exactly what the photo shows.
    const cover = Math.min(viewAspect, photoAspect) / Math.max(viewAspect, photoAspect) >= 0.84;
    if (cover === viewAspect >= photoAspect) {
      photoRect.w = w; photoRect.h = w / photoAspect;
    } else {
      photoRect.h = hgt; photoRect.w = hgt * photoAspect;
    }
    photoRect.x = (w - photoRect.w) / 2;
    photoRect.y = (hgt - photoRect.h) / 2;
    const t = Math.tan(THREE.MathUtils.degToRad(photoFovY) / 2) * (hgt / photoRect.h);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(t));
    camera.updateProjectionMatrix();
    Object.assign(photo.style, { width: `${photoRect.w}px`, height: `${photoRect.h}px`, left: `${photoRect.x}px`, top: `${photoRect.y}px` });
    applyClip();
    fitBackdrop();

    portalSvg.setAttribute('width', String(w));
    portalSvg.setAttribute('height', String(hgt));
    portalSvg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    for (const el of [maskRect, veil]) { el.setAttribute('width', String(w)); el.setAttribute('height', String(hgt)); }
    portalPhoto.setAttribute('x', String(photoRect.x));
    portalPhoto.setAttribute('y', String(photoRect.y));
    portalPhoto.setAttribute('width', String(photoRect.w));
    portalPhoto.setAttribute('height', String(photoRect.h));
    // The hole sits on the visible part of the photo.
    const vx = Math.max(0, photoRect.x), vy = Math.max(0, photoRect.y);
    const vw = Math.min(w, photoRect.x + photoRect.w) - vx, vh = Math.min(hgt, photoRect.y + photoRect.h) - vy;
    hole.size = Math.min(vh * 0.46, vw * 0.34);
    hole.cx = vx + vw / 2 + hole.size * 0.04;
    hole.cy = vy + vh * 0.45;
    const d = playPath(hole.cx, hole.cy, hole.size);
    for (const p of [holePath, glow, rim, hitArea]) p.setAttribute('d', d);
    enterBtn.style.top = `${hole.cy + hole.size * 0.62}px`;
    setHoleScale(hole.scale);
  }
  const ro = new ResizeObserver(layout);
  ro.observe(stage);

  async function paintBackdrop(url: string) {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (disposed) return;
    backdrop.width = 40;
    backdrop.height = Math.max(1, Math.round(40 / photoAspect));
    const ctx = backdrop.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, backdrop.width, backdrop.height);
    ctx.fillStyle = 'rgba(5, 4, 4, 0.6)';
    ctx.fillRect(0, 0, backdrop.width, backdrop.height);
    backdropTex = new THREE.CanvasTexture(backdrop);
    backdropTex.colorSpace = THREE.SRGBColorSpace;
    backdropTex.minFilter = THREE.LinearFilter;
    backdropTex.generateMipmaps = false;
    scene.background = backdropTex;
    fitBackdrop();
  }

  /** Cover-fit the background texture to the viewport, like the CSS backdrop (object-fit: cover). */
  function fitBackdrop() {
    if (!backdropTex) return;
    const va = camera.aspect, ta = photoAspect;
    if (va > ta) {
      backdropTex.repeat.set(1, ta / va);
      backdropTex.offset.set(0, (1 - ta / va) / 2);
    } else {
      backdropTex.repeat.set(va / ta, 1);
      backdropTex.offset.set((1 - va / ta) / 2, 0);
    }
  }

  function applyClip() {
    const w = stage.clientWidth, hgt = stage.clientHeight;
    const l = Math.max(0, photoRect.x) * clipT, t = Math.max(0, photoRect.y) * clipT;
    const r = Math.max(0, w - photoRect.x - photoRect.w) * clipT, b = Math.max(0, hgt - photoRect.y - photoRect.h) * clipT;
    renderer.domElement.style.clipPath = l + t + r + b > 0.5 ? `inset(${t.toFixed(1)}px ${r.toFixed(1)}px ${b.toFixed(1)}px ${l.toFixed(1)}px)` : '';
  }

  function setHoleScale(s: number) {
    hole.scale = s;
    const tr = `translate(${hole.cx} ${hole.cy}) scale(${Math.max(0.0001, s)}) translate(${-hole.cx} ${-hole.cy})`;
    holeGroup.setAttribute('transform', tr);
    rimGroup.setAttribute('transform', tr);
  }

  // ---------- phases ----------
  let anim: { t0: number; dur: number; step: (e: number) => void; done?: () => void } | null = null;
  const animate = (dur: number, step: (e: number) => void, done?: () => void) => {
    anim = { t0: performance.now(), dur, step, done };
  };

  function showPortal() {
    if (disposed) return;
    phase = 'portal';
    loading.hidden = true;
    portal.hidden = false;
    photo.style.visibility = 'hidden'; // the SVG draws the same photo, so the swap is invisible
    setHoleScale(0);
    animate(1300, (e) => {
      veil.setAttribute('opacity', String(0.74 * e));
      setHoleScale(e);
      rimGroup.setAttribute('opacity', String(e));
      enterBtn.style.opacity = String(Math.max(0, (e - 0.5) * 2));
    });
    enterBtn.focus({ preventScroll: true });
  }

  function enterWorld() {
    if (phase !== 'portal') return;
    phase = 'entering';
    const w = stage.clientWidth, hgt = stage.clientHeight;
    const cover = (Math.hypot(w, hgt) / (hole.size * 0.35)) * 1.1; // big enough to uncover the viewport
    const from = hole.scale;
    animate(1100, (e) => {
      setHoleScale(from + (cover - from) * e * e);
      clipT = 1 - e;
      applyClip();
      veil.setAttribute('opacity', String(0.74 * (1 - e)));
      rimGroup.setAttribute('opacity', String(1 - e));
      enterBtn.style.opacity = String(1 - Math.min(1, e * 3));
    }, () => {
      portal.hidden = true;
      phase = 'inside';
      view.classList.add('inside');
      resetPointer();
      controls.fpsMovement.enable = true;
      controls.pointerControls.enable = !editing;
      renderer.domElement.focus();
    });
  }

  function backToMemory() {
    if (phase !== 'inside') return;
    phase = 'returning';
    setEditing(false);
    controls.fpsMovement.enable = false;
    controls.pointerControls.enable = false;
    view.classList.remove('inside');
    const fromP = camera.position.clone(), fromQ = camera.quaternion.clone();
    animate(1200, (e) => {
      camera.position.lerpVectors(fromP, new THREE.Vector3(), e);
      camera.quaternion.slerpQuaternions(fromQ, new THREE.Quaternion(), e);
      clipT = e;
      applyClip();
    }, () => {
      camera.position.set(0, 0, 0);
      camera.quaternion.identity();
      showPortal();
    });
  }

  enterBtn.addEventListener('click', enterWorld);
  hitArea.addEventListener('click', enterWorld);
  backBtn.addEventListener('click', backToMemory);
  panelBtn.addEventListener('click', () => view.classList.toggle('panel-open'));

  function resetPointer() {
    const pc = controls.pointerControls;
    pc.rotating = null;
    pc.sliding = null;
    pc.rotateVelocity.set(0, 0, 0);
    pc.moveVelocity.set(0, 0, 0);
    pc.scroll.set(0, 0, 0);
  }

  // ---------- editing (optional) ----------
  const editBtn = h('button', 'Edit layout');
  const saveBtn = h('button.primary', 'Save layout');
  const resetBtn = h('button', 'Reset');
  const editBar = h('div.edit-bar',
    h('button', { onclick: () => gizmo.setMode('translate'), title: 'G' }, 'Move'),
    h('button', { onclick: () => gizmo.setMode('rotate'), title: 'R' }, 'Rotate'),
    h('button', { onclick: () => gizmo.setMode('scale'), title: 'T' }, 'Scale'),
  );

  function setEditing(on: boolean) {
    editing = on;
    editBtn.textContent = on ? 'Done editing' : 'Edit layout';
    editBtn.classList.toggle('primary', on);
    editBar.hidden = !on;
    if (!on) select(null);
    resetPointer();
    controls.pointerControls.enable = phase === 'inside' && !on;
  }
  editBtn.addEventListener('click', () => setEditing(!editing));

  gizmo.addEventListener('dragging-changed', (e) => {
    if ((e as unknown as { value: boolean }).value) resetPointer();
  });

  const raycaster = new THREE.Raycaster();
  let downAt: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!editing || phase !== 'inside' || !downAt || gizmo.dragging) return;
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(objects.filter((o) => o.visible).map((o) => o.group), true);
    const hit = hits[0];
    if (!hit) { select(null); return; }
    select(objects.find((o) => { let n: THREE.Object3D | null = hit.object; while (n) { if (n === o.group) return true; n = n.parent; } return false; }) ?? null);
  });

  function select(entry: ObjectEntry | null) {
    selected = entry;
    if (entry) gizmo.attach(entry.group);
    else gizmo.detach();
    for (const o of objects) o.row?.classList.toggle('selected', o === selected);
  }

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'enter' && phase === 'portal') { e.preventDefault(); enterWorld(); return; }
    if (k === 'p' && phase === 'inside') { backToMemory(); return; }
    if (k === 'escape') { if (editing) setEditing(false); return; }
    if (editing && selected) {
      if (k === 'g') gizmo.setMode('translate');
      if (k === 'r') gizmo.setMode('rotate');
      if (k === 't') gizmo.setMode('scale');
    }
  };
  window.addEventListener('keydown', onKey);

  // ---------- render loop ----------
  const timer = new THREE.Timer();
  const up = new THREE.Vector3(0, 1, 0);
  const before = new THREE.Vector3();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    if (anim) {
      const t = Math.min(1, (performance.now() - anim.t0) / anim.dur);
      anim.step(ease(t));
      if (t >= 1) { const done = anim.done; anim = null; done?.(); }
    }
    if (phase === 'portal' || phase === 'entering') {
      // A slow breath of parallax inside the portal shows that the world is 3D.
      const s = time / 1000, a = 0.012 * sceneDepth;
      const sway = phase === 'portal' ? 1 : 1 - Math.min(1, (performance.now() - (anim?.t0 ?? 0)) / 900);
      camera.position.set(Math.sin(s * 0.55) * a * sway, Math.sin(s * 0.41) * a * 0.4 * sway, 0);
      camera.quaternion.setFromAxisAngle(up, Math.sin(s * 0.3) * 0.006 * sway);
    } else if (phase === 'inside') {
      before.copy(camera.position);
      controls.update(camera);
      // Walk on the level: drop vertical drift from looking up or down unless Q / E (or Page keys) are held.
      const kc = controls.fpsMovement.keycode;
      if (!kc.KeyQ && !kc.KeyE && !kc.PageUp && !kc.PageDown) {
        const d = camera.position.clone().sub(before);
        camera.position.addScaledVector(camera.up, -d.dot(camera.up));
      }
    }
    renderer.render(scene, camera);
  });

  // ---------- panel ----------
  const worldToggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const reliefToggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const objectsToggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const quality = h('select') as HTMLSelectElement;
  const objList = h('ul.obj-list');
  const diag = h('ul.diag');

  worldToggle.addEventListener('change', () => { if (world) world.visible = worldToggle.checked; });
  reliefToggle.addEventListener('change', () => { if (relief) relief.visible = reliefToggle.checked; });
  objectsToggle.addEventListener('change', () => { objectsRoot.visible = objectsToggle.checked; });
  quality.addEventListener('change', () => { void loadWorld(quality.value); });

  saveBtn.addEventListener('click', async () => {
    const list: LayoutOverride[] = objects.map((o) => ({
      id: o.id,
      position: o.group.position.toArray() as [number, number, number],
      quaternion: o.group.quaternion.toArray() as [number, number, number, number],
      scale: o.group.scale.x,
      visible: o.visible,
    }));
    try {
      await api.saveLayout(id, list);
      toast('Layout saved.');
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  resetBtn.addEventListener('click', async () => {
    for (const o of objects) {
      o.group.position.copy(o.base.position);
      o.group.quaternion.copy(o.base.quaternion);
      o.group.scale.setScalar(o.base.scale);
      o.visible = true;
      o.group.visible = true;
      const cb = o.row?.querySelector('input');
      if (cb) cb.checked = true;
    }
    await api.resetLayout(id).catch(() => undefined);
    toast('Placement reset to the fitted layout.');
  });

  const exportBtn = h('button', 'Export meshes (GLB)');
  exportBtn.addEventListener('click', () => {
    const group = new THREE.Group();
    for (const o of objects) if (o.visible && o.kind === 'mesh') group.add(o.group.clone(true));
    if (relief) group.add(relief.clone(true));
    new GLTFExporter().parse(group, (result) => {
      const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `${(doc?.title ?? 'world').replace(/[^\w-]+/g, '_')}.glb` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, (err) => toast(`Export failed: ${String(err)}`, 'error'), { binary: true });
  });

  function buildPanel(d: SceneDoc) {
    clear(panel);
    clear(quality);
    for (const s of d.world?.splats ?? []) quality.append(h('option', { value: s.variant }, `${s.variant} (${(s.size / 1e6).toFixed(0)} MB)`));
    clear(objList);
    for (const o of objects) {
      const vis = h('input', { type: 'checkbox', checked: o.visible, title: 'Show' }) as HTMLInputElement;
      vis.addEventListener('change', () => { o.visible = vis.checked; o.group.visible = vis.checked; if (!vis.checked && selected === o) select(null); });
      o.row = h('li', vis, h('button.link', { onclick: () => { if (editing) select(o); } }, o.name), h('span.kind', o.kind === 'splat' ? 'splat' : 'mesh'));
      objList.append(o.row);
    }
    clear(diag);
    for (const line of d.diagnostics) diag.append(h('li', line));
    editBar.hidden = true;
    panel.append(
      h('section', h('h2', 'Layers'),
        d.world ? h('label.row', worldToggle, h('span', 'Marble world'), quality) : h('p.muted', 'No Marble world for this memory.'),
        d.relief ? h('label.row', reliefToggle, h('span', 'Depth relief (MoGe-2)')) : '',
        h('label.row', objectsToggle, h('span', 'Objects')),
      ),
      objects.length ? h('section', h('h2', 'Objects'), objList, h('div.row-buttons', editBtn, saveBtn, resetBtn), editBar) : '',
      h('div.row-buttons', exportBtn),
      h('details', h('summary', 'How it was placed'), diag),
    );
  }

  // ---------- loading ----------
  const progress = new Map<string, { loaded: number; total: number }>();
  function reportProgress(key: string, loaded: number, total: number) {
    progress.set(key, { loaded, total: Math.max(total, loaded, 1) });
    let l = 0, t = 0;
    for (const p of progress.values()) { l += p.loaded; t += p.total; }
    const pct = t ? Math.min(100, (100 * l) / t) : 0;
    progressBar.style.width = `${pct.toFixed(1)}%`;
    progressText.textContent = `Loading the world · ${pct.toFixed(0)}%`;
  }

  function loadSplat(url: string, key: string, size: number): Promise<SplatMesh> {
    reportProgress(key, 0, size);
    const mesh = new SplatMesh({
      url,
      onProgress: (ev: ProgressEvent) => reportProgress(key, ev.loaded, ev.lengthComputable ? ev.total : size),
    });
    return mesh.initialized.then(() => {
      reportProgress(key, size, size);
      return mesh;
    });
  }

  async function loadWorld(variant: string) {
    if (!doc?.world) return;
    const s = doc.world.splats.find((x) => x.variant === variant) ?? doc.world.splats[0];
    const mesh = await loadSplat(s.url, `world-${s.variant}`, s.size);
    if (disposed) { mesh.dispose(); return; }
    mesh.quaternion.fromArray(doc.world.quaternion);
    mesh.scale.setScalar(doc.world.scale);
    mesh.visible = worldToggle.checked;
    if (world) { scene.remove(world); world.dispose(); }
    scene.add(mesh);
    world = mesh;
  }

  async function loadEnvironment(d: SceneDoc) {
    hemi.color.set(d.lighting.sky);
    hemi.groundColor.set(d.lighting.ground);
    const upV = new THREE.Vector3(...d.camera.up);
    sun.position.copy(new THREE.Vector3(...d.lighting.sun).addScaledVector(upV, 0.5)).multiplyScalar(10);
    // Only meshes need lighting; splats carry their own.
    if (!d.objects.some((o) => o.kind === 'mesh')) return;
    if (d.world?.panoUrl) {
      try {
        const tex = await new THREE.TextureLoader().loadAsync(d.world.panoUrl);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        scene.environment = pmrem.fromEquirectangular(tex).texture;
        tex.dispose();
        return;
      } catch {
        // fall back to the studio environment below
      }
    }
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.8;
  }

  async function loadObject(o: SceneDoc['objects'][number], ov: LayoutOverride | undefined) {
    const group = new THREE.Group();
    group.name = o.name;
    if (o.kind === 'splat') {
      group.add(await loadSplat(o.url, `obj-${o.id}`, o.bytes ?? 18e6));
    } else {
      reportProgress(`obj-${o.id}`, 0, o.bytes ?? 5e6);
      const g = await gltf.loadAsync(o.url, (ev) => reportProgress(`obj-${o.id}`, ev.loaded, ev.lengthComputable ? ev.total : o.bytes ?? 5e6));
      reportProgress(`obj-${o.id}`, o.bytes ?? 1, o.bytes ?? 1);
      group.add(g.scene);
    }
    const base = { position: new THREE.Vector3(...o.position), quaternion: new THREE.Quaternion(...o.quaternion), scale: o.scale };
    group.position.copy(ov ? new THREE.Vector3(...ov.position) : base.position);
    group.quaternion.copy(ov ? new THREE.Quaternion(...ov.quaternion) : base.quaternion);
    group.scale.setScalar(ov ? ov.scale : base.scale);
    const visible = ov ? ov.visible : o.visible;
    group.visible = visible;
    return { id: o.id, name: o.name, kind: o.kind ?? 'mesh', group, base, visible } satisfies ObjectEntry;
  }

  async function load() {
    const { scene: d, layout: overrides } = await api.scene(id);
    if (disposed) return;
    doc = d;
    titleEl.textContent = d.title;
    document.title = `${d.title} · WOM`;
    // 1. The photo first, framed exactly like the reconstructed camera.
    photo.src = d.image.url;
    portalPhoto.setAttribute('href', d.image.url);
    photoAspect = d.image.width / d.image.height;
    photoFovY = d.camera.fovY;
    void paintBackdrop(d.image.url).catch(() => undefined);
    camera.up.set(...d.camera.up);
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    const target = new THREE.Vector3(...d.camera.target);
    sceneDepth = THREE.MathUtils.clamp(Math.abs(target.z) || target.length() || 4, 1, 60);
    // Walking pace scaled to the scene; Spark's Shift multiplier (×5) runs.
    controls.fpsMovement.moveSpeed = THREE.MathUtils.clamp(sceneDepth * 0.25, 0.5, 3);
    controls.pointerControls.scrollSpeed = 0.0015 * THREE.MathUtils.clamp(sceneDepth / 4, 0.5, 4);
    controls.pointerControls.slideSpeed = 0.006 * THREE.MathUtils.clamp(sceneDepth / 4, 0.5, 4);
    layout();

    // 2. Everything else loads underneath the photo.
    const overrideMap = new Map(overrides.map((o) => [o.id, o]));
    const tasks: Promise<unknown>[] = [loadEnvironment(d)];
    if (d.world) tasks.push(loadWorld(d.world.splats[0].variant));
    if (d.relief) {
      reportProgress('relief', 0, 4e6);
      tasks.push(gltf.loadAsync(d.relief.url, (ev) => reportProgress('relief', ev.loaded, ev.lengthComputable ? ev.total : 4e6)).then((g) => {
        if (disposed) return;
        relief = g.scene;
        relief.traverse((n) => {
          const m = n as THREE.Mesh;
          if (m.isMesh) {
            const mat = m.material as THREE.MeshBasicMaterial;
            mat.toneMapped = false;
            mat.side = THREE.DoubleSide;
          }
        });
        relief.visible = !d.world;
        reliefToggle.checked = relief.visible;
        scene.add(relief);
      }));
    }
    for (const o of d.objects) {
      tasks.push(loadObject(o, overrideMap.get(o.id)).then((entry) => {
        if (disposed) return;
        objectsRoot.add(entry.group);
        objects.push(entry);
      }).catch((err) => toast(`Could not load ${o.name}: ${(err as Error).message}`, 'error')));
    }
    const results = await Promise.allSettled(tasks);
    if (disposed) return;
    for (const r of results) if (r.status === 'rejected') toast(String((r.reason as Error)?.message ?? r.reason), 'error');
    objects.sort((a, b) => d.objects.findIndex((x) => x.id === a.id) - d.objects.findIndex((x) => x.id === b.id));
    buildPanel(d);
    // 3. Let Spark sort and draw a few frames, then open the portal.
    progressText.textContent = 'Preparing the portal…';
    progressBar.style.width = '100%';
    await new Promise((r) => setTimeout(r, 400));
    showPortal();
  }

  load().catch((err) => {
    progressText.textContent = (err as Error).message;
    toast((err as Error).message, 'error');
  });

  return () => {
    disposed = true;
    renderer.setAnimationLoop(null);
    ro.disconnect();
    window.removeEventListener('keydown', onKey);
    controls.fpsMovement.enable = false;
    controls.pointerControls.enable = false;
    gizmo.dispose();
    world?.dispose();
    for (const o of objects) o.group.traverse((n) => { if (n instanceof SplatMesh) n.dispose(); });
    backdropTex?.dispose();
    pmrem.dispose();
    renderer.dispose();
  };
}
