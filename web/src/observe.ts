// Flagging a problem while walking a world, by a person (the Flag button, key O) or by an agent (the
// automation API, available with ?debug).
//
// The viewer already holds everything a bug report needs, so a flag records facts instead of guessing from
// pixels: the exact camera, which layers were showing, which asset every object used, and what lies along
// rays through the marked spot. The server stores it as an observation (see server/src/observe/store.ts)
// and decides which layer the problem is in from the rays.
//
// A flag captures:
//   frame        what the viewer showed, as a PNG (the server keeps it as a JPEG with a thumbnail)
//   rays         from the camera through the marked pixels: every layer hit, with distance and 3D point
//   splats       statistics of the nearest layer's splats that project into the marked region
//   layer frames the same view with each layer the rays reached hidden in turn, so a person can see what goes away
import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import {
  OBSERVATION_CATEGORIES,
  type ObservationCategory,
  type ObservationCreated,
  type ObservationMark,
  type ObservationRay,
  type ObservationRecord,
  type ObservationSplats,
  type PlacementMethod,
} from '../../server/src/types.ts';
import { api, type SceneDoc, type SlideDoc, type SlideEntry } from './api.ts';
import { clear, h, toast } from './dom.ts';
import { encodeView, type ViewPose } from './viewcode.ts';

/** A part of the scene that can be hidden and hit by a ray: the Marble world, the depth relief, one object. */
export interface ObserveLayer {
  id: string;
  label: string;
  node: THREE.Object3D;
}

/** What the observer needs from the viewer. */
export interface ObserveHost {
  worldId: string;
  /** The viewer's root element; the Flag overlay is added to it. */
  mount: HTMLElement;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  doc: () => SceneDoc | null;
  phase: () => string;
  layers: () => ObserveLayer[];
  /** Whether the layer is drawn now (its own switch and, for objects, the Objects switch). */
  shown: (layer: ObserveLayer) => boolean;
  layerFlags: () => { world: boolean; relief: boolean; objects: boolean };
  objects: () => { id: string; url: string; visible: boolean; group: THREE.Object3D }[];
  worldVariant: () => string | undefined;
  placementMethod: () => PlacementMethod | undefined;
  /** Things drawn over the scene that do not belong in a frame (collider wireframes, the edit gizmo). */
  chrome: () => THREE.Object3D[];
  /** Stop (or resume) walking and looking, so the camera stays where it is. */
  freeze: (on: boolean) => void;
  isFrozen: () => boolean;
  /** Go inside without the portal animation. */
  enterNow: () => void;
  /** The camera this world was opened at: the photo's own, or the saved view it was played from. Null until loaded. */
  entry: () => SlideEntry | null;
  /** The portal camera at rest, which "Back to the memory" returns to. */
  home: () => ViewPose;
  /** Save what the camera shows now as a slide of this world (the "Capture" button and the C key). */
  saveSlide: () => Promise<SlideDoc | null>;
}

export interface FlagArgs {
  /** In pixels of the frame (see `frameSize`). */
  mark: ObservationMark;
  note?: string;
  category?: ObservationCategory;
  /** 'human' (default) or 'agent:<name>'. */
  author?: string;
  onProgress?: (text: string) => void;
}

export interface ViewerState {
  phase: string;
  pose: ViewPose;
  fovY: number;
  aspect: number;
  viewport: { width: number; height: number; pixelRatio: number };
  layers: { id: string; label: string; shown: boolean }[];
  frozen: boolean;
}

/** The automation API (window.__wom.viewer with ?debug): everything a person does by hand, for agents and scripts. */
export interface ViewerApi {
  phase(): string;
  /** Resolves with the phase once the world has loaded ('portal', or 'inside' for a ?view link). */
  ready(timeoutMs?: number): Promise<string>;
  /** Go inside without the portal animation. */
  enter(): void;
  pose(): ViewPose;
  viewCode(): string;
  state(): ViewerState;
  /** Put the camera at a pose and keep it there until `unfreeze`. Only meaningful once inside. */
  setPose(p: ViewPose): void;
  unfreeze(): void;
  layers(): { id: string; label: string; shown: boolean }[];
  setLayer(id: string, shown: boolean): void;
  /** Size of the saved frame; marks and `pick` use its pixels. */
  frameSize(): { width: number; height: number };
  /** The current view as an image. `jpeg` defaults to 640 px wide, `png` to the frame size. */
  frame(opts?: { maxWidth?: number; type?: 'png' | 'jpeg' }): Promise<Blob>;
  pick(px: [number, number]): ObservationRay;
  flag(args: FlagArgs): Promise<ObservationCreated>;
  /** The camera this world was opened at: the photo's own, or the saved view it was played from. Null until loaded. */
  entry(): SlideEntry | null;
  /** The portal camera at rest, which "Back to the memory" returns to (the entry, as a pose). */
  home(): ViewPose;
  /**
   * Save what the camera shows now as a view slide of this world: what the Capture button does, flash and card
   * included. Resolves
   * with the slide, or null when nothing was saved: the world is not entered yet, the camera is held (after
   * `setPose`, until `unfreeze`), a save is already running, or the server refused (a toast says why).
   */
  saveSlide(): Promise<SlideDoc | null>;
  /**
   * Hold the camera at the flag's own camera and lay the flagged frame over the live view, to wipe between them
   * (what a `?view=…&compare=<id>` link opens). Resolves once it is on screen.
   */
  compare(id: string): Promise<void>;
  closeCompare(): void;
}

const FRAME_MAX_W = 1600;
const LAYER_FRAME_W = 640;
/** How long a layer that was just shown or hidden needs before Spark has sorted its splats again. */
const SETTLE_MS = 650;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const round = (v: number, d = 3) => Number(v.toFixed(d));
const triple = (v: THREE.Vector3): [number, number, number] => [round(v.x), round(v.y), round(v.z)];

/** The share of rays whose nearest hit is each layer, largest first (the server applies the same rule). */
function tally(rays: ObservationRay[]) {
  const counts = new Map<string, number>();
  let n = 0;
  for (const ray of rays) {
    const nearest = ray.hits[0];
    if (!nearest) continue;
    n++;
    counts.set(nearest.layer, (counts.get(nearest.layer) ?? 0) + 1);
  }
  return [...counts].map(([layer, c]) => ({ layer, share: c / n })).sort((a, b) => b.share - a.share);
}

export function createObserver(host: ObserveHost) {
  // ---------- measuring ----------

  function frameSize(maxWidth = FRAME_MAX_W) {
    const src = host.renderer.domElement;
    const width = Math.min(maxWidth, src.width);
    return { width, height: Math.max(1, Math.round((src.height * width) / src.width)) };
  }

  function pose(): ViewPose {
    return { position: [round(host.camera.position.x), round(host.camera.position.y), round(host.camera.position.z)], quaternion: host.camera.quaternion.toArray().map((v) => round(v, 4)) as ViewPose['quaternion'] };
  }

  /** Render now and copy the canvas in the same task, before the browser clears the drawing buffer. */
  async function snapshot(maxWidth: number, type: 'image/png' | 'image/jpeg', quality = 0.9): Promise<Blob> {
    await nextFrame();
    host.renderer.render(host.scene, host.camera);
    const src = host.renderer.domElement;
    const { width, height } = frameSize(maxWidth);
    const copy = document.createElement('canvas');
    copy.width = width;
    copy.height = height;
    copy.getContext('2d')!.drawImage(src, 0, 0, width, height);
    return new Promise((resolve, reject) => copy.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not capture the frame.'))), type, quality));
  }

  /** Wait for Spark to sort the splats again after a layer was shown or hidden. */
  async function settle() {
    await nextFrame();
    await sleep(SETTLE_MS);
    await nextFrame();
    await nextFrame();
  }

  const raycaster = new THREE.Raycaster();

  /** Everything along the ray through a pixel of the frame, nearest first. */
  function pick(px: [number, number], size = frameSize()): ObservationRay {
    const ndc = new THREE.Vector2((px[0] / size.width) * 2 - 1, -((px[1] / size.height) * 2 - 1));
    host.camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, host.camera);
    const hits: ObservationRay['hits'] = [];
    for (const layer of host.layers()) {
      if (!host.shown(layer)) continue;
      layer.node.updateMatrixWorld(true);
      for (const hit of raycaster.intersectObject(layer.node, true).slice(0, 3)) hits.push({ layer: layer.id, distance: round(hit.distance), point: triple(hit.point) });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return { px: [round(px[0], 1), round(px[1], 1)], hits: hits.slice(0, 12) };
  }

  function samplePoints(mark: ObservationMark, size: { width: number; height: number }): [number, number][] {
    const clamp = (p: [number, number]): [number, number] => [Math.min(size.width - 1, Math.max(0, p[0])), Math.min(size.height - 1, Math.max(0, p[1]))];
    if (mark.kind === 'point') {
      const [x, y] = mark.px;
      const r = size.width * 0.005;
      return ([[x, y], [x - r, y], [x + r, y], [x, y - r], [x, y + r]] as [number, number][]).map(clamp);
    }
    const [x0, y0, x1, y1] = mark.px;
    const out: [number, number][] = [];
    const n = 5;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push(clamp([x0 + ((i + 0.5) / n) * (x1 - x0), y0 + ((j + 0.5) / n) * (y1 - y0)]));
    return out;
  }

  function regionOf(mark: ObservationMark, size: { width: number; height: number }): [number, number, number, number] {
    if (mark.kind === 'box') return mark.px;
    const r = size.width * 0.03;
    return [mark.px[0] - r, mark.px[1] - r, mark.px[0] + r, mark.px[1] + r];
  }

  /**
   * The splats of a layer that project into the marked region at about the depth the rays hit: how many,
   * how opaque, how flat (sheets and needles have a long axis many times the short one), and where they are.
   */
  function splatStats(layer: ObserveLayer, region: [number, number, number, number], size: { width: number; height: number }, depth: [number, number]): ObservationSplats | undefined {
    const meshes: SplatMesh[] = [];
    layer.node.traverse((n) => { if (n instanceof SplatMesh) meshes.push(n); });
    if (!meshes.length) return undefined;
    host.camera.updateMatrixWorld();
    const world = new THREE.Vector3(), ndc = new THREE.Vector3();
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let count = 0, opacity = 0, anisotropy = 0, thin = 0;
    try {
      for (const mesh of meshes) {
        mesh.updateMatrixWorld(true);
        const m = mesh.matrixWorld;
        mesh.forEachSplat((_i, center, scales, _q, alpha) => {
          world.copy(center).applyMatrix4(m);
          const d = world.distanceTo(host.camera.position);
          if (d < depth[0] || d > depth[1]) return;
          ndc.copy(world).project(host.camera);
          if (ndc.z < -1 || ndc.z > 1) return;
          const x = (ndc.x * 0.5 + 0.5) * size.width, y = (-ndc.y * 0.5 + 0.5) * size.height;
          if (x < region[0] || x > region[2] || y < region[1] || y > region[3]) return;
          count++;
          opacity += alpha;
          const longest = Math.max(scales.x, scales.y, scales.z), shortest = Math.max(1e-9, Math.min(scales.x, scales.y, scales.z));
          const a = Math.min(1000, longest / shortest);
          anisotropy += a;
          if (a > 8) thin++;
          min[0] = Math.min(min[0], world.x); min[1] = Math.min(min[1], world.y); min[2] = Math.min(min[2], world.z);
          max[0] = Math.max(max[0], world.x); max[1] = Math.max(max[1], world.y); max[2] = Math.max(max[2], world.z);
        });
      }
    } catch {
      return undefined;
    }
    if (!count) return undefined;
    return {
      layer: layer.id,
      count,
      meanOpacity: round(opacity / count),
      meanAnisotropy: round(anisotropy / count, 2),
      thinShare: round(thin / count),
      bounds: { min: min.map((v) => round(v)) as [number, number, number], max: max.map((v) => round(v)) as [number, number, number] },
    };
  }

  function cameraState() {
    const c = host.camera;
    return { position: c.position.toArray(), quaternion: c.quaternion.toArray(), fovY: c.fov, aspect: c.aspect, near: c.near, far: c.far, up: c.up.toArray() };
  }

  function sceneState() {
    return {
      version: host.doc()?.version ?? 0,
      worldVariant: host.worldVariant(),
      layers: host.layerFlags(),
      objects: host.objects().map((o) => ({
        id: o.id,
        visible: o.visible,
        url: o.url,
        transform: { position: o.group.position.toArray(), quaternion: o.group.quaternion.toArray(), scale: o.group.scale.x },
      })),
      placementMethod: host.placementMethod(),
    };
  }

  // ---------- flagging ----------

  /** Capture everything a flag keeps and send it to the server. The camera stays where it is meanwhile. */
  async function flag(args: FlagArgs): Promise<ObservationCreated> {
    if (host.phase() !== 'inside') throw new Error('Go inside the world first.');
    const size = frameSize();
    const wasFrozen = host.isFrozen();
    host.freeze(true);
    const layers = host.layers().filter((l) => host.shown(l));
    const chrome = host.chrome().filter((o) => o.visible);
    for (const o of chrome) o.visible = false;
    try {
      args.onProgress?.('Capturing the frame…');
      const frame = await snapshot(FRAME_MAX_W, 'image/png');
      const camera = cameraState();
      const scene = sceneState();
      const viewport = { width: host.renderer.domElement.clientWidth, height: host.renderer.domElement.clientHeight, pixelRatio: host.renderer.getPixelRatio() };

      args.onProgress?.('Tracing rays through the marked spot…');
      const rays = samplePoints(args.mark, size).map((p) => pick(p, size));
      const top = tally(rays)[0];
      const topLayer = top && layers.find((l) => l.id === top.layer);
      let splats: ObservationSplats | undefined;
      if (topLayer) {
        const distances = rays.map((r) => r.hits.find((x) => x.layer === topLayer.id)?.distance).filter((d): d is number => d !== undefined);
        if (distances.length) splats = splatStats(topLayer, regionOf(args.mark, size), size, [Math.min(...distances) * 0.85, Math.max(...distances) * 1.15]);
      }

      const all = await snapshot(LAYER_FRAME_W, 'image/jpeg');
      // Only a layer a ray reached can be what is wrong at the marked spot, and each layer costs about
      // a second to hide and draw again. When no ray hit anything (a very faint haze, say) the frames with
      // a layer hidden are the only evidence there is, so every layer gets one.
      const reached = new Set(rays.flatMap((r) => r.hits.map((x) => x.layer)));
      const toHide = reached.size ? layers.filter((l) => reached.has(l.id)) : layers;
      const without: { layer: ObserveLayer; blob: Blob }[] = [];
      let i = 0;
      for (const layer of toHide) {
        args.onProgress?.(`Hiding ${layer.label} (${++i} of ${toHide.length})…`);
        const was = layer.node.visible;
        layer.node.visible = false;
        try {
          await settle();
          without.push({ layer, blob: await snapshot(LAYER_FRAME_W, 'image/jpeg') });
        } finally {
          layer.node.visible = was;
        }
      }
      args.onProgress?.('Saving…');
      const form = new FormData();
      form.append('record', JSON.stringify({ author: args.author ?? 'human', category: args.category, note: args.note?.trim() || undefined, camera, viewport, frame: size, scene, mark: args.mark, rays, splats }));
      form.append('frame', frame, 'frame.png');
      form.append('ablate:all', all, 'all.jpg');
      for (const w of without) form.append(`ablate:${w.layer.id}`, w.blob, 'layer.jpg');
      // The layers are back on: Spark sorts them again while the flag is on its way, instead of before it.
      const [created] = await Promise.all([api.postObservation(host.worldId, form), settle()]);
      return created;
    } finally {
      for (const o of chrome) o.visible = true;
      if (!wasFrozen) host.freeze(false);
    }
  }

  // ---------- the Flag overlay ----------

  type Mode = 'idle' | 'marking' | 'saving' | 'saved';
  let mode: Mode = 'idle';
  /** In CSS pixels of the overlay. */
  let css: { kind: 'point'; x: number; y: number } | { kind: 'box'; x0: number; y0: number; x1: number; y1: number } | null = null;
  let category: ObservationCategory | undefined;
  let drag: { x: number; y: number } | null = null;

  const top = h('div.flag-top');
  const markEl = h('div.flag-mark');
  markEl.hidden = true;
  const note = h('textarea', { rows: 2, maxLength: 2000, placeholder: 'What looks wrong? (optional)' }) as HTMLTextAreaElement;
  const chips = OBSERVATION_CATEGORIES.map((c) => h('button.chip', { type: 'button', dataset: { category: c.id } }, c.label));
  const saveBtn = h('button.primary', { type: 'button' }, 'Save flag') as HTMLButtonElement;
  const cancelBtn = h('button', { type: 'button' }, 'Cancel') as HTMLButtonElement;
  const status = h('p.muted');
  const panel = h('div.flag-panel');
  const overlay = h('div.flag-overlay', top, markEl, panel);
  overlay.hidden = true;
  host.mount.append(overlay);

  function buildForm() {
    clear(panel);
    panel.append(h('h3', 'Flag a problem'), h('div.chips', chips), note, status, h('div.row-buttons', saveBtn, cancelBtn));
  }
  const labelOf = (id: string) => host.layers().find((l) => l.id === id)?.label ?? id;
  const rectOf = () => overlay.getBoundingClientRect();

  function drawMark() {
    if (!css) { markEl.hidden = true; return; }
    markEl.hidden = false;
    markEl.className = `flag-mark ${css.kind}`;
    if (css.kind === 'point') {
      Object.assign(markEl.style, { left: `${css.x - 14}px`, top: `${css.y - 14}px`, width: '28px', height: '28px' });
    } else {
      Object.assign(markEl.style, { left: `${css.x0}px`, top: `${css.y0}px`, width: `${css.x1 - css.x0}px`, height: `${css.y1 - css.y0}px` });
    }
  }

  function toFrame(m: NonNullable<typeof css>): ObservationMark {
    const size = frameSize();
    const rect = rectOf();
    const fx = (x: number) => round((x / rect.width) * size.width, 1), fy = (y: number) => round((y / rect.height) * size.height, 1);
    return m.kind === 'point' ? { kind: 'point', px: [fx(m.x), fy(m.y)] } : { kind: 'box', px: [fx(m.x0), fy(m.y0), fx(m.x1), fy(m.y1)] };
  }

  overlay.addEventListener('pointerdown', (e) => {
    if (mode !== 'marking' || (e.target as HTMLElement).closest('.flag-panel, .flag-top')) return;
    const r = rectOf();
    drag = { x: e.clientX - r.left, y: e.clientY - r.top };
    overlay.setPointerCapture(e.pointerId);
    css = { kind: 'point', x: drag.x, y: drag.y };
    drawMark();
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = rectOf();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (Math.hypot(x - drag.x, y - drag.y) < 6) css = { kind: 'point', x: drag.x, y: drag.y };
    else css = { kind: 'box', x0: Math.min(drag.x, x), y0: Math.min(drag.y, y), x1: Math.max(drag.x, x), y1: Math.max(drag.y, y) };
    drawMark();
  });
  overlay.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    if (css) {
      panel.hidden = false;
      saveBtn.disabled = false;
      status.textContent = css.kind === 'point' ? 'Marked a spot. Drag a box instead to mark an area.' : 'Marked an area.';
      note.focus({ preventScroll: true });
    }
  });

  for (const chip of chips) {
    chip.addEventListener('click', () => {
      const id = chip.dataset.category as ObservationCategory;
      category = category === id ? undefined : id;
      for (const c of chips) c.classList.toggle('on', c.dataset.category === category);
    });
  }

  function finish() {
    if (mode === 'idle') return;
    mode = 'idle';
    overlay.hidden = true;
    css = null;
    drag = null;
    window.removeEventListener('keydown', onKey, true);
    host.freeze(false);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && mode !== 'saving') { e.stopPropagation(); finish(); }
  }

  /** Start flagging: freeze the camera and wait for a click or a dragged box. */
  function start() {
    if (host.phase() !== 'inside' || mode === 'saving') return;
    if (mode === 'idle') host.freeze(true);
    mode = 'marking';
    css = null;
    category = undefined;
    note.value = '';
    status.textContent = '';
    for (const c of chips) c.classList.remove('on');
    saveBtn.disabled = false;
    cancelBtn.disabled = false;
    buildForm();
    panel.hidden = true;
    markEl.hidden = true;
    overlay.hidden = false;
    clear(top);
    top.append('Click the problem, or drag a box around it. Esc cancels. ', h('code', `view ${encodeView(pose())}`));
    window.addEventListener('keydown', onKey, true);
  }

  cancelBtn.addEventListener('click', finish);
  saveBtn.addEventListener('click', async () => {
    if (!css || mode !== 'marking') return;
    mode = 'saving';
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      const rec = await flag({
        mark: toFrame(css),
        note: note.value,
        category,
        onProgress: (t) => { status.textContent = t; },
      });
      showSaved(rec);
    } catch (err) {
      mode = 'marking';
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      status.textContent = (err as Error).message;
      toast((err as Error).message, 'error');
    }
  });

  function showSaved(rec: ObservationCreated) {
    mode = 'saved';
    markEl.hidden = true;
    clear(panel);
    const lines: string[] = [];
    // Flags of the same spot are one problem: say so, so the same sheet is not flagged five times over.
    const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
    if (rec.issue && rec.issue.count > 1) {
      lines.push(rec.issue.reopened
        ? `This problem was marked fixed and is open again: the ${ordinal(rec.issue.count)} sighting of it.`
        : `This spot was flagged before. This is the ${ordinal(rec.issue.count)} sighting, so it counts as one problem, not ${rec.issue.count}.`);
    }
    if (rec.suspect) {
      const share = rec.votes.find((v) => v.layer === rec.suspect)?.share;
      lines.push(`In: ${labelOf(rec.suspect)}${rec.suspectSource === 'ray' && share !== undefined ? ` (the nearest surface for ${Math.round(share * 100)}% of the rays)` : rec.suspectSource === 'ablation' ? ' (from the frames with a layer hidden)' : ''}.`);
    } else {
      lines.push('Could not tell which layer it is in.');
    }
    for (const a of [...rec.ablation].sort((x, y) => y.changedShare - x.changedShare).slice(0, 2)) {
      lines.push(`Hiding ${labelOf(a.layer)} changes ${Math.round(a.changedShare * 100)}% of the marked region.`);
    }
    if (rec.splats) lines.push(`${rec.splats.count.toLocaleString()} splats of ${labelOf(rec.splats.layer)} project there; ${Math.round(rec.splats.thinShare * 100)}% are flat or needle-like.`);
    const again = h('button', { type: 'button' }, 'Flag another');
    again.addEventListener('click', start);
    const done = h('button.primary', { type: 'button' }, 'Done');
    done.addEventListener('click', finish);
    panel.append(
      h('h3', 'Flag saved'),
      ...lines.map((l) => h('p', l)),
      h('div.row-buttons', done, again, h('a.button', { href: `#/observations/${host.worldId}`, target: '_blank', rel: 'noopener' }, 'Open observations')),
    );
    panel.hidden = false;
  }

  // ---------- compare: the flagged frame over the live view ----------

  let closeCompare: (() => void) | null = null;

  /**
   * Lay the frame of a flag over the live view and wipe between what was flagged and what the world shows now. It
   * opens at the flag's own camera (a view link with ?compare=<id>) and holds the camera there, where the two
   * line up exactly: same position, same rotation, and the frame is scaled to the live field of view. "Looks fixed"
   * keeps a picture of the view as it is now beside the flagged one and marks the problem fixed. "Still wrong"
   * starts a new flag from here.
   */
  async function compare(id: string): Promise<void> {
    closeCompare?.();
    const t0 = performance.now();
    while (host.phase() !== 'inside') {
      if (performance.now() - t0 > 20_000) { toast('Go inside the world first, then compare.', 'error'); return; }
      await sleep(100);
    }
    let rec: ObservationRecord;
    try {
      rec = await api.observation(host.worldId, id);
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
    const flagged = rec.camera;
    if (!flagged) { toast('That flag has no camera to compare from.', 'error'); return; }
    if (mode !== 'idle') finish();

    host.freeze(true);
    host.camera.position.fromArray(flagged.position);
    host.camera.quaternion.fromArray(flagged.quaternion);
    host.camera.updateMatrixWorld();

    let split = 0.5;
    const img = h('img', { src: `/bench-files/observations/${host.worldId}/${rec.id}/${rec.files.frame}`, alt: 'The frame that was flagged', draggable: false }) as HTMLImageElement;
    const handle = h('div.compare-handle', { role: 'slider', tabindex: '0', 'aria-label': 'Wipe between the flagged frame and the live view', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span.grip'));
    const tagFlagged = h('span.compare-tag', 'Flagged');
    const tagNow = h('span.compare-tag', 'Now');
    const box = h('div.compare-frame', img, tagFlagged, tagNow, handle);
    const note = rec.note ? ` (“${rec.note.length > 120 ? `${rec.note.slice(0, 120)}…` : rec.note}”)` : '';
    const say = h('p', `Flagged ${new Date(rec.createdAt).toLocaleString()}${note}. Drag the line to wipe between the flagged frame and what the world shows now.`);
    const fixedBtn = h('button.primary', { type: 'button' }, 'Looks fixed') as HTMLButtonElement;
    const wrongBtn = h('button', { type: 'button' }, 'Still wrong') as HTMLButtonElement;
    const closeBtn = h('button', { type: 'button' }, 'Close') as HTMLButtonElement;
    const layer = h('div.compare', box, h('div.compare-bar', say, h('div.row-buttons', fixedBtn, wrongBtn, closeBtn)));
    host.mount.append(layer);

    function layout() {
      const vw = layer.clientWidth, vh = layer.clientHeight;
      if (!vw || !vh) return;
      // The frame covers the vertical field of view it was drawn with; the live view may use another.
      const k = Math.tan((flagged!.fovY * Math.PI) / 360) / Math.tan((host.camera.fov * Math.PI) / 360);
      const fh = vh * k, fw = fh * (rec.frame.width / rec.frame.height);
      Object.assign(box.style, { left: `${(vw - fw) / 2}px`, top: `${(vh - fh) / 2}px`, width: `${fw}px`, height: `${fh}px` });
      img.style.clipPath = `inset(0 ${(1 - split) * 100}% 0 0)`;
      handle.style.left = `${split * 100}%`;
      // The two names sit either side of the line, level with its grip, so neither runs into the viewer's top bar.
      tagFlagged.style.right = `calc(${(1 - split) * 100}% + 24px)`;
      tagNow.style.left = `calc(${split * 100}% + 24px)`;
      handle.setAttribute('aria-valuenow', String(Math.round(split * 100)));
    }
    const resize = new ResizeObserver(layout);
    resize.observe(layer);
    layout();

    const move = (e: PointerEvent) => {
      const r = box.getBoundingClientRect();
      split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      layout();
    };
    handle.addEventListener('pointerdown', (e) => { handle.setPointerCapture(e.pointerId); handle.addEventListener('pointermove', move); move(e); });
    handle.addEventListener('pointerup', (e) => { handle.releasePointerCapture(e.pointerId); handle.removeEventListener('pointermove', move); });
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      split = Math.min(1, Math.max(0, split + (e.key === 'ArrowRight' ? 0.05 : -0.05)));
      layout();
      e.preventDefault();
    });

    const close = () => {
      closeCompare = null;
      resize.disconnect();
      window.removeEventListener('keydown', onEsc, true);
      layer.remove();
      host.freeze(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onEsc, true);
    closeCompare = close;
    closeBtn.addEventListener('click', close);
    wrongBtn.addEventListener('click', () => { close(); start(); });
    fixedBtn.addEventListener('click', async () => {
      fixedBtn.disabled = wrongBtn.disabled = closeBtn.disabled = true;
      const chrome = host.chrome().filter((o) => o.visible);
      try {
        for (const o of chrome) o.visible = false;
        let picture: Blob;
        try {
          picture = await snapshot(LAYER_FRAME_W, 'image/jpeg');
        } finally {
          for (const o of chrome) o.visible = true;
        }
        const r = await api.markFixed(host.worldId, rec.id, picture);
        toast(r.updated > 1 ? `Marked fixed: all ${r.updated} sightings. This view is kept beside the flagged one.` : 'Marked fixed. This view is kept beside the flagged one.');
        close();
      } catch (err) {
        fixedBtn.disabled = wrongBtn.disabled = closeBtn.disabled = false;
        toast((err as Error).message, 'error');
      }
    });
  }

  // ---------- the automation API ----------

  const api_: ViewerApi = {
    phase: () => host.phase(),
    async ready(timeoutMs = 180_000) {
      const t0 = performance.now();
      while (host.phase() === 'photo') {
        if (performance.now() - t0 > timeoutMs) throw new Error('The world did not finish loading.');
        await sleep(100);
      }
      return host.phase();
    },
    enter: () => host.enterNow(),
    pose,
    viewCode: () => encodeView(pose()),
    state: () => ({
      phase: host.phase(),
      pose: pose(),
      fovY: host.camera.fov,
      aspect: host.camera.aspect,
      viewport: { width: host.renderer.domElement.clientWidth, height: host.renderer.domElement.clientHeight, pixelRatio: host.renderer.getPixelRatio() },
      layers: host.layers().map((l) => ({ id: l.id, label: l.label, shown: host.shown(l) })),
      frozen: host.isFrozen(),
    }),
    setPose(p) {
      host.camera.position.fromArray(p.position);
      host.camera.quaternion.fromArray(p.quaternion);
      host.camera.updateMatrixWorld();
      host.freeze(true);
    },
    unfreeze: () => host.freeze(false),
    layers: () => host.layers().map((l) => ({ id: l.id, label: l.label, shown: host.shown(l) })),
    setLayer(id, shown) {
      const layer = host.layers().find((l) => l.id === id);
      if (!layer) throw new Error(`No layer ${id}`);
      layer.node.visible = shown;
    },
    frameSize: () => frameSize(),
    frame: (opts = {}) => snapshot(opts.maxWidth ?? (opts.type === 'jpeg' ? LAYER_FRAME_W : FRAME_MAX_W), opts.type === 'jpeg' ? 'image/jpeg' : 'image/png'),
    pick: (px) => pick(px),
    flag,
    entry: () => host.entry(),
    home: () => host.home(),
    saveSlide: () => host.saveSlide(),
    compare,
    closeCompare: () => closeCompare?.(),
  };

  return {
    /** Start flagging by hand. */
    start,
    /** Open the compare view for a flag (see `compare`). */
    compare,
    api: api_,
    dispose() {
      closeCompare?.();
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
    },
  };
}
