// What the benchmarks call the things they compare: the 3D models that rebuild an object and the depth models
// that read the photo. The labels and prices go into the tasks' dimensions, which is how the dashboard
// names them; a new model needs a line here and nothing in the dashboard.
import type { DepthModel, MeshModel } from '../types.ts';
import type { DimensionSpec, ValueInfo } from '@wom/metrics';

export const ASSET_MODELS: Partial<Record<MeshModel, ValueInfo>> = {
  idol: { label: 'IDOL', priceUsd: 0.1 },
  triposplat: { label: 'TripoSplat', priceUsd: 0.05 },
  'tripo-v31': { label: 'Tripo H3.1', priceUsd: 0.3 },
  'tripo-p1': { label: 'Tripo P1', priceUsd: 0.5 },
};

export const DEPTH_MODELS: Record<DepthModel, ValueInfo> = {
  moge2: { label: 'MoGe-2' },
  moge3: { label: 'MoGe-3' },
};

/** What surrounds the objects: a Marble world, or only the relief built from the photo's depth. */
export const WORLD_MODELS: Record<string, ValueInfo> = {
  worldlabs: { label: 'Marble' },
  'worldlabs-draft': { label: 'Marble (draft)' },
  none: { label: 'Depth relief only' },
};

export const WORLD_DIMENSION: DimensionSpec = { id: 'world', label: 'World', show: 'never' };
export const WORLD_MODEL_DIMENSION: DimensionSpec = { id: 'worldModel', label: 'Surrounding world', show: 'varied', values: WORLD_MODELS };
export const OBJECT_DIMENSION: DimensionSpec = { id: 'object', label: 'Object', show: 'never' };
export const ASSET_DIMENSION: DimensionSpec = { id: 'asset', label: '3D model', show: 'always', values: ASSET_MODELS as Record<string, ValueInfo> };
export const DEPTH_DIMENSION: DimensionSpec = { id: 'depth', label: 'Depth model', show: 'varied', values: DEPTH_MODELS };
