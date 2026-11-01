// Shared types for the WOM server and web client.
// Keep this file free of runtime code other than constants so the web app can import it.

export type StepId =
  | 'prepare'
  | 'analyze'
  | 'segment'
  | 'cleanplate'
  | 'depth'
  | 'cutouts'
  | 'meshes'
  | 'world'
  | 'compose';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepState {
  id: StepId;
  label: string;
  status: StepStatus;
  message?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

export const STEP_ORDER: { id: StepId; label: string }[] = [
  { id: 'prepare', label: 'Preparing the photo' },
  { id: 'analyze', label: 'Muse Spark reads the memory' },
  { id: 'segment', label: 'SAM 3.1 outlines each object' },
  { id: 'cleanplate', label: 'Muse Image clears the scene' },
  { id: 'depth', label: 'MoGe-2 measures depth' },
  { id: 'cutouts', label: 'Isolating objects' },
  { id: 'meshes', label: 'Shaping the objects in 3D' },
  { id: 'world', label: 'Marble grows the surrounding world' },
  { id: 'compose', label: 'Composing the 3D scene' },
];

export type PlannerModel = 'muse-spark-1.3' | 'muse-wonder-1.0';
// Object generators on AI3D. triposplat returns Gaussian splats; the Tripo models return textured meshes.
// tripo-v31 and tripo-p1 run on fal; the native Tripo IDs are accepted for completeness.
export type MeshModel = 'triposplat' | 'tripo-v31' | 'tripo-p1' | 'tripo-h31-image' | 'tripo-p1-image';
export type WorldModel = 'worldlabs' | 'worldlabs-draft' | 'none';

export interface WorldOptions {
  maxObjects: number;
  plannerModel: PlannerModel;
  meshModel: MeshModel;
  worldModel: WorldModel;
  /** Ask Muse Image to complete objects that are occluded or cut off by the frame before meshing. */
  completeOccluded: boolean;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One object Muse Spark chose to reconstruct as its own mesh. Boxes and points use the 0-1000 grid. */
export interface PlannedObject {
  id: string;
  name: string;
  segmentPrompt: string;
  description: string;
  box: Box;
  point: { x: number; y: number };
  occluded: boolean;
  truncated: boolean;
  contact: 'floor' | 'surface' | 'wall' | 'hanging' | 'held' | 'free';
  importance: number;
  approxSizeM: { width: number; height: number; depth: number };
}

export interface ScenePlan {
  title: string;
  summary: string;
  style: 'photo' | 'illustration' | 'render' | 'other';
  setting: 'indoor' | 'outdoor' | 'mixed';
  objects: PlannedObject[];
  removalPrompt: string;
  worldPrompt: string;
  hasOverlayText: boolean;
}

export interface Ai3dJobRef {
  model: string;
  jobId?: string;
  idempotencyKey: string;
  status: string;
  error?: string;
  chargedUsd?: number;
  viewerUrl?: string;
}

export interface ObjectRecord {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  error?: string;
  mask?: {
    file: string;
    /** Pixel box in source-image coordinates, half-open. */
    box: Box;
    area: number;
    method: 'box' | 'concept';
  };
  cutout?: {
    file: string;
    rawFile: string;
    completed: boolean;
    publicUrl?: string;
    review?: string;
  };
  mesh?: {
    job: Ai3dJobRef;
    /** 'splat' for Gaussian-splat outputs (PLY/SPZ), 'mesh' for GLB. Missing on older worlds = mesh. */
    kind?: 'splat' | 'mesh';
    file?: string;
    previewFile?: string;
    alignImage: boolean;
  };
  placement?: ObjectPlacement;
}

export interface ObjectPlacement {
  /** three.js coordinates (camera at origin looking down -Z, +Y up). */
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
  fit: {
    iou: number;
    yawDeg: number;
    pitchDeg: number;
    depthM: number;
    heightM: number;
  };
}

export interface CostItem {
  label: string;
  usd: number;
  provider: 'meta' | 'ai3d';
  estimated: boolean;
}

export interface WorldManifest {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  status: 'queued' | 'running' | 'done' | 'partial' | 'failed';
  error?: string;
  options: WorldOptions;
  image: { file: string; thumb: string; width: number; height: number; publicUrl?: string };
  steps: Record<StepId, StepState>;
  plan?: ScenePlan;
  objects: ObjectRecord[];
  cleanPlate?: { file: string; publicUrl?: string };
  depth: {
    original?: { job: Ai3dJobRef; files?: Record<string, string> };
    clean?: { job: Ai3dJobRef; files?: Record<string, string> };
  };
  world?: {
    job: Ai3dJobRef;
    splats?: { variant: string; file: string; size: number }[];
    collider?: string;
    pano?: string;
    thumbnail?: string;
  };
  scene?: { file: string; version: number };
  costs: CostItem[];
}

/** Everything the viewer needs. All transforms are in three.js coordinates. */
export interface SceneDoc {
  version: number;
  title: string;
  image: { url: string; width: number; height: number };
  camera: {
    fovY: number;
    aspect: number;
    /** Gravity "up" in camera coordinates, used for orbiting and walking. */
    up: [number, number, number];
    /** Point the orbit controls circle around. */
    target: [number, number, number];
    source: 'marble' | 'moge';
  };
  world?: {
    splats: { variant: string; url: string; size: number }[];
    colliderUrl?: string;
    panoUrl?: string;
    scale: number;
    quaternion: [number, number, number, number];
    calibration: { hfovDeg: number; colorError: number; depthSamples: number };
  };
  relief?: { url: string };
  objects: {
    id: string;
    name: string;
    kind: 'splat' | 'mesh';
    url: string;
    /** File size, for load progress. */
    bytes?: number;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    scale: number;
    visible: boolean;
    fitIou: number;
  }[];
  lighting: { sky: string; ground: string; sun: [number, number, number] };
  diagnostics: string[];
}

export interface LayoutOverride {
  id: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
  visible: boolean;
}

export type WorldEvent =
  | { type: 'manifest'; manifest: WorldManifest }
  | { type: 'log'; message: string; at: string };
