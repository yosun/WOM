// The slide space page (#/space, #/space/<sub space>): loads every slide, picks the space's part of them
// (spaces.ts) and shows them as a stack (space.ts). Playing a slide hands it to the viewer; coming back from
// the viewer flies it home.
import { api, type SlideDoc } from '../api.ts';
import { h, toast } from '../dom.ts';
import { dropHandoff, giveHandoff, removeCover, takeHandoff } from './handoff.ts';
import { createSlideSpace, type SlideSpace } from './space.ts';
import { worldHref } from '../routes.ts';
import { resolveSpace, slideKey, spaceHref, spaceTrail } from './spaces.ts';
import { createVideoStudio, type VideoStudio } from '../videos.ts';

/** `navigate` goes to another page of the app without a page load (main.ts). */
export function renderSpace(root: HTMLElement, spaceId: string, params: URLSearchParams, navigate: (href: string) => void): () => void {
  const host = h('main.space-page');
  root.append(host);
  let disposed = false;
  let space: SlideSpace | null = null;
  let all: SlideDoc[] = [];
  let studio: VideoStudio | null = null;
  let studioWorld = '';
  let animateRequest = 0;
  // Back from a world played from this space: its slide is still on screen, in the cover. A cover meant for
  // somewhere else goes.
  const back = takeHandoff((x) => x.direction === 'return' && x.from === spaceId);
  dropHandoff();

  function mount(selected: string | undefined) {
    const def = resolveSpace(spaceId, all);
    if (!def) {
      location.replace(spaceHref('all'));
      return null;
    }
    document.title = `${def.title} · WOM`;
    space?.dispose();
    space = createSlideSpace(host, {
      title: def.title,
      trail: spaceTrail(def, all).map((s) => ({ title: s.title, href: spaceHref(s.id) })),
      slides: all.filter(def.includes),
      time: def.time,
      selected,
      onPlay: (s, cover) => {
        giveHandoff({ direction: 'enter', world: s.world, slide: s.id, doc: s, from: spaceId, cover });
        // The page stays, so the cover with the slide is still on it when the viewer mounts and takes it over.
        navigate(worldHref(s.world, { query: new URLSearchParams({ slide: s.id, from: spaceId }) }));
      },
      // Keep the address on the slide in front, so reloading or coming back lands on it.
      onSelect: (s) => history.replaceState(history.state, '', spaceHref(spaceId, slideKey(s.world, s.id))),
      onAnimate: (s) => {
        const request = ++animateRequest;
        if (studioWorld !== s.world) {
          studio?.dispose();
          studioWorld = s.world;
          // Access is resolved before opening; another person's shared image can still play completed videos.
          studio = createVideoStudio(host, s.world, { editable: false });
        }
        const active = studio;
        void api.get(s.world).then((world) => {
          if (!disposed && request === animateRequest && studio === active && active) {
            active.setEditable(world.access.canEdit);
            active.open(s);
          }
        }).catch((err) => { if (!disposed && request === animateRequest) toast((err as Error).message, 'error'); });
      },
      subspaceHref: (kind, value) => {
        const id = `${kind}/${value}`;
        return id === spaceId ? null : spaceHref(id);
      },
      onDelete: async (s) => {
        if (!window.confirm(`Remove the slide "${s.title}" of ${s.worldTitle}? The world stays.`)) return false;
        try {
          await api.deleteSlide(s.world, s.id);
        } catch (err) {
          toast((err as Error).message, 'error');
          return false;
        }
        const i = all.indexOf(s);
        all = all.filter((x) => x !== s);
        const next = all[Math.min(i, all.length - 1)];
        toast('Slide removed.');
        mount(next ? slideKey(next.world, next.id) : undefined);
        return true;
      },
    });
    return space;
  }

  void api.slides().then((list) => {
    if (disposed) {
      if (back) removeCover(back.cover);
      return;
    }
    all = list;
    const key = back ? slideKey(back.world, back.slide) : params.get('slide') ?? undefined;
    const made = mount(key);
    if (back && !made?.returnFrom(key!, back.cover)) removeCover(back.cover);
  }).catch((err) => {
    if (back) removeCover(back.cover);
    host.append(h('div.space-empty', h('h2', 'The slides could not be loaded'), h('p', (err as Error).message), h('a.button', { href: '#/' }, 'Home')));
  });

  return () => {
    disposed = true;
    space?.dispose();
    studio?.dispose();
    host.remove();
  };
}
