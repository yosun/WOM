// Passing a slide between the slide space and the viewer without a seam.
//
// The two are separate pages, and between them the router clears the screen and fetches. A handoff bridges
// that: the sender leaves a cover on top of everything (the slide's image exactly where the receiver will
// show it, on the same blurred bars), and the receiver takes the cover over and removes it once it shows the
// same picture itself.
//   enter   the space carried a slide up to face the camera, growing its keyhole from its resting size to its full
//           size on the way, and the cover shows it with that glowing keyhole the world loads behind. The viewer
//           removes the cover once its photo and aperture are on screen.
//   return  the viewer was left for the space it came from: the cover shows the slide's image, and the space
//           flies the slide back into its place from there.
import { apertureGeometry } from '../aperture.ts';
import type { SlideDoc } from '../api.ts';
import type { WorldLoading } from '../world-loading.ts';
import { h } from '../dom.ts';
import { paintBackdrop, photoFrame } from '../frame.ts';
import { createKeyholeMark } from './mark.ts';

export interface Handoff {
  direction: 'enter' | 'return';
  world: string;
  /** The slide's id in its world ('photo' for the photo). */
  slide: string;
  /** The slide itself, when the sender has it. */
  doc?: SlideDoc;
  /** The space the slide was played from. */
  from?: string;
  cover: HTMLElement;
  /** An opt-in homepage loader stays alive, including its firefly score, while the viewer mounts. */
  loading?: WorldLoading;
}

/** A cover nobody takes is removed after this long. */
const STALE_MS = 12_000;

let pending: { handoff: Handoff; timer: number } | null = null;

export function giveHandoff(handoff: Handoff) {
  dropHandoff();
  document.body.append(handoff.cover);
  pending = { handoff, timer: window.setTimeout(dropHandoff, handoff.loading ? 120_000 : STALE_MS) };
}

/** The pending handoff when `wanted` accepts it; the cover is then the caller's to remove (see `removeCover`). */
export function takeHandoff(wanted: (h: Handoff) => boolean): Handoff | null {
  if (!pending || !wanted(pending.handoff)) return null;
  const { handoff, timer } = pending;
  clearTimeout(timer);
  pending = null;
  return handoff;
}

/** Remove a cover nobody took (the next page is not the one it was meant for). */
export function dropHandoff() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.handoff.loading?.dispose();
  removeCover(pending.handoff.cover);
  pending = null;
}

export function removeCover(cover: HTMLElement, ms = 160) {
  cover.style.transition = `opacity ${ms}ms ease`;
  cover.style.opacity = '0';
  window.setTimeout(() => cover.remove(), ms + 40);
}

/**
 * The slide's image where the viewer shows it on a `w` × `h` stage (full-bleed or whole on blurred bars), and,
 * when `dormant`, the keyhole on it as it looks before the world loads. `image` should be decoded already, so the
 * cover paints at once.
 */
export function buildCover(o: { image: HTMLImageElement; aspect: number; dormant: boolean; w?: number; h?: number }): HTMLElement {
  const w = o.w ?? window.innerWidth, hgt = o.h ?? window.innerHeight;
  const rect = photoFrame(w, hgt, o.aspect);
  const cover = h('div.slide-cover', { 'aria-hidden': 'true' });
  if (rect.x > 0.5 || rect.y > 0.5) {
    const bars = h('canvas.slide-cover-bars') as HTMLCanvasElement;
    try { paintBackdrop(bars, o.image, o.aspect); } catch { /* the bars stay dark */ }
    cover.append(bars);
  }
  const img = h('img.slide-cover-img', { src: o.image.currentSrc || o.image.src, alt: '', draggable: false });
  Object.assign(img.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
  cover.append(img);
  if (o.dormant) {
    const mark = createKeyholeMark(w, hgt);
    mark.set(apertureGeometry({ w, h: hgt, photo: rect }), { glow: 1, px: 1 });
    mark.svg.classList.add('slide-cover-mark');
    cover.append(mark.svg);
  }
  return cover;
}
