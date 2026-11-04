import type { WorldMetrics } from '../../server/src/wometrics.ts';
import { MODEL_LABELS, PLACEMENT_METHODS } from '../../server/src/types.ts';
import { api } from './api.ts';
import { clear, fmtDuration, fmtUsd, h, type Child } from './dom.ts';
import './wometrics.css';

const pct = (v: number | null) => v === null ? 'Not measured' : `${(v * 100).toFixed(1)}%`;
const metricModel = (model: string) => ({
  ...MODEL_LABELS, idol: 'IDOL', triposplat: 'TripoSplat', 'tripo-v31': 'Tripo H3.1', 'tripo-p1': 'Tripo P1',
  moge2: 'MoGe-2', moge3: 'MoGe-3', worldlabs: 'Marble', 'worldlabs-draft': 'Marble Draft',
} as Record<string, string>)[model] ?? model;
const methodLabel = (method: string) => PLACEMENT_METHODS.find((m) => m.id === method)?.label ?? method;

function fact(label: string, value: string, explanation: string, tone = '') {
  return h('div.wm-fact',
    h('dt', label, h('small', explanation)), h('dd', { class: tone }, value));
}

function smallFact(label: string, value: string, explanation: string) {
  return h('div.wm-small-fact', h('span', label), h('strong', value), h('small', explanation));
}

/** Refreshes in place; coalesces pipeline updates and ignores replies after navigation. */
export function mountWorldMetrics(host: HTMLElement, id: string, owner: boolean, onReport?: (r: WorldMetrics) => void) {
  let disposed = false;
  let fetching = false;
  let again = false;
  let report: WorldMetrics | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = h('p.wm-load', { role: 'status' }, 'Reading this generation’s facts…');
  const content = h('div.wm-content');
  host.append(status, content);

  async function refresh() {
    if (disposed) return;
    if (fetching) { again = true; return; }
    fetching = true;
    try {
      const next = await api.metrics(id);
      if (disposed) return;
      status.hidden = true;
      // Keep the comparison slider and keyboard focus intact when only the polling clock changed.
      if (JSON.stringify(next) !== JSON.stringify(report)) {
        const oldSlider = content.querySelector<HTMLInputElement>('input[type="range"]');
        const reveal = oldSlider?.value;
        const focused = oldSlider === document.activeElement;
        report = next;
        clear(content);
        content.append(renderReport(next, id, owner));
        const slider = content.querySelector<HTMLInputElement>('input[type="range"]');
        if (slider && reveal !== undefined) {
          slider.value = reveal;
          slider.dispatchEvent(new Event('input'));
          if (focused) slider.focus({ preventScroll: true });
        }
        onReport?.(next);
      }
    } catch (err) {
      if (disposed) return;
      status.hidden = false;
      clear(status);
      status.append(report ? 'Facts could not be refreshed. Showing the last report. ' : 'Could not load WOMetrics. ',
        h('span', (err as Error).message), ' ', h('button.small', { type: 'button', onclick: () => void refresh() }, 'Try again'));
    } finally {
      fetching = false;
      if (again && !disposed) {
        again = false;
        timer = setTimeout(() => void refresh(), 300);
      }
    }
  }

  void refresh();
  // Also updates shared pages (which cannot subscribe to the owner's pipeline log) and observation changes.
  const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
  return { refresh, dispose: () => { disposed = true; clearInterval(poll); clearTimeout(timer); } };
}

function renderReport(r: WorldMetrics, id: string, owner: boolean) {
  const p = r.placement;
  const a = r.assets;
  const notInScene = r.objects.filter((o) => !o.inScene);
  const missingChecks = Math.max(0, a.generated - a.checked);
  const gaps = p.meanAbsGapM === null ? 'Not measured' : `${(p.meanAbsGapM * 100).toFixed(1)} cm`;
  const note = h('div.wm-reading', h('span.wm-eyebrow', 'HOW TO READ THIS LABEL'),
    h('p', 'One generation, measured from the photo it came from. Coverage, visual fit, physical placement, and asset quality answer different questions.'),
    h('p', 'These measurements describe this generation. Whole-world preference is evaluated separately across a fixed WOMPar course.'));
  const facts = h('section.wm-facts', { 'aria-label': 'Generation facts' },
    h('span.wm-eyebrow', 'WORLD OBSERVATION METRICS'),
    h('h2', 'Generation facts'),
    h('p.wm-serving', 'One photo. One generated world.'),
    h('div.wm-label-rule'),
    h('div.wm-fact-meta', h('span', 'Measurement'), h('span', 'This generation')),
    h('dl.wm-fact-list',
      fact('Objects in the world', r.plannedObjects === null ? `${r.placedObjects} / —` : `${r.placedObjects} / ${r.plannedObjects}`, r.plannedObjects === null ? 'Scene plan not available yet' : 'Placed objects / planned objects', notInScene.length ? 'wm-warn' : ''),
      fact('Silhouette overlap', pct(p.meanIou), `Mean IoU · ${p.measured} of ${r.placedObjects} placed objects measured`),
      fact('Clean assets', a.checked ? `${a.clean} / ${a.checked}` : 'Not checked', `${a.checked} of ${a.generated} active assets checked${a.minor ? ` · ${a.minor} minor` : ''}${a.contaminated ? ` · ${a.contaminated} contaminated` : ''}`, a.contaminated ? 'wm-warn' : ''),
      fact('Ground gap', gaps, `Mean absolute distance · ${p.gapMeasured} object${p.gapMeasured === 1 ? '' : 's'} measured`),
      fact('Object tilt', p.meanTiltDeg === null ? 'Not measured' : `${p.meanTiltDeg.toFixed(1)}°`, 'Mean tilt from upright; some objects intentionally lean'),
      fact('Surrounding world', r.components.background ? 'Present' : r.components.backgroundRequested ? 'Not ready' : 'Not requested', r.components.relief ? 'Depth relief also available' : 'Depth relief not available'),
    ),
    h('p.wm-label-foot', 'Higher overlap means a closer match to the object’s outline in the original photo. It does not measure unseen surfaces or the quality of the whole world.'),
    h('div.wm-label-method', h('span', 'Placement used'), h('strong', methodLabel(p.active))),
  );

  const concerns: Child[] = [];
  if (r.running) concerns.push(h('li', 'Generation is running. Facts update as each stage finishes.'));
  if (notInScene.length) concerns.push(h('li', `${notInScene.length} planned object${notInScene.length === 1 ? ' is' : 's are'} not in the generated scene: ${notInScene.map((o) => o.name).join(', ')}.`));
  if (missingChecks) concerns.push(h('li', `${missingChecks} active asset${missingChecks === 1 ? ' has' : 's have'} no current quality check. Unchecked assets are not counted as clean.`));
  if (a.contaminated || a.minor) concerns.push(h('li', `${a.contaminated} contaminated and ${a.minor} minor-leftover verdict${a.contaminated + a.minor === 1 ? '' : 's'} from the asset checker. These are model judgments.`));
  if (r.components.backgroundRequested && !r.components.background) concerns.push(h('li', 'The requested surrounding world is not in the scene yet.'));

  const elapsed = r.elapsedMs === null ? r.status === 'queued' ? 'Not started' : 'Not recorded' : fmtDuration(r.elapsedMs);
  const bytes = r.payloadBytes === null ? 'Not measured' : `${(r.payloadBytes / 1_000_000).toFixed(1)} MB`;
  const time = new Date(r.updatedAt);
  return h('div.wm-report',
    h('div.wm-report-meta',
      h('span', `Generation ${r.world}`),
      h('span', r.sceneVersion === null ? 'Scene not composed yet' : `Scene revision ${r.sceneVersion}`),
      h('time', { dateTime: r.updatedAt }, Number.isFinite(time.getTime()) ? `Updated ${time.toLocaleString()}` : 'Update time unavailable')),
    parCard(r, owner),
    h('div.wm-hero', facts, h('div.wm-evidence', comparison(r, id), note)),
    h('section.wm-resources', { 'aria-label': 'Generation resources' },
      smallFact('Pipeline stages', `${r.stages.done} / ${r.stages.total - r.stages.skipped}`, `Completed · ${r.stages.skipped} skipped · ${r.stages.failed} failed`),
      smallFact('Build time', elapsed, 'Wall time across recorded stages; includes waits and retries'),
      smallFact('Generation spend', r.spend ? fmtUsd(r.spend.usd) : 'Owner only', r.spend ? `${r.spend.calls} recorded charges${r.spend.estimatedUsd > 0 ? ` · ${fmtUsd(r.spend.estimatedUsd)} estimated` : ''} · includes retries` : 'Costs are private to the world’s owner'),
      smallFact('3D download', bytes, `${r.payloadComplete ? 'Objects + default world splats' : 'Partial size of known 3D files'}; excludes textures, relief and colliders`)),
    concerns.length ? h('section.wm-attention', h('h2', 'What still needs attention'), h('ul', concerns)) : null,
    h('section.wm-section', h('div.wm-section-head', h('h2', 'Object by object'), h('span.muted', 'Current assets and generated placements')),
      r.objects.length ? objectTable(r) : h('p.muted', 'Objects will appear here after the scene has been planned. A background-only generation can have no separate objects.'),
      h('p.wm-help', 'IoU compares silhouettes on a scale of 0–100%. Gap is signed: positive is above the ground, negative below it. Held, elevated, or leaning objects need context. A missing value means there is no measurement. Saved manual layout edits are excluded.')),
    h('div.wm-bottom-grid',
      h('section.wm-section', h('h2', 'Model ingredients'), h('dl.wm-ingredients', r.models.map((row) => h('div', h('dt', row.role), h('dd', row.models.length ? row.models.map(metricModel).join(', ') : 'Not recorded yet')))),
        h('p.wm-help', 'Scene director is the configured model. Other model names come from recorded outputs and current asset checks.')),
      h('section.wm-section', h('h2', 'Camera & world'), h('dl.wm-ingredients',
        ingredient('Camera source', r.camera.source === 'marble' ? 'Marble calibration' : r.camera.source === 'moge' ? 'MoGe depth' : 'Not measured'),
        ingredient('Horizontal field of view', r.camera.hfovDeg === null ? 'Not measured' : `${r.camera.hfovDeg.toFixed(1)}°`),
        ingredient('Difference from photo lens', r.camera.lensErrorDeg === null ? 'No lens comparison' : `${r.camera.lensErrorDeg >= 0 ? '+' : ''}${r.camera.lensErrorDeg.toFixed(1)}°`),
        ingredient('Camera height', r.camera.heightM === null ? 'Not measured' : `${r.camera.heightM.toFixed(2)} m`),
        ingredient('Depth map', r.components.depth ? 'Available' : 'Not available'),
        ingredient('World collision mesh', r.components.collision ? 'Available' : 'Not available')),
        h('p.wm-help', 'A field-of-view match checks the camera, not the accuracy of the generated geometry.'))),
    h('section.wm-section.wm-observations', h('div', h('h2', 'Observations from inside the world'),
      h('p.muted', r.observations ? r.observations.total ? `${r.observations.unresolved} unresolved · ${r.observations.fixed} fixed · ${r.observations.total} flags recorded. Flags may describe the same problem; earlier scene revisions may be included.` : 'No observations recorded. This does not mean the world has been inspected or is free of problems.' : 'Observation history is available to the owner.')),
      owner ? h('a.button', { href: `#/observations/${id}` }, 'Review observations →') : null),
    h('footer.wm-footer', h('span', 'WOMetrics · Facts schema 1 · Current generation snapshot'),
      h('a', { href: `/api/worlds/${id}/metrics`, target: '_blank', rel: 'noopener' }, 'Report JSON'),
      h('a', { href: '/api/wometrics/setup-schema', target: '_blank', rel: 'noopener' }, 'Contributor format'),
      owner ? h('a', { href: '#/bench/global' }, 'Compare methods in benchmarks →') : null));
}

function parCard(r: WorldMetrics, owner: boolean) {
  const par = r.par;
  if (!par) return h('section.wm-par', { 'aria-label': 'Current WOMPar score' },
    h('div', h('span.wm-eyebrow', 'CURRENT WOMPAR'), h('h2', 'Reference unavailable'), h('p', 'A published course is needed before methods can be ranked.')));
  const name = par.reference.id.replace(/^wompar-/i, 'WOMPar ');
  return h('section.wm-par', { 'aria-label': 'Current WOMPar score' },
    h('div.wm-par-anchor', h('span.wm-eyebrow', 'CURRENT WOMPAR'), h('h2', name),
      h('div.wm-par-number', h('strong', String(par.reference.score)), h('span', 'Par')),
      h('p', 'Lower is better. Negative beats par.')),
    h('div.wm-par-context',
      h('p.wm-par-course', `${par.course.photographs}-photo ${par.course.release} · ${par.track.kind === 'human' ? 'Human' : 'Model'} comparison track`),
      h('p', 'The frozen reference defines zero. Every contributing setup is compared on the same photographs and camera walkthroughs.'),
      h('div.wm-par-entry', h('span', 'This generation'), h('strong', 'Not ranked')),
      h('p.wm-help', 'A method earns its score by completing the course. The measurements below describe this generation.'),
      h('div.wm-par-links',
        h('span.muted', par.evaluation ? `${par.evaluation.actualBallots} actual comparison ballots in the latest run` : 'Comparison results have not been published'),
        owner && par.evaluation ? h('a', { href: `#/bench/global/${par.evaluation.run}` }, 'Course scorecard →') : null),
      h('details.wm-par-provenance', h('summary', 'Score provenance'),
        h('p', `${par.protocol} · ${par.course.id} · ${par.track.id}`), h('code', par.course.sha256))),
  );
}

function ingredient(label: string, value: string) { return h('div', h('dt', label), h('dd', value)); }

function objectTable(r: WorldMetrics) {
  const dash = '—';
  return h('div.wm-table-scroll', { role: 'region', 'aria-label': 'Object measurements', tabIndex: 0 }, h('table.wm-table',
    h('thead', h('tr', ['Object / model', 'In scene', 'Overlap ↑', 'Gap', 'Tilt', 'Asset check'].map((label) => h('th', { scope: 'col' }, label)))),
    h('tbody', r.objects.map((o) => h('tr',
      h('th', { scope: 'row' }, o.name, h('small', o.model ? metricModel(o.model) : 'No generated model')),
      h('td', o.inScene ? 'Placed' : o.status === 'failed' ? 'Failed' : o.status === 'skipped' ? 'Skipped' : 'Not placed'),
      h('td', o.iou === null ? dash : pct(o.iou), o.method && o.method !== r.placement.active ? h('small', 'Fitter fallback') : null),
      h('td', o.gapM === null ? dash : `${o.gapM > 0 ? '+' : ''}${(o.gapM * 100).toFixed(1)} cm`),
      h('td', o.tiltDeg === null ? dash : `${o.tiltDeg.toFixed(1)}°`),
      h('td', h('span.wm-verdict', { class: o.verdict ?? 'unchecked' }, o.verdict === 'minor' ? 'Minor leftovers' : o.verdict === 'contaminated' ? 'Contaminated' : o.verdict === 'clean' ? 'Clean' : 'Unchecked'), o.foreignShare !== null ? h('small', `${pct(o.foreignShare)} foreign area, estimated`) : null),
    )))));
}

function comparison(r: WorldMetrics, id: string) {
  const source = `/files/${id}/source.jpg`;
  const preview = `/files/${id}/reprojection.jpg?v=${r.sceneVersion ?? 0}`;
  const heading = h('div.wm-section-head', h('h2', 'Back to the original view'), h('span.wm-eyebrow', 'VISUAL EVIDENCE'));
  const img = h('img', { src: source, alt: 'The original photo used to generate this world' });
  const frame = h('div.wm-compare', img);
  const controls = h('div.wm-compare-controls');
  if (r.reprojection) {
    const overlay = h('img.wm-reproject', { src: preview, alt: 'Reconstruction preview from the photo’s camera' });
    const slider = h('input', { type: 'range', min: 0, max: 100, value: '50', 'aria-label': 'Reveal reconstruction over original photo' });
    const apply = () => { overlay.style.clipPath = `inset(0 ${100 - Number(slider.value)}% 0 0)`; };
    slider.addEventListener('input', apply);
    apply();
    frame.append(overlay, h('span.wm-compare-tag', 'Reconstruction'), h('span.wm-compare-tag.original', 'Original'));
    controls.append(h('span', 'Original'), slider, h('span', 'Reconstruction'));
    overlay.addEventListener('error', () => {
      overlay.remove();
      frame.querySelectorAll('.wm-compare-tag').forEach((tag) => tag.remove());
      clear(controls);
      controls.append('Reconstruction preview is unavailable. Showing the original photo.');
    });
  } else {
    controls.append(h('p.muted', 'The original photo is shown here. A reconstruction preview will appear after composition, when available.'));
  }
  return h('section.wm-visual', heading, frame, controls,
    h('p.wm-help', 'The saved compose preview is a visual aid. Alternate placements and later alignment edits may differ; inspect the live world for the current result.'));
}
