// What a person sees after capturing a moment inside a world: a quick flash, then a small card with the picture,
// its name and optional caption (which can be changed right there), a way to look at it among the slides, and a
// way to take it back.
//
// The picture and the camera are saved by the viewer (`saveSlide`, as a slide of the world). This module only
// tells the person that it worked, so nobody has to know what a "slide" or a "camera entry" is to use it.
import { api, type SlideDoc } from './api.ts';
import { h, toast } from './dom.ts';
import { slideKey, spaceUrl } from './slides/spaces.ts';

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

/** How long the card stays when the pointer and the keyboard are elsewhere. */
const SHOW_MS = 9000;

export interface CaptureCard {
  /** The moment the picture is taken: a quick flash over the view (not drawn when motion is turned down). */
  flash(): void;
  /** Show the card for a slide that was just saved. `preview` is the picture that was saved. */
  show(slide: SlideDoc, preview: Blob): void;
  dispose(): void;
}

export function createCaptureCard(mount: HTMLElement): CaptureCard {
  // Announced to screen readers; the card itself is not a live region, because content that is already in
  // a region when it is inserted is often not read out.
  const live = h('div.capture-live', { role: 'status', 'aria-live': 'polite' });
  mount.append(live);

  let card: HTMLElement | null = null;
  let previewUrl = '';
  let timer = 0;
  let gone = false;

  const close = () => {
    clearTimeout(timer);
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
      previewUrl = URL.createObjectURL(preview);
      let title = slide.title;
      let undone = false;

      // (h() leaves out a prop whose value is `false`, so these two are the strings the attributes take.)
      const name = h('input.capture-name', { type: 'text', value: title, maxLength: 120, spellcheck: 'false', autocomplete: 'off', title: 'Click to rename', 'aria-label': 'Name this capture' }) as HTMLInputElement;
      const caption = h('textarea.capture-caption', { rows: 2, maxLength: 2000, placeholder: 'Add a caption (optional)', 'aria-label': 'Caption this capture' }) as HTMLTextAreaElement;
      caption.value = slide.caption ?? '';
      const undo = h('button', { type: 'button', title: 'Take this capture back: the picture is removed and nothing else changes' }, 'Undo') as HTMLButtonElement;
      const dismiss = h('button.capture-close', { type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss' }, '×');
      const see = h('a.button', {
        href: spaceUrl(`world/${slide.world}`, slideKey(slide.world, slide.id)),
        target: '_blank',
        rel: 'noopener',
        title: 'Open this world\'s slides on this capture, in a new tab',
      }, 'See in slides');
      const el = h('aside.capture-card',
        h('img.capture-thumb', { src: previewUrl, alt: 'The picture that was captured', draggable: 'false' }),
        h('div.capture-body',
          h('p.capture-kicker', 'Captured. Come back to this spot from the slides.'),
          name,
          caption,
          h('div.capture-actions', see, undo),
        ),
        dismiss,
      );

      // The card stays while it is being used and goes a few seconds after it is left alone.
      const inUse = () => el.matches(':hover') || el.contains(document.activeElement);
      const arm = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => { if (inUse()) arm(); else close(); }, SHOW_MS);
      };
      el.addEventListener('pointerenter', () => clearTimeout(timer));
      el.addEventListener('pointerleave', arm);
      el.addEventListener('focusout', () => setTimeout(() => { if (card === el && !inUse()) arm(); }, 0));
      dismiss.addEventListener('click', close);

      // Typing a name must not walk the camera: the viewer's controls listen to every key on the page.
      name.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
        else if (e.key === 'Escape') { name.value = title; name.blur(); }
      });
      caption.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); caption.blur(); }
        else if (e.key === 'Escape') { caption.value = slide.caption ?? ''; caption.blur(); }
      });
      name.addEventListener('focus', () => clearTimeout(timer));
      caption.addEventListener('focus', () => clearTimeout(timer));
      name.addEventListener('change', async () => {
        const wanted = name.value.trim();
        if (!wanted || wanted === title) { name.value = title; return; }
        try {
          const renamed = await api.updateSlide(slide.world, slide.id, { title: wanted });
          title = renamed.title;
          // The server tidies a name (one line, no odd characters); show what was kept, unless typing went on.
          if (name.value.trim() === wanted) name.value = title;
        } catch (err) {
          if (!undone) toast((err as Error).message, 'error');
          name.value = title;
        }
      });

      caption.addEventListener('change', async () => {
        const wanted = caption.value;
        if (undone || wanted === (slide.caption ?? '')) { caption.value = slide.caption ?? ''; return; }
        try {
          const updated = await api.updateSlide(slide.world, slide.id, { caption: wanted });
          slide.caption = updated.caption;
          if (caption.value === wanted) caption.value = updated.caption ?? '';
        } catch (err) {
          if (!undone) toast((err as Error).message, 'error');
          caption.value = slide.caption ?? '';
        }
      });

      const cancelPendingEdits = () => {
        undone = true;
        name.value = title;
        caption.value = slide.caption ?? '';
      };
      undo.addEventListener('pointerdown', cancelPendingEdits);
      undo.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') cancelPendingEdits();
      });
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        name.disabled = true;
        caption.disabled = true;
        // Marked before the request: pressing Undo right after typing a name or caption also sends that edit
        // when the field loses focus first, and if the delete lands first, that 404 is not worth showing.
        undone = true;
        try {
          await api.deleteSlide(slide.world, slide.id);
          if (card === el) close();
          toast('Capture removed.');
        } catch (err) {
          undone = false;
          undo.disabled = false;
          name.disabled = false;
          caption.disabled = false;
          toast((err as Error).message, 'error');
        }
      });

      card = el;
      mount.append(el);
      arm();
      live.textContent = '';
      requestAnimationFrame(() => { live.textContent = `Captured. Saved as ${title}.`; });
    },

    dispose() {
      gone = true;
      close();
      live.remove();
      mount.querySelectorAll('.capture-flash').forEach((n) => n.remove());
    },
  };
}
