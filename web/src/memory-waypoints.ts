// A memory lives at the tip of the camera that captured it. Small keyholes face the visitor;
// opening one reveals its middle frame on the saved camera's own image plane.
import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { api, type SlideDoc, type VideoGeneration } from './api.ts';
import { h } from './dom.ts';
import { keyholeCover, keyholePath } from './keyhole.ts';
import { createKeyholeLight, KEYHOLE_LOOK, type KeyholeLight } from './keyhole-light.ts';
import type { VideoStudio } from './videos.ts';
import './memory-waypoints.css';

const NS = 'http://www.w3.org/2000/svg';
const FRAME_PX = 960;
// The viewer clips at 2 cm. Magnify that image plane for inspection without moving its centre
// away from the camera tip. FOV and aspect still determine its exact proportions and size.
const NEAR_PLANE_MAGNIFICATION = 40;
let serial = 0;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...kids: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  el.append(...kids);
  return el;
}

interface Memory {
  id: string;
  slide: SlideDoc;
  job?: VideoGeneration;
  button: HTMLButtonElement;
  image: SVGImageElement;
  tether: SVGLineElement;
  light: KeyholeLight;
  position: THREE.Vector3;
  thumbnail: string;
  thumbnailKey: string;
}

interface WaypointHost {
  mount: HTMLElement;
  stage: HTMLElement;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  worldId: string;
  studio: VideoStudio;
  active(): boolean;
  freeze(on: boolean): void;
  isFrozen(): boolean;
}

/** Keep input on a memory from becoming walking, looking, or a viewer shortcut. */
function localInput(el: HTMLElement) {
  for (const type of ['pointerdown', 'pointerup', 'click', 'wheel', 'keydown']) {
    el.addEventListener(type, (event) => event.stopPropagation());
  }
}

function sparklingPlay(title: string) {
  const button = h('button.memory-play', { type: 'button', 'aria-label': `Play memory: ${title}` },
    h('span.memory-play-disc', { 'aria-hidden': 'true' }, '▶'));
  // Reuse the dormant keyhole's four-point glints, colour, and rhythm.
  const sparkle = KEYHOLE_LOOK.sparkle;
  for (const star of sparkle.stars) {
    const glint = h('span.memory-play-spark', { 'aria-hidden': 'true' }, '✦');
    glint.style.cssText = `--spark-time:${star.every}s;--spark-delay:${-star.at * star.every}s;--spark-color:${sparkle.color};--spark-glow:${sparkle.glow}`;
    button.append(glint);
  }
  return button;
}

export function createMemoryWaypoints(host: WaypointHost) {
  let disposed = false;
  let enabled = true;
  let captures: SlideDoc[] = [];
  let jobs: readonly VideoGeneration[] = [];
  let fetching: Promise<void> | null = null;
  let captureRevision = 0;
  let selected: Memory | null = null;
  let openedAt = 0;
  let fromQuaternion = new THREE.Quaternion();
  const targetQuaternion = new THREE.Quaternion();
  let fromScale = 1;
  const fromPosition = new THREE.Vector3();
  let targetScale = 1;
  let frameHeight = 1;
  let playing = false;
  let playButton: HTMLButtonElement | null = null;
  let closePremiere: (() => void) | null = null;
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const memories = new Map<string, Memory>();
  const markers = h('div.memory-waypoints', { 'aria-label': 'Memory waypoints', hidden: true });
  const tethers = svg('svg', { class: 'memory-waypoint-tethers', 'aria-hidden': 'true' });
  markers.append(tethers);
  const list = h('div.memory-waypoint-list');
  const count = h('span', 'Memory waypoints');
  const toggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const status = h('p.muted.memory-layer-status', { role: 'status' }, 'Loading captures…');
  const panel = h('div.memory-layer', h('label.row', toggle, count), status,
    h('details', h('summary', 'Browse memories'), list));
  const bar = h('aside.memory-inspection', { hidden: true, 'aria-label': 'Selected memory' });
  const title = h('strong');
  const subtitle = h('span.memory-inspection-note');
  const watch = h('button', { type: 'button' }, 'Watch memory');
  const close = h('button', { type: 'button', 'aria-label': 'Close memory preview' }, '×');
  bar.append(h('div', title, subtitle), watch, close);
  localInput(bar);
  watch.addEventListener('click', () => { if (selected?.job) premiere(selected); });
  close.addEventListener('click', () => closeInspection());
  localInput(markers);

  const css = new CSS3DRenderer();
  css.domElement.className = 'memory-frame-layer';
  const frameScene = new THREE.Scene();
  const picture = h('img.memory-frame-image', { alt: '', draggable: false });
  picture.addEventListener('error', () => picture.removeAttribute('src'));
  const surface = h('div.memory-frame-surface', picture);
  const plane = h('div.memory-frame', surface);
  localInput(plane);
  const frame = new CSS3DObject(plane);
  frame.visible = false;
  frameScene.add(frame);
  host.stage.append(css.domElement, markers);
  host.mount.append(bar);
  let width = 0, height = 0;
  const projected = new THREE.Vector3();
  const local = new THREE.Vector3();

  function closeInspection(focus = true) {
    const prior = selected;
    selected = null;
    frame.visible = false;
    bar.hidden = true;
    prior?.button.setAttribute('aria-expanded', 'false');
    if (focus) host.canvas.focus({ preventScroll: true });
  }

  function inspect(memory: Memory) {
    if (!enabled || !host.active() || host.isFrozen() || playing) return;
    if (selected === memory) { closeInspection(); return; }
    closeInspection(false);
    selected = memory;
    openedAt = performance.now();
    fromQuaternion = host.camera.quaternion.clone();
    const entry = memory.slide.entry;
    frameHeight = FRAME_PX / entry.aspect;
    const nearHeight = 2 * host.camera.near * Math.tan(THREE.MathUtils.degToRad(entry.fovY) / 2);
    targetScale = nearHeight * NEAR_PLANE_MAGNIFICATION / frameHeight;
    // Match the keyhole's screen size at the beginning of its opening.
    const distance = Math.max(host.camera.near, host.camera.position.distanceTo(memory.position));
    const pixelHeight = memory.button.getBoundingClientRect().height || 68;
    fromScale = pixelHeight * distance / Math.max(1, height) * 2 * Math.tan(THREE.MathUtils.degToRad(host.camera.fov) / 2) / frameHeight;
    frame.position.copy(memory.position); // never offset to the focus point or the near plane
    const buttonBox = memory.button.getBoundingClientRect(), stageBox = host.stage.getBoundingClientRect();
    fromPosition.copy(memory.position);
    if (buttonBox.width && width && height) {
      const depth = memory.position.clone().project(host.camera).z;
      fromPosition.set(
        2 * (buttonBox.x + buttonBox.width / 2 - stageBox.x) / width - 1,
        1 - 2 * (buttonBox.y + buttonBox.height / 2 - stageBox.y) / height, depth,
      ).unproject(host.camera);
    }
    frame.quaternion.copy(fromQuaternion);
    frame.scale.setScalar(fromScale);
    plane.classList.remove('is-open');
    plane.style.width = `${FRAME_PX}px`;
    plane.style.height = `${frameHeight}px`;
    if (memory.thumbnail) picture.src = memory.thumbnail;
    else picture.removeAttribute('src');
    picture.alt = memory.job ? `Middle frame of ${memory.job.title}` : memory.slide.title;
    surface.querySelector('.memory-play')?.remove();
    playButton = null;
    if (memory.job) {
      const play = sparklingPlay(memory.job.title);
      play.addEventListener('click', () => premiere(memory));
      surface.append(play);
      playButton = play;
    }
    frame.visible = true;
    bar.hidden = false;
    title.textContent = memory.job?.title || memory.slide.title;
    subtitle.textContent = memory.job ? 'At its captured viewpoint · drag to look around' : 'Captured here · no video yet';
    watch.hidden = !memory.job;
    memory.button.setAttribute('aria-expanded', 'true');
    host.canvas.focus({ preventScroll: true });
  }

  function premiere(memory: Memory) {
    if (!memory.job?.videoUrl || playing || host.isFrozen() || disposed) return;
    const source = memory.job.videoUrl;
    const video = h('video.memory-premiere-video', {
      src: source, poster: memory.thumbnail || undefined, playsInline: true,
      controls: true, preload: 'auto', loop: false,
      'aria-label': memory.job.title,
    }) as HTMLVideoElement;
    const exit = h('button.memory-premiere-exit', { type: 'button' }, '← Return to world');
    const message = h('p.memory-premiere-status', { role: 'status' });
    const dialog = h('dialog.memory-premiere', { 'aria-label': `Premiere: ${memory.job.title}` },
      video, h('header', exit, h('span', memory.job.title)), message) as HTMLDialogElement;
    localInput(dialog);
    let finished = false;
    let enteredFullscreen = false;
    const fullscreenTarget = host.mount;
    const requestFullscreen = !document.fullscreenElement && !!fullscreenTarget.requestFullscreen;
    const focusBefore = document.activeElement;
    const onFullscreen = () => {
      if (document.fullscreenElement === fullscreenTarget) enteredFullscreen = true;
      else if (enteredFullscreen) finish();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      document.removeEventListener('fullscreenchange', onFullscreen);
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (requestFullscreen && document.fullscreenElement === fullscreenTarget) void document.exitFullscreen().catch(() => undefined);
      dialog.close();
      dialog.remove();
      closePremiere = null;
      playing = false;
      host.mount.classList.remove('memory-playing');
      host.freeze(false);
      closeInspection(false);
      if (!disposed) {
        if (focusBefore instanceof HTMLElement && focusBefore.isConnected && !focusBefore.closest('[hidden]')) focusBefore.focus({ preventScroll: true });
        else host.canvas.focus({ preventScroll: true });
      }
    };
    closePremiere = finish;
    playing = true;
    host.freeze(true);
    host.mount.classList.add('memory-playing');
    for (const other of host.mount.querySelectorAll('video')) other.pause();
    host.mount.append(dialog);
    dialog.showModal();
    exit.focus({ preventScroll: true });
    if (requestFullscreen) document.addEventListener('fullscreenchange', onFullscreen);
    exit.addEventListener('click', finish);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(); });
    video.addEventListener('ended', finish, { once: true });
    video.addEventListener('error', () => { if (!finished) message.textContent = 'This memory could not play. Return to the world and try again.'; });
    // Both calls stay in the play gesture. A viewport-filling dialog is also the fallback on iOS
    // and browsers that do not allow element fullscreen; playback never depends on that permission.
    // Browsers prohibit requestFullscreen() on <dialog>. Its viewer ancestor is a valid
    // fullscreen target, and the modal remains above it with an operable return button.
    if (requestFullscreen) {
      void fullscreenTarget.requestFullscreen().then(() => {
        if (finished && document.fullscreenElement === fullscreenTarget) void document.exitFullscreen().catch(() => undefined);
      }).catch(() => undefined);
    }
    void video.play().catch(() => { if (!finished) message.textContent = 'Press play to begin your memory.'; });
    video.addEventListener('playing', () => { message.textContent = ''; });
  }

  function makeMemory(id: string, slide: SlideDoc, job?: VideoGeneration): Memory {
    const key = `wom-memory-${++serial}`;
    const geo = { cx: 50, cy: 46, size: 72 };
    const light = createKeyholeLight(key);
    light.fit(geo, 0.8);
    const image = svg('image', { x: 26, y: 10, width: 48, height: 72, preserveAspectRatio: 'xMidYMid slice', 'clip-path': `url(#${key}-image)` });
    const icon = svg('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' },
      svg('defs', {}, ...light.defs, ...light.lineDefs,
        svg('clipPath', { id: `${key}-image` }, svg('path', { d: keyholePath(geo) }))),
      light.glow, svg('path', { d: keyholePath(geo), fill: '#170d0a' }), image, light.sheen, light.line);
    const button = h('button.memory-waypoint', { type: 'button', 'aria-expanded': 'false', dataset: { memoryId: id } }, icon);
    const tether = svg('line', { class: 'memory-waypoint-tether', display: 'none' });
    tethers.append(tether);
    const memory: Memory = { id, slide, job, button, image, tether, light, position: new THREE.Vector3(...slide.entry.position), thumbnail: '', thumbnailKey: '' };
    button.addEventListener('click', () => inspect(memory));
    markers.append(button);
    return memory;
  }

  function sync() {
    if (disposed) return;
    const keep = new Set<string>();
    for (const slide of captures) {
      // Do not invent a location for deleted sources or for a world's original photograph.
      if (slide.kind !== 'view') continue;
      const completed = jobs.filter((job) => job.slideId === slide.id && job.status === 'succeeded' && job.videoUrl);
      const variants: (VideoGeneration | undefined)[] = completed.length ? completed : [undefined];
      for (const job of variants) {
        const id = job?.id ?? `capture:${slide.id}`;
        keep.add(id);
        const memory = memories.get(id) ?? makeMemory(id, slide, job);
        memories.set(id, memory);
        memory.slide = slide;
        memory.job = job;
        memory.position.fromArray(slide.entry.position);
        memory.button.title = job?.title || slide.title;
        memory.button.setAttribute('aria-label', `Inspect memory: ${job?.title || slide.title}`);
        const thumbnailKey = job ? `${job.id}:${job.updatedAt}` : slide.image.url;
        if (thumbnailKey !== memory.thumbnailKey) {
          memory.thumbnailKey = thumbnailKey;
          // A completed clip never falls back to the first frame of its siblings.
          const thumbnail = job ? host.studio.thumbnail(job) : Promise.resolve(slide.image.url);
          void thumbnail.then((url) => {
            if (disposed || memories.get(id) !== memory || memory.thumbnailKey !== thumbnailKey || !url) return;
            memory.thumbnail = url;
            memory.image.setAttribute('href', url);
            if (selected === memory) picture.src = url;
          });
        }
      }
    }
    for (const [id, memory] of memories) if (!keep.has(id)) {
      if (selected === memory) { closePremiere?.(); closeInspection(false); }
      memory.button.remove();
      memory.tether.remove();
      memories.delete(id);
    }
    count.textContent = `Memory waypoints (${memories.size})`;
    status.textContent = memories.size ? 'Keyholes mark where each memory was captured.' : 'Capture a view inside this world to leave a memory here.';
    // Preserve focused list controls across unchanged status polls.
    const ids = [...memories.keys()].join('|');
    if (list.dataset.ids !== ids) {
      list.dataset.ids = ids;
      list.replaceChildren(...[...memories.values()].map((memory) => h('button', {
        type: 'button', onclick: () => inspect(memory),
      }, memory.job?.title || memory.slide.title)));
    }
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (fetching) return fetching;
    const startedRevision = captureRevision;
    fetching = api.worldSlides(host.worldId).then((slides) => {
      if (disposed || startedRevision !== captureRevision) return;
      captures = slides;
      sync();
    }).catch(() => {
      if (!disposed) status.textContent = 'Could not refresh memories. Reconnecting…';
    }).finally(() => {
      fetching = null;
      if (!disposed && startedRevision !== captureRevision) void refresh();
    });
    return fetching;
  }

  const unsubscribe = host.studio.subscribe((records) => {
    jobs = records;
    sync();
    void refresh();
  });
  toggle.addEventListener('change', () => {
    enabled = toggle.checked;
    list.hidden = !enabled;
    if (!enabled) closeInspection(false);
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && selected && !playing) { event.preventDefault(); event.stopPropagation(); closeInspection(); }
  };
  host.mount.addEventListener('keydown', onKey, true);

  return {
    panel,
    refresh,
    addCapture(slide: SlideDoc) {
      captureRevision++;
      captures = [...captures.filter((capture) => capture.id !== slide.id), slide];
      sync();
    },
    removeCapture(id: string) {
      captureRevision++;
      captures = captures.filter((capture) => capture.id !== id);
      sync();
    },
    isPlaying: () => playing,
    /** Called with the viewer's render loop, after its camera has moved. */
    frame(now: number) {
      if (disposed) return;
      const visible = enabled && host.active() && !host.isFrozen() && !playing;
      markers.hidden = !visible;
      css.domElement.hidden = !visible;
      if (!host.active() && selected && !playing) closeInspection(false);
      if (!visible) { bar.hidden = true; return; }
      const w = host.stage.clientWidth, hgt = host.stage.clientHeight;
      if (!w || !hgt) return;
      if (w !== width || hgt !== height) { width = w; height = hgt; css.setSize(w, hgt); }
      host.camera.updateMatrixWorld();
      const focal = height / (2 * Math.tan(THREE.MathUtils.degToRad(host.camera.fov) / 2));
      const occupied: { x: number; y: number; size: number }[] = [];
      for (const memory of memories.values()) {
        local.copy(memory.position).applyMatrix4(host.camera.matrixWorldInverse);
        projected.copy(memory.position).project(host.camera);
        const show = !selected && local.z < -host.camera.near && projected.z < 1 && Math.abs(projected.x) < 1.15 && Math.abs(projected.y) < 1.15;
        memory.button.hidden = !show;
        memory.tether.setAttribute('display', 'none');
        if (!show) continue;
        const size = THREE.MathUtils.clamp(0.18 * focal / -local.z, 44, 100);
        const anchorX = (projected.x + 1) * width / 2, anchorY = (1 - projected.y) * height / 2;
        let x = anchorX, y = anchorY;
        // Captures can be centimetres apart, and sibling clips share exactly one origin.
        // Separate their finger targets, then tether each to its precise projected camera tip.
        for (let attempt = 0; attempt < 64; attempt++) {
          const r = attempt ? size * 1.15 * Math.sqrt(attempt) : 0;
          const angle = attempt * 2.39996;
          x = THREE.MathUtils.clamp(anchorX + Math.cos(angle) * r, size / 2, width - size / 2);
          y = THREE.MathUtils.clamp(anchorY + Math.sin(angle) * r, size / 2, height - size / 2);
          if (!occupied.some((other) => Math.abs(x - other.x) < (size + other.size) * .52 && Math.abs(y - other.y) < (size + other.size) * .52)) break;
        }
        occupied.push({ x, y, size });
        if (Math.hypot(x - anchorX, y - anchorY) > 4) {
          for (const [key, value] of Object.entries({ x1: anchorX, y1: anchorY, x2: x, y2: y })) memory.tether.setAttribute(key, value.toFixed(2));
          memory.tether.setAttribute('display', 'inline');
        }
        memory.button.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
        memory.button.style.width = `${size}px`;
        memory.button.style.height = `${size}px`;
        memory.button.style.zIndex = String(Math.round(10000 / (1 - local.z)));
        memory.light.frame(now / 1000, 0.32, 1, 1, 0.3);
      }
      if (selected) {
        bar.hidden = false;
        const t = calm.matches ? 1 : Math.min(1, (now - openedAt) / 600);
        const e = 1 - (1 - t) ** 3;
        frame.position.lerpVectors(fromPosition, selected.position, e);
        targetQuaternion.fromArray(selected.slide.entry.quaternion).normalize();
        frame.quaternion.slerpQuaternions(fromQuaternion, targetQuaternion, e);
        frame.scale.setScalar(THREE.MathUtils.lerp(fromScale, targetScale, e));
        const geo = { cx: FRAME_PX / 2, cy: frameHeight / 2, size: frameHeight * 0.72 };
        surface.style.clipPath = t === 1 ? 'none' : `path('${keyholePath(geo, THREE.MathUtils.lerp(1, keyholeCover(geo, FRAME_PX, frameHeight, 0), e))}')`;
        plane.classList.toggle('is-open', t === 1);
        local.copy(frame.position).applyMatrix4(host.camera.matrixWorldInverse);
        frame.visible = local.z < -host.camera.near;
        if (playButton && frame.visible) {
          // Preserve a finger-sized play disc as the visitor moves away from the image plane.
          const pixelsPerUnit = frame.scale.x * focal / -local.z;
          playButton.style.setProperty('--memory-play-scale', String(56 / (108 * pixelsPerUnit)));
        }
      }
      css.render(frameScene, host.camera);
    },
    dispose() {
      disposed = true;
      closePremiere?.();
      unsubscribe();
      host.mount.removeEventListener('keydown', onKey, true);
      frame.removeFromParent();
      css.domElement.remove();
      markers.remove(); bar.remove(); panel.remove();
      memories.clear();
    },
  };
}
