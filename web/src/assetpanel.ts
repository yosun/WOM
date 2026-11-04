// What the asset check found, and the per-object choice of 3D model it feeds: a chip per verdict, a line
// for the build page, and the viewer's "Object models" section (pick a model for one object, check the
// assets that have no verdict yet).
import { CHECK_PRICE_USD } from '../../server/src/types.ts';
import { api, type AssetCheck, type WorldManifest } from './api.ts';
import { h, fmtUsd, toast } from './dom.ts';
import { modelLabel } from './maskeditor.ts';

type ObjectRecord = WorldManifest['objects'][number];

/** The check that belongs to an object's asset for `model`, if there is one. */
export function checkOf(o: ObjectRecord, model: string): AssetCheck | undefined {
  const a = o.assets?.[model as keyof NonNullable<ObjectRecord['assets']>];
  return a?.check && a.check.file === a.file ? a.check : undefined;
}

const VERDICT_TEXT: Record<string, string> = {
  clean: 'clean',
  minor: 'minor leftovers',
  contaminated: 'background inside',
};

export function verdictChip(check: AssetCheck | undefined, title?: string) {
  const verdict = check?.verdict ?? 'unchecked';
  return h('span.chip', { class: verdict, title: title ?? check?.rationale ?? 'No asset check yet' }, check ? (VERDICT_TEXT[verdict] ?? verdict) : 'unchecked');
}

/** A line under an object on the build page when its shown asset is not clean, with a link to its flag if it has one. */
export function assetCheckLine(o: ObjectRecord, worldId: string): HTMLElement | null {
  const model = o.mesh?.job?.model;
  const check = model ? checkOf(o, model) : undefined;
  if (!check || check.verdict === 'clean') return null;
  const what = check.findings.map((f) => f.what).join('; ') || check.rationale;
  return h('div.obj-err', { title: check.rationale }, `Asset check: ${VERDICT_TEXT[check.verdict]}. ${what}`,
    check.flag ? [' · ', h('a', { href: `#/observations/${worldId}`, title: 'The asset check opened an observation for a person to inspect' }, 'Flagged for inspection')] : null);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until the world's background work (a task or the pipeline) is done, then return its manifest. */
async function untilIdle(worldId: string, isDisposed: () => boolean): Promise<WorldManifest | null> {
  for (;;) {
    await sleep(1500);
    if (isDisposed()) return null;
    const r = await api.get(worldId);
    if (!r.running) return r.manifest;
  }
}

/**
 * The viewer's "Object models" section. Each object lists the models it has an asset for, with the
 * check's verdict; choosing one shows it for that object only. `onChanged` runs once the world has been
 * composed again, so the viewer can load what changed.
 */
export function assetSection(opts: {
  worldId: string;
  manifest: WorldManifest;
  onManifest: (m: WorldManifest) => void;
  onChanged: () => Promise<void>;
  isDisposed: () => boolean;
}): HTMLElement | '' {
  const withAssets = opts.manifest.objects.filter((o) => Object.values(o.assets ?? {}).some((a) => a?.file));
  if (!withAssets.length) return '';
  const status = h('p.muted');
  const selects: HTMLSelectElement[] = [];
  const setBusy = (busy: boolean, text = '') => {
    for (const s of selects) s.disabled = busy;
    checkBtn.disabled = busy;
    status.textContent = text;
  };

  const rows = withAssets.map((o) => {
    const shown = o.mesh?.job?.model ?? '';
    const models = (Object.values(o.assets ?? {}).filter((a) => a?.file) as NonNullable<ObjectRecord['assets']>[keyof NonNullable<ObjectRecord['assets']>][]).map((a) => a!.model);
    const select = h('select', { title: 'The 3D model this object shows' }, models.map((m) => {
      const c = checkOf(o, m);
      return h('option', { value: m, selected: m === shown }, `${modelLabel(m)} · ${c ? (VERDICT_TEXT[c.verdict] ?? c.verdict) : 'unchecked'}`);
    })) as HTMLSelectElement;
    select.disabled = models.length < 2;
    selects.push(select);
    select.addEventListener('change', async () => {
      const model = select.value as WorldManifest['options']['meshModel'];
      setBusy(true, `Fitting the ${modelLabel(model)} ${o.name}…`);
      try {
        await api.useObjectAsset(opts.worldId, o.id, model);
        const m = await untilIdle(opts.worldId, opts.isDisposed);
        if (!m) return;
        opts.onManifest(m);
        await opts.onChanged();
        toast(`${o.name} now shows the ${modelLabel(model)} model.`);
      } catch (err) {
        toast((err as Error).message, 'error');
        select.value = shown;
        setBusy(false);
      }
    });
    const c = shown ? checkOf(o, shown) : undefined;
    return h('li.model-row', h('span.model-name', o.name), select, verdictChip(c));
  });

  const unchecked = withAssets.reduce((n, o) => n + Object.values(o.assets ?? {}).filter((a) => a?.file && !(a.check && a.check.file === a.file)).length, 0);
  const checkBtn = h('button', { type: 'button', title: 'Muse Spark looks at a turntable of each asset for leftovers of the photo\'s background (lawn, hedge, wall)' },
    `Check ${unchecked} asset${unchecked === 1 ? '' : 's'} · about ${fmtUsd(unchecked * CHECK_PRICE_USD)}`) as HTMLButtonElement;
  checkBtn.hidden = unchecked === 0;
  checkBtn.addEventListener('click', async () => {
    setBusy(true, 'Muse Spark is looking at each asset…');
    try {
      const r = await api.checkAssets(opts.worldId, 'all');
      if (r.started) {
        const m = await untilIdle(opts.worldId, opts.isDisposed);
        if (!m) return;
        opts.onManifest(m);
      }
      await opts.onChanged();
    } catch (err) {
      toast((err as Error).message, 'error');
      setBusy(false);
    }
  });

  return h('section', h('h2', 'Object models'),
    h('ul.model-rows', rows),
    h('div.row-buttons', checkBtn),
    status,
    h('p.muted', 'Choose a model per object. Each is generated once and kept, so switching is free. The check looks for lawn, hedge or wall from the photo that got rebuilt into an object.'),
  );
}
