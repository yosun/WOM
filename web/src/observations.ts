// Observations: problems flagged while walking a world, by people (Flag a problem, key O) or by agents.
//
// A person flags what they see, so one problem arrives many times from different spots. The server groups
// flags that mark the same place into one problem, and this page lists problems, 20 at a time. A card shows
// the clearest sighting with a thumbnail (the full frame opens on click), where it was marked, which layer
// it is in, the other sightings, and the ways to deal with it: a status for all of them at once, a link that
// reopens the world at the exact spot, and the other models the object already has. The same view with each
// layer hidden loads only when asked for.
import { OBSERVATION_CATEGORIES, OBSERVATION_STATUSES, type ObservationStatus } from '../../server/src/types.ts';
import { api, type FixSuggestion, type FixSuggestions, type ObservationIssue, type ObservationIssuePage, type ObservationSummary, type WorldManifest } from './api.ts';
import { checkOf, verdictChip } from './assetpanel.ts';
import { clear, fmtUsd, h, toast } from './dom.ts';
import { modelLabel } from './maskeditor.ts';
import { womHeader } from '@wom/metrics/web';
import { worldHref } from './routes.ts';
import { viewLink } from './viewcode.ts';

const PAGE = 20;
const SIGHTING_THUMBS = 8;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function renderObservations(root: HTMLElement, worldId?: string): () => void {
  clear(root);
  let disposed = false;
  let data: ObservationIssuePage | null = null;
  let statusFilter = '';
  let offset = 0;
  const manifests = new Map<string, WorldManifest | null>();

  const statusChips = h('div.chips', { role: 'group', 'aria-label': 'Filter by status' });
  const worldSel = h('select', { 'aria-label': 'World' }) as HTMLSelectElement;
  const summary = h('p.muted.obs-summary');
  const list = h('div.obs-list', h('p.muted', 'Loading…'));
  const pager = h('nav.obs-pager', { 'aria-label': 'Pages of problems' });
  root.append(h('main.bench.wom',
    womHeader({
      back: { href: '#/bench/observations', label: '← WOM metrics' },
      lede: 'Observations: problems flagged while walking a world, by people (Flag a problem, or O in the viewer) or by agents. Flags that mark the same spot are one problem. Each keeps the frame, the exact camera and scene that drew it, and the layer the problem is in. The asset check also opens one when it finds background inside an object the world shows; its frame is the turntable the checker saw.',
    }),
    h('div.obs-filters', statusChips, h('label.row', h('span', 'World '), worldSel)),
    summary,
    list,
    pager,
  ));
  worldSel.addEventListener('change', () => {
    location.hash = worldSel.value ? `#/observations/${worldSel.value}` : '#/observations';
  });

  async function manifestOf(world: string) {
    if (!manifests.has(world)) manifests.set(world, await api.get(world).then((r) => r.manifest).catch(() => null));
    return manifests.get(world) ?? null;
  }

  async function load() {
    try {
      const page = await api.issues({ world: worldId, status: statusFilter || undefined, limit: PAGE, offset });
      if (disposed) return;
      // A page past the end (after the last problem on it was filtered away) goes back to the last real one.
      if (!page.issues.length && page.total > 0 && offset > 0) {
        offset = Math.max(0, Math.floor((page.total - 1) / PAGE) * PAGE);
        return load();
      }
      data = page;
      clear(worldSel);
      worldSel.append(h('option', { value: '' }, 'Every world'), ...page.worlds.map((w) => h('option', { value: w.id, selected: w.id === worldId }, `${w.title} (${w.flags})`)));
      await Promise.all([...new Set(page.issues.map((i) => i.world))].map(manifestOf));
      if (!disposed) render();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  function layerLabel(world: string, layer: string) {
    if (layer === 'world') return 'Marble world';
    if (layer === 'relief') return 'Depth relief';
    const oid = layer.startsWith('object:') ? layer.slice('object:'.length) : layer;
    return manifests.get(world)?.objects.find((o) => o.id === oid)?.name ?? oid;
  }

  const fileUrl = (rec: { world: string; id: string }, name: string) => `/bench-files/observations/${rec.world}/${rec.id}/${name}`;

  // One chip per status with how many problems have it; the chip of the status being shown is on.
  function drawChips(page: ObservationIssuePage) {
    clear(statusChips);
    const chip = (id: string, label: string, n: number) => h('button.chip', {
      type: 'button',
      class: statusFilter === id ? 'on' : '',
      'aria-pressed': String(statusFilter === id),
      onclick: () => { statusFilter = id; offset = 0; void load(); },
    }, `${label} ${n}`);
    statusChips.append(chip('', 'All', page.all));
    for (const s of OBSERVATION_STATUSES) {
      const n = page.byStatus[s.id] ?? 0;
      if (n || statusFilter === s.id) statusChips.append(chip(s.id, s.label, n));
    }
  }

  function drawPager(page: ObservationIssuePage) {
    clear(pager);
    if (page.total <= PAGE) return;
    const from = offset + 1, to = Math.min(offset + PAGE, page.total);
    const prev = h('button', { type: 'button', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - PAGE); void load(); window.scrollTo({ top: 0 }); } }, '← Newer');
    const next = h('button', { type: 'button', disabled: to >= page.total, onclick: () => { offset += PAGE; void load(); window.scrollTo({ top: 0 }); } }, 'Older →');
    pager.append(prev, h('span.muted', `${from}–${to} of ${page.total} problems`), next);
  }

  function render() {
    if (!data) return;
    drawChips(data);
    drawPager(data);
    clear(list);
    summary.textContent = data.all
      ? `${data.all} problem${data.all === 1 ? '' : 's'} from ${data.flags} flag${data.flags === 1 ? '' : 's'}${statusFilter ? `; showing the ${data.total} that ${data.total === 1 ? 'is' : 'are'} ${OBSERVATION_STATUSES.find((s) => s.id === statusFilter)?.label.toLowerCase()}` : ''}.`
      : '';
    if (!data.issues.length) {
      list.append(h('p.muted', data.all ? 'Nothing with that status.' : 'No observations yet. Go inside a world and press O, or use Flag a problem.'));
      return;
    }
    for (const iss of data.issues) list.append(card(iss));
  }

  /** Change the status (or layer) of every sighting of a problem, then list again: a change of layer regroups. */
  async function patchIssue(iss: ObservationIssue, change: Parameters<typeof api.updateObservations>[2]) {
    try {
      await api.updateObservations(iss.world, iss.ids, change);
      await load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  /** Wait for the world's background task to finish (a fix runs there), telling the caller how long it has taken. */
  async function untilIdle(world: string, tick: (seconds: number) => void): Promise<WorldManifest | null> {
    const t0 = Date.now();
    for (;;) {
      await sleep(1500);
      if (disposed) return null;
      const r = await api.get(world);
      tick(Math.round((Date.now() - t0) / 1000));
      if (!r.running) {
        manifests.set(world, r.manifest);
        return r.manifest;
      }
    }
  }

  function card(iss: ObservationIssue) {
    const manifest = manifests.get(iss.world) ?? null;
    const sources: Record<string, string> = { ray: 'the nearest surface along the rays', ablation: 'the frames with a layer hidden', author: 'the author\'s hint', human: 'set by a person' };
    // The sighting on show: one with a picture of the view after the fix if there is one (the pair says most),
    // else the clearest, until another is picked from the strip.
    let current: ObservationSummary = iss.sightings.find((s) => s.files.after) ?? iss.best;
    const article = h('article.panel.obs-card', { class: iss.status });

    const oid = iss.suspect?.startsWith('object:') ? iss.suspect.slice('object:'.length) : '';
    const obj = oid ? manifest?.objects.find((o) => o.id === oid) : undefined;
    const shownModel = obj?.mesh?.job?.model;

    // ---------- suggested fixes: asked for once per card, because they depend on the problem, not on the sighting on show ----------

    const fixBox = h('div.obs-fixes');
    let working = false;

    const verb: Record<FixSuggestion['kind'], string> = { 'use-asset': 'Show it', 'check-assets': 'Check', 'generate-asset': 'Make it', 'edit-mask': '' };
    const doing: Record<FixSuggestion['kind'], string> = { 'use-asset': 'Fitting it into the world', 'check-assets': 'Checking', 'generate-asset': 'Making it', 'edit-mask': '' };

    function drawFixes(s: FixSuggestions) {
      clear(fixBox);
      fixBox.className = 'obs-fixes';
      if (!s.fixes.length && !s.notes.length) return;
      const rows = s.fixes.map((f) => {
        const act = h('span.fix-go');
        const arm = () => {
          clear(act);
          if (f.kind === 'edit-mask') {
            act.append(h('a.button.small', { href: f.href ?? worldHref(iss.world, { build: true }) }, 'Open the build page'));
            return;
          }
          // A fix that charges asks twice: the second click names the most it can cost.
          act.append(h('button.small', { type: 'button', onclick: f.costUsd > 0 ? ask : () => void runFix(f) }, f.costUsd > 0 ? `${verb[f.kind]} · up to ${fmtUsd(f.costUsd)}` : verb[f.kind]));
        };
        const ask = () => {
          clear(act);
          act.append(
            h('button.small.primary', { type: 'button', onclick: () => void runFix(f) }, `Spend up to ${fmtUsd(f.costUsd)}`),
            h('button.small', { type: 'button', onclick: arm }, 'Cancel'),
          );
        };
        arm();
        return h('li.fix',
          h('div.fix-head',
            h('strong', f.title),
            f.evidence ? h('span.chip', { class: f.evidence, title: 'What the asset check says about this model' }, f.evidence === 'clean' ? 'checked: clean' : f.evidence === 'minor' ? 'checked: minor leftovers' : f.evidence) : null,
            h('span.chip', f.costUsd > 0 ? `up to ${fmtUsd(f.costUsd)}` : 'free')),
          h('p.muted', f.because),
          act);
      });
      fixBox.append(
        h('h4', 'Suggested fixes'),
        ...(rows.length ? [h('ol.fix-list', rows)] : []),
        ...s.notes.map((n) => h('p.muted.fix-note', n)),
      );
    }

    async function showFixes() {
      if (iss.status !== 'open' && iss.status !== 'confirmed') return;
      try {
        const s = await api.fixes(iss.world, iss.best.id);
        if (!disposed) drawFixes(s);
      } catch (err) {
        if (!disposed) fixBox.replaceChildren(h('p.muted', (err as Error).message));
      }
    }

    /** Apply a fix, wait for the world to finish, check that it did what it said, and list again. */
    async function runFix(f: FixSuggestion) {
      if (working) return;
      working = true;
      fixBox.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const status = h('p.fix-status', `${doing[f.kind]}…`);
      fixBox.append(status);
      try {
        await api.applyFix(iss.world, iss.best.id, f.id, f.costUsd > 0 ? f.costUsd : undefined);
        const m = await untilIdle(iss.world, (s) => { status.textContent = `${doing[f.kind]}… ${s} s`; });
        if (disposed) return;
        const o = m?.objects.find((x) => x.id === f.object);
        const ok = f.kind === 'use-asset' ? o?.mesh?.job?.model === f.model
          : f.kind === 'generate-asset' ? Boolean(o?.assets?.[f.model!]?.file)
            : (f.models ?? []).every((x) => o?.assets?.[x]?.check);
        toast(ok
          ? (f.kind === 'use-asset' ? `The ${o?.name} shows the ${modelLabel(f.model!)} model now. Compare it at the flagged view.` : 'Done.')
          : `That did not finish. The world's log says why (${iss.worldTitle}, build page).`, ok ? 'info' : 'error');
      } catch (err) {
        toast((err as Error).message, 'error');
      }
      working = false;
      await load();
    }

    function paint() {
      const rec = current;
      const f = rec.frame;
      const mark = rec.mark.kind === 'box'
        ? h('div.obs-mark.box', { style: { left: `${(rec.mark.px[0] / f.width) * 100}%`, top: `${(rec.mark.px[1] / f.height) * 100}%`, width: `${((rec.mark.px[2] - rec.mark.px[0]) / f.width) * 100}%`, height: `${((rec.mark.px[3] - rec.mark.px[1]) / f.height) * 100}%` } })
        : h('div.obs-mark.point', { style: { left: `${(rec.mark.px[0] / f.width) * 100}%`, top: `${(rec.mark.px[1] / f.height) * 100}%` } });
      const category = OBSERVATION_CATEGORIES.find((c) => c.id === rec.category)?.label;

      // Which layers the problem could be in: those that were showing, and the current choice.
      const layers = [...new Set([...rec.ablation.map((a) => a.layer), ...(iss.suspect ? [iss.suspect] : [])])];
      const suspectSel = h('select', { title: 'Which layer the problem is in, for every sighting of it' },
        h('option', { value: '' }, 'Not sure'),
        layers.map((l) => h('option', { value: l, selected: l === iss.suspect }, layerLabel(iss.world, l)))) as HTMLSelectElement;
      suspectSel.addEventListener('change', () => void patchIssue(iss, { suspect: suspectSel.value || null }));

      // A flag the asset check opened: what it found instead of rays, and no camera to reopen.
      const ac = rec.assetCheck;
      const evidence = ac
        ? [
          h('p.muted', `The asset check (${ac.checker}) found this in the ${modelLabel(ac.model)} model: about ${pct(ac.foreignShare)} of what it saw is not the object.`),
          ac.findings.length ? h('ul.obs-findings', ac.findings.map((x) => h('li', `${x.severity}: ${x.what}${x.yaws.length ? ` (yaw ${x.yaws.join(', ')}°)` : ''}`))) : null,
          ac.rationale ? h('p.muted', ac.rationale) : null,
          obj && obj.mesh?.file !== ac.file ? h('p.muted', `The ${obj.name} no longer shows this asset.`) : null,
        ]
        : [
          rec.votes.length ? h('p.muted', `Nearest surface along ${rec.rayCount} ray${rec.rayCount === 1 ? '' : 's'}: ${rec.votes.map((v) => `${pct(v.share)} ${layerLabel(iss.world, v.layer)}`).join(', ')}.`) : h('p.muted', 'No ray hit anything at the marked spot.'),
          rec.splats ? h('p.muted', `${rec.splats.count.toLocaleString()} splats of ${layerLabel(iss.world, rec.splats.layer)} project into the marked region: mean opacity ${rec.splats.meanOpacity.toFixed(2)}, ${pct(rec.splats.thinShare)} flat or needle-like.`) : null,
        ];
      const open = rec.camera
        ? h('a.button.small', { href: viewLink(rec.world, rec.camera), title: 'Open the world at the exact camera this sighting was flagged from' }, 'Open at this view')
        : h('a.button.small', { href: worldHref(rec.world), title: 'Open the world and walk to the object' }, 'Open the world');
      // After a fix: the same view with the flagged frame to wipe over what the world shows now.
      const compare = rec.camera && iss.fix
        ? h('a.button.small.primary', { href: viewLink(rec.world, rec.camera, rec.id), title: 'Open the world at the flagged camera, with the flagged frame to wipe over the live view' }, 'Compare at this view')
        : null;
      // Once a person has looked and marked it fixed, the view as it is now sits beside the one that was flagged.
      const afterFigure = rec.files.after
        ? h('figure.obs-after',
          h('a', { href: fileUrl(rec, rec.files.after), target: '_blank', rel: 'noopener', title: 'Open the picture' },
            h('img', { src: fileUrl(rec, rec.files.after), alt: 'The same view after the fix', loading: 'lazy' })),
          h('figcaption', 'After the fix'))
        : null;

      // The other sightings of this problem, as thumbnails; one click puts it on show.
      const strip = iss.sightings.length > 1
        ? h('div.obs-sightings',
          ...iss.sightings.slice(0, SIGHTING_THUMBS).map((s) => h('button.sighting', {
            type: 'button',
            class: s.id === rec.id ? 'on' : '',
            title: `${new Date(s.createdAt).toLocaleString()} · ${s.author}${s.note ? ` · ${s.note}` : ''}`,
            onclick: () => { current = s; paint(); },
          }, h('img', { src: fileUrl(s, 'tiny.jpg'), alt: `Sighting of ${new Date(s.createdAt).toLocaleString()}`, loading: 'lazy' }))),
          iss.count > SIGHTING_THUMBS ? h('span.muted.small', `+ ${iss.count - SIGHTING_THUMBS} older`) : null,
        )
        : null;

      // The same view with each layer hidden: about 90 KB each, so only fetched when this is opened.
      const layerFrames = rec.ablation.length
        ? h('details.obs-layers', { ontoggle: (e: Event) => {
          const d = e.currentTarget as HTMLDetailsElement;
          if (!d.open || d.dataset.filled) return;
          d.dataset.filled = '1';
          d.append(h('div.obs-strip',
            rec.files.all ? h('figure', h('img', { src: fileUrl(rec, rec.files.all), alt: 'Every layer showing', loading: 'lazy' }), h('figcaption', 'Everything showing')) : null,
            ...[...rec.ablation].sort((a, b) => b.changedShare - a.changedShare).map((a) =>
              h('figure', { class: a.layer === iss.suspect ? 'suspect' : '' },
                h('img', { src: fileUrl(rec, a.file), alt: `Without ${layerLabel(iss.world, a.layer)}`, loading: 'lazy' }),
                h('figcaption', `Without ${layerLabel(iss.world, a.layer)}`, h('br'), h('span.muted', `${pct(a.changedShare)} of the region changes`)))),
          ));
        } }, h('summary', `The same view with each layer hidden (${rec.ablation.length})`))
        : null;

      const authors = [...new Set(iss.sightings.map((s) => s.author))];
      clear(article);
      article.className = `panel obs-card ${iss.status}`;
      article.append(
        h('header.obs-head',
          // The sighting on show may have no note while another one does: the problem is still described.
          h('h3', rec.note || iss.sightings.find((s) => s.note)?.note || 'Flagged without a note'),
          h('span.obs-badges',
            iss.count > 1 ? h('span.chip.seen', { title: `${iss.count} flags mark this spot` }, `seen ${iss.count} times`) : null,
            iss.reopened ? h('span.chip.reopened', { title: 'Marked fixed, then flagged again' }, 'reopened') : null,
            h('span.chip', { class: `status-${iss.status}` }, OBSERVATION_STATUSES.find((s) => s.id === iss.status)?.label ?? iss.status)),
        ),
        h('p.muted', h('a', { href: worldHref(iss.world, { build: true }) }, iss.worldTitle), ' · ', iss.count > 1 ? `first ${new Date(iss.firstSeen).toLocaleString()}, last ${new Date(iss.lastSeen).toLocaleString()}` : new Date(iss.firstSeen).toLocaleString(), ' · ', authors.join(', '), category ? ` · ${category}` : ''),
        h('div.obs-body',
          h('div.obs-pics',
            h('figure.obs-frame',
              h('a', { href: fileUrl(rec, rec.files.frame), target: '_blank', rel: 'noopener', title: 'Open the full frame' },
                h('img', { src: fileUrl(rec, 'thumb.jpg'), alt: ac ? 'The turntable the asset check saw' : 'The frame that was flagged', loading: 'lazy' })),
              mark,
            ),
            // Outside the figure: the mark is placed in percentages of the figure, which must be the picture alone.
            afterFigure ? h('p.obs-cap', 'Flagged') : null,
            afterFigure,
          ),
          h('div.obs-meta',
            h('p', h('strong', 'In: '), iss.suspect ? layerLabel(iss.world, iss.suspect) : 'unknown', rec.suspectSource ? h('span.muted', ` (${ac && rec.suspectSource === 'author' ? 'the object the asset check looked at' : sources[rec.suspectSource]})`) : null),
            ...evidence,
            shownModel && obj ? h('p.muted', `${obj.name} shows the ${modelLabel(shownModel)} model. `, verdictChip(checkOf(obj, shownModel))) : null,
            h('div.obs-actions',
              h('label.row', h('span', 'Layer '), suspectSel),
              compare,
              open,
            ),
            iss.fix ? h('p', h('strong', 'Fix applied: '), iss.fix.title, h('span.muted', ` · ${new Date(iss.fix.at).toLocaleString()} · ${iss.fix.by}`)) : null,
            fixBox,
            h('div.obs-actions', OBSERVATION_STATUSES.filter((s) => s.id !== iss.status).map((s) => {
              const b = h('button.small', { type: 'button', title: iss.count > 1 ? `Mark all ${iss.count} sightings` : '' }, s.label);
              b.addEventListener('click', () => void patchIssue(iss, { status: s.id as ObservationStatus }));
              return b;
            })),
          ),
        ),
        ...(strip ? [strip] : []),
        ...(layerFrames ? [layerFrames] : []),
      );
    }
    paint();
    void showFixes();
    return article;
  }

  void load();
  return () => { disposed = true; };
}
