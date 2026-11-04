// A saved capture becomes a video first frame: name it, describe its motion, and generate from this exact image.
// The viewer saves the picture and camera; the video studio owns generation history and inline playback.
import { api, type SlideDoc } from './api.ts';
import { h, toast } from './dom.ts';
import { slideKey, spaceUrl } from './slides/spaces.ts';
import type { VideoStudio, VideoEditor } from './videos.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A small outline camera used for the capture control. */
export function cameraIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M5 7h3l1.4-2h5.2L16 7h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z');
  const lens = document.createElementNS(SVG_NS, 'circle');
  lens.setAttribute('cx', '12');
  lens.setAttribute('cy', '13');
  lens.setAttribute('r', '3.5');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', '17.5');
  dot.setAttribute('cy', '10');
  dot.setAttribute('r', '0.75');
  for (const shape of [body, lens, dot]) {
    shape.setAttribute('fill', 'none');
    shape.setAttribute('stroke', 'currentColor');
    shape.setAttribute('stroke-width', '1.8');
    shape.setAttribute('stroke-linecap', 'round');
    shape.setAttribute('stroke-linejoin', 'round');
    svg.append(shape);
  }
  return svg;
}

export interface CaptureCard {
  /** The moment the picture is taken: a quick flash over the view (not drawn when motion is turned down). */
  flash(): void;
  /** Show the card for a slide that was just saved. `preview` is the picture that was saved. */
  show(slide: SlideDoc, preview?: Blob): void;
  dispose(): void;
}

export function createCaptureCard(mount: HTMLElement, studio: VideoStudio, options: { onRemove?: (slideId: string) => void } = {}): CaptureCard {
  // Announced to screen readers; the card itself is not a live region, because content that is already in
  // a region when it is inserted is often not read out.
  const live = h('div.capture-live', { role: 'status', 'aria-live': 'polite' });
  mount.append(live);

  let card: HTMLElement | null = null;
  let previewUrl = '';
  let editor: VideoEditor | null = null;
  let gone = false;

  const close = () => {
    editor?.dispose();
    editor = null;
    card?.remove();
    card = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  };

  return {
    flash() {
      if (gone) return;
      const el = h('div.capture-flash', { 'aria-hidden': 'true' });
      el.addEventListener('animationend', () => el.remove(), { once: true });
      // A browser that does not run the animation (motion turned down) would never fire animationend.
      setTimeout(() => el.remove(), 800);
      mount.append(el);
    },

    show(slide, preview) {
      if (gone) return;
      close();
      if (preview) previewUrl = URL.createObjectURL(preview);
      const undo = h('button', { type: 'button', title: 'Remove this capture' }, 'Undo') as HTMLButtonElement;
      const dismiss = h('button.capture-close', { type: 'button', 'aria-label': 'Dismiss capture', title: 'Dismiss capture' }, '×');
      const see = h('a.button', {
        href: spaceUrl(`world/${slide.world}`, slideKey(slide.world, slide.id)),
        target: '_blank', rel: 'noopener', title: 'Open this capture in the slides',
      }, 'See in slides');
      const body = h('div.capture-body');
      const el = h('aside.capture-card', { 'aria-label': 'Animate this capture' },
        h('p.capture-kicker', h('span.capture-saved', 'Captured'), h('span.capture-heading', 'Make this moment move')),
        body,
        h('div.capture-actions', see, undo),
        dismiss,
      );
      editor = studio.mountEditor(slide, body, { previewUrl: previewUrl || undefined });
      // Explicit dismissal leaves time to write and expand the prompt. The studio keeps jobs running afterward.
      dismiss.addEventListener('click', close);
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      }, { capture: true });
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        try {
          await api.deleteSlide(slide.world, slide.id);
          options.onRemove?.(slide.id);
          if (card === el) close();
          toast('Capture removed.');
        } catch (err) {
          undo.disabled = false;
          toast((err as Error).message, 'error');
        }
      });
      card = el;
      mount.append(el);
      live.textContent = '';
      requestAnimationFrame(() => { if (!gone) live.textContent = `Captured. Saved as ${slide.title}.`; });
    },

    dispose() {
      gone = true;
      close();
      live.remove();
      mount.querySelectorAll('.capture-flash').forEach((n) => n.remove());
    },
  };
}
