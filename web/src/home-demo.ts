// Loaded only after a homepage demo click. Carry the actual source photograph into the existing viewer,
// growing the card and its keyhole together; the viewer then reveals the live world through that aperture.
import { api } from './api.ts';
import { apertureGeometry } from './aperture.ts';
import { photoFrame } from './frame.ts';
import type { KeyholeGeo } from './keyhole.ts';
import { worldHref } from './routes.ts';
import { buildCover, giveHandoff } from './slides/handoff.ts';
import { createKeyholeMark } from './slides/mark.ts';
import { createWorldLoading } from './world-loading.ts';

export async function openMemoryDemo(o: {
  id: string;
  stage: HTMLElement;
  photo: HTMLImageElement;
  keyhole: () => KeyholeGeo;
  signal: AbortSignal;
  navigate: (href: string) => void;
  onCancel: () => void;
  onLoading: () => void;
}) {
  o.signal.throwIfAborted();
  const loading = createWorldLoading(o.onCancel);
  o.onLoading();
  let cover: HTMLElement | null = null;
  const abort = () => { loading.dispose(); cover?.remove(); };
  o.signal.addEventListener('abort', abort, { once: true });
  try {
    const [{ manifest, access, running }] = await Promise.all([
      api.get(o.id, o.signal),
      // Download and evaluate the viewer on intent; a WebGL context is created only after navigation.
      import('./viewer.ts'),
      o.photo.decode(),
    ]);
    o.signal.throwIfAborted();
    if (access?.visibility !== 'link' || running || !manifest.scene || !['done', 'partial'].includes(manifest.status)) {
      throw new Error('The sample is not a shared, completed world.');
    }

    const w = window.innerWidth, h = window.innerHeight;
    const aspect = o.photo.naturalWidth / o.photo.naturalHeight;
    const rect = o.stage.getBoundingClientRect();
    const target = photoFrame(w, h, aspect);
    // The card crops the photo; interpolate that very crop into the viewer's shared camera framing.
    const scale = Math.max(rect.width / o.photo.naturalWidth, rect.height / o.photo.naturalHeight);
    const source = { w: o.photo.naturalWidth * scale, h: o.photo.naturalHeight * scale };
    const from = { x: rect.left + (rect.width - source.w) / 2, y: rect.top + (rect.height - source.h) / 2, ...source };
    const geo = o.keyhole();
    const endGeo = apertureGeometry({ w, h, photo: target });
    const style = getComputedStyle(o.stage);
    const corners = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(parseFloat);
    const coverEl = cover = buildCover({ image: o.photo, aspect, dormant: false, w, h });
    coverEl.classList.add('home-demo-cover');
    const image = coverEl.querySelector<HTMLImageElement>('.slide-cover-img')!;
    const mark = createKeyholeMark(w, h);
    mark.svg.classList.add('slide-cover-mark');
    const shade = document.createElement('div');
    shade.className = 'memory-shade';
    shade.style.inset = 'auto';
    coverEl.append(shade, mark.svg);

    const mix = (a: number, b: number, t: number) => a + (b - a) * t;
    const draw = (t: number) => {
      const edge = [rect.top, w - rect.right, h - rect.bottom, rect.left].map((v) => `${mix(v, 0, t)}px`).join(' ');
      coverEl.style.clipPath = `inset(${edge} round ${corners.map((v) => `${v * (1 - t)}px`).join(' ')})`;
      Object.assign(image.style, {
        left: `${mix(from.x, target.x, t)}px`, top: `${mix(from.y, target.y, t)}px`,
        width: `${mix(from.w, target.w, t)}px`, height: `${mix(from.h, target.h, t)}px`,
      });
      Object.assign(shade.style, {
        left: `${rect.left * (1 - t)}px`, top: `${rect.top * (1 - t)}px`,
        width: `${mix(rect.width, w, t)}px`, height: `${mix(rect.height, h, t)}px`, opacity: String(1 - t),
      });
      mark.set({ cx: mix(geo.cx, endGeo.cx, t), cy: mix(geo.cy, endGeo.cy, t), size: mix(geo.size, endGeo.size, t) }, { glow: 1, px: 1 });
    };
    draw(0);
    document.body.append(coverEl);
    await new Promise<void>((resolve, reject) => {
      let frame = 0;
      const cancel = () => { cancelAnimationFrame(frame); reject(o.signal.reason); };
      o.signal.addEventListener('abort', cancel, { once: true });
      const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 800;
      const start = performance.now();
      const tick = (now: number) => {
        const t = duration ? Math.min(1, (now - start) / duration) : 1;
        draw(t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
        if (t < 1) frame = requestAnimationFrame(tick);
        else { o.signal.removeEventListener('abort', cancel); resolve(); }
      };
      frame = requestAnimationFrame(tick);
    });
    o.signal.throwIfAborted();
    coverEl.style.removeProperty('clip-path');
    // The viewer now owns cancellation and cleanup; home teardown must not end the shared game.
    o.signal.removeEventListener('abort', abort);
    giveHandoff({ direction: 'enter', world: o.id, slide: 'photo', cover: coverEl, loading });
    loading.setCancel(() => o.navigate('/#/'));
    o.navigate(worldHref(o.id, { handle: access.handle, query: 'demo=1' }));
  } catch (err) {
    loading.dispose();
    cover?.remove();
    throw err;
  } finally {
    o.signal.removeEventListener('abort', abort);
  }
}
