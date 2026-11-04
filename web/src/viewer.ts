// The world viewer.
//
//  1. "photo"  – loading. The memory is shown immediately, framed exactly like the reconstructed camera, with
//                a dormant keyhole-shaped aperture on it (aperture.ts). Opened on its own, the keyhole rests at an
//                eighth of its size, sparkling, until it is tapped; played from a slide, it has grown already.
//                Two lights rise from the keyhole's base along both sides as the world loads underneath, and meet
//                at the top of its head.
//  2. "portal" – loaded, not yet entered. The aperture ignites (once it is awake and grown): its outline lights,
//                the photo inside dissolves into the live 3D world and the surround darkens. The camera slowly
//                swings round the scene's focus point and turns, and leans toward the pointer, so you can see
//                it is 3D. ENTER THE WORLD.
//  3. "entering" – the keyhole grows about its head, past the photo's own borders, until the world fills
//                the screen.
//  4. "inside" – the overlay is gone and SparkControls take over: W A S D to walk, drag to look.
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { SparkControls, SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { MeshBVH } from 'three-mesh-bvh';
import { requireSignIn, userMenu } from './auth.ts';
import { api, type LayoutOverride, type PlacementMethod, type SceneDoc, type SlideDoc, type SlideEntry, type WorldManifest } from './api.ts';
import { clear, fmtUsd, h, toast } from './dom.ts';
import { geometryFromArrays, mergedGeometry, Walker } from './walker.ts';
import { assetSection } from './assetpanel.ts';
import { createObserver, type ObserveLayer } from './observe.ts';
import { decodeView, viewLink, type ViewPose } from './viewcode.ts';
import { createAperture } from './aperture.ts';
import { paintBackdrop as paintTinyCopy, photoFrame } from './frame.ts';
import { buildCover, dropHandoff, giveHandoff, removeCover, takeHandoff } from './slides/handoff.ts';
import { worldHref } from './routes.ts';
import { slideKey, spaceUrl } from './slides/spaces.ts';
import { cameraIcon, createCaptureCard } from './capture.ts';

/** Placement agents the viewer can run on demand; costs are benchmark means per object. */
const AGENTS = [
  { model: 'muse-spark-1.3', method: 'agent-spark', label: 'Muse Spark agent', perObjectUsd: 0.07 },
  { model: 'muse-wonder-1.0', method: 'agent-wonder', label: 'Muse Wonder agent', perObjectUsd: 0.1 },
] as const;

interface ObjectEntry {
  id: string;
  name: string;
  kind: 'splat' | 'mesh';
  group: THREE.Group;
  base: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: number };
  /** Every placement computed for this object (fitter, grounded, agents). */
  placements: NonNullable<SceneDoc['objects'][number]['placements']>;
  row?: HTMLElement;
  visible: boolean;
  /** Convex hull in the object's own coordinates, for walking collisions. */
  collider?: MeshBVH;
  /** The asset file shown (its path names the model and mask version). */
  url: string;
}

type Phase = 'photo' | 'portal' | 'entering' | 'inside' | 'returning';

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export interface ViewerOptions {
  /** A view code (see viewcode.ts): open inside the world at that spot instead of at the portal. */
  view?: string;
  /** With `view`: the id of a flag made from there. Its frame is laid over the live view to wipe between them (see observe.ts). */
  compare?: string;
  /** The slide to enter from (its id in the world; 'photo', the default, is the photo). */
  slide?: string;
  /** The slide space it was played from; the back arrow returns there. */
  from?: string;
  /** Whether this visitor owns the world and may use build/edit actions. */
  canEdit?: boolean;
  /** The owner's current handle, for a canonical share link. */
  handle?: string | null;
  /** Who may open the world: anyone with the link, or only its owner. The owner can switch it. */
  visibility?: 'private' | 'link';
}

/** The photo's own entry: the camera that took it, at the origin of the scene. */
function photoEntry(d: SceneDoc): SlideEntry {
  return { position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: d.camera.fovY, aspect: d.image.width / d.image.height };
}

export function renderViewer(root: HTMLElement, id: string, opts: ViewerOptions = {}): () => void {
  clear(root);
  let disposed = false;
  let phase: Phase = 'photo';
  const slideId = opts.slide && opts.slide !== 'photo' ? opts.slide : 'photo';
  // Played from the slide space: its cover shows the slide (with the dormant opening) until this page shows the same.
  const handoff = takeHandoff((x) => x.direction === 'enter' && x.world === id && x.slide === slideId);
  dropHandoff();

  // ---------- DOM ----------
  const stage = h('div.stage');
  // A tiny, darkened copy of the photo, upscaled smoothly: it fills the letterbox bars around a
  // whole (not full-bleed) photo, and the same pixels are the 3D scene's background, so nothing jumps
  // when the world takes over the bars. (Entered from a view saved inside the world, the bars are a copy
  // of the view's image and the background stays the photo's: see setBackground.)
  const backdrop = h('canvas.memory-backdrop') as HTMLCanvasElement;
  const photo = h('img.memory-photo', { alt: 'The original photo', draggable: false });

// The aperture: a dormant keyhole while the world loads, lit and open onto the live world once it has,
  // its outline sweeping outward when you enter. It draws the photo too, so it can cut the world through it.
  // A world opened on its own starts with the keyhole at rest: an eighth of its size, sparkling, until it is tapped.
  // One played from a slide has been tapped already (the slide's flight grew the keyhole), whether or not the slide's
  // cover made it here.
  const ap = createAperture({
    onEnter: () => enterWorld(),
    asleep: !handoff && !opts.from,
    // The camera's swing starts from the photo's own viewpoint when the light comes on, not when the world loaded.
    onLit: () => { orbit.t0 = performance.now(); },
  });

  const titleEl = h('h1');
  const backBtn = h('button', { title: 'Return to the original photo (P)' }, 'Back to the memory');
  const panelBtn = h('button', { title: 'Layers and objects' }, 'Layers');
  const flagBtn = h('button', { title: 'Flag something that looks wrong here (O)' }, 'Flag a problem');
  const captureBtn = h('button.capture-button', { type: 'button', title: 'Capture this view', 'aria-label': 'Capture this view' }, cameraIcon()) as HTMLButtonElement;
  let canEdit = opts.canEdit === true;
  const shareBtn = h('button', { title: 'Copy a link anyone can open' }, 'Share');
  // The owner decides who can open the link. Visitors never see this button.
  let visibility: 'private' | 'link' = opts.visibility ?? 'link';
  const visBtn = h('button', { type: 'button' }) as HTMLButtonElement;
  const showVisibility = () => {
    visBtn.hidden = !canEdit;
    visBtn.textContent = visibility === 'link' ? 'Open by link' : 'Private';
    visBtn.setAttribute('aria-pressed', String(visibility === 'link'));
    visBtn.title = visibility === 'link'
      ? 'Anyone with the link can open this memory. Click to make it private.'
      : 'Only you can open this memory. Click to let anyone with the link open it.';
  };
  showVisibility();
  const auth = userMenu();
  const backLink = h('a.back', { href: opts.from ? spaceUrl(opts.from, slideKey(id, slideId)) : new URL('#/', location.origin).href, title: opts.from ? 'Back to the slides' : 'Home' }, '←');
  const top = h('header.viewer-top', backLink, titleEl, h('div.spacer'), auth, visBtn, shareBtn, flagBtn, backBtn, panelBtn, canEdit ? h('a.button', { href: worldHref(id, { handle: opts.handle, build: true }) }, 'Build details') : '');
  const panel = h('aside.side');
  const hint = h('div.hint');
  const HINT_WALK = 'W A S D to walk · drag to look · Shift to run · F to fly · O to flag a problem';
  const HINT_FLY = 'W A S D to fly · drag to look · Q / E down and up · Shift to run · F to walk · O to flag a problem';
  const view = h('main.viewer', stage, top, panel, hint, captureBtn, ap.el);
  stage.append(backdrop, photo);
  root.append(view);
  // The slide's cover sits over the stage and under the aperture until the photo and aperture show the same.
  let cover = handoff?.cover ?? null;
  if (cover) {
    cover.classList.add('in-viewer');
    view.classList.add('from-slide');
    view.insertBefore(cover, top);
  }

  // ---------- three.js + Spark ----------
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  backdrop.after(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#050404');
  let backdropTex: THREE.CanvasTexture | null = null;
  /** The shape of the image the 3D background is a tiny copy of. */
  let backdropAspect = 1.5;
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
  /** True while a flag is being made or an agent holds the camera: walking and looking are off. */
  let frozen = false;

  let doc: SceneDoc | null = null;
  let world: SplatMesh | null = null;
  let relief: THREE.Object3D | null = null;

  // Walking: collisions with Marble's collider mesh (or the depth relief) and one hull per object.
  const walker = new Walker();
  let walkMode = true;
  let walkReady = false;
  let walkMeasured = false;
  let worldCollider: { bvh: MeshBVH; geometry: THREE.BufferGeometry } | null = null;
  let reliefCollider: { bvh: MeshBVH; geometry: THREE.BufferGeometry } | null = null;
  const colliderViews = new THREE.Group();
  colliderViews.visible = false;
  // ?debug in the URL exposes the camera and walker for automated checks.
  if (new URLSearchParams(location.search).has('debug')) {
    (window as unknown as Record<string, unknown>).__wom = { THREE, camera, walker, walking: () => walkMode && walkReady, objects: () => objects };
  }
  const objects: ObjectEntry[] = [];
  let selected: ObjectEntry | null = null;
  // The slide this world was entered from, and its entry: where the camera starts, and where "Back to the
  // memory" returns. The memory is the slide's image: the photo, or a view saved inside the world.
  let slide: SlideDoc | null = handoff?.doc ?? null;
  let entry: SlideEntry | null = slide?.entry ?? null;
  let memoryUrl = '';
  const home = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  let photoAspect = entry?.aspect ?? 1.5;
  let photoFovY = entry?.fovY ?? 50;
  let sceneDepth = 4;
  const photoRect = { x: 0, y: 0, w: 0, h: 0 };
  /**
   * Portal camera: it swings round `pivot` (the scene's focus point) and keeps looking at it, and it turns.
   * The swing keeps the pivot put on screen while nearer things slide one way and farther things the other,
   * which is what reads as depth. `yawDeg` swings about gravity-up, `pitchDeg` about the camera's right axis; with
   * pitch not far behind yaw the path is a slow ellipse round the focus rather than a slide from side to side.
   * `lookYawDeg` / `lookPitchDeg` add what the pointer asks for (lean toward it).
   * The turn is the camera's own: the view rotates about the camera's place, as a head does, in the same sense
   * as the swing turns it, so the camera ends up turned by the sum and the picture sweeps across the opening
   * as well as shifting against itself. It has its own, slower period (`turnPeriodS`) so the two do not repeat
   * together; `turnLookYawDeg` / `turnLookPitchDeg` are the pointer's share of it.
   * `t0` is when the portal lit, `rampS` eases both in from the photo's own viewpoint, and `settleMs` eases them
   * back out (from `enterT0`) while the aperture's edges travel outward. Reduced motion: a smaller swing, no turn.
   */
  const orbit = {
    yawDeg: 7, pitchDeg: 4, lookYawDeg: 4, lookPitchDeg: 2.2, periodS: 16,
    turnYawDeg: 3.5, turnPitchDeg: 2, turnLookYawDeg: 2.5, turnLookPitchDeg: 1.4, turnPeriodS: 23,
    rampS: 2.2, settleMs: 900, t0: 0,
  };
  let enterT0 = 0;
  /** Where the pointer is on the stage (-1..1, `t…` the target), smoothed into the camera's lean. */
  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  const pivot = new THREE.Vector3(0, 0, -4);
  const orbitUp = new THREE.Vector3(0, 1, 0);
  const orbitRight = new THREE.Vector3(1, 0, 0);
  const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

  // ---------- layout ----------
  function layout() {
    const w = stage.clientWidth, hgt = stage.clientHeight;
    if (!w || !hgt) return;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    // Full-bleed ("cover") when that crops little of the photo, else the whole photo ("contain") with
    // blurred bars. Either way the camera sees exactly what the photo shows.
    const frame = photoFrame(w, hgt, photoAspect);
    photoRect.x = frame.x; photoRect.y = frame.y; photoRect.w = frame.w; photoRect.h = frame.h;
    const t = Math.tan(THREE.MathUtils.degToRad(photoFovY) / 2) * (hgt / photoRect.h);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(t));
    camera.updateProjectionMatrix();
    Object.assign(photo.style, { width: `${photoRect.w}px`, height: `${photoRect.h}px`, left: `${photoRect.x}px`, top: `${photoRect.y}px` });
    fitBackdrop();
    ap.layout({ w, h: hgt, photo: photoRect });
  }
  const ro = new ResizeObserver(layout);
  ro.observe(stage);

  async function decodedImage(url: string) {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }

  /** The bars around the memory when it is shown whole: a tiny copy of it, on the stage and in the aperture. */
  async function paintBackdrop(url: string) {
    const img = await decodedImage(url);
    if (disposed) return;
    paintTinyCopy(backdrop, img, photoAspect);
    // The aperture draws the bars around a photo shown whole from this same tiny image.
    try { ap.setBackdrop(backdrop.toDataURL('image/png')); } catch { /* the bars stay dark */ }
  }

  /**
   * The 3D scene's background where the world has nothing: a tiny copy of the world's photo, whichever slide
   * the world was entered from. Entered from the photo, these are the bars' own pixels. A view saved inside the
   * world has this background in its image, so entering from the view sees what its image shows.
   */
  function setBackground(source: HTMLCanvasElement, aspect: number) {
    if (disposed) return;
    backdropTex?.dispose();
    backdropTex = new THREE.CanvasTexture(source);
    backdropTex.colorSpace = THREE.SRGBColorSpace;
    backdropTex.minFilter = THREE.LinearFilter;
    backdropTex.generateMipmaps = false;
    backdropAspect = aspect;
    scene.background = backdropTex;
    fitBackdrop();
  }

  /** Cover-fit the background texture to the viewport, like the CSS backdrop (object-fit: cover). */
  function fitBackdrop() {
    if (!backdropTex) return;
    const va = camera.aspect, ta = backdropAspect;
    if (va > ta) {
      backdropTex.repeat.set(1, ta / va);
      backdropTex.offset.set(0, (1 - ta / va) / 2);
    } else {
      backdropTex.repeat.set(va / ta, 1);
      backdropTex.offset.set((1 - va / ta) / 2, 0);
    }
  }

  // ---------- phases ----------
  let anim: { t0: number; dur: number; step: (e: number) => void; done?: () => void } | null = null;
  const animate = (dur: number, step: (e: number) => void, done?: () => void) => {
    anim = { t0: performance.now(), dur, step, done };
  };

  /** Loaded and not yet entered: the aperture lights and the live world shows through it. */
  function showPortal() {
    if (disposed) return;
    phase = 'portal';
    orbit.t0 = performance.now();
    photo.style.visibility = 'hidden'; // the aperture draws the same photo, so the swap is invisible
    ap.ignite();
  }

  /** The keyhole outline travels outward, past the photo's borders, until the world fills the screen. */
  function enterWorld() {
    // The first tap opens a keyhole at rest (it grows, then lights once the world is there); the next goes in.
    const rest = ap.stage();
    if (rest === 'asleep') { ap.wake(); return; }
    if (rest === 'waking' || phase !== 'portal') return;
    phase = 'entering';
    enterT0 = performance.now();
    ap.expand(1250, () => {
      ap.el.hidden = true;
      phase = 'inside';
      view.classList.add('inside');
      resetPointer();
      controls.fpsMovement.enable = true;
      controls.pointerControls.enable = !editing;
      startWalking(false);
      renderer.domElement.focus();
    });
  }

  /**
   * Walk from the photo's viewpoint: the eye stays at the photo camera's height above the ground, measured
   * on entering. Switching back from flying keeps that height and falls to the ground.
   */
  function startWalking(resume: boolean) {
    walker.setUp(camera.up);
    if (!walkMode || !walker.hasColliders) {
      walkReady = false;
    } else if (resume && walkMeasured) {
      walker.resume();
      walkReady = true;
    } else {
      walkReady = walker.start(camera.position, doc?.camera.heightM);
      walkMeasured = walkReady;
      if (!walkReady) toast('There is no ground under the camera here, so you are flying (F to try walking again).');
    }
    updateMoveUi();
  }

  function setWalkMode(on: boolean) {
    walkMode = on;
    if (phase === 'inside') startWalking(on);
    else updateMoveUi();
  }

  function updateMoveUi() {
    const walking = walkMode && walkReady;
    hint.textContent = walking || (walkMode && phase !== 'inside' && walker.hasColliders) ? HINT_WALK : HINT_FLY;
    walkToggle.checked = walkMode;
    walkToggle.disabled = !walker.hasColliders;
  }

  /** Stop (or resume) walking and looking, so the camera stays exactly where it is. */
  function freeze(on: boolean) {
    frozen = on;
    if (on) {
      controls.fpsMovement.enable = false;
      controls.pointerControls.enable = false;
      resetPointer();
    } else if (phase === 'inside') {
      controls.fpsMovement.enable = true;
      controls.pointerControls.enable = !editing;
    }
  }

  /** Go inside without the portal animation: for links to a view, and for scripts. */
  function enterNow() {
    if (disposed || phase === 'inside') return;
    anim = null;
    phase = 'inside';
    ap.open();
    ap.el.hidden = true;
    photo.style.visibility = 'hidden';
    view.classList.add('inside');
    resetPointer();
    controls.fpsMovement.enable = !frozen;
    controls.pointerControls.enable = !editing && !frozen;
    startWalking(false);
    renderer.domElement.focus();
  }

  function backToMemory() {
    if (phase !== 'inside') return;
    phase = 'returning';
    setEditing(false);
    controls.fpsMovement.enable = false;
    controls.pointerControls.enable = false;
    view.classList.remove('inside');
    const fromP = camera.position.clone(), fromQ = camera.quaternion.clone();
    // The camera flies home (the slide's entry) while the aperture's edges come back in around its image.
    animate(1200, (e) => {
      camera.position.lerpVectors(fromP, home.position, e);
      camera.quaternion.slerpQuaternions(fromQ, home.quaternion, e);
    });
    ap.el.hidden = false;
    ap.contract(1200, () => {
      anim = null;
      camera.position.copy(home.position);
      camera.quaternion.copy(home.quaternion);
      phase = 'portal';
      orbit.t0 = performance.now();
    });
  }

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
  async function setVisibility(next: 'private' | 'link'): Promise<boolean> {
    visBtn.disabled = true;
    try {
      await api.setVisibility(id, next);
      visibility = next;
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      return false;
    } finally {
      visBtn.disabled = false;
      showVisibility();
    }
  }
  visBtn.addEventListener('click', async () => {
    const next = visibility === 'link' ? 'private' : 'link';
    if (await setVisibility(next)) toast(next === 'link' ? 'Anyone with the link can open this memory.' : 'Only you can open this memory now.');
  });
  shareBtn.addEventListener('click', async () => {
    // A link to a private memory opens nothing for anyone else, so sharing it means opening it up. Ask first.
    if (canEdit && visibility === 'private') {
      if (!window.confirm('This memory is private. Let anyone with the link open it?')) return;
      if (!(await setVisibility('link'))) return;
    }
    const link = `${location.origin}${worldHref(id, { handle: opts.handle })}`;
    try {
      if (navigator.share) await navigator.share({ title: doc?.title ?? 'World of a Memory', text: 'Step inside this memory', url: link });
      else await navigator.clipboard.writeText(link);
      toast('Share link copied. Anyone can open it.');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      try { await navigator.clipboard.writeText(link); toast('Share link copied. Anyone can open it.'); } catch { toast(link); }
    }
  });
  captureBtn.hidden = !canEdit;
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

  function startObserver() {
    void requireSignIn().then((ok) => { if (ok && phase === 'inside' && !editing) observer.start(); });
  }

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'enter' && phase === 'portal') { e.preventDefault(); enterWorld(); return; }
    // While the world loads, Enter opens a keyhole at rest (unless it is a button or link that has the key).
    if (k === 'enter' && phase === 'photo' && ap.stage() === 'asleep' && !(e.target as HTMLElement)?.closest('a, button')) { e.preventDefault(); ap.wake(); return; }
    if (k === 'p' && phase === 'inside') { backToMemory(); return; }
    if (k === 'o' && phase === 'inside' && !editing && !e.metaKey && !e.ctrlKey && !e.altKey) { startObserver(); return; }
    if (k === 'f' && phase === 'inside' && !editing) { setWalkMode(!walkMode); return; }
    if (k === 'escape') { if (editing) setEditing(false); return; }
    if (editing && selected) {
      if (k === 'g') gizmo.setMode('translate');
      if (k === 'r') gizmo.setMode('rotate');
      if (k === 't') gizmo.setMode('scale');
    }
  };
  window.addEventListener('keydown', onKey);

  // The pointer leans the portal camera. Touch has no hover, and reduced motion asks for none of it.
  const onLook = (e: PointerEvent) => {
    if (ap.calm || e.pointerType === 'touch') return;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    look.tx = THREE.MathUtils.clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    look.ty = THREE.MathUtils.clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
  };
  const onLookEnd = () => { look.tx = 0; look.ty = 0; };
  window.addEventListener('pointermove', onLook, { passive: true });
  document.documentElement.addEventListener('mouseleave', onLookEnd);
  window.addEventListener('blur', onLookEnd);

  // ---------- render loop ----------
  const timer = new THREE.Timer();
  const before = new THREE.Vector3();
  const qYaw = new THREE.Quaternion();
  const qPitch = new THREE.Quaternion();
  const qSwing = new THREE.Quaternion();
  const qTurn = new THREE.Quaternion();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    if (anim) {
      const t = Math.min(1, (performance.now() - anim.t0) / anim.dur);
      anim.step(ease(t));
      if (t >= 1) { const done = anim.done; anim = null; done?.(); }
    }
    if (phase !== 'inside') ap.frame(performance.now());
    if (phase === 'portal' || phase === 'entering') {
      // Orbit the focus point. The swing starts at zero (the photo's own camera, so the aperture first shows
      // what the photo shows) and returns to zero as the edges travel outward, so walking starts from the
      // photo's viewpoint. The pointer adds a lean: the camera peeks toward it, as through a window.
      const now = performance.now();
      const swing = ease(Math.min(1, (now - orbit.t0) / 1000 / orbit.rampS))
        * (phase === 'portal' ? 1 : 1 - ease(Math.min(1, (now - enterT0) / orbit.settleMs)));
      const turn = (2 * Math.PI * (now - orbit.t0)) / 1000 / orbit.periodS;
      const lean = 1 - Math.exp(-5 * Math.min(0.05, timer.getDelta()));
      look.x += (look.tx - look.x) * lean;
      look.y += (look.ty - look.y) * lean;
      const reach = ap.calm ? 0.6 : 1;
      const yawDeg = (orbit.yawDeg * Math.sin(turn) + orbit.lookYawDeg * look.x) * swing * reach;
      const pitchDeg = (orbit.pitchDeg * Math.cos(turn) + orbit.lookPitchDeg * look.y) * swing * reach;
      ap.setParallax(yawDeg / (orbit.yawDeg + orbit.lookYawDeg), pitchDeg / (orbit.pitchDeg + orbit.lookPitchDeg));
      qYaw.setFromAxisAngle(orbitUp, THREE.MathUtils.degToRad(yawDeg));
      qPitch.setFromAxisAngle(orbitRight, THREE.MathUtils.degToRad(pitchDeg));
      qSwing.multiplyQuaternions(qYaw, qPitch);
      // Swing the entry camera by q about the pivot: it turns by q and moves to pivot + q * (home - pivot).
      camera.quaternion.multiplyQuaternions(qSwing, home.quaternion);
      camera.position.copy(home.position).sub(pivot).applyQuaternion(qSwing).add(pivot);
      // Then turn the view about the camera's own place, further the way the swing turned it.
      if (!ap.calm) {
        const spin = (2 * Math.PI * (now - orbit.t0)) / 1000 / orbit.turnPeriodS;
        qYaw.setFromAxisAngle(orbitUp, THREE.MathUtils.degToRad((orbit.turnYawDeg * Math.sin(spin + 1.3) + orbit.turnLookYawDeg * look.x) * swing));
        qPitch.setFromAxisAngle(orbitRight, THREE.MathUtils.degToRad((orbit.turnPitchDeg * Math.cos(spin + 0.4) + orbit.turnLookPitchDeg * look.y) * swing));
        qTurn.multiplyQuaternions(qYaw, qPitch);
        camera.quaternion.premultiply(qTurn);
      }
    } else if (phase === 'inside' && !frozen) {
      before.copy(camera.position);
      controls.update(camera);
      const d = camera.position.clone().sub(before);
      if (walkMode && walkReady) {
        // Walking: only the level part of the move; gravity and collisions decide the rest.
        d.addScaledVector(camera.up, -d.dot(camera.up));
        camera.position.copy(before);
        walker.step(camera.position, d, Math.min(0.05, timer.getDelta()));
      } else {
        // Flying stays level unless Q / E (or Page keys) are held.
        const kc = controls.fpsMovement.keycode;
        if (!kc.KeyQ && !kc.KeyE && !kc.PageUp && !kc.PageDown) camera.position.addScaledVector(camera.up, -d.dot(camera.up));
      }
    }
    if (colliderViews.visible) {
      // Object hulls follow their objects (placement switches, layout edits).
      for (const { entry, view } of hullViews) {
        view.visible = entry.group.visible && objectsRoot.visible;
        entry.group.updateMatrixWorld();
        view.matrix.copy(entry.group.matrixWorld);
      }
    }
    renderer.render(scene, camera);
  });

  // ---------- panel ----------
  const worldToggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const reliefToggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const objectsToggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const walkToggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const collidersToggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
  walkToggle.addEventListener('change', () => setWalkMode(walkToggle.checked));
  collidersToggle.addEventListener('change', () => { colliderViews.visible = collidersToggle.checked; });
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

  // ---------- placement choice (fitter, grounded fitter, Muse agents) ----------
  let placementMethod: PlacementMethod = 'fitter';
  const placementList = h('div.placement-list');

  /** Show every object with `method`'s placement (objects without it keep the fitter's). */
  function applyPlacementMethod(method: PlacementMethod) {
    placementMethod = method;
    for (const o of objects) {
      const v = o.placements[method] ?? o.placements.fitter;
      if (!v) continue;
      o.base = { position: new THREE.Vector3(...v.position), quaternion: new THREE.Quaternion(...v.quaternion), scale: v.scale };
      o.group.position.copy(o.base.position);
      o.group.quaternion.copy(o.base.quaternion);
      o.group.scale.setScalar(o.base.scale);
    }
    if (selected) gizmo.attach(selected.group);
  }

  // The world's own choice of placement agents (run whenever its objects are rebuilt).
  let worldAgents: string[] = AGENTS.map((a) => a.model);

  /** Choose which agents place this world's objects, and run a chosen one that has not placed them yet. */
  function agentChooser(d: SceneDoc) {
    if (!objects.length) return '';
    const placed = new Set((d.placement?.methods ?? []).map((m) => m.id));
    const status = h('p.muted', 'Chosen agents place every object with the benchmark\'s tools, now and whenever this world\'s objects are rebuilt. On the benchmarked objects they mostly agreed with the grounded fitter.');
    const boxes = AGENTS.map((a) => {
      const cb = h('input', { type: 'checkbox', checked: worldAgents.includes(a.model) }) as HTMLInputElement;
      const row = h('label.row', cb, h('span', a.label), h('span.score', placed.has(a.method) ? 'placed' : `about ${fmtUsd(a.perObjectUsd * objects.length)}`));
      return { a, cb, row };
    });
    const runBtn = h('button', { type: 'button' }, 'Run chosen agents') as HTMLButtonElement;
    const chosen = () => boxes.filter((b) => b.cb.checked).map((b) => b.a.model);
    const refreshRun = () => {
      const missing = boxes.filter((b) => b.cb.checked && !placed.has(b.a.method));
      runBtn.hidden = missing.length === 0;
      runBtn.textContent = `Run ${missing.map((b) => b.a.label.replace(' agent', '')).join(' and ')} · about ${fmtUsd(missing.reduce((s, b) => s + b.a.perObjectUsd, 0) * objects.length)}`;
    };
    for (const b of boxes) {
      b.cb.addEventListener('change', async () => {
        refreshRun();
        try {
          await api.setAgents(id, chosen(), false);
          worldAgents = chosen();
        } catch (err) { toast((err as Error).message, 'error'); }
      });
    }
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      for (const b of boxes) b.cb.disabled = true;
      status.textContent = `Placing ${objects.length} object(s); this takes a minute or two…`;
      try {
        await api.setAgents(id, chosen(), true);
        worldAgents = chosen();
        // Wait for the background run, then pick up the new placements.
        for (;;) {
          await new Promise((r) => setTimeout(r, 3000));
          if (disposed) return;
          const r = await api.get(id);
          if (r.running) continue;
          if (r.manifest.steps.placements?.status === 'failed') throw new Error(r.manifest.steps.placements.error ?? 'the agent run failed');
          break;
        }
        const { scene: fresh } = await api.scene(id);
        if (disposed) return;
        doc = fresh;
        for (const o of objects) o.placements = fresh.objects.find((x) => x.id === o.id)?.placements ?? o.placements;
        buildPanel(fresh);
        toast('The agents placed the objects. Pick one under Placement to compare.');
      } catch (err) {
        toast((err as Error).message, 'error');
        status.textContent = (err as Error).message;
        runBtn.disabled = false;
        for (const b of boxes) b.cb.disabled = false;
      }
    });
    refreshRun();
    return h('div.agent-run', h('h3', 'Placement agents'), boxes.map((b) => b.row), h('div.row-buttons', runBtn), status);
  }

  function buildPlacementSection(d: SceneDoc) {
    clear(placementList);
    if (!canEdit) return '';
    const methods = d.placement?.methods ?? [];
    const runner = agentChooser(d);
    if (methods.length < 2) return runner ? h('section', h('h2', 'Placement'), runner) : '';
    const saveDefault = h('button', { title: 'Open this world with the selected placement' }, 'Use for this world');
    saveDefault.addEventListener('click', async () => {
      try {
        await api.setPlacement(id, placementMethod);
        toast(`This world now opens with "${methods.find((m) => m.id === placementMethod)?.label ?? placementMethod}".`);
      } catch (err) { toast((err as Error).message, 'error'); }
    });
    for (const m of methods) {
      const radio = h('input', { type: 'radio', name: 'wom-placement', value: m.id, checked: m.id === placementMethod }) as HTMLInputElement;
      radio.addEventListener('change', () => { if (radio.checked) applyPlacementMethod(m.id); });
      placementList.append(h('label.row', radio, h('span', m.label), h('span.score', { title: 'Mean silhouette IoU against the object masks' }, `IoU ${m.meanIou.toFixed(2)}${m.objects < objects.length ? ` · ${m.objects}/${objects.length}` : ''}`)));
    }
    return h('section', h('h2', 'Placement'), placementList, h('div.row-buttons', saveDefault), h('p.muted', 'Compare how each method places the objects, then keep the one that looks right.'), runner);
  }

  function colliderSummary() {
    const hulls = objects.filter((o) => o.collider).length;
    const ground = worldCollider ? 'Marble\'s collider mesh' : reliefCollider ? 'the depth relief' : '';
    if (!ground) return 'This world has no ground to walk on, so you fly.';
    return `Walking collides with ${ground}${hulls ? ` and ${hulls === objects.length ? 'every' : `${hulls} of ${objects.length}`} object's hull` : ''}, at the photo camera's height above the ground.${hulls < objects.length ? ' Recompose the world to give every object a hull.' : ''}`;
  }

  // ---------- colliders ----------
  const colliderMaterial = new THREE.MeshBasicMaterial({ color: 0x35e0a1, wireframe: true, transparent: true, opacity: 0.28, depthWrite: false });
  const hullMaterial = new THREE.MeshBasicMaterial({ color: 0xffc061, wireframe: true, transparent: true, opacity: 0.6, depthWrite: false });
  const hullViews: { entry: ObjectEntry; view: THREE.Mesh }[] = [];
  scene.add(colliderViews);

  async function loadWorldCollider(d: SceneDoc) {
    if (!d.world?.colliderUrl) return;
    reportProgress('collider', 0, 6e6);
    const g = await gltf.loadAsync(d.world.colliderUrl, (ev) => reportProgress('collider', ev.loaded, ev.lengthComputable ? ev.total : 6e6));
    // The collider shares the Marble splats' frame, so it gets the same rotation and metric scale.
    const toScene = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion(...d.world.quaternion), new THREE.Vector3().setScalar(d.world.scale));
    const geometry = mergedGeometry(g.scene, toScene);
    worldCollider = { bvh: new MeshBVH(geometry), geometry };
    reportProgress('collider', 1, 1);
  }

  /** Tell the walker what to collide with, and build the wireframes shown by "Show colliders". */
  function registerColliders() {
    walker.colliders.length = 0;
    if (worldCollider) walker.colliders.push({ bvh: worldCollider.bvh, object: null, active: () => worldToggle.checked });
    if (reliefCollider) walker.colliders.push({ bvh: reliefCollider.bvh, object: null, active: () => reliefToggle.checked && !(worldCollider && worldToggle.checked) });
    for (const o of objects) {
      if (o.collider) walker.colliders.push({ bvh: o.collider, object: o.group, active: () => objectsRoot.visible && o.group.visible });
    }
    colliderViews.clear();
    hullViews.length = 0;
    const ground = worldCollider ?? reliefCollider;
    // Drawn after Spark's splats (which write no depth), so the wireframes show over the world.
    if (ground) colliderViews.add(Object.assign(new THREE.Mesh(ground.geometry, colliderMaterial), { renderOrder: 10 }));
    for (const o of objects) {
      if (!o.collider) continue;
      const view = new THREE.Mesh(o.collider.geometry, hullMaterial);
      view.matrixAutoUpdate = false;
      view.renderOrder = 11;
      colliderViews.add(view);
      hullViews.push({ entry: o, view });
    }
    updateMoveUi();
  }

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
        d.relief ? h('label.row', reliefToggle, h('span', 'Depth relief')) : '',
        h('label.row', objectsToggle, h('span', 'Objects')),
      ),
      h('section', h('h2', 'Movement'),
        h('label.row', walkToggle, h('span', 'Walk on the ground (F switches)')),
        h('label.row', collidersToggle, h('span', 'Show colliders')),
        h('p.muted', colliderSummary()),
      ),
      buildPlacementSection(d),
      objects.length ? h('section', h('h2', 'Objects'), objList, h('div.row-buttons', editBtn, saveBtn, resetBtn), editBar) : '',
      objectModelsSection(),
      viewSection(),
      h('div.row-buttons', exportBtn),
      h('details', h('summary', 'How it was placed'), diag),
    );
  }

  // ---------- flagging problems, and a model per object ----------
  let manifest: WorldManifest | null = null;

  const observeLayers = (): ObserveLayer[] => {
    const out: ObserveLayer[] = [];
    if (world) out.push({ id: 'world', label: 'Marble world', node: world });
    if (relief) out.push({ id: 'relief', label: 'Depth relief', node: relief });
    for (const o of objects) out.push({ id: `object:${o.id}`, label: o.name, node: o.group });
    return out;
  };
  const observer = createObserver({
    worldId: id,
    mount: view,
    renderer,
    camera,
    scene,
    doc: () => doc,
    phase: () => phase,
    layers: observeLayers,
    shown: (l) => l.node.visible && (!l.id.startsWith('object:') || objectsRoot.visible),
    layerFlags: () => ({ world: Boolean(world?.visible), relief: Boolean(relief?.visible), objects: objectsRoot.visible }),
    objects: () => objects.map((o) => ({ id: o.id, url: o.url, visible: o.group.visible, group: o.group })),
    worldVariant: () => quality.value || undefined,
    placementMethod: () => placementMethod,
    chrome: () => [colliderViews, gizmo.getHelper()],
    freeze,
    isFrozen: () => frozen,
    enterNow,
    entry: () => entry,
    home: () => ({ position: home.position.toArray() as ViewPose['position'], quaternion: home.quaternion.toArray() as ViewPose['quaternion'] }),
    saveSlide,
  });
  flagBtn.addEventListener('click', startObserver);
  // With ?debug, scripts and agents get the same abilities through window.__wom.viewer.
  if (new URLSearchParams(location.search).has('debug')) Object.assign((window as unknown as { __wom: object }).__wom, { viewer: observer.api });

  /** After another model was chosen for an object: load what changed and rebuild the panel. */
  async function refreshObjects() {
    const { scene: fresh, layout } = await api.scene(id);
    if (disposed) return;
    const overrides = new Map(layout.map((l) => [l.id, l]));
    for (const o of fresh.objects) {
      const i = objects.findIndex((x) => x.id === o.id);
      if (i >= 0 && objects[i].url === o.url) {
        objects[i].placements = o.placements ?? objects[i].placements;
        continue;
      }
      const entry = await loadObject(o, overrides.get(o.id));
      if (disposed) return;
      // A new asset starts where the placement method in use puts it, and keeps the object's switch.
      const v = entry.placements[placementMethod] ?? entry.placements.fitter;
      if (v && !overrides.has(o.id)) {
        entry.base = { position: new THREE.Vector3(...v.position), quaternion: new THREE.Quaternion(...v.quaternion), scale: v.scale };
        entry.group.position.copy(entry.base.position);
        entry.group.quaternion.copy(entry.base.quaternion);
        entry.group.scale.setScalar(entry.base.scale);
      }
      if (i >= 0) {
        const old = objects[i];
        if (selected === old) select(null);
        entry.visible = old.visible;
        entry.group.visible = old.visible;
        objectsRoot.remove(old.group);
        old.group.traverse((n) => { if (n instanceof SplatMesh) n.dispose(); });
        objects[i] = entry;
      } else {
        objects.push(entry);
      }
      objectsRoot.add(entry.group);
    }
    doc = fresh;
    registerColliders();
    buildPanel(fresh);
  }

  function objectModelsSection() {
    if (!manifest) return '';
    if (!canEdit) return '';
    return assetSection({ worldId: id, manifest, onManifest: (m) => { manifest = m; }, onChanged: () => refreshObjects(), isDisposed: () => disposed });
  }

  function viewSection() {
    const copy = h('button', { type: 'button', title: 'Copies a link that opens this world at this exact spot' }, 'Copy link to this view');
    copy.addEventListener('click', async () => {
      const link = `${location.origin}${location.pathname}${viewLink(id, { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() })}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copied. It opens the world at this spot.');
      } catch {
        toast(link);
      }
    });
    return h('section', h('h2', 'This view'), h('div.row-buttons', copy), h('p.muted', 'Flag a problem with the button above or the O key. The flag keeps the exact camera and scene, so it can be reopened from the same spot.'));
  }

  // ---------- loading ----------
  const progress = new Map<string, { loaded: number; total: number }>();
  function reportProgress(key: string, loaded: number, total: number) {
    progress.set(key, { loaded, total: Math.max(total, loaded, 1) });
    let l = 0, t = 0;
    for (const p of progress.values()) { l += p.loaded; t += p.total; }
    ap.setProgress(t ? Math.min(1, l / t) : 0, 'Loading the world');
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
    const collider = o.collider?.indices.length ? new MeshBVH(geometryFromArrays(o.collider.positions, o.collider.indices)) : undefined;
    return { id: o.id, name: o.name, kind: o.kind ?? 'mesh', group, base, placements: o.placements ?? {}, visible, collider, url: o.url } satisfies ObjectEntry;
  }

  async function load() {
    const [{ scene: d, layout: overrides }, found] = await Promise.all([
      api.scene(id),
      // A slide saved inside the world brings its own image and camera; the photo's come with the scene.
      slideId !== 'photo' && !slide ? api.worldSlides(id).then((all) => all.find((s) => s.id === slideId) ?? null).catch(() => null) : Promise.resolve(slide),
    ]);
    if (disposed) return;
    doc = d;
    if (slideId !== 'photo' && !found) toast('That slide is no longer there, so the world opens from its photo.');
    slide = found?.kind === 'view' ? found : null;
    const start = slide?.entry ?? photoEntry(d);
    entry = start;
    memoryUrl = slide?.image.url ?? d.image.url;
    titleEl.textContent = d.title;
    document.title = `${d.title} · WOM`;
    // 1. The memory first (the photo, or the slide's image), framed exactly like the camera that sees it.
    photoAspect = start.aspect;
    photoFovY = start.fovY;
    photo.src = memoryUrl;
    ap.setPhoto(memoryUrl, { immediate: Boolean(cover) });
    const backdropPainted = paintBackdrop(memoryUrl).then(() => true, () => false);
    if (!slide) {
      void backdropPainted.then((ok) => { if (ok) setBackground(backdrop, photoAspect); });
    } else {
      const aspect = d.image.width / d.image.height;
      void decodedImage(d.image.url).then((img) => setBackground(paintTinyCopy(document.createElement('canvas'), img, aspect), aspect), () => undefined);
    }
    camera.up.set(...d.camera.up);
    home.position.fromArray(start.position);
    home.quaternion.fromArray(start.quaternion).normalize();
    camera.position.copy(home.position);
    camera.quaternion.copy(home.quaternion);
    const target = new THREE.Vector3(...d.camera.target);
    sceneDepth = THREE.MathUtils.clamp(Math.abs(target.z) || target.length() || 4, 1, 60);
    // The portal orbits the scene's focus point (kept in front of the camera) about gravity-up. From a view
    // saved inside the world, that is what the middle of its image shows.
    if (slide) pivot.set(0, 0, -(start.focus ?? sceneDepth)).applyQuaternion(home.quaternion).add(home.position);
    else if (target.z < -0.5) pivot.copy(target);
    else pivot.set(0, 0, -sceneDepth);
    orbitUp.copy(camera.up).normalize();
    orbitRight.set(1, 0, 0).applyQuaternion(home.quaternion);
    // Walking pace scaled to the scene; Spark's Shift multiplier (×5) runs.
    controls.fpsMovement.moveSpeed = THREE.MathUtils.clamp(sceneDepth * 0.25, 0.5, 3);
    controls.pointerControls.scrollSpeed = 0.0015 * THREE.MathUtils.clamp(sceneDepth / 4, 0.5, 4);
    controls.pointerControls.slideSpeed = 0.006 * THREE.MathUtils.clamp(sceneDepth / 4, 0.5, 4);
    layout();
    if (cover) void releaseCover(backdropPainted);

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
        // The relief is also the ground to walk on when there is no Marble world (or it is hidden).
        const geometry = mergedGeometry(relief);
        reliefCollider = { bvh: new MeshBVH(geometry), geometry };
      }));
    }
    if (d.world?.colliderUrl) tasks.push(loadWorldCollider(d).catch((err) => toast(`Could not load the world's collider: ${(err as Error).message}`, 'error')));
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
    placementMethod = d.placement?.active ?? 'fitter';
    canEdit = opts.canEdit === true;
    manifest = await api.get(id).then((r) => { canEdit = r.access.canEdit; visibility = r.access.visibility; return r.manifest; }).catch(() => null);
    worldAgents = manifest?.options.placementAgents ?? worldAgents;
    registerColliders();
    captureBtn.hidden = !canEdit;
    showVisibility();
    buildPanel(d);
    // 3. Let Spark sort and draw a few frames while the light finishes tracing the aperture, then light it.
    ap.setProgress(1, 'Loading the world');
    ap.setStatus('Preparing the portal…');
    await Promise.all([ap.charged(), new Promise((r) => setTimeout(r, 400))]);
    if (disposed || phase !== 'photo') return; // already inside (a script called enter()), or gone
    // A link to a view opens inside the world at that spot; anything else opens the portal.
    const startView = decodeView(opts.view);
    if (startView) {
      camera.position.fromArray(startView.position);
      camera.quaternion.fromArray(startView.quaternion);
      enterNow();
      if (opts.compare && /^o[a-z0-9]{6,24}$/.test(opts.compare)) void observer.compare(opts.compare);
    } else {
      showPortal();
    }
  }

  /**
   * Take the slide's cover away once this page shows the same picture: the aperture draws its own dormant
   * opening from the next frame on, and the photo and its bars once they are decoded.
   */
  async function releaseCover(backdropPainted: Promise<unknown>) {
    await nextFrame();
    cover?.querySelector('.slide-cover-mark')?.remove();
    await Promise.all([photo.decode().catch(() => undefined), backdropPainted]);
    await nextFrame();
    await nextFrame();
    if (cover) removeCover(cover, 140);
    cover = null;
  }

  // ---------- slides: save a view as a way into this world ----------

  // The flash, and the card that confirms a capture and lets it be named or taken back (capture.ts).
  const captureCard = createCaptureCard(view);

  /** Exactly what the camera sees now (without colliders or the edit gizmo), and the camera that sees it. */
  async function captureView(): Promise<{ blob: Blob; entry: SlideEntry }> {
    const chrome = [colliderViews, gizmo.getHelper()];
    const shown = chrome.map((o) => o.visible);
    await nextFrame();
    chrome.forEach((o) => { o.visible = false; });
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    // Copied in the same task as the render, before the browser clears the drawing buffer.
    const src = renderer.domElement;
    const w = Math.min(2048, src.width), hgt = Math.max(1, Math.round((src.height * w) / src.width));
    const copy = document.createElement('canvas');
    copy.width = w;
    copy.height = hgt;
    copy.getContext('2d')!.drawImage(src, 0, 0, w, hgt);
    // The camera is read here, in the same task as the render. Encoding the picture takes a while, and the
    // render loop keeps moving the camera meanwhile (walking, flying): reading it after the encode saved a
    // position up to a metre away from where the picture was taken, so the slide would open somewhere else.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const focus = walker.hitDistance(camera.position, forward, 400);
    const r = (v: number, d: number) => Number(v.toFixed(d));
    const entry: SlideEntry = {
      position: camera.position.toArray().map((v) => r(v, 5)) as SlideEntry['position'],
      quaternion: camera.quaternion.toArray().map((v) => r(v, 7)) as SlideEntry['quaternion'],
      fovY: r(camera.fov, 5),
      aspect: r(camera.aspect, 6),
      ...(focus !== null && focus > 0.05 ? { focus: r(focus, 4) } : {}),
    };
    chrome.forEach((o, i) => { o.visible = shown[i]; });
    captureCard.flash();
    const blob = await new Promise<Blob>((resolve, reject) => copy.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not capture the view.'))), 'image/jpeg', 0.92));
    return { blob, entry };
  }

  let savingSlide = false;
  async function saveSlide(): Promise<SlideDoc | null> {
    if (phase !== 'inside' || savingSlide || frozen) return null;
    if (!(await requireSignIn())) return null;
    savingSlide = true;
    captureBtn.disabled = true;
    try {
      const shot = await captureView();
      const form = new FormData();
      form.append('record', JSON.stringify({ entry: shot.entry }));
      form.append('image', shot.blob, 'slide.jpg');
      const made = await api.createSlide(id, form);
      if (!disposed) captureCard.show(made, shot.blob);
      return made;
    } catch (err) {
      toast((err as Error).message, 'error');
      return null;
    } finally {
      savingSlide = false;
      captureBtn.disabled = false;
    }
  }
  captureBtn.addEventListener('click', () => void saveSlide());

  load().catch((err) => {
    ap.fail((err as Error).message);
    toast((err as Error).message, 'error');
  });

  return () => {
    disposed = true;
    // Back to the space it was played from: the slide's image stays up while the space flies it home.
    if (opts.from && memoryUrl && photo.complete && photo.naturalWidth) {
      giveHandoff({ direction: 'return', world: id, slide: slideId, from: opts.from, cover: buildCover({ image: photo, aspect: photoAspect, dormant: false }) });
    }
    cover?.remove();
    renderer.setAnimationLoop(null);
    ro.disconnect();
    observer.dispose();
    captureCard.dispose();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pointermove', onLook);
    document.documentElement.removeEventListener('mouseleave', onLookEnd);
    window.removeEventListener('blur', onLookEnd);
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
