// Every generation opens on WOMetrics. Build details and refinement have their own owner-only tab.
import { api, subscribe, type WorldManifest } from './api.ts';
import { clear, fmtDuration, fmtUsd, h, toast } from './dom.ts';
import { assetCheckLine } from './assetpanel.ts';
import { modelLabel, OBJECT_PRICE_USD, openMaskEditor } from './maskeditor.ts';
import { STEP_ORDER } from '../../server/src/types.ts';
import { mountWorldMetrics } from './wometrics.ts';

const ICON: Record<string, string> = { pending: '○', running: '◐', done: '●', failed: '✕', skipped: '–' };

export function renderBuild(root: HTMLElement, id: string, onReady: () => void, canEdit = true, showRefinement = false): () => void {
  clear(root);
  const steps = h('ol.steps');
  const header = h('header.build-head');
  const gallery = h('div.artifacts');
  const logEl = h('pre.log');
  const costEl = h('div.cost');
  const actions = h('div.build-actions');
  const metricsHost = h('section.wm-metrics', { id: `metrics-${id}`, role: 'tabpanel', 'aria-labelledby': `metrics-tab-${id}` });
  const buildDetails = h('section.wm-build-details', { id: `details-${id}`, role: 'tabpanel', 'aria-labelledby': `details-tab-${id}` }, h('h2', 'Build Details'),
    h('div.build-grid', h('section.panel', h('h2', 'Progress'), steps, costEl), h('section.panel.wide', h('h2', 'What WOM sees'), gallery)),
    h('details.panel.log-wrap', h('summary', 'Pipeline log'), logEl));
  const metricsTab = h('button', { type: 'button', role: 'tab', id: `metrics-tab-${id}`, 'aria-controls': metricsHost.id, onclick: () => selectTab('wometrics') }, 'WOMetrics');
  const detailsTab = h('button', { type: 'button', role: 'tab', id: `details-tab-${id}`, 'aria-controls': buildDetails.id, onclick: () => selectTab('build-details') }, 'Build Details');
  const tabs = h('nav.wm-tabs', { role: 'tablist', 'aria-label': 'World report' }, metricsTab, canEdit ? detailsTab : null);
  const page = h('main.build.wometrics', header, tabs, metricsHost, canEdit ? buildDetails : null);
  root.append(page);

  let manifest: WorldManifest | null = null;
  let running = false;
  let lastSceneVersion = 0;
  let disposed = false;
  let selected: 'wometrics' | 'build-details' = showRefinement && canEdit ? 'build-details' : 'wometrics';
  const lines: string[] = [];
  const tick = setInterval(() => manifest && canEdit && running && renderSteps(), 1000);
  const metrics = mountWorldMetrics(metricsHost, id, canEdit, (r) => {
    if (!canEdit && manifest) {
      manifest = { ...manifest, title: r.title, status: r.status, scene: r.sceneVersion === null ? undefined : { file: 'scene.json', version: r.sceneVersion } };
      running = r.running;
      render();
    }
  });

  function selectTab(next: typeof selected, updateUrl = true) {
    selected = next === 'build-details' && canEdit ? next : 'wometrics';
    metricsHost.hidden = selected !== 'wometrics';
    buildDetails.hidden = selected !== 'build-details';
    for (const [tab, active] of [[metricsTab, selected === 'wometrics'], [detailsTab, selected === 'build-details']] as const) {
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    if (manifest) document.title = `${selected === 'wometrics' ? 'WOMetrics' : 'Build Details'} · ${manifest.title}`;
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.delete('refine');
      if (selected === 'build-details') url.searchParams.set('tab', 'build-details');
      else url.searchParams.delete('tab');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }
  tabs.addEventListener('keydown', (event) => {
    const buttons = canEdit ? [metricsTab, detailsTab] : [metricsTab];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    selectTab(next === 0 ? 'wometrics' : 'build-details');
    buttons[next].focus();
  });
  selectTab(selected, false);

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
    document.title = `${selected === 'wometrics' ? 'WOMetrics' : 'Build Details'} · ${m.title}`;
    clear(header);
    header.append(
      h('div.wm-header-nav', h('a.back', { href: '#/' }, '← All worlds'), h('span.muted', 'One format for every setup.')),
      h('p.wm-brand', 'World of a Memory'),
      h('h1', 'WOMetrics'),
      h('h2.wm-world-title', m.title),
      m.plan?.summary ? h('p.lede', m.plan.summary) : '',
      h('div.status-line', { class: m.status }, running ? 'Building your world…' : m.status === 'failed' ? `Stopped: ${m.error ?? 'unknown error'}` : m.status === 'partial' ? 'Ready, with some parts missing' : m.status === 'done' ? 'Ready' : 'Queued'),
      actions,
    );
    clear(actions);
    if (m.scene) actions.append(h('button.primary', { onclick: onReady }, 'Enter the world'));
    if (canEdit && !running && (m.status === 'failed' || m.status === 'partial')) {
      actions.append(h('button', {
        onclick: async () => {
          try {
            await api.retry(id);
            toast('Retrying the failed parts. Finished work is reused.');
          } catch (err) { toast((err as Error).message, 'error'); }
        },
      }, 'Retry failed parts'));
    }

    if (!canEdit) return;
    renderSteps();
    const total = m.costs.reduce((a, c) => a + c.usd, 0);
    clear(costEl);
    costEl.append(
      h('div.cost-total', h('span', 'Spent so far'), h('strong', fmtUsd(total))),
      h('ul.cost-items', m.costs.map((c) => h('li', h('span', c.label), h('span', fmtUsd(c.usd))))),
    );

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
            o.mesh?.previewFile ? h('img', { src: file(o.mesh.previewFile), alt: `${o.name} preview`, title: o.mesh.job?.model ?? '' }) : h('div.ph', o.status === 'running' ? 'sculpting…' : o.mesh?.file ? `${modelLabel(o.mesh.job?.model ?? '')} (no preview)` : ''),
          ),
          h('div.obj-name', o.name, o.cutout?.completed ? h('span.tag', 'completed') : null, (o.maskVersion ?? 1) > 1 ? h('span.tag', `mask v${o.maskVersion}`) : null),
          o.error ? h('div.obj-err', o.error) : o.placement?.fit ? h('div.obj-msg', `fit ${(o.placement.fit.iou * 100).toFixed(0)}% · ${o.placement.fit.heightM.toFixed(2)} m tall · ${o.placement.fit.depthM.toFixed(1)} m away`) : null,
          Object.keys(o.assets ?? {}).length ? h('div.obj-msg', `Models: ${Object.keys(o.assets ?? {}).map(modelLabel).join(', ')}`) : null,
          assetCheckLine(o, id),
          o.mask ? h('button.small', { type: 'button', disabled: running, title: 'Redo this object\'s mask with SAM 3.1; only this object is rebuilt', onclick: () => openMaskEditor(m, o) }, 'Fix mask') : null,
        )),
      )));
      gallery.append(objectModels(m));
    }
    gallery.append(cameraEl);
    if ((m.image.frames?.length ?? 0) > 1) {
      gallery.append(h('div.art', h('h3', `Frames in the upload (built from ${(m.image.frame ?? 0) + 1} of ${m.image.frames!.length})`),
        h('div.frame-strip', m.image.frames!.map((f, i) => h('a.frame', { class: i === m.image.frame ? 'selected' : '', href: file(f.file), target: '_blank', title: f.timeS !== undefined ? `${f.timeS.toFixed(2)} s` : `Frame ${i + 1}` }, h('img', { src: file(f.thumb), alt: `Frame ${i + 1}` })))),
      ));
    }
    if (m.world?.thumbnail) {
      gallery.append(h('div.art', h('h3', 'Marble world'), h('img', { src: file(m.world.thumbnail), alt: 'Marble world thumbnail' })));
    }
    if (m.plan?.worldPrompt) {
      gallery.append(h('div.art', h('h3', 'World prompt by Muse Spark'), h('p.prompt', m.plan.worldPrompt)));
    }
  }

  // The real camera (EXIF lens, phone depth) against each depth model; refreshed when depth finishes.
  const cameraEl = h('div.art');
  let cameraDepthState = '';
  async function refreshCamera() {
    try {
      const r = await api.camera(id);
      clear(cameraEl);
      const cam = r.camera;
      const who = [cam?.make, cam?.model].filter(Boolean).join(' ');
      const lens = cam?.focalLength35mm ? `${cam.focalLength35mm} mm equivalent` : cam?.focalLengthMm ? `${cam.focalLengthMm} mm` : '';
      cameraEl.append(h('h3', 'Camera'),
        h('p.muted', cam?.hfovDeg ? `${[who, lens].filter(Boolean).join(', ')}: ${cam.hfovDeg.toFixed(1)}° horizontal field of view (from the photo's lens data).` : 'This photo has no lens data, so the depth models\' field of view cannot be checked.'),
        r.depth.length ? h('ul.cost-items', r.depth.map((d) => h('li',
          h('span', `${d.model === 'moge3' ? 'MoGe-3' : d.model === 'moge2' ? 'MoGe-2' : d.model}: ${d.hfovDeg.toFixed(1)}°${d.errorDeg !== undefined ? ` (${d.errorDeg >= 0 ? '+' : ''}${d.errorDeg.toFixed(1)}° vs the lens)` : ''}`),
          h('span', d.phone ? `phone ${d.phone.type}: ${(d.phone.absRel * 100).toFixed(1)}% off, r ${d.phone.r.toFixed(2)}${d.phone.scale ? `, scale ×${d.phone.scale.toFixed(2)}` : ''}` : ''),
        ))) : '',
        r.aux.some((a) => a.preview) ? h('div.frame-strip', r.aux.filter((a) => a.preview).map((a) => h('a.frame', { href: a.preview!, target: '_blank', title: `${a.type} (${a.width}×${a.height}${a.accuracy ? `, ${a.accuracy}` : ''})` }, h('img', { src: a.preview!, alt: a.type })))) : '',
      );
    } catch {
      clear(cameraEl);
    }
  }

  /** Every object model this world has (per current mask): generate one to compare, or switch the world to it. */
  function objectModels(m: WorldManifest) {
    const withCutout = m.objects.filter((o) => o.cutout);
    const rows = (['idol', 'triposplat', 'tripo-v31', 'tripo-p1'] as const).map((model) => {
      const have = withCutout.filter((o) => o.assets?.[model]?.file).length;
      const missing = withCutout.length - have;
      const active = m.options.meshModel === model;
      let action: HTMLElement | string = '';
      if (missing > 0) {
        action = h('button.small', {
          type: 'button',
          disabled: running,
          title: 'Generate it for the objects that lack it, to compare; the world keeps its current model',
          onclick: async () => {
            try {
              await api.generateAssets(id, model);
              toast(`Generating ${modelLabel(model)} for ${missing} object(s).`);
            } catch (err) { toast((err as Error).message, 'error'); }
          },
        }, `Generate (${fmtUsd(missing * (OBJECT_PRICE_USD[model] ?? 0))})`);
      } else if (!active && have > 0) {
        action = h('button.small', {
          type: 'button',
          disabled: running,
          title: 'Show this model in the world. Free: no 3D jobs, and agent placements come only from earlier answers (run agents from the viewer).',
          onclick: async () => {
            try {
              await api.useObjectModel(id, model);
              toast(`Switching the world to ${modelLabel(model)}.`);
            } catch (err) { toast((err as Error).message, 'error'); }
          },
        }, 'Show in the world');
      }
      return h('li.row', h('span', modelLabel(model)), h('span.muted', `${have} of ${withCutout.length}${active ? ' · shown in the world' : ''}`), action);
    });
    return h('div.art', h('h3', 'Object models'), h('ul.model-list', rows),
      h('p.muted', 'Each model is generated once per object and mask, and kept. Compare them on the ', h('a', { href: '#/bench' }, 'benchmark page'), ' after running npm run bench:placement.'));
  }

  const unsubscribe = canEdit ? subscribe(id, {
    manifest: (m, isRunning) => {
      if (disposed) return;
      manifest = m;
      running = isRunning;
      const depthState = `${m.steps.depth.status}:${Object.keys(m.depthAssets ?? {}).join(',')}`;
      if (depthState !== cameraDepthState) {
        cameraDepthState = depthState;
        void refreshCamera();
      }
      render();
      void metrics.refresh();
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
  }) : () => {};

  void api.get(id).then((r) => {
    if (disposed) return;
    lines.unshift(...r.log);
    logEl.textContent = lines.join('\n');
    if (!manifest) {
      manifest = r.manifest;
      running = r.running;
      render();
      if (canEdit) void refreshCamera();
    }
    lastSceneVersion = r.manifest.scene?.version ?? 0;
  }).catch((err) => {
    if (disposed) return;
    toast((err as Error).message, 'error');
  });

  return () => {
    disposed = true;
    clearInterval(tick);
    unsubscribe();
    metrics.dispose();
  };
}
