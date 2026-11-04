// Browser addresses. Public worlds use path URLs so a copied link works without WOM's old hash router:
//   /u/<handle>/<world>
//   /u/<handle>/<world>/build
// The rest of the app keeps its hash routes for spaces, observations and benchmarks.

export interface WorldHrefOptions {
  handle?: string | null;
  build?: boolean;
  query?: URLSearchParams | string;
}

export interface WorldPath {
  handle: string;
  id: string;
  build: boolean;
}

const WORLD_ID = '[a-z0-9]{6,32}';

export function worldHref(id: string, options: WorldHrefOptions = {}): string {
  const handle = options.handle && /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(options.handle) ? options.handle : '-';
  const path = `/u/${handle}/${id}${options.build ? '/build' : ''}`;
  const query = options.query instanceof URLSearchParams ? options.query.toString() : (options.query ?? '').replace(/^\?/, '');
  return query ? `${path}?${query}` : path;
}

export function parseWorldPath(pathname = location.pathname): WorldPath | null {
  const m = new RegExp(`^/u/([a-z0-9-]+|-)\/(${WORLD_ID})(\/build)?/?$`).exec(pathname);
  return m ? { handle: m[1], id: m[2], build: Boolean(m[3]) } : null;
}

/** Convert an old `#/world/<id>` address into the new path route. */
export function parseLegacyWorldHash(hash = location.hash): { id: string; build: boolean; query: string } | null {
  const m = new RegExp(`^#/world/(${WORLD_ID})(/build)?(?:\\?(.*))?$`).exec(hash);
  return m ? { id: m[1], build: Boolean(m[2]), query: m[3] ?? '' } : null;
}

export function sameOriginPath(href: string): URL | null {
  try {
    const url = new URL(href, location.href);
    return url.origin === location.origin ? url : null;
  } catch {
    return null;
  }
}
