// Tiny DOM helpers: h('div.card', { onclick }, children).
export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { style?: Partial<CSSStyleDeclaration> | string; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K | `${K}.${string}` | `${K}#${string}`, props?: Props | Child, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name as K);
  for (const part of rest) {
    if (part.startsWith('.')) el.classList.add(part.slice(1));
    else if (part.startsWith('#')) el.id = part.slice(1);
  }
  let kids = children;
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    kids = [props as Child, ...children];
  } else if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'style') {
        if (typeof value === 'string') el.setAttribute('style', value);
        else Object.assign(el.style, value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value as Record<string, string>);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'class' || key === 'className') {
        el.className = `${el.className} ${String(value)}`.trim();
      } else if (key in el && typeof value !== 'string') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, kids);
  return el;
}

function append(el: Node, kids: Child[]) {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    if (Array.isArray(kid)) append(el, kid);
    else el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmtUsd(v: number) {
  return v < 0.01 && v > 0 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function toast(message: string, kind: 'info' | 'error' = 'info') {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  const t = h('div.toast', { class: kind }, message);
  host.appendChild(t);
  setTimeout(() => t.classList.add('out'), 4200);
  setTimeout(() => t.remove(), 4800);
}
