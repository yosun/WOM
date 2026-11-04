// Mask editor: redo one object's mask with SAM 3.1. Click the object to add points, Alt-click (or
// right-click) things that are not the object, or drag a box around it. "Preview" runs SAM on the marks
// without changing the world; "Keep this mask" rebuilds only that object (cutout, 3D asset, placements).
import { api, type WorldManifest } from './api.ts';
import { clear, fmtUsd, h, toast } from './dom.ts';

type ObjectRecord = WorldManifest['objects'][number];

const MODEL_LABEL: Record<string, string> = {
  idol: 'IDOL',
  triposplat: 'TripoSplat',
  'tripo-v31': 'Tripo H3.1',
  'tripo-p1': 'Tripo P1',
};
export const OBJECT_PRICE_USD: Record<string, number> = { idol: 0.1, triposplat: 0.05, 'tripo-v31': 0.3, 'tripo-p1': 0.5 };
export const modelLabel = (m: string) => MODEL_LABEL[m] ?? m;

/** Paint a binary mask PNG as a translucent colour layer on a canvas the size of the photo. */
async function tintedMask(url: string, rgba: [number, number, number, number]): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < px.data.length; i += 4) {
    const on = px.data[i] >= 128;
    px.data[i] = rgba[0];
    px.data[i + 1] = rgba[1];
    px.data[i + 2] = rgba[2];
    px.data[i + 3] = on ? rgba[3] : 0;
  }
  ctx.putImageData(px, 0, 0);
  return c;
}

export function openMaskEditor(m: WorldManifest, o: ObjectRecord) {
  const { width: W, height: H } = m.image;
  const file = (rel: string) => `/files/${m.id}/${rel}`;
  const points: { x: number; y: number; positive: boolean }[] = [];
  let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
  let drag: { x: number; y: number } | null = null;
  let hasDraft = false;

  const photo = h('img.mask-photo', { src: file(m.image.file), alt: 'Your photo', draggable: false });
  const current = h('div.mask-layer');
  const draft = h('div.mask-layer');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('mask-marks');
  const stage = h('div.mask-stage', photo, current, draft, svg);
  stage.style.setProperty('--ar', String(W / H));

  const info = h('p.muted');
  const previewBtn = h('button.primary', { type: 'button' }, 'Preview mask') as HTMLButtonElement;
  const keepBtn = h('button', { type: 'button', disabled: true }, 'Keep this mask') as HTMLButtonElement;
  const undoBtn = h('button', { type: 'button' }, 'Undo last mark') as HTMLButtonElement;
  const clearBtn = h('button', { type: 'button' }, 'Clear marks') as HTMLButtonElement;
  const closeBtn = h('button.link.close', { type: 'button', title: 'Close' }, '×') as HTMLButtonElement;
  const model = m.options.meshModel;
  const occluded = m.plan?.objects.find((p) => p.id === o.id)?.occluded;
  const history = h('div.mask-history');

  const modal = h('div.modal-backdrop',
    h('div.modal.mask-editor', { role: 'dialog', 'aria-label': `Fix the mask of ${o.name}` },
      h('header.modal-head', h('h2', `Fix the mask: ${o.name}`), closeBtn),
      h('p.muted', 'Click the object to add points. Alt-click or right-click something that is not the object. Drag to draw a box around it. Red is the current mask, green the preview.'),
      stage,
      info,
      h('div.row-buttons', previewBtn, keepBtn, undoBtn, clearBtn),
      h('p.muted',
        `Each preview runs SAM 3.1 ($0.0025). Keeping a mask rebuilds only this object: its cutout${occluded ? ' (completed by Muse Image, $0.01)' : ''}, ` +
        `its ${modelLabel(model)} asset (${fmtUsd(OBJECT_PRICE_USD[model] ?? 0)}) and its placements. The plan, clean plate, depth, world and the other objects are reused, ` +
        'and this mask with its assets stays in the object\'s history.'),
      history,
    ),
  );

  function close() {
    modal.remove();
    window.removeEventListener('keydown', onKey);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
  window.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  function toImage(e: PointerEvent | MouseEvent) {
    const r = photo.getBoundingClientRect();
    return {
      x: Math.min(W - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * W))),
      y: Math.min(H - 1, Math.max(0, Math.round(((e.clientY - r.top) / r.height) * H))),
    };
  }

  function drawMarks() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const radius = Math.max(W, H) * 0.008;
    if (box) {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(box.x0));
      rect.setAttribute('y', String(box.y0));
      rect.setAttribute('width', String(box.x1 - box.x0));
      rect.setAttribute('height', String(box.y1 - box.y0));
      rect.setAttribute('class', 'mark-box');
      rect.setAttribute('stroke-width', String(radius * 0.4));
      svg.appendChild(rect);
    }
    for (const p of points) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', String(p.x));
      c.setAttribute('cy', String(p.y));
      c.setAttribute('r', String(radius));
      c.setAttribute('class', p.positive ? 'mark-pos' : 'mark-neg');
      c.setAttribute('stroke-width', String(radius * 0.35));
      svg.appendChild(c);
    }
    previewBtn.disabled = !points.some((p) => p.positive) && !box;
  }

  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    drag = toImage(e);
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toImage(e);
    if (Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) < Math.max(W, H) * 0.01) return;
    box = { x0: Math.min(drag.x, p.x), y0: Math.min(drag.y, p.y), x1: Math.max(drag.x, p.x), y1: Math.max(drag.y, p.y) };
    drawMarks();
  });
  stage.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const p = toImage(e);
    const moved = Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) >= Math.max(W, H) * 0.01;
    drag = null;
    if (!moved) points.push({ ...p, positive: !(e.altKey || e.button === 2) });
    drawMarks();
  });

  undoBtn.addEventListener('click', () => {
    if (points.length) points.pop();
    else box = undefined;
    drawMarks();
  });
  clearBtn.addEventListener('click', () => {
    points.length = 0;
    box = undefined;
    drawMarks();
  });

  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    info.textContent = 'SAM 3.1 is looking…';
    try {
      const d = await api.maskPreview(m.id, o.id, { points, box });
      clear(draft);
      const layer = await tintedMask(d.url, [40, 220, 120, 150]);
      draft.append(layer);
      hasDraft = true;
      keepBtn.disabled = false;
      info.textContent = `Preview: ${(d.coverage * 100).toFixed(1)}% of the photo, ${d.box.x1 - d.box.x0}×${d.box.y1 - d.box.y0} px. Add or remove marks and preview again, or keep it.`;
    } catch (err) {
      info.textContent = (err as Error).message;
    } finally {
      previewBtn.disabled = false;
    }
  });

  keepBtn.addEventListener('click', async () => {
    if (!hasDraft) return;
    keepBtn.disabled = true;
    try {
      await api.applyMask(m.id, o.id);
      toast(`Rebuilding ${o.name} with the new mask. Everything else is reused.`);
      close();
    } catch (err) {
      toast((err as Error).message, 'error');
      keepBtn.disabled = false;
    }
  });

  // Earlier masks can be brought back with everything made from them, at no cost.
  if (o.history?.length) {
    history.append(h('h3', 'Earlier masks'));
    for (const v of [...o.history].reverse()) {
      const models = Object.keys(v.assets ?? {}).map(modelLabel).join(', ') || 'no 3D assets';
      const btn = h('button', { type: 'button' }, `Restore mask v${v.maskVersion}`) as HTMLButtonElement;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api.restoreMask(m.id, o.id, v.maskVersion);
          toast(`Restored mask v${v.maskVersion} of ${o.name}.`);
          close();
        } catch (err) {
          toast((err as Error).message, 'error');
          btn.disabled = false;
        }
      });
      history.append(h('div.row', h('span', `v${v.maskVersion} · ${models} · replaced ${v.replacedAt.slice(0, 16).replace('T', ' ')}`), btn));
    }
  }

  drawMarks();
  document.body.append(modal);
  if (o.mask?.file) {
    void tintedMask(file(o.mask.file), [255, 40, 90, 120]).then((c) => current.append(c)).catch(() => undefined);
  }
}
