import { api } from './api.ts';
import { h } from './dom.ts';
import { keyholeDot, keyholePath } from './keyhole.ts';
import { worldHref } from './routes.ts';

// This generated garden is the existing pipeline demo, never a visitor's upload.
// The bundled media come from its source.jpg and the sunny-garden Par pilot walkthrough.
const SAMPLE_ID = 'mvxixlbz34cbfb22';
const PHOTO = '/home/sunny-garden.webp';

export function memoryMark(className: string) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 128');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const geo = { cx: 50, cy: 53, size: 96 };
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', keyholePath(geo));
  const dot = document.createElementNS(ns, 'circle');
  const d = keyholeDot(geo);
  dot.setAttribute('cx', String(d.x));
  dot.setAttribute('cy', String(d.y));
  dot.setAttribute('r', String(d.r));
  svg.append(path, dot);
  return svg;
}

/** A light, opt-in preview. The full WebGL viewer loads only when someone follows the sample link. */
export function createMemoryPreview() {
  let disposed = false;
  let playing = false;
  let available = true;
  const video = h('video.memory-video', {
    src: '/home/sunny-garden.mp4', muted: true, playsInline: true, preload: 'none',
    poster: PHOTO, 'aria-label': 'A short walk through the garden rebuilt in 3D',
  });
  const status = h('span.memory-state', { 'aria-live': 'polite' }, 'One photograph');
  const hint = h('span.memory-hint', 'Open the memory');
  const play = h('button.memory-play', { type: 'button', 'aria-label': 'Play the sample memory preview', 'aria-pressed': 'false' }, memoryMark('memory-keyhole'), hint);
  const reset = h('button.memory-reset', { type: 'button', hidden: true }, 'Back to the photograph', h('span', { 'aria-hidden': 'true' }, '↶'));
  const error = h('p.memory-error', { role: 'status', hidden: true });
  const stage = h('div.memory-stage',
    h('img.memory-photo', { src: PHOTO, alt: 'A golden retriever in a sunny garden, beside a red bicycle and a wooden bench.', width: 1200, height: 800, fetchPriority: 'high' }),
    video,
    h('div.memory-shade', { 'aria-hidden': 'true' }),
    h('div.memory-topline', status, h('span', 'A WOM sample')),
    play, reset, error,
  );
  const el = h('figure.home-memory', stage,
    h('figcaption.memory-caption', h('span', h('strong', 'An afternoon, revisited.'), h('span', 'One photo. A place to wander.')), h('span.memory-caption-index', { 'aria-hidden': 'true' }, '01 / A MEMORY')),
  );

  const stop = () => {
    playing = false;
    video.pause();
    stage.classList.remove('is-playing');
    status.textContent = 'One photograph';
    play.hidden = false;
    play.setAttribute('aria-pressed', 'false');
    reset.hidden = true;
  };
  const start = () => {
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
    if (!available) return;
    error.hidden = true;
    video.currentTime = 0;
    playing = true;
    stage.classList.add('is-playing');
    status.textContent = 'Inside the 3D world';
    play.setAttribute('aria-pressed', 'true');
    play.hidden = true;
    reset.hidden = false;
    reset.focus({ preventScroll: true });
    void video.play().catch(() => {
      if (disposed || !playing) return;
      stop();
      play.focus({ preventScroll: true });
      error.textContent = 'The preview could not play. Please try again.';
      error.hidden = false;
    });
  };
  play.addEventListener('click', start);
  reset.addEventListener('click', () => { stop(); play.focus(); });
  video.addEventListener('ended', () => { stop(); if (el.contains(document.activeElement)) play.focus(); });
  video.addEventListener('error', () => {
    if (disposed) return;
    available = false;
    stop();
    play.hidden = true;
    fallback.disabled = true;
    fallback.textContent = 'Sample preview unavailable';
    error.textContent = 'The video preview is unavailable.';
    error.hidden = false;
  });

  const fallback = h('button.home-sample-link', { type: 'button', onclick: start }, 'Preview a sample memory', h('span', { 'aria-hidden': 'true' }, '↗'));
  const action = h('span.home-sample-action', fallback);
  // Only offer the live viewer when this explicitly chosen demo still exists and is shared.
  // Its baked-in preview remains usable on installations without the sample world.
  void api.get(SAMPLE_ID).then(({ manifest, access, running }) => {
    if (disposed || access.visibility !== 'link' || !manifest.scene || running || !['done', 'partial'].includes(manifest.status)) return;
    action.replaceChildren(h('a.home-sample-link', { href: worldHref(SAMPLE_ID, { handle: access.handle }) }, 'Explore a sample memory', h('span', { 'aria-hidden': 'true' }, '↗')));
  }).catch(() => undefined);

  return {
    el, action,
    dispose() {
      disposed = true;
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
}
