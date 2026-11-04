// Who may do what. identify() works out who is asking. guard() holds every /api, /files and /bench-files route to the rule
// written for it in RULES, and a route with no rule is for administrators only. A world shared by link can be looked at
// by anyone, with no sign-in. Generation facts have a separate safe report; changes and detailed build records belong to the owner.
//
// The same rule is written again in the database as row-level security on worlds (db/migrations/001_init.sql):
// levelOf() mirrors worlds_read, so a bug here cannot show more than the database would.
import type { Context, MiddlewareHandler } from 'hono';
import { clerkConfigured, clerkSession, clerkUsername, NOT_SET_UP } from './auth.ts';
import { SIGN_IN_REQUIRED, STORE } from './config.ts';
import { worldAccess, type WorldAccess } from './store.ts';
import type { WorldManifest } from './types.ts';
import { ensureUser, LOCAL_USER, type Identity } from './users.ts';

export type AppEnv = { Variables: { user: Identity | null; access: WorldAccess | null; cookies: string[] } };

// ---------------------------------------------------------------- who is asking

interface Asker {
  user: Identity | null;
  /** Cookies Clerk wants set, which go out with the response. */
  cookies: string[];
}
export type Resolver = (req: Request) => Promise<Asker>;

const fromSession: Resolver = async (req) => {
  if (!SIGN_IN_REQUIRED) {
    // One person at this machine. With the database they still need a row, because worlds belong to a user.
    if (STORE !== 'postgres') return { user: LOCAL_USER, cookies: [] };
    return { user: { ...(await ensureUser(LOCAL_USER.id, async () => LOCAL_USER.handle)), role: 'admin' }, cookies: [] };
  }
  const session = await clerkSession(req);
  if (!session.userId) return { user: null, cookies: session.cookies };
  // Without the database nobody owns anything, so a signed-in person is trusted with all of it, as before sharing existed.
  if (STORE !== 'postgres') return { user: { id: session.userId, handle: null, role: 'admin' }, cookies: session.cookies };
  const userId = session.userId;
  return { user: await ensureUser(userId, () => clerkUsername(userId)), cookies: session.cookies };
};

let resolver: Resolver = fromSession;
/** For tests only: decide who is asking without Clerk. Nothing in the server calls this. */
export function setResolverForTests(next: Resolver | null) {
  resolver = next ?? fromSession;
}

/** Works out who is asking and keeps it on the request. Never refuses: that is guard()'s job. */
export const identify: MiddlewareHandler<AppEnv> = async (c, next) => {
  const asker = await resolver(c.req.raw);
  c.set('user', asker.user);
  c.set('access', null);
  c.set('cookies', asker.cookies);
  await next();
};

// ---------------------------------------------------------------- what a person may do with a world

export type Level = 'owner' | 'viewer' | 'none';

/** 'owner' (the owner, or an administrator) may change the world. 'viewer' may look. 'none' may not know it exists. */
export function levelOf(user: Identity | null, access: WorldAccess): Level {
  if (user && (user.role === 'admin' || user.id === access.ownerId)) return 'owner';
  return access.visibility === 'link' && !access.removed ? 'viewer' : 'none';
}

// Of a shared world's files, only the ones the viewer draws are public. The manifest, log, depth maps, masks, cutouts and
// the photo as it was uploaded stay with the owner. Keep this a path allow-list, not an extension allow-list: generated
// directories can contain vendor-named files, but only viewer artifacts may cross the public boundary.
const PUBLIC_FILES: RegExp[] = [
  /^(?:scene\.json|relief\.glb|source\.jpg|thumb\.jpg|clean\.jpg|reprojection\.jpg)$/,
  /^world\/[\w.-]+(?:\/[\w.-]+)?\.(?:spz|glb|png|webp|jpg)$/,
  // An object's models sit directly in its folder or one or two folders down (idol/, tripo-p1/, m2/idol/): only files named model* or preview*.
  /^objects\/[\w-]+(?:\/[\w-]+){0,2}\/(?:model[^/]*|preview[^/]*)\.(?:ply|glb|spz|png|jpg|webp)$/,
  /^objects\/[\w-]+\/cutout\.png$/,
  /^slides\/s[a-z0-9]{6,24}(?:-thumb)?\.jpg$/,
  /^videos\/v[a-z0-9]{12,40}(?:\.(?:mp4|webm|mov)|-(?:thumb|source)\.jpg)$/,
];

export function isPublicFile(rel: string): boolean {
  if (rel.includes('\\') || rel.split('/').some((part) => !part || part === '.' || part === '..')) return false;
  return PUBLIC_FILES.some((re) => re.test(rel));
}

const GONE = new Set(['job', 'jobId', 'publicUrl', 'error']);
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !GONE.has(k)).map(([k, v]) => [k, strip(v)]));
  }
  return value;
}

/**
 * What someone who does not own a world sees of its manifest: what the viewer needs. Not what it cost, which vendor jobs
 * made it, what failed along the way, or the name of the file that was uploaded.
 */
export function publicManifest(m: WorldManifest): WorldManifest {
  const copy = strip(m) as WorldManifest;
  const safe = copy as Omit<WorldManifest, 'depth'> & { depth?: unknown; depthAssets?: unknown; worldAssets?: unknown };
  copy.costs = [];
  // The viewer gets the scene through /api/worlds/:id/scene. It does not need upload frames, mattes, depth maps,
  // object masks, vendor job records, or the private file names that produced the scene.
  copy.image = { file: 'source.jpg', thumb: 'thumb.jpg', width: m.image.width, height: m.image.height };
  delete safe.depth;
  delete safe.depthAssets;
  delete safe.worldAssets;
  delete copy.image.original;
  delete copy.image.aux;
  delete copy.image.frames;
  copy.objects = copy.objects.map((o) => ({ id: o.id, name: o.name, status: o.status }));
  if (copy.cleanPlate) copy.cleanPlate = { file: 'clean.jpg' };
  if (copy.world) {
    copy.world = {
      splats: copy.world.splats,
      collider: copy.world.collider,
      pano: copy.world.pano,
      thumbnail: copy.world.thumbnail,
    } as WorldManifest['world'];
  }
  return copy;
}

// ---------------------------------------------------------------- the rules

/** Public: no one is asked. user: someone signed in. admin: an administrator. view: look at the world. file: view, and only public files unless owner. edit: change it. */
type Need = 'public' | 'user' | 'admin' | 'view' | 'file' | 'flag' | 'edit';
interface Rule {
  method: string;
  re: RegExp;
  need: Need;
  /** The world is named in ?world=, not in the path. Without it, the route is for administrators. */
  worldInQuery?: boolean;
}

// First match wins. Group 1 of a world rule is the world id.
const RULES: Rule[] = [
  { method: 'GET', re: /^\/api\/auth\/config$/, need: 'public' },
  { method: 'GET', re: /^\/api\/health$/, need: 'public' },
  { method: 'GET', re: /^\/api\/wometrics\/setup-schema$/, need: 'public' },
  { method: 'GET', re: /^\/api\/me$/, need: 'public' },
  { method: 'PUT', re: /^\/api\/me\/handle$/, need: 'user' },
  { method: 'GET', re: /^\/api\/credits$/, need: 'user' },
  { method: 'POST', re: /^\/api\/credits\/redeem$/, need: 'user' },
  // Stripe calls this, signed; stripe.ts checks the signature. It has no cookie or token to check here.
  { method: 'POST', re: /^\/api\/stripe\/webhook$/, need: 'public' },

  // making worlds, and the lists of your own
  { method: 'GET', re: /^\/api\/worlds$/, need: 'user' },
  { method: 'POST', re: /^\/api\/(?:inspect|worlds)$/, need: 'user' },
  { method: 'GET', re: /^\/api\/slides$/, need: 'user' },

  // looking at a world that is shared
  { method: 'GET', re: /^\/api\/worlds\/([a-z0-9]+)$/, need: 'view' },
  { method: 'GET', re: /^\/api\/worlds\/([a-z0-9]+)\/scene$/, need: 'view' },
  { method: 'GET', re: /^\/api\/worlds\/([a-z0-9]+)\/metrics$/, need: 'view' },
  { method: 'GET', re: /^\/api\/worlds\/([a-z0-9]+)\/slides$/, need: 'view' },
  { method: 'GET', re: /^\/api\/worlds\/([a-z0-9]+)\/videos$/, need: 'view' },
  { method: 'GET', re: /^\/files\/([a-z0-9]+)\/.+$/, need: 'file' },

  // A signed-in visitor may flag a shared world. Reading and changing the observation ledger remains owner/admin-only.
  { method: 'POST', re: /^\/api\/worlds\/([a-z0-9]+)\/observations$/, need: 'flag' },
  { method: 'GET', re: /^\/api\/(?:observations|issues)$/, need: 'edit', worldInQuery: true },
  { method: 'GET', re: /^\/bench-files\/observations\/([a-z0-9]+)\/.+$/, need: 'edit' },

  // Tools that spend our model budget and are not yet priced in credits: administrators only. (Building a world and
  // retrying its failed parts are the owner's; they are what credits pay for.)
  { method: 'POST', re: /^\/api\/worlds\/[a-z0-9]+\/(?:assets|assets\/check|agents)$/, need: 'admin' },
  { method: 'POST', re: /^\/api\/worlds\/[a-z0-9]+\/objects\/[^/]+\/mask(?:\/preview|\/restore)?$/, need: 'admin' },
  { method: 'POST', re: /^\/api\/worlds\/[a-z0-9]+\/observations\/[^/]+\/fix$/, need: 'admin' },

  // everything else about one world is its owner's
  { method: '*', re: /^\/api\/worlds\/([a-z0-9]+)(?:\/.*)?$/, need: 'edit' },
];

const GUARDED = /^\/(?:api|files|bench-files)\//;

function refuse(c: Context<AppEnv>, status: 401 | 403 | 404, message?: string) {
  for (const cookie of c.get('cookies')) c.header('Set-Cookie', cookie, { append: true });
  if (status === 404) return c.json({ error: 'not found' }, 404);
  if (status === 401) {
    if (SIGN_IN_REQUIRED && !clerkConfigured()) return c.json({ error: NOT_SET_UP }, 503);
    return c.json({ error: 'Sign in to continue.', signIn: true }, 401);
  }
  return c.json({ error: message ?? 'Only the owner of this world can do that.' }, 403);
}

/** Holds each route to its rule. Answers 404 for a world the person may not know exists, 401 when signing in would help, 403 when it would not. */
export const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;
  if (!GUARDED.test(path)) return next();
  const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
  const rule = RULES.find((r) => (r.method === '*' || r.method === method) && r.re.test(path));
  let need: Need = rule?.need ?? 'admin';
  if (need === 'public') return next();

  const user = c.get('user');
  // Without the database, sign-in is all or nothing, as it was before worlds could be shared.
  if (!user && STORE !== 'postgres' && SIGN_IN_REQUIRED) return refuse(c, 401);

  let worldId: string | undefined = rule ? path.match(rule.re)?.[1] : undefined;
  if (rule?.worldInQuery) {
    worldId = c.req.query('world') || undefined;
    if (!worldId) need = 'admin';
  }

  if (need === 'user') return user ? next() : refuse(c, 401);
  if (need === 'admin') {
    if (!user) return refuse(c, 401);
    return user.role === 'admin' ? next() : refuse(c, 403, 'Only an administrator can do that.');
  }

  const access = worldId ? await worldAccess(worldId) : null;
  const level = access ? levelOf(user, access) : 'none';
  if (!access || level === 'none') return refuse(c, 404);
  c.set('access', access);
  if (need === 'view') return next();
  if (need === 'file') {
    if (level === 'owner') return next();
    let rel: string;
    try {
      rel = decodeURIComponent(path.slice(`/files/${worldId}/`.length));
    } catch {
      return refuse(c, 404);
    }
    return isPublicFile(rel) ? next() : refuse(c, 404);
  }
  if (need === 'flag') {
    if (!user) return refuse(c, 401);
    return level === 'owner' || level === 'viewer' ? next() : refuse(c, 404);
  }
  return level === 'owner' ? next() : refuse(c, user ? 403 : 401);
};
