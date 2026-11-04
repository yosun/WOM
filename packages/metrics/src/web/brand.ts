// The name on the metrics pages. In the app, WOM is World of a Memory: one photo rebuilt as a world you walk
// through. On the benchmark and observations pages it is also World Observation Metrics, the measurements of how
// faithfully a rebuilt world matches the photo it came from, taken from the photo's camera and from inside.
import { h, type Child } from './dom.ts';

export const WOM_NAME = 'World Observation Metrics';
export const WOM_TITLE = `WOM · ${WOM_NAME}`;

const word = (w: string) => [h('b', w[0]), w.slice(1)];

/** The mark, and the name with the three letters that spell it picked out. */
export function womTitle(): HTMLElement {
  return h('div.wom-title',
    h('abbr.wom-mark', { title: `WOM: ${WOM_NAME}` }, 'WOM'),
    h('h1.wom-name', word('World'), ' ', word('Observation'), ' ', word('Metrics')),
  );
}

/** The header of a metrics page: back link, the name, a line saying what the page is, and optional controls. */
export function womHeader(o: { lede: Child; back?: { href: string; label: string }; controls?: Child }): HTMLElement {
  return h('header.wom-head',
    h('a.back', { href: o.back?.href ?? '#/' }, o.back?.label ?? '← All memories'),
    womTitle(),
    h('p.wom-lede', o.lede),
    o.controls ? h('div.wom-controls', o.controls) : null,
  );
}
