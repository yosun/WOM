// Authentication is deliberately non-blocking. A visitor can open a shared world without Clerk; Clerk is loaded only
// when a signed-in session exists or when the visitor clicks Sign in. The server still verifies every protected request.
import type { Clerk } from '@clerk/clerk-js';
import { clear, h, toast } from './dom.ts';

export interface AuthUser {
  id: string;
  handle: string | null;
  role: 'user' | 'admin';
}

type Settings = { required: false; publishableKey?: undefined } | { required: true; publishableKey: string | null };
type MeResponse = { user: AuthUser | null; signInRequired: boolean; shares: boolean };

let clerk: Clerk | null = null;
let settings: Settings = { required: false };
let state: MeResponse = { user: null, signInRequired: false, shares: false };
let clerkListener: (() => void) | null = null;
let clerkWasSignedIn = false;
const menus = new Set<HTMLDivElement>();

/** The sign-in form in the WOM palette. */
const APPEARANCE = {
  variables: {
    colorPrimary: '#e8b26a',
    colorTextOnPrimaryBackground: '#161311',
    colorBackground: '#1b1815',
    colorText: '#f3ebe0',
    colorTextSecondary: '#b3a796',
    colorInputBackground: '#12100e',
    colorInputText: '#f3ebe0',
    borderRadius: '10px',
  },
};

/** Load the anonymous session state, but never replace the app with a sign-in page. */
export async function initializeAuth(root: HTMLElement): Promise<boolean> {
  clear(root);
  root.append(h('main.auth-gate', h('p.muted', 'Loading…')));
  let me: MeResponse;
  try {
    me = await loadMe();
  } catch (err) {
    showUnavailable(root, err);
    return false;
  }
  state = me;
  // A missing production Clerk key should not stop public links from working. It only disables the Sign in button.
  try {
    settings = await loadSettings();
  } catch {
    settings = me.signInRequired ? { required: true, publishableKey: null } : { required: false };
  }
  renderMenus();
  clear(root);
  // Clerk loads in the background, so a shared world opens without waiting for it. It finishes a sign-in that came back from
  // another site (GitHub), refreshes the session cookie the server reads, and draws the account button.
  if (settings.required && settings.publishableKey) void syncClerk(settings.publishableKey);
  return true;
}

/** Load Clerk and make the server and the browser agree about who is signed in. */
async function syncClerk(publishableKey: string) {
  try {
    const loaded = await loadClerk(publishableKey);
    if (loaded.isSignedIn && !state.user) {
      // Clerk knows the person but the server has not seen the session: a first visit after signing in, for instance back from GitHub.
      // Asking for a token writes the session cookie the server reads. Reload once so the page starts signed in.
      await loaded.session?.getToken();
      const me = await loadMe().catch(() => null);
      const last = Number(sessionStorage.getItem('wom:synced') ?? 0);
      if (me?.user && Date.now() - last > 30_000) {
        sessionStorage.setItem('wom:synced', String(Date.now()));
        location.reload();
        return;
      }
    }
    renderMenus();
  } catch {
    // The Sign in button says so when it is pressed.
  }
}

/** The current server-verified WOM user, or null for an anonymous visitor. */
export function currentUser(): AuthUser | null {
  return state.user;
}

/** Whether an operation should be offered to this visitor. Local development has a local admin user. */
export function signedIn(): boolean {
  return state.user !== null;
}

/** Ask Clerk to sign in. The modal leaves the current path and query untouched after it succeeds. */
export async function promptSignIn(): Promise<void> {
  if (state.user) return;
  if (!settings.required || !settings.publishableKey) {
    toast('Sign-in is not available on this server.', 'error');
    return;
  }
  try {
    const loaded = await loadClerk(settings.publishableKey);
    if (!loaded.isSignedIn) loaded.openSignIn({});
  } catch (err) {
    toast(messageOf(err), 'error');
  }
}

/** Gate a create, flag or other owner action. A click opens Clerk and the caller stops until the page reloads. */
export async function requireSignIn(): Promise<boolean> {
  if (state.user) return true;
  await promptSignIn();
  return false;
}

/** A small account control for public pages: Clerk's user button when signed in, Sign in otherwise. */
export function userMenu(): HTMLDivElement {
  const slot = h('div.auth-user');
  menus.add(slot);
  renderMenu(slot);
  return slot;
}

async function loadMe(): Promise<MeResponse> {
  let res: Response;
  try {
    res = await fetch('/api/me');
  } catch {
    throw new Error('The WOM server is not reachable. Start it with npm run dev, then reload.');
  }
  const body = (await res.json().catch(() => null)) as Partial<MeResponse> & { error?: unknown } | null;
  if (!res.ok || !body || typeof body.signInRequired !== 'boolean' || typeof body.shares !== 'boolean') {
    throw new Error(typeof body?.error === 'string' ? body.error : `The WOM server answered ${res.status}.`);
  }
  return { user: body.user ?? null, signInRequired: body.signInRequired, shares: body.shares };
}

async function loadSettings(): Promise<Settings> {
  const res = await fetch('/api/auth/config');
  const body = (await res.json().catch(() => null)) as { required?: unknown; publishableKey?: unknown; error?: unknown } | null;
  if (res.status === 503) return { required: true, publishableKey: null };
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `The WOM server answered ${res.status}.`);
  if (!body || typeof body.required !== 'boolean') throw new Error('The WOM server sent an invalid auth configuration.');
  if (!body.required) return { required: false };
  return { required: true, publishableKey: typeof body.publishableKey === 'string' && body.publishableKey ? body.publishableKey : null };
}

async function loadClerk(publishableKey: string): Promise<Clerk> {
  if (clerk) return clerk;
  const [{ Clerk: ClerkSDK }, { ClerkUI }] = await Promise.all([import('@clerk/clerk-js'), import('@clerk/ui/entry')]);
  const instance = new ClerkSDK(publishableKey);
  clerk = instance;
  await instance.load({ ui: { ClerkUI }, appearance: APPEARANCE });
  clerkWasSignedIn = instance.isSignedIn;
  clerkListener = instance.addListener(({ user }) => {
    const nowSignedIn = Boolean(user);
    // Signing in or out here changes what the server must show, so the page starts again with the new session.
    if (nowSignedIn !== clerkWasSignedIn && (nowSignedIn || state.user)) {
      clerkWasSignedIn = nowSignedIn;
      location.reload();
      return;
    }
    clerkWasSignedIn = nowSignedIn;
  });
  return instance;
}

function renderMenus() {
  for (const menu of menus) {
    if (menu.isConnected) renderMenu(menu);
    else menus.delete(menu);
  }
}

function renderMenu(slot: HTMLDivElement) {
  if (clerk && slot.childNodes.length) {
    try { clerk.unmountUserButton(slot); } catch { /* it was not mounted */ }
  }
  clear(slot);
  if (state.user && clerk?.isSignedIn) {
    queueMicrotask(() => { if (clerk?.isSignedIn && slot.isConnected) clerk.mountUserButton(slot); });
  } else if (state.user) {
    slot.append(h('span.auth-local', state.user.handle ? `@${state.user.handle}` : 'Signed in'));
  } else if (state.signInRequired) {
    slot.append(h('button.button.sign-in', { type: 'button', onclick: () => void promptSignIn() }, 'Sign in'));
  }
}

function showUnavailable(root: HTMLElement, err: unknown) {
  clear(root);
  root.append(h('main.auth-gate', h('div.auth-card', h('h1', 'WOM cannot start'), h('p.muted', messageOf(err)))));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
