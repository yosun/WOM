// Build progress view: pipeline steps, intermediate artifacts, costs and the live log.
import { api, subscribe, type WorldManifest } from './api.ts';
import { clear, fmtDuration, fmtUsd, h, toast } from './dom.ts';
import { STEP_ORDER } from '../../server/src/types.ts';

const ICON: Record<string, string> = { pending: '○', running: '◐', done: '●', failed: '✕', skipped: '–' };

export function renderBuild(root: HTMLElement, id: string, onReady: () => void): () => void {
  clear(root);
  const steps = h('ol.steps');
  const header = h('header.build-head');
  const gallery = h('div.artifacts');
  const logEl = h('pre.log');
  const costEl = h('div.cost');
  const actions = h('div.build-actions');
  const page = h('main.build', header, h('div.build-grid', h('section.panel', h('h2', 'Progress'), steps, costEl, actions), h('section.panel.wide', h('h2', 'What WOM sees'), gallery)), h('details.panel.log-wrap', h('summary', 'Pipeline log'), logEl));
  root.append(page);

  let manifest: WorldManifest | null = null;
  let running = false;
  let lastSceneVersion = 0;
  const lines: string[] = [];
  const tick = setInterval(() => manifest && renderSteps(), 1000);

  const file = (rel?: string) => (rel ? `/files/${id}/${rel}` : '');

  function renderSteps() {
    const m = manifest!;
    clear(steps);
    for (const s of STEP_ORDER) {
      const st = m.steps[s.id];
      const elapsed = st.startedAt ? (st.endedAt ? Date.parse(st.endedAt) : Date.now()) - Date.parse(st.startedAt) : 0;
      steps.append(
        h('li.step', { class: st.status },
          h('span.icon', ICON[st.status] ?? '○'),
          h('div.step-body',
            h('div.step-title', st.label, st.startedAt ? h('span.time', fmtDuration(elapsed)) : null),
            st.error ? h('div.step-error', st.error) : st.message ? h('div.step-msg', st.message) : null,
          ),
        ),
      );
    }
  }

  function render() {
    const m = manifest!;
    clear(header);
    header.append(
      h('a.back', { href: '#/' }, '← All worlds'),
      h('h1', m.title),
      m.plan?.summary ? h('p.lede', m.plan.summary) : '',
      h('div.status-line', { class: m.status }, running ? 'Building your world…' : m.status === 'failed' ? `Stopped: ${m.error ?? 'unknown error'}` : m.status === 'partial' ? 'Ready, with some parts missing' : m.status === 'done' ? 'Ready' : 'Queued'),
    );
    renderSteps();

    const total = m.costs.reduce((a, c) => a + c.usd, 0);
    clear(costEl);
    costEl.append(
      h('div.cost-total', h('span', 'Spent so far'), h('strong', fmtUsd(total))),
      h('ul.cost-items', m.costs.map((c) => h('li', h('span', c.label), h('span', fmtUsd(c.usd))))),
    );

    clear(actions);
    if (m.scene) actions.append(h('button.primary', { onclick: onReady }, 'Enter the world'));
    if (!running && (m.status === 'failed' || m.status === 'partial')) {
      actions.append(h('button', {
        onclick: async () => {
          try {
            await api.retry(id);
            toast('Retrying the failed parts. Finished work is reused.');
          } catch (err) { toast((err as Error).message, 'error'); }
        },
      }, 'Retry failed parts'));
    }

    clear(gallery);
    const imgBox = h('figure.photo-boxes', h('img', { src: file(m.image.file), alt: 'Your photo' }));
    if (m.plan) {
      for (const o of m.plan.objects) {
        const rec = m.objects.find((x) => x.id === o.id);
        imgBox.append(h('div.objbox', {
          class: rec?.status ?? 'pending',
          style: { left: `${o.box.x0 / 10}%`, top: `${o.box.y0 / 10}%`, width: `${(o.box.x1 - o.box.x0) / 10}%`, height: `${(o.box.y1 - o.box.y0) / 10}%` },
        }, h('span', o.name)));
      }
    }
    gallery.append(h('div.art', h('h3', 'The memory'), imgBox));
    if (m.cleanPlate?.file && m.cleanPlate.file !== m.image.file) {
      gallery.append(h('div.art', h('h3', 'Objects erased by Muse Image'), h('img', { src: file(m.cleanPlate.file), alt: 'Clean plate' })));
    }
    if (m.objects.length) {
      gallery.append(h('div.art', h('h3', 'Objects'), h('div.objects',
        m.objects.map((o) => h('div.obj', { class: o.status },
          h('div.obj-imgs',
            o.cutout ? h('img.checker', { src: file(o.cutout.file), alt: `${o.name} cutout`, title: o.cutout.completed ? 'Completed by Muse Image' : 'Cut out with SAM 3.1' }) : h('div.ph'),
            o.mesh?.previewFile ? h('img', { src: file(o.mesh.previewFile), alt: `${o.name} mesh preview`, title: 'Tripo mesh' }) : h('div.ph', o.status === 'running' ? 'sculpting…' : ''),
          ),
          h('div.obj-name', o.name, o.cutout?.completed ? h('span.tag', 'completed') : null),
          o.error ? h('div.obj-err', o.error) : o.placement ? h('div.obj-msg', `fit ${(o.placement.fit.iou * 100).toFixed(0)}% · ${o.placement.fit.heightM.toFixed(2)} m tall · ${o.placement.fit.depthM.toFixed(1)} m away`) : null,
        )),
      )));
    }
    if (m.world?.thumbnail) {
      gallery.append(h('div.art', h('h3', 'Marble world'), h('img', { src: file(m.world.thumbnail), alt: 'Marble world thumbnail' })));
    }
    if (m.plan?.worldPrompt) {
      gallery.append(h('div.art', h('h3', 'World prompt by Muse Spark'), h('p.prompt', m.plan.worldPrompt)));
    }
  }

  const unsubscribe = subscribe(id, {
    manifest: (m, isRunning) => {
      manifest = m;
      running = isRunning;
      render();
      if (m.scene && m.scene.version !== lastSceneVersion && lastSceneVersion !== 0 && (m.status === 'done' || m.status === 'partial')) {
        toast('Your world is ready.');
      }
      if (m.scene) lastSceneVersion = m.scene.version;
    },
    log: (line) => {
      lines.push(line);
      if (lines.length > 400) lines.shift();
      logEl.textContent = lines.join('\n');
    },
  });

  void api.get(id).then((r) => {
    lines.unshift(...r.log);
    logEl.textContent = lines.join('\n');
    if (!manifest) {
      manifest = r.manifest;
      running = r.running;
      render();
    }
    lastSceneVersion = r.manifest.scene?.version ?? 0;
  }).catch((err) => {
    toast((err as Error).message, 'error');
  });

  return () => {
    clearInterval(tick);
    unsubscribe();
  };
}
