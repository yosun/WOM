// An opt-in loading screen. DOM lights and compositor animations only: no renderer, assets or frame loop.
// This module and its CSS are reached through the demo click or an explicitly opened world, never the homepage.
import { h } from './dom.ts';
import './world-loading.css';

export interface WorldLoading {
  setStatus(text: string): void;
  progress(loaded: number, total: number): void;
  setCancel(cancel: () => void): void;
  ready(): void;
  dispose(): void;
}

export function createWorldLoading(onCancel: () => void): WorldLoading {
  const events = new AbortController();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false, finished = false, hidden = false, caught = 0;
  let cancel = onCancel;
  const title = h('p.world-loading-title', { role: 'status' }, 'Preparing the 3D viewer…');
  const percent = h('span.world-loading-percent', 'Preparing…');
  const bar = h('progress.world-loading-bar', { max: 100, 'aria-label': 'Loading the 3D world' });
  const bytes = h('span.world-loading-bytes', 'The world will open when it is ready.');
  const score = h('strong.world-loading-count', '0');
  const counter = h('span.world-loading-score', score, ' caught');
  const hint = h('p.world-loading-hint', 'Catch a little light while your world loads.');
  const live = h('span.world-loading-live', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const toggle = h('button.world-loading-toggle', { type: 'button', 'aria-pressed': 'false' }, 'Hide fireflies');
  const stop = h('button.world-loading-cancel', { type: 'button', onclick: () => cancel() }, 'Cancel');
  const field = h('div.world-fireflies', { role: 'group', 'aria-label': 'Catch the fireflies' });
  const card = h('section.world-loading-card', { 'aria-label': 'World loading' },
    h('div.world-loading-heading', title, percent), bar, bytes,
    h('div.world-loading-game', hint, counter),
    h('div.world-loading-actions', toggle, stop), live,
  );
  const root = h('div.world-loading', field, card);
  document.body.append(root);
  // Keep game gestures out of the viewer's Enter-to-enter, camera and walking shortcuts.
  for (const name of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'click', 'wheel']) {
    root.addEventListener(name, (event) => {
      if (name === 'keydown' && (event as KeyboardEvent).key === 'Escape') cancel();
      event.stopPropagation();
    }, { signal: events.signal });
  }

  const flies: { button: HTMLButtonElement; animation?: Animation; timer?: number }[] = [];
  const animate = (fly: typeof flies[number], index: number) => {
    fly.animation?.cancel();
    if (disposed || finished) return;
    const w = window.innerWidth, ht = window.innerHeight;
    // Stay beside the keyhole; reserve the bottom of the screen for the loading card.
    const left = index % 2 === 0;
    const x0 = left ? 12 : w * 0.68;
    const x1 = left ? w * 0.28 : w - 60;
    const y0 = Math.min(110, ht * 0.2), y1 = Math.max(y0 + 20, ht - 265);
    const point = () => ({ x: x0 + Math.random() * Math.max(1, x1 - x0), y: y0 + Math.random() * Math.max(1, y1 - y0) });
    // With reduced motion, random positions never move apart. Space the still targets down each side so one cannot
    // permanently cover another; compress the spacing on short screens while keeping it inside the viewport.
    const slots = left ? 4 : 3;
    const gap = Math.min(80, Math.max(0, (y1 - 8) / (slots - 1)));
    const top = Math.max(8, Math.min(y0, y1 - gap * (slots - 1)));
    const at = motion.matches
      ? { x: x0 + Math.max(0, x1 - x0) / 2, y: top + Math.floor(index / 2) * gap }
      : point();
    fly.button.style.transform = `translate(${at.x}px, ${at.y}px)`;
    if (!motion.matches) {
      const points = [at, ...Array.from({ length: 7 }, point)];
      fly.animation = fly.button.animate(points.map((p, i) => ({
        transform: `translate(${p.x}px, ${p.y}px)`, opacity: i % 3 === 0 ? 0.6 : 1,
      })), { duration: 16_000 + index * 1100, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
      if (document.hidden || hidden) fly.animation.pause();
    }
  };
  for (let i = 0; i < 7; i++) {
    const button = h('button.world-firefly', { type: 'button', 'aria-label': `Catch firefly ${i + 1}` },
      h('span.world-firefly-halo', { 'aria-hidden': 'true' }),
      h('span.world-firefly-star', { 'aria-hidden': 'true' }),
      h('span.world-firefly-ring', { 'aria-hidden': 'true' }),
    );
    const fly: typeof flies[number] = { button };
    flies.push(fly);
    button.addEventListener('click', () => {
      if (disposed || finished || button.disabled) return;
      caught++;
      score.textContent = String(caught);
      live.textContent = `${caught} firefl${caught === 1 ? 'y' : 'ies'} caught.`;
      button.disabled = true;
      button.classList.add('is-caught');
      fly.animation?.pause();
      fly.timer = window.setTimeout(() => {
        if (disposed || finished) return;
        button.disabled = false;
        button.classList.remove('is-caught');
        animate(fly, i);
      }, 650);
    }, { signal: events.signal });
    field.append(button);
    animate(fly, i);
  }

  const sync = () => {
    if (disposed || finished) return;
    for (const fly of flies) {
      if (document.hidden || hidden || fly.button.disabled) fly.animation?.pause();
      else fly.animation?.play();
    }
  };
  document.addEventListener('visibilitychange', sync, { signal: events.signal });
  const layout = () => { if (!finished && !disposed) flies.forEach(animate); };
  window.addEventListener('resize', layout, { signal: events.signal });
  motion.addEventListener('change', layout, { signal: events.signal });
  toggle.addEventListener('click', () => {
    hidden = !hidden;
    field.hidden = hidden;
    toggle.textContent = hidden ? 'Show fireflies' : 'Hide fireflies';
    toggle.setAttribute('aria-pressed', String(hidden));
    sync();
  }, { signal: events.signal });

  const stopFlies = () => {
    for (const fly of flies) { fly.animation?.cancel(); clearTimeout(fly.timer); }
    field.remove();
  };
  return {
    setStatus(text) { if (!disposed && title.textContent !== text) title.textContent = text; },
    progress(loaded, total) {
      if (disposed || finished || total <= 0) return;
      // Downloading is only part of readiness. Reserve the last five percent for decoding and the first frames.
      bar.value = Math.max(bar.value, Math.min(95, Math.floor(95 * loaded / total)));
      percent.textContent = `${bar.value}%`;
      bar.setAttribute('aria-valuetext', `${bar.value}% — loading the world`);
      bytes.textContent = `${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
      if (title.textContent !== 'Loading the 3D world…') title.textContent = 'Loading the 3D world…';
    },
    setCancel(fn) { cancel = fn; },
    ready() {
      if (disposed || finished) return;
      finished = true;
      stopFlies();
      root.classList.add('is-ready');
      bar.value = 100;
      bar.setAttribute('aria-valuetext', '100% — world ready');
      percent.textContent = '100%';
      title.textContent = 'Your world is ready.';
      hint.textContent = 'Tap the keyhole to enter.';
      live.textContent = `World ready. ${caught} firefl${caught === 1 ? 'y' : 'ies'} caught. Tap the keyhole to enter.`;
      stop.textContent = 'Back to home';
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      events.abort();
      stopFlies();
      root.remove();
    },
  };
}
