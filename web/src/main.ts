import './styles.css';
import '@wom/metrics/web/styles.css';
import { matchMetricsRoute, mountMetrics, WOM_TITLE } from '@wom/metrics/web';
import { api } from './api.ts';
import { initializeAuth } from './auth.ts';
import { renderBuild } from './build.ts';
import { clear } from './dom.ts';
import { renderHome } from './home.ts';
import { renderObservations } from './observations.ts';
import { dropHandoff } from './slides/handoff.ts';
import { renderSpace } from './slides/page.ts';
import { renderViewer } from './viewer.ts';
import { sameOriginPath, parseLegacyWorldHash, parseWorldPath, worldHref } from './routes.ts';
import { wom } from './wom.ts';

const root = document.getElementById('app')!;
/** The home page's title. web/index.html has the same text, which is what crawlers that do not run this script read. */
const HOME_TITLE = 'World of a Memory: Step Inside a Photo';
let teardown: (() => void) | null = null;

/** ?debug (the switch for scripts and agents) stays on as the page changes, as it did while only the hash changed. */
function keepDebug(href: string): string {
  if (!new URLSearchParams(location.search).has('debug')) return href;
  const url = new URL(href, location.origin);
  if (url.searchParams.has('debug')) return href;
  return `${url.pathname}${url.search ? `${url.search}&debug` : '?debug'}${url.hash}`;
}

function navigate(href: string, replace = false) {
  const to = keepDebug(href);
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  void route();
}

async function route() {
  // Old bookmarks are still useful. Convert them once, before any page is mounted, so reloads become real paths.
  const legacy = parseLegacyWorldHash();
  if (legacy) {
    navigate(worldHref(legacy.id, { build: legacy.build, query: legacy.query }), true);
    return;
  }

  teardown?.();
  teardown = null;
  clear(root);
  document.title = 'World of a Memory';
  const hash = location.hash || '#/';
  const pathWorld = parseWorldPath();

  // #/space, #/space/<sub space> (world/<id>, year/<yyyy>), each with ?slide=<world>.<slide>: the slides.
  const space = /^#\/space(?:\/([a-z0-9]+(?:\/[a-z0-9]+)*))?\/?(?:\?(.*))?$/.exec(hash);
  if (!pathWorld && space) {
    document.body.className = 'page-space';
    teardown = renderSpace(root, space[1] ?? 'all', new URLSearchParams(space[2] ?? ''), navigate);
    return;
  }

  // A path world carries its query in location.search. The hash form remains supported only long enough to be converted above.
  const oldWorld = !pathWorld ? /^#\/world\/([a-z0-9]+)(\/build)?(?:\?(.*))?$/.exec(hash) : null;
  const world = pathWorld ?? (oldWorld ? { id: oldWorld[1], handle: '-', build: Boolean(oldWorld[2]) } : null);
  if (!world) dropHandoff();

  // #/bench, #/bench/<run>, #/bench/<tab> or #/bench/<run>/<tab>: WOM, World Observation Metrics (@wom/metrics).
  const bench = !pathWorld ? matchMetricsRoute(hash) : null;
  if (bench) {
    document.title = WOM_TITLE;
    document.body.className = 'page-build';
    teardown = mountMetrics(root, bench, wom);
    return;
  }
  const obs = !pathWorld ? /^#\/observations(?:\/([a-z0-9]+))?$/.exec(hash) : null;
  if (obs) {
    document.title = `Observations · ${WOM_TITLE}`;
    document.body.className = 'page-build';
    teardown = renderObservations(root, obs[1]);
    return;
  }
  if (!world) {
    document.title = HOME_TITLE;
    document.body.className = 'page-home';
    renderHome(root);
    return;
  }

  const id = world.id;
  const forceBuild = world.build;
  const query = pathWorld ? new URLSearchParams(location.search) : new URLSearchParams(oldWorld?.[3] ?? '');
  let ready = false;
  let info: Awaited<ReturnType<typeof api.get>> | null = null;
  try {
    info = await api.get(id);
    ready = Boolean(info.manifest.scene) && !info.running;
    // A link copied as /u/-/<id> settles on the owner's current handle. The server does this on a full request; this
    // also keeps a single-page navigation canonical without a round trip through the HTML route.
    if (info.access?.handle && world.handle !== info.access.handle) {
      history.replaceState(null, '', worldHref(id, { handle: info.access.handle, build: forceBuild, query }));
    }
  } catch {
    dropHandoff();
    if (pathWorld) navigate('/', true);
    else location.hash = '#/';
    return;
  }
  if (ready && !forceBuild) {
    const from = query.get('from');
    document.body.className = 'page-viewer';
    teardown = renderViewer(root, id, {
      view: query.get('view') ?? undefined,
      compare: query.get('compare') ?? undefined,
      slide: query.get('slide') ?? undefined,
      from: from && /^[a-z0-9]+(?:\/[a-z0-9]+)*$/.test(from) ? from : undefined,
      canEdit: info!.access.canEdit,
      handle: info!.access.handle,
      visibility: info!.access.visibility,
    });
  } else {
    dropHandoff();
    document.body.className = 'page-build';
    teardown = renderBuild(root, id, () => navigate(worldHref(id, { handle: world.handle, query })));
  }
}

function onDocumentClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target.closest('a') : null;
  if (!target || target.target === '_blank' || target.hasAttribute('download')) return;
  // A bare #/… link is a hash route of the app's own page, "/", also when it is clicked on a world's page.
  const raw = target.getAttribute('href') ?? '';
  const url = sameOriginPath(raw.startsWith('#/') ? `/${raw}` : (target as HTMLAnchorElement).href);
  // Between the app's own pages (a world's path, the hash routes at "/") the page stays. A page load would drop
  // what is in memory, such as the cover that carries a slide between the space and the viewer.
  if (!url || !(url.pathname.startsWith('/u/') || (url.pathname === '/' && url.hash.startsWith('#/')))) return;
  event.preventDefault();
  navigate(`${url.pathname}${url.search}${url.hash}`);
}

// Hash routes are still used for spaces, observations and benchmarks. Public worlds use pushState paths.
// A hash navigation fires popstate and then hashchange: route it once. A second pass would take down what the first
// one set up, such as the slide cover handed over to the page it mounts.
let poppedTo = '';
window.addEventListener('popstate', () => {
  poppedTo = location.href;
  void route();
});
window.addEventListener('hashchange', (event) => {
  if (event.newURL === poppedTo) {
    poppedTo = '';
    return;
  }
  void route();
});
document.addEventListener('click', onDocumentClick);

void initializeAuth(root).then((ready) => {
  if (ready) void route();
});
