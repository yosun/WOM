// Building blocks shared by the dashboard's tabs: cards, panels, a segmented control, and loading states.
// An application that adds a tab of its own builds it from these, so it looks like the rest.
import { clear, h, type Child } from './dom.ts';
import { TONE_COLOR, type Tone } from './charts.ts';

export interface KpiOptions {
  label: string;
  /** Keep the label's capitals, for names such as MoGe-3. */
  asIs?: boolean;
  value: string;
  sub?: Child;
  tone?: Tone;
  /** Longer explanation shown on hover. */
  hint?: string;
  /** Makes the card a link that jumps to another tab. */
  link?: { href: string; onClick: () => void };
}

/** A headline number with a label and one line of context. */
export function kpi(o: KpiOptions): HTMLElement {
  const body: Child[] = [h('span.kpi-label', { class: o.asIs ? 'as-is' : '' }, o.label), h('strong.kpi-value', o.value), o.sub ? h('span.kpi-sub', o.sub) : null];
  const cls = o.tone ? `tone-${o.tone}` : '';
  if (!o.link) return h('div.kpi', { class: cls, title: o.hint }, body);
  const link = o.link;
  return h('a.kpi.link', { href: link.href, class: cls, title: o.hint, onclick: (e: Event) => { e.preventDefault(); link.onClick(); } }, body);
}

export function panel(o: { title: string; lede?: Child; actions?: Child; id?: string; className?: string }, ...kids: Child[]): HTMLElement {
  return h('section.panel.mpanel', { id: o.id, class: o.className },
    h('header.panel-head',
      h('div.panel-title', h('h2', o.title), o.lede ? h('p.panel-lede', o.lede) : null),
      o.actions ? h('div.panel-actions', o.actions) : null,
    ),
    ...kids,
  );
}

export function chip(text: string, tone?: Tone | string, title?: string) {
  return h('span.chip', { class: tone ?? '', title }, text);
}

export function dot(color: string) {
  return h('i.dot', { style: `background:${color}` });
}

export function toneDot(tone: Tone) {
  return dot(TONE_COLOR[tone]);
}

/** A row of buttons of which exactly one is on. */
export function segmented<T extends string>(items: { id: T; label: string; title?: string }[], initial: T, onChange: (id: T) => void, label: string): HTMLElement {
  let current = initial;
  const el = h('div.seg', { role: 'group', 'aria-label': label });
  const draw = () => {
    clear(el);
    for (const it of items) {
      el.append(h('button', {
        type: 'button',
        title: it.title,
        'aria-pressed': String(it.id === current),
        class: it.id === current ? 'on' : '',
        onclick: () => { if (current === it.id) return; current = it.id; draw(); onChange(it.id); },
      }, it.label));
    }
  };
  draw();
  return el;
}

export function notice(text: Child, tone: 'info' | 'warn' | 'good' = 'info') {
  return h('p.notice', { class: tone }, text);
}

/** The server answered, but with something this page cannot use: usually a server started before this version. */
export class StaleServerError extends Error {}

export function errorNote(err: unknown, what: string) {
  const message = err instanceof StaleServerError ? err.message : `${what}: ${(err as Error).message}`;
  return notice(message, 'warn');
}

function nodes(child: Child, out: Node[] = []): Node[] {
  if (child === null || child === undefined || child === false) return out;
  if (Array.isArray(child)) for (const c of child) nodes(c, out);
  else out.push(child instanceof Node ? child : document.createTextNode(String(child)));
  return out;
}

/** Show "Loading…", then what `render` makes of the result, or the error. */
export function loadInto<T>(host: HTMLElement, load: Promise<T>, render: (value: T) => Child, what: string, isDisposed: () => boolean = () => false) {
  clear(host);
  host.append(h('p.muted.loading', `Loading ${what}…`));
  load.then(
    (value) => {
      if (isDisposed()) return;
      clear(host);
      host.append(...nodes(render(value)));
    },
    (err) => {
      if (isDisposed()) return;
      clear(host);
      host.append(errorNote(err, what));
    },
  );
}
