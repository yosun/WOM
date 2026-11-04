// WOM, World Observation Metrics, in this app: the @wom/metrics dashboard plus the two tabs only this app can
// fill. Camera compares each depth model's field of view with the lens the photo recorded; Observations counts
// the problems people and agents flagged while walking a world. Both are built from the dashboard's own
// pieces, so they look like the rest. The Observations page itself (observations.ts) is the app's.
import {
  chip, DASH, diverge, fPct, fSigned, fWhen, fx, h, hbars, isNum, kpi, loadInto, mean, notice, panel, plural, StaleServerError,
  type DashboardInsight, type HostTab, type KpiOptions, type MetricsContext, type MetricsUiHost, type View,
} from '@wom/metrics/web';
import { OBSERVATION_CATEGORIES, OBSERVATION_STATUSES } from '../../server/src/types.ts';
import { worldHref } from './routes.ts';
import { api, type CameraReport, type ObservationListItem } from './api.ts';

// ---------- camera ----------

const DEPTH_LABEL: Record<string, string> = { moge2: 'MoGe-2', moge3: 'MoGe-3' };
const depthLabel = (d: string) => DEPTH_LABEL[d] ?? d;

interface DepthModelRow {
  model: string;
  label: string;
  photos: number;
  withLens: number;
  meanFovDeg: number | null;
  /** Mean of |field of view − the lens's|, over photos whose lens is known. */
  meanAbsErrorDeg: number | null;
  withPhoneDepth: number;
  meanPhoneAbsRel: number | null;
}

function depthModelRows(reports: CameraReport[]): DepthModelRow[] {
  const models = [...new Set(reports.flatMap((r) => r.depth.map((d) => d.model)))].sort();
  return models.map((model) => {
    const entries = reports.map((r) => ({ r, d: r.depth.find((x) => x.model === model) })).filter((x): x is { r: CameraReport; d: CameraReport['depth'][number] } => Boolean(x.d));
    const errs = entries.map((x) => x.d.errorDeg).filter(isNum);
    const phone = entries.map((x) => x.d.phone?.absRel).filter(isNum);
    return {
      model,
      label: depthLabel(model),
      photos: entries.length,
      withLens: errs.length,
      meanFovDeg: mean(entries.map((x) => x.d.hfovDeg)),
      meanAbsErrorDeg: mean(errs.map(Math.abs)),
      withPhoneDepth: phone.length,
      meanPhoneAbsRel: mean(phone),
    };
  });
}

function cameraView(ctx: MetricsContext): View {
  const host = h('div.tab-camera');
  const load = ctx.data.remember('cameras', async () => {
    const reports = await api.cameras();
    if (!Array.isArray(reports)) throw new StaleServerError('The camera report is not available from this server. If it was started before this version, restart it (npm run dev, or npm start).');
    return reports;
  });
  loadInto(host, load, (reports) => {
    if (!reports.length) return notice('No worlds yet. Make one from a photo to compare its camera.');
    const models = depthModelRows(reports);
    const withLens = reports.filter((r) => r.camera?.hfovDeg).length;
    return [
      panel({
        title: 'Depth models against the real camera',
        lede: 'Depth models also guess the camera: the field of view their point maps imply. Photos taken with a phone record the lens, which gives the true field of view, and Portrait or LiDAR photos carry the phone\'s own depth map. Each depth model is checked against both.',
      },
      withLens === 0
        ? notice(`None of ${plural(reports.length, 'photo')} has lens data (the photo was generated, or its EXIF is gone), so there is no true field of view to compare with. The table shows how the depth models differ from each other.`)
        : null,
      h('div.kpis.compact', models.map((m) => kpi({
        label: m.label,
        asIs: true,
        value: m.meanAbsErrorDeg !== null ? `±${m.meanAbsErrorDeg.toFixed(1)}°` : `${fx(m.meanFovDeg, 0)}°`,
        tone: m.meanAbsErrorDeg === null ? 'muted' : m.meanAbsErrorDeg <= 2 ? 'good' : m.meanAbsErrorDeg <= 5 ? 'fair' : 'poor',
        sub: m.meanAbsErrorDeg !== null
          ? `Field of view off by this much on average (${plural(m.withLens, 'photo')} with lens data)${m.meanPhoneAbsRel !== null ? ` · ${fPct(m.meanPhoneAbsRel, 1)} from the phone's depth (${m.withPhoneDepth})` : ''}`
          : `Average field of view over ${plural(m.photos, 'photo')}. No lens data to compare with.`,
      }))),
      h('div.table-wrap', cameraTable(reports, models.map((m) => m.model)))),
    ];
  }, 'the camera report', ctx.isDisposed);
  return { el: host };
}

function cameraTable(reports: CameraReport[], models: string[]) {
  const maxErr = Math.max(8, ...reports.flatMap((r) => r.depth.map((d) => Math.abs(d.errorDeg ?? 0))));
  const pair = models.length === 2 ? models : null;
  const fovOf = (r: CameraReport, m: string) => r.depth.find((d) => d.model === m);
  return h('table.lb.camera',
    h('thead', h('tr',
      h('th.left', 'Photo'),
      h('th.left', 'Camera'),
      h('th', { title: 'Horizontal field of view from the lens in the photo\'s EXIF' }, 'Lens'),
      models.map((m) => h('th', { title: 'Horizontal field of view the depth model implies. With lens data, the bar shows how far off it is.' }, depthLabel(m))),
      pair ? h('th', { title: `${depthLabel(pair[1])} minus ${depthLabel(pair[0])}` }, 'Models differ') : null,
    )),
    h('tbody', reports.map((r) => {
      const a = pair ? fovOf(r, pair[0]) : undefined, b = pair ? fovOf(r, pair[1]) : undefined;
      const gap = a && b ? b.hfovDeg - a.hfovDeg : null;
      return h('tr',
        h('td.left', h('a', { href: worldHref(r.world, { build: true }) }, r.title)),
        h('td.left', [r.camera?.make, r.camera?.model].filter(Boolean).join(' ') || h('span.muted', 'unknown')),
        h('td', r.camera?.hfovDeg ? `${r.camera.hfovDeg.toFixed(1)}°` : DASH),
        models.map((m) => {
          const d = fovOf(r, m);
          if (!d) return h('td', DASH);
          return h('td.fov',
            h('span', `${d.hfovDeg.toFixed(1)}°`),
            isNum(d.errorDeg) ? diverge(d.errorDeg, maxErr, fSigned(d.errorDeg, 1)) : null,
            d.phone ? h('small', { title: `Depth compared with the phone's ${d.phone.type} map after the best scale${d.phone.type === 'disparity' ? ' and shift' : ''}` }, `depth off by ${fPct(d.phone.absRel, 1)} · r ${d.phone.r.toFixed(2)}`) : null,
          );
        }),
        pair ? h('td', isNum(gap) ? diverge(gap, 15, fSigned(gap, 1) + '°') : DASH) : null,
      );
    })),
  );
}

// ---------- observations ----------

const LAYER_COLOR: Record<string, string> = { world: 'var(--run)', relief: '#bfa4ee', objects: 'var(--accent)', unknown: 'var(--muted)' };
const STATUS_TONE: Record<string, string> = { open: 'status-open', confirmed: 'status-confirmed', fixed: 'status-fixed', 'false-positive': 'status-false-positive', wontfix: 'status-wontfix' };

interface FlagStats {
  total: number;
  open: number;
  /** Opened by the asset check from a turntable, not by someone walking the world. */
  fromAssetCheck: number;
  byStatus: Record<string, number>;
  byLayer: { id: string; label: string; count: number }[];
  byCategory: { id: string; count: number }[];
  byWorld: { id: string; label: string; count: number }[];
}

function layerGroup(layer: string | null): { id: string; label: string } {
  if (!layer) return { id: 'unknown', label: 'Not sure' };
  if (layer === 'world') return { id: 'world', label: 'Marble world' };
  if (layer === 'relief') return { id: 'relief', label: 'Depth relief' };
  return { id: 'objects', label: 'Objects' };
}

function flagStats(flags: ObservationListItem[]): FlagStats {
  const tally = <K extends string>(keys: K[]) => {
    const m = new Map<K, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const byStatus = Object.fromEntries(tally(flags.map((f) => f.status)));
  const layers = new Map<string, { id: string; label: string; count: number }>();
  for (const f of flags) {
    const g = layerGroup(f.suspect);
    const row = layers.get(g.id) ?? { ...g, count: 0 };
    row.count++;
    layers.set(g.id, row);
  }
  const worlds = new Map<string, { id: string; label: string; count: number }>();
  for (const f of flags) {
    const row = worlds.get(f.world) ?? { id: f.world, label: f.worldTitle || f.world, count: 0 };
    row.count++;
    worlds.set(f.world, row);
  }
  return {
    total: flags.length,
    open: byStatus.open ?? 0,
    fromAssetCheck: flags.filter((f) => f.assetCheck).length,
    byStatus,
    byLayer: [...layers.values()].sort((a, b) => b.count - a.count),
    byCategory: [...tally(flags.map((f) => f.category ?? 'uncategorised'))].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
    byWorld: [...worlds.values()].sort((a, b) => b.count - a.count),
  };
}

const flags = (ctx: MetricsContext) => ctx.data.remember('observations', async () => {
  const list = await api.observations();
  if (!Array.isArray(list)) throw new StaleServerError('The list of observations is not available from this server. If it was started before this version, restart it (npm run dev, or npm start).');
  return list;
});

function flagsView(ctx: MetricsContext): View {
  const host = h('div.tab-flags');
  loadInto(host, flags(ctx), (list) => {
    const open = h('a.button.small', { href: '#/observations' }, 'Open every observation →');
    if (!list.length) {
      return panel({ title: 'Observations', lede: 'Problems that only show when someone walks around a world: a green sheet hanging off a wheel, streaks in the sky.', actions: open },
        notice('Nothing flagged yet. Go inside a world and press O, or use Flag a problem in the top bar.'));
    }
    const s = flagStats(list);
    const label = (id: string) => OBSERVATION_CATEGORIES.find((c) => c.id === id)?.label ?? (id === 'uncategorised' ? 'No category' : id);
    return [
      h('div.kpis.compact',
        kpi({ label: 'Observations', value: String(s.total), sub: `in ${plural(s.byWorld.length, 'world')}` }),
        ...OBSERVATION_STATUSES.map((st) => kpi({
          label: st.label,
          value: String(s.byStatus[st.id] ?? 0),
          tone: st.id === 'open' && (s.byStatus.open ?? 0) > 0 ? 'fair' : st.id === 'fixed' && (s.byStatus.fixed ?? 0) > 0 ? 'good' : 'muted',
        })),
      ),
      h('div.cols-2',
        panel({ title: 'Where the problem is', lede: 'The layer the viewer found for each observation: the nearest surface along the rays through the marked spot. A flag from the asset check is in the object it checked.' },
          hbars(s.byLayer.map((l) => ({ label: l.label, value: l.count, text: String(l.count), color: LAYER_COLOR[l.id] })))),
        panel({ title: 'What kind of problem', lede: 'The category the person or agent chose.' },
          hbars(s.byCategory.map((c) => ({ label: label(c.id), value: c.count, text: String(c.count) })))),
      ),
      panel({ title: 'Latest observations', lede: 'Newest first.', actions: open },
        h('ul.flag-list', list.slice(0, 6).map((f) => flagRow(f)))),
    ];
  }, 'the observations', ctx.isDisposed);
  return { el: host };
}

function flagRow(f: ObservationListItem) {
  const status = OBSERVATION_STATUSES.find((s) => s.id === f.status)?.label ?? f.status;
  // Object ids are slugs of the object's name (red-vintage-bicycle), so spaces bring the name back.
  const layer = f.suspect ? (f.suspect === 'world' ? 'Marble world' : f.suspect === 'relief' ? 'Depth relief' : f.suspect.replace(/^object:/, '').replace(/-/g, ' ')) : 'layer unknown';
  return h('li',
    h('a.flag-thumb', { href: `#/observations/${f.world}`, title: 'Open in Observations' },
      h('img', { src: `/bench-files/observations/${f.world}/${f.id}/thumb.jpg`, alt: 'The frame that was flagged', loading: 'lazy' })),
    h('div',
      h('p.flag-note', f.note || 'Flagged without a note'),
      h('p.muted.small', h('a', { href: worldHref(f.world, { build: true }) }, f.worldTitle), ` · ${fWhen(f.createdAt)} · ${f.author} · ${layer}`),
    ),
    chip(status, STATUS_TONE[f.status]),
  );
}

const observationsTab: HostTab = {
  id: 'observations',
  label: 'Observations',
  question: 'What did people see while walking around?',
  view: flagsView,
  async headline(ctx): Promise<KpiOptions> {
    const s = flagStats(await flags(ctx));
    return {
      label: 'Open observations',
      value: String(s.open),
      tone: s.total === 0 ? 'muted' : s.open ? 'fair' : 'good',
      sub: s.total ? `of ${s.total} flagged in the viewer` : 'Nothing flagged yet',
    };
  },
  async insights(ctx): Promise<DashboardInsight[]> {
    const list = await flags(ctx);
    if (!list.length) return [];
    const s = flagStats(list);
    const top = s.byLayer.find((l) => l.id !== 'unknown');
    return [{
      tone: s.open ? 'warn' : 'good',
      tab: 'observations',
      parts: [
        { b: s.open ? `${plural(s.open, 'observation')} open` : 'No observations open' },
        ` of ${s.total} flagged${s.fromAssetCheck ? ` (${s.fromAssetCheck} by the asset check)` : ' while walking worlds'}${s.total >= 3 && top ? `. Most are in ${top.label.toLowerCase()} (${top.count})` : ''}.`,
      ],
    }];
  },
};

const cameraTab: HostTab = {
  id: 'camera',
  label: 'Camera',
  question: 'Was the photo\'s camera read correctly?',
  view: cameraView,
};

/** What the dashboard needs to know about this app. */
export const wom: MetricsUiHost = {
  lede: 'Scores each rebuilt world against the photo it came from: where its objects sit, whether anything foreign is baked into them, how well the camera was read, what people flagged while walking around, and what it all cost.',
  tabs: [cameraTab, observationsTab],
  caseLinks: (_task, c) => (c.dims.world
    ? [{ label: 'Open in the viewer', href: worldHref(c.dims.world) }, { label: 'WOMetrics · Generation facts', href: worldHref(c.dims.world, { build: true }) }]
    : []),
};

