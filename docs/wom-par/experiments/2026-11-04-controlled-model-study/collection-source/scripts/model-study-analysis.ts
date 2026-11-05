// Paired analysis for the controlled WOM placement study. Photographs, not trials, are the units.
export interface StudyRow {
  caseId: string; photo: string; model: string; trial: number; status: string;
  iou: number | null; costUsd: number; wallMs: number; modelMs: number; calls: number;
}
export const STUDY_MODELS = ['muse-spark-1.3', 'muse-wonder-1.0', 'gpt-6.1-terra', 'gpt-6.1-sol'];
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); const p = (s.length - 1) * q, i = Math.floor(p); return s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (p - i); };

/** Exhaustive photo-level bootstrap; descriptive only for this small convenience course. */
export function photoBootstrap(values: number[]): [number, number] | null {
  if (values.length < 2) return null;
  const means: number[] = [];
  const visit = (sum: number, depth: number) => {
    if (depth === values.length) { means.push(sum / depth); return; }
    for (const value of values) visit(sum + value, depth + 1);
  };
  visit(0, 0);
  return [quantile(means, .025), quantile(means, .975)];
}

/** Exact two-sided sign-flip test at the photograph level, including the observed allocation. */
export function photoPermutation(values: number[]): number | null {
  if (!values.length) return null;
  const observed = Math.abs(avg(values));
  let extreme = 0;
  for (let bits = 0; bits < 2 ** values.length; bits++) {
    const statistic = Math.abs(avg(values.map((value, i) => bits & 2 ** i ? value : -value)));
    if (statistic >= observed - 1e-12) extreme++;
  }
  return extreme / 2 ** values.length;
}

export function analyzeStudy(rows: StudyRow[], cases: { id: string; photo: string }[], trials: number, models = STUDY_MODELS) {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.caseId}/${row.model}/${row.trial}`;
    if (keys.has(key)) throw new Error(`Duplicate trial: ${key}`);
    keys.add(key);
    if (!cases.some((c) => c.id === row.caseId && c.photo === row.photo) || !models.includes(row.model) || row.trial < 1 || row.trial > trials) throw new Error('Result is outside the frozen study');
    if (row.status === 'completed' && !(typeof row.iou === 'number' && row.iou >= 0 && row.iou <= 1)) throw new Error('A completed result needs a valid score');
  }
  const photos = [...new Set(cases.map((c) => c.photo))];
  // Do not silently drop failed attempts. Missing attempts leave a photo's score unavailable.
  const score = (row: StudyRow) => row.status === 'completed' ? row.iou! : 0;
  const caseMean = (id: string, model: string) => {
    const found = rows.filter((r) => r.caseId === id && r.model === model);
    return found.length === trials ? avg(found.map(score)) : null;
  };
  const photoMean = (photo: string, model: string) => {
    const values = cases.filter((c) => c.photo === photo).map((c) => caseMean(c.id, model));
    return values.every((v) => v !== null) ? avg(values as number[]) : null;
  };
  const summaries = models.map((model) => {
    const found = rows.filter((r) => r.model === model), complete = found.filter((r) => r.status === 'completed');
    const perPhoto = photos.map((photo) => ({ photo, iou: photoMean(photo, model) }));
    const values = perPhoto.map((p) => p.iou);
    return { model, attempted: found.length, expected: cases.length * trials, completed: complete.length,
      failed: found.length - complete.length, completeCourse: values.every((v) => v !== null),
      photoWeightedIou: values.every((v) => v !== null) ? avg(values as number[]) : null,
      conditionalValidIou: complete.length ? avg(complete.map((r) => r.iou!)) : null,
      totalUsd: found.reduce((n, r) => n + r.costUsd, 0), totalCalls: found.reduce((n, r) => n + r.calls, 0),
      medianWallSeconds: found.length ? median(found.map((r) => r.wallMs / 1000)) : null,
      medianModelSeconds: found.length ? median(found.map((r) => r.modelMs / 1000)) : null, perPhoto };
  });
  const pairs = [['muse-spark-1.3', 'gpt-6.1-terra'], ['muse-wonder-1.0', 'gpt-6.1-sol']].map(([meta, openai]) => {
    const perPhoto = photos.map((photo) => {
      const a = photoMean(photo, meta), b = photoMean(photo, openai);
      return { photo, meta: a, openai: b, delta: a !== null && b !== null ? a - b : null };
    });
    const available = perPhoto.every((p) => p.delta !== null), deltas = perPhoto.map((p) => p.delta!) as number[];
    let wins = 0, ties = 0, losses = 0;
    for (const c of cases) {
      const a = caseMean(c.id, meta), b = caseMean(c.id, openai);
      if (a === null || b === null) continue;
      if (a - b > .01) wins++; else if (b - a > .01) losses++; else ties++;
    }
    return { meta, openai, complete: available, perPhoto, deltaMetaMinusOpenai: available ? avg(deltas) : null,
      descriptiveBootstrap95: available ? photoBootstrap(deltas) : null,
      photoSignFlipP: available ? photoPermutation(deltas) : null, holmP: null as number | null,
      objectWins: wins, objectTies: ties, objectLosses: losses, tieThresholdIou: .01 };
  });
  const ordered = pairs.filter((p) => p.photoSignFlipP !== null).sort((a, b) => a.photoSignFlipP! - b.photoSignFlipP!);
  let previous = 0;
  ordered.forEach((p, i) => { previous = Math.max(previous, Math.min(1, p.photoSignFlipP! * (ordered.length - i))); p.holmP = previous; });
  return { photos: photos.length, cases: cases.length, trials, rows: rows.length, expected: cases.length * trials * models.length,
    estimand: 'Equal photograph weights; within each photo, equal object weights and equal fresh-trial weights. Non-completions score zero; missing attempts stay unavailable.',
    inference: 'Small existing development course, not a held-out population sample. Bootstrap intervals are descriptive. No Global WOMPar preference score is inferred.',
    summaries, pairs };
}
