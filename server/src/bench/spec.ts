// What the placement benchmark measures, as data: the metrics, the families of methods, and how each method
// is named. The dashboard reads this from every stored run, so a method added here appears in the tables
// with its colour and description and nothing else changes.
import type { FamilySpec, Finding, MethodSpec, MetricSpec, TaskSpec } from '@wom/metrics';
import { ASSET_DIMENSION, DEPTH_DIMENSION, OBJECT_DIMENSION, WORLD_DIMENSION } from './catalog.ts';

export const BASELINE_ID = 'fitter-grounded';

export const METRICS: MetricSpec[] = [
  {
    id: 'iou', label: 'IoU', better: 'higher', digits: 2, range: [0, 1], thresholds: { good: 0.75, fair: 0.5 },
    description: 'Overlap between the placed object\'s silhouette and the SAM mask, 0 to 1. Parts hidden behind something closer, or outside the photo, are not held against it.',
  },
  {
    id: 'gapCm', label: 'Gap', better: 'lower', unit: 'cm', digits: 1, aggregate: 'meanAbs', range: [0, 20],
    description: 'How far the object\'s lowest point is from the ground, floating (plus) or sunk (minus). The table averages the size of the gap.',
  },
  { id: 'tiltDeg', label: 'Tilt', better: 'lower', unit: '°', digits: 1, range: [0, 20], description: 'How far the object\'s up axis leans from gravity.' },
  {
    id: 'colorErr', label: 'Colour', better: 'lower', digits: 3, range: [0, 0.5], advanced: true,
    description: 'Mean colour difference from the photo where the object covers it, 0 to 1. A wrong facing raises it.',
  },
  {
    id: 'depthErr', label: 'Depth', better: 'lower', digits: 3, range: [0, 1], advanced: true,
    description: 'Disagreement with the depth map at the object: median |ln(rendered depth ÷ MoGe depth)|.',
  },
  {
    id: 'yawVsFitter', label: 'Yaw Δ', better: 'lower', unit: '°', digits: 0, aggregate: 'medianAbs', range: [0, 180], advanced: true,
    description: 'Median difference between the facing and the grounded fitter\'s. It says how much a method disagrees with the free baseline, not who is right.',
  },
];

export const FAMILIES: FamilySpec[] = [
  { id: 'geometry', label: 'Geometry only', color: '#8ab8f0', description: 'No model: the fitter searches for the pose that matches the mask.' },
  { id: 'model', label: 'Model answer', color: '#bfa4ee', description: 'One structured answer from a Muse model, used as given.' },
  { id: 'refined', label: 'Model + geometry', color: '#6fd0c0', description: 'The model\'s answer, finished by the fitter.' },
  { id: 'agent', label: 'Agent with tools', color: '#eaa1c0', description: 'The model renders and scores placements, calls the fitter, then submits one.' },
];

export type PlacementKind = 'fitter' | 'fitter-grounded' | 'direct' | 'direct+defer' | 'direct→fit' | 'agent';
export type Protocol = 'direct' | 'agent';

const KINDS: Record<PlacementKind, { label: string; family: string; order: number; description: string }> = {
  fitter: {
    label: 'Fitter', family: 'geometry', order: 0,
    description: 'The compose fitter: matches the silhouette to the SAM mask and takes the distance from MoGe depth. It can lean a little.',
  },
  'fitter-grounded': {
    label: 'Grounded fitter', family: 'geometry', order: 1,
    description: 'The fitter kept upright along gravity, then scaled about the camera so the object\'s base rests on the ground. The silhouette does not change. This is the free baseline.',
  },
  direct: {
    label: 'Direct answer', family: 'model', order: 2,
    description: 'One structured answer from the model: base point, height, yaw and tilt. The base point is put on the ground.',
  },
  'direct+defer': {
    label: 'Direct + fitter', family: 'refined', order: 3,
    description: 'The model\'s answer, except for what it deferred (position, scale, yaw), which the fitter decides.',
  },
  'direct→fit': {
    label: 'Direct → fit', family: 'refined', order: 4,
    description: 'The grounded fitter, searching only ±30° around the model\'s yaw.',
  },
  agent: {
    label: 'Agent', family: 'agent', order: 5,
    description: 'The model with tools: it renders and scores placements, runs the grounded fitter and reads MoGe depth, then submits one.',
  },
};

/** `spark` from `muse-spark-1.3`, for the short name beside a method. */
export function shortModel(model: string): string {
  const name = model.replace(/^muse-/, '').split('-')[0];
  return name ? name[0].toUpperCase() + name.slice(1) : model;
}

/** `direct:muse-spark-1.3`; the geometric methods have no model and keep their plain name. */
export const methodId = (kind: PlacementKind, model?: string) => (model ? `${kind}:${model}` : kind);

/** Which kind and model a method id names. */
export function parseMethodId(id: string): { kind: PlacementKind; model?: string } | null {
  const i = id.indexOf(':');
  const kind = (i < 0 ? id : id.slice(0, i)) as PlacementKind;
  return kind in KINDS ? { kind, model: i < 0 ? undefined : id.slice(i + 1) } : null;
}

export function methodSpec(kind: PlacementKind, model?: string): MethodSpec {
  const k = KINDS[kind];
  return {
    id: methodId(kind, model),
    label: k.label,
    family: k.family,
    description: k.description,
    order: k.order,
    ...(kind === BASELINE_ID ? { baseline: true } : {}),
    ...(model ? { subject: model, subjectLabel: shortModel(model) } : {}),
    ...(kind === 'direct+defer' || kind === 'direct→fit' ? { via: methodId('direct', model) } : {}),
  };
}

// ---------- the asset check ----------

export const CHECK_FAMILY: FamilySpec = {
  id: 'checker',
  label: 'Vision model',
  color: '#bfa4ee',
  description: 'A vision model looks at the asset\'s turntable and lists what is not the object.',
};

/** The asset check by one vision model. */
export const checkMethodId = (model: string) => `check:${model}`;

export function checkMethod(model: string): MethodSpec {
  return {
    id: checkMethodId(model),
    label: 'Asset check',
    family: CHECK_FAMILY.id,
    subject: model,
    subjectLabel: shortModel(model),
    description: 'Renders the asset through eight yaws and asks the model which parts are not the object. The verdict is decided in code from its findings.',
  };
}

export const ASSET_CHECK_SPEC: TaskSpec = {
  id: 'assets',
  label: 'Assets',
  description: 'Objects are cut out of the photo with a mask and rebuilt from the cutout. Whatever the photo showed through gaps in the mask (lawn between a bicycle\'s spokes, a hedge behind bench slats) is rebuilt too, as flat sheets or lumps hanging off the object. The placement benchmark cannot see that, and can reward it.',
  kind: 'verdicts',
  metrics: [
    {
      id: 'foreignShare', label: 'Foreign area', better: 'lower', format: 'percent', digits: 0, range: [0, 0.3],
      description: 'Share of the asset\'s visible area, averaged over the views, that the checker said is not the object.',
    },
  ],
  primary: 'foreignShare',
  families: [CHECK_FAMILY],
  dimensions: [WORLD_DIMENSION, OBJECT_DIMENSION, ASSET_DIMENSION],
  // Most severe first: the dashboard reads the first as "bad" and the last as "clean".
  labels: [
    { id: 'contaminated', label: 'background inside', tone: 'poor', description: 'Any major finding, or more than 12% of the visible area is not the object.' },
    { id: 'minor', label: 'minor leftovers', tone: 'fair', description: 'Any finding, or more than 3% of the visible area is not the object.' },
    { id: 'clean', label: 'clean', tone: 'good', description: 'Nothing but the object.' },
  ],
  artifacts: [{ id: 'sheet', label: 'The eight views the checker saw.' }],
  revision: { label: 'mask', hint: 'The mask was redone; this is the newer one' },
  howToRun: 'Run npm run bench:assets, or use Check assets in a world\'s viewer.',
  groupLabel: 'world',
  question: 'Is anything from the photo baked into an object?',
};

/** What the checker found, as the dashboard lists findings under a case: where it saw each one is the yaws. */
export function asFindings(findings: { what: string; severity?: string; yaws?: number[] }[]): Finding[] {
  return findings.map((f) => ({ what: f.what, ...(f.severity ? { severity: f.severity } : {}), ...(f.yaws?.length ? { where: `yaw ${f.yaws.join(', ')}°` } : {}) }));
}

// ---------- placement ----------

export const PLACEMENT_SPEC: TaskSpec = {
  id: 'placement',
  label: 'Placement',
  description: 'Every method puts a 3D object back where it is in the photo. The score is taken from the photo\'s own camera, so a good placement lines the object up with the object in the photo.',
  kind: 'metrics',
  metrics: METRICS,
  primary: 'iou',
  families: FAMILIES,
  dimensions: [WORLD_DIMENSION, OBJECT_DIMENSION, ASSET_DIMENSION, DEPTH_DIMENSION],
  splitBy: 'depth',
  artifacts: [
    { id: 'overlay', label: 'Each method\'s placement over the photo, with its IoU.' },
    { id: 'turntable', label: 'The 3D model turned through eight yaws, seen from the photo camera\'s angle.' },
  ],
  tie: 0.01,
  gain: 0.02,
  smallSample: 5,
  revision: { label: 'mask', hint: 'The mask was redone; this is the newer one' },
  caveat: 'IoU is only as good as the mask: if SAM outlined the wrong thing, a correct placement scores low, and an asset that copies the mask\'s mistakes scores high. The asset check catches the second case.',
  hardCasesHint: 'When every method struggles, the mask or the asset is usually off, not the placement.',
  howToRun: 'Run npm run bench:placement to create one.',
  groupLabel: 'world',
  question: 'Where does each object sit?',
};
