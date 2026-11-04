// Slide spaces: which slides a stack shows. The whole collection is the space `all`; a sub space is any part
// of it with a parent to go back to. Each one is the same stack (space.ts) with fewer slides, so a new kind of
// sub space is one more entry in SPACES below, and `createSlideSpace` can also be handed any list directly.
//
// Addresses: #/space (all), #/space/world/<id> (one world's ways in), #/space/year/<yyyy>, each with
// ?slide=<world>.<slide> for the slide to start on.
import type { SlideDoc } from '../api.ts';

export interface SpaceDef {
  id: string;
  title: string;
  /** The space Esc and the back arrow go to. */
  parent?: string;
  includes: (s: SlideDoc) => boolean;
  /** Which date lays the slides out along the timeline: the memory's, or when each slide was made. */
  time: 'taken' | 'created';
}

const SPACES: { match: RegExp; make: (m: RegExpExecArray, all: SlideDoc[]) => SpaceDef | null }[] = [
  {
    match: /^all$/,
    make: () => ({ id: 'all', title: 'Memories', includes: () => true, time: 'taken' }),
  },
  {
    // Every way into one world: its photo and the views saved inside it.
    match: /^world\/([a-z0-9]+)$/,
    make: (m, all) => {
      const first = all.find((s) => s.world === m[1]);
      return first ? { id: m[0], title: first.worldTitle, parent: 'all', includes: (s) => s.world === m[1], time: 'created' } : null;
    },
  },
  {
    // The memories of one year (the timeline's labels open these).
    match: /^year\/(\d{4})$/,
    make: (m) => ({ id: m[0], title: m[1], parent: 'all', includes: (s) => new Date(s.takenAt).getFullYear() === Number(m[1]), time: 'taken' }),
  },
];

export function resolveSpace(id: string, all: SlideDoc[]): SpaceDef | null {
  for (const s of SPACES) {
    const m = s.match.exec(id);
    if (m) return s.make(m, all);
  }
  return null;
}

/** The spaces above `def`, outermost first. */
export function spaceTrail(def: SpaceDef, all: SlideDoc[]): SpaceDef[] {
  const out: SpaceDef[] = [];
  const seen = new Set([def.id]);
  for (let p = def.parent; p && !seen.has(p); ) {
    seen.add(p);
    const parent = resolveSpace(p, all);
    if (!parent) break;
    out.unshift(parent);
    p = parent.parent;
  }
  return out;
}

/** A slide's key in a space and in addresses: `<world>.<slide>`. */
export const slideKey = (world: string, slide: string) => `${world}.${slide}`;

export function spaceHref(space: string, slide?: string): string {
  return `#/space${space === 'all' ? '' : `/${space}`}${slide ? `?slide=${encodeURIComponent(slide)}` : ''}`;
}

/** A root-absolute URL for a hash space, so it also works from a path-based world URL (`/u/<handle>/<id>`). */
export function spaceUrl(space: string, slide?: string): string {
  return new URL(spaceHref(space, slide), location.origin).href;
}
