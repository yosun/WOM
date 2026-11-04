// Sign-in with Clerk. The browser signs in through Clerk's SDK, which keeps a session cookie, and that cookie goes
// with every same-origin request (fetch, EventSource and <img> alike). The server only verifies the session. It never
// refuses a visitor for lacking one: access.ts decides what each route needs, and a shared world needs none. The
// publishable key (public by design) is served to the browser. The secret key stays on the server.
//
// Sign-in is in use when SIGN_IN_REQUIRED (config.ts) says so: on any server other machines can reach, unless
// WOM_AUTH=off, and always with WOM_AUTH=required. Localhost has it off. While it is in use, a server without both
// Clerk keys answers 503 to every request that needs a person.
import { createClerkClient } from '@clerk/backend';
import type { Context } from 'hono';
import { CLERK_AUTHORIZED_PARTIES, CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, SIGN_IN_REQUIRED } from './config.ts';

export const NOT_SET_UP = 'Sign-in is required on this server but not set up: add CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY.';

const clerk = CLERK_PUBLISHABLE_KEY && CLERK_SECRET_KEY
  ? createClerkClient({ publishableKey: CLERK_PUBLISHABLE_KEY, secretKey: CLERK_SECRET_KEY })
  : null;

/** Whether both Clerk keys are set. */
export function clerkConfigured(): boolean {
  return clerk !== null;
}

/** GET /api/auth/config: whether the browser can sign in and, if so, the publishable key it needs. Public. */
export function authConfig(c: Context) {
  if (!SIGN_IN_REQUIRED) return c.json({ required: false });
  if (!clerk) return c.json({ error: NOT_SET_UP }, 503);
  return c.json({ required: true, publishableKey: CLERK_PUBLISHABLE_KEY });
}

export interface Session {
  /** The Clerk user id, or null when the request carries no valid session. */
  userId: string | null;
  /** Cookies Clerk asks to set so the session can refresh. They go out with the response, whatever it is. */
  cookies: string[];
}

const NO_SESSION: Session = { userId: null, cookies: [] };

/** Who the request is from, if anyone. Never refuses: a visitor without a session is an ordinary visitor. */
export async function clerkSession(req: Request): Promise<Session> {
  if (!clerk) return NO_SESSION;
  // No token and no session cookie: there is nothing to ask Clerk about.
  if (!req.headers.get('authorization') && !/(?:^|;\s*)__(?:session|client_uat)/.test(req.headers.get('cookie') ?? '')) return NO_SESSION;
  const state = await clerk.authenticateRequest(req, { authorizedParties: CLERK_AUTHORIZED_PARTIES });
  const cookies = state.headers.getSetCookie();
  return state.isAuthenticated ? { userId: state.toAuth().userId, cookies } : { userId: null, cookies };
}

/** The username someone chose with Clerk, which becomes their first handle. Null when they have none. */
export async function clerkUsername(userId: string): Promise<string | null> {
  if (!clerk) return null;
  try {
    return (await clerk.users.getUser(userId)).username;
  } catch {
    return null;
  }
}
