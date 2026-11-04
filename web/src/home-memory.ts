import { h } from './dom.ts';
import { keyholeDot, keyholePath } from './keyhole.ts';
import { worldHref } from './routes.ts';

// This generated garden is the existing pipeline demo, never a visitor's upload.
// Only its source photograph is loaded before someone asks to enter.
const SAMPLE_ID = 'mvxixlbz34cbfb22';
const PHOTO = '/home/sunny-garden.webp';
const MARK = { cx: 50, cy: 53, size: 96 };

export function memoryMark(className: string) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 128');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', keyholePath(MARK));
  const dot = document.createElementNS(ns, 'circle');
  const d = keyholeDot(MARK);
  dot.setAttribute('cx', String(d.x));
  dot.setAttribute('cy', String(d.y));
  dot.setAttribute('r', String(d.r));
  svg.append(path, dot);
  return svg;
}

/** A photograph until a click: no video, world requests, renderer imports or WebGL context on the homepage. */
export function createMemoryPreview(navigate: (href: string) => void) {
  let disposed = false;
  let attempt: AbortController | null = null;
  const events = new AbortController();
  const photo = h('img.memory-photo', { src: PHOTO, alt: 'A dog in a sunny garden, beside a red bicycle and a wooden bench.', width: 1200, height: 800, fetchPriority: 'high' });
  const status = h('span.memory-state', { 'aria-live': 'polite' }, 'One photograph');
  const hint = h('span.memory-hint', 'Load the 3D demo');
  const mark = memoryMark('memory-keyhole');
  const enter = h('button.memory-enter', { type: 'button', 'aria-label': 'Load the sample 3D world' }, mark, hint);
  const cancel = h('button.memory-cancel', { type: 'button', hidden: true }, 'Cancel');
  const preparing = h('div.memory-preparing', { hidden: true }, h('progress', { max: 100, 'aria-label': 'Preparing the demo' }));
  const error = h('p.memory-error', { role: 'status', hidden: true });
  const stage = h('div.memory-stage',
    photo,
    h('div.memory-shade', { 'aria-hidden': 'true' }),
    h('div.memory-topline', status, h('span', 'Interactive 3D demo')),
    enter, preparing, cancel, error,
  );
  const el = h('figure.home-memory', stage,
    h('figcaption.memory-caption', h('span', h('strong', 'One image. More to discover.'), h('span', 'Enter, look around, and walk beyond the frame.')), h('span.memory-caption-index', { 'aria-hidden': 'true' }, '01 / A MEMORY')),
  );

  const reset = () => {
    stage.setAttribute('aria-busy', 'false');
    stage.classList.remove('is-loading');
    status.textContent = 'One photograph';
    hint.textContent = 'Load the 3D demo';
    enter.disabled = launch.disabled = false;
    cancel.hidden = true;
    preparing.hidden = true;
  };
  const start = async () => {
    if (disposed || attempt) return;
    const controller = new AbortController();
    attempt = controller;
    const timeout = window.setTimeout(() => {
      controller.abort(new DOMException('The demo took too long to load.', 'TimeoutError'));
      if (disposed || attempt !== controller) return;
      attempt = null;
      reset();
      error.textContent = 'The world is taking longer to open. Please try again.';
      error.hidden = false;
      enter.focus({ preventScroll: true });
    }, 120_000);
    error.hidden = true;
    stage.setAttribute('aria-busy', 'true');
    stage.classList.add('is-loading');
    status.textContent = 'Opening the 3D world…';
    hint.textContent = 'Loading your way in…';
    enter.disabled = launch.disabled = true;
    cancel.hidden = false;
    preparing.hidden = false;
    cancel.focus({ preventScroll: true });
    try {
      const { openMemoryDemo } = await import('./home-demo.ts');
      controller.signal.throwIfAborted();
      await openMemoryDemo({
        id: SAMPLE_ID, stage, photo, signal: controller.signal, navigate,
        onCancel: stop,
        onLoading: () => { preparing.hidden = true; cancel.hidden = true; },
        keyhole: () => {
          const box = mark.getBoundingClientRect();
          return { cx: box.left + MARK.cx * box.width / 100, cy: box.top + MARK.cy * box.height / 128, size: MARK.size * box.height / 128 };
        },
      });
    } catch {
      if (disposed || attempt !== controller) return;
      const aborted = controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError';
      reset();
      if (aborted) return;
      error.textContent = controller.signal.reason?.name === 'TimeoutError'
        ? 'The world is taking longer to open. Please try again.'
        : 'This sample could not open. Please try again, or create a world from your own photo.';
      error.hidden = false;
      enter.focus({ preventScroll: true });
    } finally {
      clearTimeout(timeout);
      if (attempt === controller) attempt = null;
    }
  };
  const stop = () => {
    attempt?.abort();
    attempt = null;
    reset();
    enter.focus({ preventScroll: true });
  };
  enter.addEventListener('click', () => void start());
  cancel.addEventListener('click', stop);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && attempt) { event.preventDefault(); stop(); }
  }, { signal: events.signal });

  const launch = h('button.home-sample-link', { type: 'button', onclick: () => void start() }, 'Try the interactive world', h('span', { 'aria-hidden': 'true' }, '↗'));
  const action = h('span.home-sample-action', launch, h('span.home-sample-note', 'Loads on click · Explore an existing world'));
  const facts = h('a.home-sample-link', { href: worldHref(SAMPLE_ID, { build: true }) }, 'Read the sample’s WOMetrics', h('span', { 'aria-hidden': 'true' }, '↗'));

  return {
    el, action, facts,
    dispose() {
      disposed = true;
      attempt?.abort();
      events.abort();
    },
  };
}
