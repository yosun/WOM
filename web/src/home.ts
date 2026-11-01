import { api, type WorldOptions, type WorldSummary } from './api.ts';
import { clear, fmtUsd, h, toast } from './dom.ts';

const STATUS_LABEL: Record<WorldSummary['status'], string> = {
  queued: 'Queued',
  running: 'Building',
  done: 'Ready',
  partial: 'Ready (partial)',
  failed: 'Failed',
};

export function renderHome(root: HTMLElement) {
  clear(root);
  let file: File | null = null;
  let options: WorldOptions = { maxObjects: 5, plannerModel: 'muse-spark-1.3', meshModel: 'triposplat', worldModel: 'worldlabs', completeOccluded: true };

  const preview = h('img.drop-preview', { alt: '' });
  const dropHint = h('div.drop-hint', h('strong', 'Drop a photo here'), h('span', 'or click to choose a JPEG, PNG or WebP'));
  const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true }) as HTMLInputElement;
  const drop = h('label.drop', { tabIndex: 0 }, input, preview, dropHint);
  const startBtn = h('button.primary', { type: 'button', disabled: true }, 'Step into this memory');
  const keysNote = h('p.note');
  const balance = h('span.balance');

  const setFile = (f: File | null) => {
    file = f;
    startBtn.disabled = !f;
    if (f) {
      preview.src = URL.createObjectURL(f);
      drop.classList.add('has-file');
    } else {
      preview.removeAttribute('src');
      drop.classList.remove('has-file');
    }
  };
  input.addEventListener('change', () => setFile(input.files?.[0] ?? null));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f && /^image\//.test(f.type)) setFile(f);
    else toast('That is not an image file.', 'error');
  });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });

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

  const settings = h('details.settings',
    h('summary', 'Settings'),
    h('div.fields',
      select('maxObjects', 'Objects to sculpt', [[0, 'None (world only)'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6'], [8, '8']], 'Muse Spark picks the most important ones'),
      select('plannerModel', 'Scene director', [['muse-spark-1.3', 'Muse Spark 1.3'], ['muse-wonder-1.0', 'Muse Wonder 1.0']], 'Reads the photo and plans the scene'),
      select('meshModel', 'Objects', [['triposplat', 'TripoSplat (Gaussian splats)'], ['tripo-v31', 'Tripo H3.1 mesh'], ['tripo-p1', 'Tripo P1 low-poly mesh']], 'TripoSplat $0.05 per object; Tripo meshes $0.30–0.50'),
      select('worldModel', 'Surrounding world', [['worldlabs', 'Marble 1.1'], ['worldlabs-draft', 'Marble draft (cheaper)'], ['none', 'None (depth relief only)']], 'Grown from the photo with objects erased'),
      h('label.field.check', completeBox, h('span', 'Complete hidden parts of objects with Muse Image')),
    ),
  );

  startBtn.addEventListener('click', async () => {
    if (!file) return;
    startBtn.disabled = true;
    startBtn.textContent = 'Uploading…';
    try {
      const m = await api.create(file, options);
      location.hash = `#/world/${m.id}`;
    } catch (err) {
      toast((err as Error).message, 'error');
      startBtn.disabled = false;
      startBtn.textContent = 'Step into this memory';
    }
  });

  const gallery = h('div.gallery');
  const galleryWrap = h('section.gallery-wrap', h('h2', 'Your worlds'), gallery);

  root.append(
    h('main.home',
      h('header.hero',
        h('div.brand', h('span.mark', 'WOM'), h('span', 'World of a Memory')),
        h('h1', 'Step inside a photograph.'),
        h('p.lede', 'Give WOM one image. Muse Spark reads the scene, SAM 3.1 outlines every object, Tripo sculpts each one, MoGe-2 measures the depth, and World Labs Marble grows the world around them.'),
      ),
      h('section.upload', drop, settings, h('div.actions', startBtn, balance), keysNote),
      galleryWrap,
    ),
  );

  void api.health().then((hres) => {
    if (!hres.keys.meta || !hres.keys.ai3d) {
      keysNote.textContent = `Missing API keys in .env: ${[!hres.keys.meta && 'MUSE_API_KEY', !hres.keys.ai3d && 'AI3D_API_KEY'].filter(Boolean).join(', ')}`;
      keysNote.classList.add('warn');
    }
  }).catch(() => {
    keysNote.textContent = 'The WOM server is not reachable. Start it with npm run dev.';
    keysNote.classList.add('warn');
  });
  void api.account().then((a) => {
    if (a.ai3dBalanceUsd !== null) balance.textContent = `AI3D balance ${fmtUsd(a.ai3dBalanceUsd)}`;
  }).catch(() => undefined);

  const loadGallery = async () => {
    let worlds: WorldSummary[] = [];
    try {
      worlds = await api.list();
    } catch {
      return;
    }
    clear(gallery);
    galleryWrap.hidden = worlds.length === 0;
    for (const w of worlds) {
      gallery.append(
        h('a.card', { href: `#/world/${w.id}` },
          h('div.thumb', h('img', { src: w.thumb, alt: '', loading: 'lazy' }), h('span.badge', { class: w.status }, w.running ? 'Building' : STATUS_LABEL[w.status])),
          h('div.meta', h('strong', w.title), h('span', `${w.objects} object${w.objects === 1 ? '' : 's'}${w.hasWorld ? ' · Marble world' : ''} · ${fmtUsd(w.costUsd)}`)),
        ),
      );
    }
  };
  void loadGallery();
}
