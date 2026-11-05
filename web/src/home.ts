import { api, type WorldOptions, type WorldSummary } from './api.ts';
import { currentUser, userMenu, requireSignIn, signedIn } from './auth.ts';
import { worldHref } from './routes.ts';
import { clear, fmtUsd, h, toast } from './dom.ts';
import { MODEL_LABELS, PLANNER_MODELS } from '../../server/src/types.ts';
import { createMemoryPreview, memoryMark } from './home-memory.ts';
import { createHomeAccount } from './home-account.ts';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif,.heic,.heif,.avif,video/quicktime,video/mp4,.mov,.mp4';

const STATUS_LABEL: Record<WorldSummary['status'], string> = {
  queued: 'Queued',
  running: 'Building',
  done: 'Ready',
  partial: 'Ready (partial)',
  failed: 'Failed',
};

export function renderHome(root: HTMLElement, navigate: (href: string) => void) {
  clear(root);
  const memory = createMemoryPreview(navigate);
  let disposed = false;
  let previewUrl: string | undefined;
  let file: File | null = null;
  let options: WorldOptions = { maxObjects: 5, plannerModel: 'muse-spark-1.3', meshModel: 'idol', worldModel: 'worldlabs', depthModel: 'moge3', completeOccluded: true, splitPeople: true, placementAgents: ['muse-spark-1.3', 'muse-wonder-1.0'] };

  const preview = h('img.drop-preview', { alt: '' });
  const dropHint = h('div.drop-hint', h('span', 'or drop a moment here'));
  const input = h('input', { type: 'file', accept: ACCEPT, hidden: true }) as HTMLInputElement;
  const choose = h('button.primary.choose-photo', { type: 'button', onclick: () => input.click() }, 'Choose a photo', h('span', { 'aria-hidden': 'true' }, '↑'));
  const drop = h('div.drop', { role: 'group', 'aria-label': 'Upload a photograph' }, input, preview, choose, dropHint);
  const selectedFile = h('p.upload-filename', { hidden: true });
  const startBtn = h('button.primary', { type: 'button', disabled: true }, 'Create this memory');
  const keysNote = h('p.note');
  const balance = h('span.balance');
  const actions = h('div.actions', { hidden: true }, startBtn);
  // What the file holds: the lens, and a frame picker when there is more than one frame.
  const uploadInfo = h('div.upload-info');
  let frame: number | undefined;
  let inspectSeq = 0;

  const setFile = (f: File | null) => {
    const seq = ++inspectSeq;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
    file = f;
    frame = undefined;
    startBtn.disabled = true;
    actions.hidden = !f;
    selectedFile.hidden = !f;
    selectedFile.textContent = f?.name ?? '';
    choose.firstChild!.textContent = f ? 'Change photo' : 'Choose a photo';
    clear(uploadInfo);
    if (!f) {
      preview.removeAttribute('src');
      drop.classList.remove('has-file');
      return;
    }
    // Browsers other than Safari cannot show HEIC, and videos need a frame: use the server's thumbnail then.
    if (/^image\/(jpeg|png|webp|avif)$/.test(f.type)) preview.src = previewUrl = URL.createObjectURL(f);
    else preview.removeAttribute('src');
    drop.classList.add('has-file');
    if (!signedIn()) {
      clear(uploadInfo);
      uploadInfo.append(h('p.note', 'Sign in to inspect and build a memory.'));
      startBtn.disabled = false;
      return;
    }
    uploadInfo.append(h('p.note', 'Reading the file…'));
    void api.inspect(f).then((info) => {
      if (disposed || seq !== inspectSeq) return;
      clear(uploadInfo);
      startBtn.disabled = false;
      frame = info.primary;
      if (!preview.getAttribute('src')) preview.src = info.frames[info.primary]?.thumb ?? '';
      const extras = info.aux.filter((a) => a.type !== 'hdr-gain-map').map((a) => a.type === 'disparity' || a.type === 'depth' ? `${a.type} map (${a.accuracy ?? 'relative'})` : a.type.replace('-', ' '));
      uploadInfo.append(h('p.note', `Lens: ${info.cameraLine}.${extras.length ? ` The camera also stored: ${extras.join(', ')}.` : ''}`));
      if (info.frames.length > 1) {
        const strip = h('div.frame-strip');
        const pick = (i: number) => {
          frame = info.frames[i].index;
          preview.src = info.frames[i].thumb;
          strip.querySelectorAll('button').forEach((b, j) => b.classList.toggle('selected', j === i));
        };
        info.frames.forEach((fr, i) => {
          strip.append(h('button.frame', {
            type: 'button',
            class: fr.index === info.primary ? 'selected' : '',
            title: fr.timeS !== undefined ? `${fr.timeS.toFixed(2)} s` : `Frame ${i + 1}${fr.index === info.primary ? ' (the photo)' : ''}`,
            onclick: () => pick(i),
          }, h('img', { src: fr.thumb, alt: `Frame ${i + 1}` })));
        });
        uploadInfo.append(h('p.note', `${info.frames.length} frames in this file. Pick the one to build from; all of them are kept with the world.`), strip);
      }
    }).catch((err) => {
      if (disposed || seq !== inspectSeq) return;
      clear(uploadInfo);
      uploadInfo.append(h('p.note.warn', (err as Error).message));
      file = null;
      startBtn.disabled = true;
    });
  };
  input.addEventListener('change', () => setFile(input.files?.[0] ?? null));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    // HEIC often arrives without a MIME type, so also go by the file name.
    if (f && (/^(image|video)\//.test(f.type) || /\.(heic|heif|avif|mov|mp4)$/i.test(f.name))) setFile(f);
    else toast('That is not a photo or video file.', 'error');
  });

  const select = <K extends keyof WorldOptions>(key: K, label: string, choices: [WorldOptions[K], string][], hint: string) => {
    const el = h('select', {
      onchange: (e: Event) => {
        const raw = (e.target as HTMLSelectElement).value;
        const match = choices.find(([v]) => String(v) === raw);
        if (match) options = { ...options, [key]: match[0] };
      },
    }, choices.map(([v, text]) => h('option', { value: String(v), selected: v === options[key] }, text)));
    return h('label.field', h('span', label), el, h('small', hint));
  };

  const completeBox = h('input', { type: 'checkbox', checked: options.completeOccluded, onchange: (e: Event) => { options = { ...options, completeOccluded: (e.target as HTMLInputElement).checked }; } });

  const splitBox = h('input', { type: 'checkbox', checked: options.splitPeople, onchange: (e: Event) => { options = { ...options, splitPeople: (e.target as HTMLInputElement).checked }; } });

  const settings = h('details.settings',
    h('summary', 'Advanced settings'),
    h('div.fields',
      select('maxObjects', 'Objects to sculpt', [[0, 'None (world only)'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6'], [8, '8']], 'The scene director picks the most important ones'),
      select('plannerModel', 'Scene director', PLANNER_MODELS.map((m) => [m, MODEL_LABELS[m]]), 'Reads the photo and plans the scene; Sol is experimental'),
      select('meshModel', 'Objects', [['idol', 'IDOL (Gaussian splats)'], ['triposplat', 'TripoSplat (Gaussian splats)'], ['tripo-v31', 'Tripo H3.1 mesh'], ['tripo-p1', 'Tripo P1 low-poly mesh']], 'IDOL $0.10, TripoSplat $0.05 per object; Tripo meshes $0.30–0.50'),
      select('worldModel', 'Surrounding world', [['worldlabs', 'Marble 1.1'], ['worldlabs-draft', 'Marble draft (cheaper)'], ['none', 'None (depth relief only)']], 'Grown from the photo with objects erased'),
      select('depthModel', 'Depth', [['moge3', 'MoGe-3'], ['moge2', 'MoGe-2']], '$0.10 per image (the photo and its clean plate)'),
      h('label.field.check', completeBox, h('span', 'Complete hidden parts of objects with Muse Image')),
      h('label.field.check', splitBox, h('span', 'Build a big face as its own head and body (Gaussian-splat objects only; about +$0.12 per person, a minute or two longer to compose)')),
      h('div.field.check', h('span', 'Placement agents'),
        ...PLANNER_MODELS.map((m) => h('label.field.check',
          h('input', {
            type: 'checkbox',
            checked: options.placementAgents.includes(m),
            onchange: (e: Event) => {
              const on = (e.target as HTMLInputElement).checked;
              options = { ...options, placementAgents: on ? [...new Set([...options.placementAgents, m])] : options.placementAgents.filter((x) => x !== m) };
            },
          }),
          h('span', `${MODEL_LABELS[m]} also places each object (${m === 'gpt-6.1-sol' ? 'experimental, usage-priced' : `about $${m === 'muse-spark-1.3' ? '0.07' : '0.10'} per object`}); pick the placement you like in the viewer`),
        )),
      ),
    ),
    keysNote,
  );

  startBtn.addEventListener('click', async () => {
    if (!file) return;
    if (!(await requireSignIn())) return;
    startBtn.disabled = true;
    startBtn.textContent = 'Uploading…';
    try {
      const m = await api.create(file, options, frame);
      location.href = worldHref(m.id);
    } catch (err) {
      toast((err as Error).message, 'error');
      startBtn.disabled = false;
      startBtn.textContent = 'Create this memory';
    }
  });

  const gallery = h('div.gallery');
  const galleryTitle = h('h2', { tabIndex: -1 }, 'Your worlds');
  const galleryNote = h('p.gallery-note', 'Loading your worlds…');
  const slidesLink = h('a.button.slides-link', { href: '#/space', hidden: true }, 'Browse as slides', h('span', { 'aria-hidden': 'true' }, '↗'));
  const galleryWrap = h('section.gallery-wrap', { id: 'your-worlds', hidden: !signedIn(), 'aria-label': 'Your worlds' },
    h('div.gallery-head', h('div', galleryTitle, galleryNote), slidesLink), gallery,
  );
  const account = createHomeAccount(balance);
  const showWorlds = () => {
    galleryWrap.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    galleryTitle.focus({ preventScroll: true });
  };

  root.append(
    h('main.home',
      h('header.home-nav',
        h('a.home-brand', { href: '/', 'aria-label': 'World of a Memory home' }, memoryMark('home-brand-keyhole'), h('span', h('strong', 'WOM'), h('span', 'World of a Memory'))),
        h('nav.home-nav-actions', { 'aria-label': 'Your account and worlds' },
          signedIn() ? h('button.home-nav-link', { type: 'button', onclick: showWorlds }, 'Your worlds') : '', account?.button, userMenu(),
        ),
      ),
      h('section.home-intro', { 'aria-labelledby': 'home-title' },
        h('div.hero',
          h('p.home-eyebrow', 'Every memory has more to give.'),
          h('h1', { id: 'home-title' }, 'Go beyond the ', h('em', 'photograph.')),
          h('p.lede', 'Turn a photo into a 3D scene with individually rebuilt objects. Explore new angles, save your favorite views, and bring still moments to life with video.'),
          h('section.upload', { 'aria-label': 'Create a memory' },
            drop,
            h('p.upload-formats', 'Photos, iPhone HEIC & short videos'),
            selectedFile, uploadInfo, actions,
            settings,
          ),
          memory.action,
        ),
        memory.el,
      ),
      h('section.home-measure', { 'aria-label': 'How WOM measures AI worlds' },
        h('article',
          h('span.home-eyebrow', 'WOMetrics'),
          h('h2', 'Nutrition facts for AI worlds.'),
          h('p', 'See which AI models shaped each scene, how closely it matches the photo, and how long it took.'),
          memory.facts,
        ),
        h('article',
          h('span.home-eyebrow', 'Global WOMPar'),
          h('h2', 'A common score for every mix.'),
          h('p', 'Compare complete reconstructions on the same fixed course. The reference sets par at zero; lower is better.'),
          h('a.home-sample-link', { href: '/wompar.html' }, 'Explore the WOMPar demo', h('span', { 'aria-hidden': 'true' }, '↗')),
        ),
      ),
      galleryWrap,
      h('footer.home-footer',
        h('p', 'A photograph holds a moment. See what it can become.'),
        h('details.home-colophon', h('summary', 'Behind the memory'),
          h('p', 'Built with Muse Spark, SAM, IDOL, Tripo, MoGe and World Labs Marble.'),
          currentUser()?.role === 'admin' ? h('nav', { 'aria-label': 'World evaluation' }, h('a', { href: '#/bench' }, 'World Observation Metrics'), h('a', { href: '#/observations' }, 'Observations')) : '',
        ),
      ),
    ),
  );
  // The README and WOMPar landing page link directly to the photo-to-3D starting point.
  // Wait for layout so the showcase above it cannot absorb the initial scroll.
  let createFrame = 0;
  if (new URLSearchParams(location.search).get('create') === '1') {
    createFrame = requestAnimationFrame(() => {
      if (disposed) return;
      root.querySelector('#create-memory')?.scrollIntoView({ block: 'start' });
      choose.focus({ preventScroll: true });
    });
  }
  if (account) {
    root.append(account.dialog);
    if (account.paidForCredits) account.open();
  }

  if (currentUser()?.role === 'admin') void api.health().then((hres) => {
    if (hres.keys && (!hres.keys.meta || !hres.keys.ai3d)) {
      keysNote.textContent = `Missing API keys in .env: ${[!hres.keys.meta && 'MUSE_API_KEY', !hres.keys.ai3d && 'AI3D_API_KEY'].filter(Boolean).join(', ')}`;
      keysNote.classList.add('warn');
    }
  }).catch(() => {
    keysNote.textContent = 'The WOM server is not reachable. Start it with npm run dev.';
    keysNote.classList.add('warn');
  });
  if (currentUser()?.role === 'admin') void api.account().then((a) => {
    if (a.ai3dBalanceUsd !== null) balance.textContent = fmtUsd(a.ai3dBalanceUsd);
  }).catch(() => undefined);

  const loadGallery = async () => {
    if (!signedIn()) return;
    gallery.setAttribute('aria-busy', 'true');
    let worlds: WorldSummary[] = [];
    try {
      worlds = await api.list();
    } catch {
      if (disposed) return;
      gallery.setAttribute('aria-busy', 'false');
      galleryNote.textContent = 'Please try again in a moment.';
      gallery.append(h('div.gallery-empty', h('p', 'Your worlds could not be loaded.'), h('button', { type: 'button', onclick: () => { clear(gallery); void loadGallery(); } }, 'Try again')));
      return;
    }
    if (disposed) return;
    clear(gallery);
    gallery.setAttribute('aria-busy', 'false');
    galleryNote.textContent = 'Places to come back to.';
    slidesLink.hidden = worlds.length === 0;
    if (!worlds.length) {
      galleryNote.textContent = 'Every world starts with a moment.';
      gallery.append(h('div.gallery-empty', h('p', 'Your first memory is waiting.'), h('button', { type: 'button', onclick: () => input.click() }, 'Choose a photo')));
    }
    for (const w of worlds) {
      const card = h('div.world-card');
      card.append(
        h('a.card', { href: worldHref(w.id, { handle: w.handle }) },
          h('div.thumb', h('img', { src: w.thumb, alt: '', loading: 'lazy' }), h('span.badge', { class: w.status }, w.running ? 'Building' : STATUS_LABEL[w.status])),
          // What a world cost to build is for administrators; everyone else pays in credits.
          h('div.meta', h('strong', w.title), h('span', `${w.objects} object${w.objects === 1 ? '' : 's'}${w.hasWorld ? ' · Marble world' : ''}${w.visibility === 'private' ? ' · Private' : ''}${currentUser()?.role === 'admin' ? ` · ${fmtUsd(w.costUsd)}` : ''}`)),
        ),
        h('a.world-metrics-link', { href: worldHref(w.id, { handle: w.handle, build: true }), title: 'Facts and evaluation for this generation' }, 'WOMetrics', h('span', { 'aria-hidden': 'true' }, '↗')),
      );
      gallery.append(card);
    }
  };
  void loadGallery();

  return () => {
    disposed = true;
    cancelAnimationFrame(createFrame);
    inspectSeq++;
    account?.dispose();
    memory.dispose();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  };
}
