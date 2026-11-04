// Shared types for the WOM server and web client.
// Keep this file free of runtime code other than constants so the web app can import it.

export type StepId =
  | 'prepare'
  | 'analyze'
  | 'segment'
  | 'split'
  | 'cleanplate'
  | 'depth'
  | 'cutouts'
  | 'meshes'
  | 'world'
  | 'compose'
  | 'placements';

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
  { id: 'split', label: 'SAM 3.1 splits people into head and body' },
  { id: 'cleanplate', label: 'Muse Image clears the scene' },
  { id: 'depth', label: 'MoGe measures depth' },
  { id: 'cutouts', label: 'Isolating objects' },
  { id: 'meshes', label: 'Shaping the objects in 3D' },
  { id: 'world', label: 'Marble grows the surrounding world' },
  { id: 'compose', label: 'Composing the 3D scene' },
  { id: 'placements', label: 'Agents check each placement' },
];

/**
 * Ways to place an object, all kept in scene.json so the viewer can switch between them:
 *   fitter        silhouette fit, distance from depth (may lean or float)
 *   grounded      the same fit kept upright and resting on the ground plane
 *   agent-spark   Muse Spark with tools (render and score, run the fitter, read depth)
 *   agent-wonder  Muse Wonder with the same tools
 */
export type PlacementMethod = 'fitter' | 'grounded' | 'agent-spark' | 'agent-wonder';

export const PLACEMENT_METHODS: { id: PlacementMethod; label: string }[] = [
  { id: 'fitter', label: 'Fitter, matched to depth' },
  { id: 'grounded', label: 'Fitter, standing on the ground' },
  { id: 'agent-spark', label: 'Muse Spark agent' },
  { id: 'agent-wonder', label: 'Muse Wonder agent' },
];

export const AGENT_PLACEMENTS: Record<PlannerModel, PlacementMethod> = {
  'muse-spark-1.3': 'agent-spark',
  'muse-wonder-1.0': 'agent-wonder',
};

export interface PlacementVariant {
  /** three.js coordinates, like the object's base transform. */
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
  /** Silhouette IoU against the object's mask (scored as in the placement benchmark). */
  iou: number;
  /** Lowest point above the local ground, metres. */
  contactGapM: number;
  tiltDeg: number;
  heightM: number;
  /** For agents: what they based the answer on, in their words. */
  note?: string;
}

export type PlannerModel = 'muse-spark-1.3' | 'muse-wonder-1.0';
// Object generators on AI3D. idol and triposplat return Gaussian splats; the Tripo models return textured meshes.
// tripo-v31 and tripo-p1 run on fal; the native Tripo IDs are accepted for completeness.
export type MeshModel = 'idol' | 'triposplat' | 'tripo-v31' | 'tripo-p1' | 'tripo-h31-image' | 'tripo-p1-image';
export type WorldModel = 'worldlabs' | 'worldlabs-draft' | 'none';
/** Metric depth / point-map models on AI3D. */
export type DepthModel = 'moge2' | 'moge3';

export interface WorldOptions {
  maxObjects: number;
  plannerModel: PlannerModel;
  meshModel: MeshModel;
  worldModel: WorldModel;
  depthModel: DepthModel;
  /** Ask Muse Image to complete objects that are occluded or cut off by the frame before meshing. */
  completeOccluded: boolean;
  /**
   * Build a person whose face is large in the photo as two objects, a head and a body, and align them to the photo's pixels
   * (a Gaussian-splat object model only). The face then fills the 3D model's whole input instead of a third of it.
   */
  splitPeople: boolean;
  /** Language models that also place every object (with tools) after compose; the viewer can switch to their answer. */
  placementAgents: PlannerModel[];
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
  /**
   * Set on a person whose face is big enough in the photo that building the head on its own pays off. The split step then
   * replaces this object with a head and a body (see `part`). `headBox` is the head with its hair, on the 0-1000 grid.
   */
  splitHeadBody?: { headBox: Box };
  /** Set on the two objects the split step makes from a person: which half this is and which person it came from. */
  part?: { of: string; role: 'head' | 'body' };
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
    /** 'manual': redone by the user with points and a box (see `maskVersion`). */
    method: 'box' | 'concept' | 'manual';
  };
  /**
   * 1 (or missing) for the first mask; raised each time the mask is redone. Version n > 1 keeps its
   * mask, cutout and 3D assets in objects/<id>/m<n>/, so earlier versions are never overwritten.
   */
  maskVersion?: number;
  /** Earlier masks with their cutouts and every asset made from them, newest last (restorable for free). */
  history?: ObjectVersion[];
  cutout?: {
    file: string;
    rawFile: string;
    completed: boolean;
    publicUrl?: string;
    review?: string;
  };
  /** The active 3D asset (one of `assets`), used by compose and the viewer. */
  mesh?: {
    job: Ai3dJobRef;
    /** 'splat' for Gaussian-splat outputs (PLY/SPZ), 'mesh' for GLB. Missing on older worlds = mesh. */
    kind?: 'splat' | 'mesh';
    file?: string;
    previewFile?: string;
    alignImage: boolean;
  };
  /** Every 3D asset ever generated for this object, one per model. Switching models reuses these. */
  assets?: Partial<Record<MeshModel, ObjectAsset>>;
  /**
   * The asset after alignment to the photo's pixels (see pipeline/align.ts), made from `mesh.file` for the current mask. It sits next
   * to the registered asset, which is never changed. Compose shows this one while `key` still describes the inputs.
   */
  aligned?: AlignedAsset;
  /**
   * The model this object shows when it differs from the world's (`options.meshModel`), chosen per object,
   * e.g. because another model's asset holds no leftovers of the photo's background. Retries and rebuilds
   * of other objects keep it; redoing this object's mask clears it.
   */
  pinnedModel?: MeshModel;
  placement?: ObjectPlacement;
}

/** What alignment did to one part of a split person, and the inputs it was made from. */
export interface AlignedAsset {
  file: string;
  /** Hash of everything the result depends on: the asset, both masks, the photo, the camera and the settings. */
  key: string;
  /** The pose the part is shown at (three.js frame), which alignment leaves as the silhouette fitter chose it. */
  pose: { position: [number, number, number]; quaternion: [number, number, number, number]; scale: number };
  stats: {
    /** Gaussians moved sideways by the warp in its first pass, and by how much (mean, in photo pixels). */
    warpedGaussians: number;
    meanShiftPx: number;
    /** Patches added to close the seam, on the body only. */
    seamPatches: number;
    /** Gaussians added by the detail corrector, on the head only, and the regions it worked on. */
    correctorGaussians: number;
    regions: string[];
    /** What alignment left out because it failed (the rest still applied). Empty or missing when everything ran. */
    notes?: string[];
    seconds: number;
  };
  createdAt: string;
}

/** A replaced mask of an object, kept with everything generated from it. */
export interface ObjectVersion {
  maskVersion: number;
  mask?: ObjectRecord['mask'];
  cutout?: ObjectRecord['cutout'];
  mesh?: ObjectRecord['mesh'];
  assets?: ObjectRecord['assets'];
  aligned?: ObjectRecord['aligned'];
  replacedAt: string;
}

/** One generated 3D asset. Kept for good so each model is paid for at most once per object. */
export interface ObjectAsset {
  model: MeshModel;
  kind: 'splat' | 'mesh';
  /** Set once the output has been downloaded. */
  file?: string;
  previewFile?: string;
  alignImage: boolean;
  job: Ai3dJobRef;
  /** SHA-256 of the cutout PNG the asset was generated from. */
  cutoutSha256?: string;
  createdAt: string;
  /** 'legacy' = recovered from files written before assets were tracked per model. */
  source: 'pipeline' | 'legacy';
  /** Whether the asset holds anything that is not the object (see bench/assetcheck.ts). */
  check?: AssetCheck;
}

/** One generated surrounding world, kept per world model like object assets. */
export interface WorldAsset {
  model: Exclude<WorldModel, 'none'>;
  job: Ai3dJobRef;
  splats?: { variant: string; file: string; size: number }[];
  collider?: string;
  pano?: string;
  thumbnail?: string;
  createdAt: string;
  source: 'pipeline' | 'legacy';
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

export interface DepthEntry {
  job: Ai3dJobRef;
  /** points / depth / normal / mask → relative file paths. */
  files?: Record<string, string>;
  /** Horizontal field of view the point map implies (degrees). */
  hfovDeg?: number;
}

/** The camera that took the photo, from EXIF (or a Live Photo video's metadata). */
export interface CameraInfo {
  make?: string;
  model?: string;
  lens?: string;
  focalLengthMm?: number;
  focalLength35mm?: number;
  fNumber?: number;
  /** Field of view of the upright photo, from the 35 mm-equivalent focal length (matched on the diagonal). */
  hfovDeg?: number;
  vfovDeg?: number;
  takenAt?: string;
  source: 'exif' | 'video';
}

/** Depth, disparity or a matte the camera stored with the photo (Apple Portrait mode, LiDAR). */
export interface PhotoAuxRecord {
  type: string;
  width: number;
  height: number;
  /** Float32 little-endian for depth (metres) and disparity (1/metre), PNG for mattes; upright. */
  file?: string;
  preview?: string;
  /** 'absolute' (LiDAR / TrueDepth) or 'relative' (dual-camera disparity). */
  accuracy?: string;
  quality?: string;
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
  image: {
    file: string;
    thumb: string;
    width: number;
    height: number;
    publicUrl?: string;
    /** The upload as it came, when it was HEIC/HEIF or a video. */
    original?: { file: string; kind: string; name: string };
    /** Every frame the upload held (a HEIC can hold several, a video gives several); `frame` is the one used. */
    frames?: { file: string; thumb: string; width: number; height: number; timeS?: number }[];
    frame?: number;
    /** Depth, disparity and mattes stored with the photo. */
    aux?: PhotoAuxRecord[];
    camera?: CameraInfo;
  };
  steps: Record<StepId, StepState>;
  plan?: ScenePlan;
  objects: ObjectRecord[];
  cleanPlate?: { file: string; publicUrl?: string };
  /** The active depth maps (one of `depthAssets`), used by compose. */
  depth: {
    original?: DepthEntry;
    clean?: DepthEntry;
  };
  /** Every depth model's maps for this photo and its clean plate, kept so switching is free. */
  depthAssets?: Partial<Record<DepthModel, { original?: DepthEntry; clean?: DepthEntry }>>;
  /** The active surrounding world (one of `worldAssets`). */
  world?: {
    job: Ai3dJobRef;
    splats?: { variant: string; file: string; size: number }[];
    collider?: string;
    pano?: string;
    thumbnail?: string;
  };
  /** Every surrounding world generated for this photo, one per world model. */
  worldAssets?: Partial<Record<Exclude<WorldModel, 'none'>, WorldAsset>>;
  /** Which placement the scene uses by default (chosen in the viewer). */
  placementMethod?: PlacementMethod;
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
    /** Height of the camera above the ground plane fitted to the depth (metres), when ground is visible. */
    heightM?: number;
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
    /** Every placement computed for this object; the base transform above is the active one. */
    placements?: Partial<Record<PlacementMethod, PlacementVariant>>;
    /** Convex hull in the object's own coordinates, for walking collisions (positions xyz, triangle indices). */
    collider?: { positions: number[]; indices: number[] };
  }[];
  /** Which placement is active and how each method scored across the objects. */
  placement?: {
    active: PlacementMethod;
    methods: { id: PlacementMethod; label: string; objects: number; meanIou: number }[];
  };
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

// ---------- asset checks ----------

/**
 * clean: nothing but the object. minor: small leftovers that are easy to miss. contaminated: large or striking
 * leftovers, such as the lawn and hedge seen through a bicycle's wheels rebuilt as flat green sheets.
 */
export type AssetVerdict = 'clean' | 'minor' | 'contaminated';

/** What one asset check costs (one image and a short structured answer; measured at about $0.009), for estimates. */
export const CHECK_PRICE_USD = 0.02;

export interface AssetFinding {
  /** What the leftover is, in the checker's words. */
  what: string;
  /** Yaws (degrees) of the turntable views where it can be seen. */
  yaws: number[];
  severity: 'minor' | 'major';
}

/** A vision model's verdict on one 3D asset, made from a turntable of it. */
export interface AssetCheck {
  verdict: AssetVerdict;
  /** Rough share of the asset's visible area that is not the object, 0 to 1. */
  foreignShare: number;
  findings: AssetFinding[];
  rationale: string;
  model: string;
  at: string;
  /** The file this verdict is about. Assets never change in place: another file or size means a new check. */
  file: string;
  bytes: number;
  /** The turntable the checker saw, relative to the world folder. */
  sheet?: string;
  /** The observation opened for a person to inspect, when this is the asset the object shows and it is contaminated. */
  flag?: string;
}

// ---------- observations: things people or agents flag while walking a world ----------

export type ObservationStatus = 'open' | 'confirmed' | 'false-positive' | 'fixed' | 'wontfix';

export const OBSERVATION_STATUSES: { id: ObservationStatus; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'false-positive', label: 'False alarm' },
  { id: 'fixed', label: 'Fixed' },
  { id: 'wontfix', label: 'Won\'t fix' },
];

export type ObservationCategory = 'floating-bits' | 'background-in-object' | 'smeared' | 'hole' | 'placement' | 'other';

export const OBSERVATION_CATEGORIES: { id: ObservationCategory; label: string }[] = [
  { id: 'floating-bits', label: 'Floating bits' },
  { id: 'background-in-object', label: 'Background inside an object' },
  { id: 'smeared', label: 'Smeared or stretched' },
  { id: 'hole', label: 'Hole or gap' },
  { id: 'placement', label: 'Wrong place, size or facing' },
  { id: 'other', label: 'Something else' },
];

/** What was marked, in pixels of the saved frame: one point, or a box (x0, y0, x1, y1). */
export type ObservationMark = { kind: 'point'; px: [number, number] } | { kind: 'box'; px: [number, number, number, number] };

/**
 * One ray from the camera through a pixel of the frame, with every layer it hit and how far away. Layer ids:
 * `world` (the Marble splats), `relief` (the depth relief), `object:<id>`.
 */
export interface ObservationRay {
  px: [number, number];
  hits: { layer: string; distance: number; point: [number, number, number] }[];
}

export interface ObservationObjectState {
  id: string;
  visible: boolean;
  /** The asset file the viewer had loaded. The model and mask version are read from its path. */
  url: string;
  asset?: string;
  maskVersion?: number;
  transform: { position: [number, number, number]; quaternion: [number, number, number, number]; scale: number };
}

/** Facts about the splats of one layer that project into the marked region, near the depth the rays hit. */
export interface ObservationSplats {
  layer: string;
  count: number;
  meanOpacity: number;
  /** Mean of the longest over the shortest axis. Large values mean flat sheets or needles. */
  meanAnisotropy: number;
  /** Share of those splats with anisotropy above 8. */
  thinShare: number;
  /** Axis-aligned bounds in scene coordinates, for a region edit that hides them. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** The check behind a flag the asset check opened. Such a flag has no camera: its frame is the turntable. */
export interface ObservationAssetCheck {
  object: string;
  model: MeshModel;
  /** The asset file and size the verdict is about. An asset gets at most one such flag. */
  file: string;
  bytes: number;
  verdict: AssetVerdict;
  foreignShare: number;
  findings: AssetFinding[];
  rationale: string;
  /** The model that judged it. */
  checker: string;
}

export interface ObservationRecord {
  id: string;
  world: string;
  createdAt: string;
  /** 'human', or 'agent:<name>'. */
  author: string;
  status: ObservationStatus;
  category?: ObservationCategory;
  note?: string;
  /** Exactly what rendered the frame. Absent on flags opened by the asset check (see `assetCheck`). */
  camera?: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    fovY: number;
    aspect: number;
    near: number;
    far: number;
    up: [number, number, number];
  };
  /** The canvas in CSS pixels, its pixel ratio, and the size of the saved frame. */
  viewport?: { width: number; height: number; pixelRatio: number };
  frame: { width: number; height: number };
  scene?: {
    version: number;
    worldVariant?: string;
    layers: { world: boolean; relief: boolean; objects: boolean };
    objects: ObservationObjectState[];
    placementMethod?: PlacementMethod;
  };
  mark: ObservationMark;
  rays: ObservationRay[];
  /** Share of the rays whose nearest hit is each layer, largest first. */
  votes: { layer: string; share: number }[];
  /** The layer the problem is in: the nearest hit of most rays; else the layer whose removal changes the mark most. */
  suspect: string | null;
  suspectSource: 'ray' | 'ablation' | 'author' | 'human' | null;
  /** Frames with one layer hidden, and how much of the marked region each one changes. */
  ablation: { layer: string; file: string; changedShare: number }[];
  splats?: ObservationSplats;
  /**
   * `frame` is a JPEG (a PNG in flags saved before frames were compressed); `thumb` and `tiny` are small JPEGs of it
   * for lists; `after` is the same view once the problem was fixed (640 px wide, and named afresh each time it is replaced).
   */
  files: { frame: string; all?: string; thumb?: string; tiny?: string; after?: string };
  /** Set when the asset check opened this flag rather than someone in the viewer. */
  assetCheck?: ObservationAssetCheck;
  /** Fixes applied for the problem this flag belongs to, oldest first. Every flag of the problem carries them. */
  fixes?: AppliedFix[];
}

/** A flag without its rays (the bulk of a record), for lists. */
export type ObservationSummary = Omit<ObservationRecord, 'rays'> & { rayCount: number };

/**
 * Flags of one world that mark the same place on the same layer of the same asset, shown as one problem. A
 * person flags what they see, so one problem arrives many times, from different spots.
 */
export interface ObservationIssue {
  /** The id of the oldest flag in it. */
  id: string;
  world: string;
  worldTitle: string;
  suspect: string | null;
  /** The status of the newest sighting, so a flag made after a fix reopens the problem. */
  status: ObservationStatus;
  /** True when it is open again after earlier sightings were marked fixed. */
  reopened: boolean;
  /** How many flags it is made of, and their ids (all of them, for changing the status of the problem). */
  count: number;
  ids: string[];
  firstSeen: string;
  lastSeen: string;
  /** The sighting whose evidence is clearest (most rays on the suspect layer), the newest among equals. */
  best: ObservationSummary;
  /** The newest sightings, newest first (at most 12). */
  sightings: ObservationSummary[];
  /** Where on the layer it is: scene metres, or metres in the object's own frame for an object. Null when no ray reached it. */
  location: [number, number, number] | null;
  /** The newest fix applied for it. The status stays as it is until a person has looked at the view again. */
  fix?: AppliedFix;
}

export interface ObservationIssuePage {
  /** Problems that match the filter, and the page of them that was asked for. */
  total: number;
  issues: ObservationIssue[];
  /** Every problem whatever its status, the flags they are made of, and how many problems have each status. */
  all: number;
  flags: number;
  byStatus: Partial<Record<ObservationStatus, number>>;
  /** Worlds that have flags. */
  worlds: { id: string; title: string; flags: number }[];
}

/** What saving a flag answers with: the record, and the problem it belongs to now. */
export type ObservationCreated = ObservationRecord & { issue?: { id: string; count: number; status: ObservationStatus; reopened: boolean } };

// ---------- fixes: what can be done about a problem ----------

/**
 * `use-asset` changes what the world shows. `check-assets` and `generate-asset` get evidence or a new candidate
 * and change nothing visible. `edit-mask` is done by hand on the build page.
 */
export type FixKind = 'use-asset' | 'check-assets' | 'generate-asset' | 'edit-mask';

export interface FixSuggestion {
  /** 'use:<model>', 'check', 'generate:<model>' or 'mask': what `POST …/fix` takes. */
  id: string;
  kind: FixKind;
  title: string;
  /** The evidence for it, in a sentence. */
  because: string;
  /** The most applying it can charge, in USD (0 when it is free). Sent back as `approveUsd` to apply a paid one. */
  costUsd: number;
  object?: string;
  model?: MeshModel;
  /** For `check-assets`: the models it checks, which is what its price is for. */
  models?: MeshModel[];
  /** For `use-asset`: what the asset check says about that model's asset. */
  evidence?: AssetVerdict | 'unchecked';
  /** Where to do it by hand, for a fix the server does not run. */
  href?: string;
}

export interface FixSuggestions {
  /** The object the problem is in: the model the flag was made on, and the one the world shows now. */
  object?: { id: string; name: string; flagged: MeshModel | null; shows: MeshModel | null };
  /** Best first. */
  fixes: FixSuggestion[];
  /** What the person should know besides: why nothing is offered, which models are ruled out. */
  notes: string[];
}

/** A fix that changed what a world shows. */
export interface AppliedFix {
  kind: 'use-asset';
  at: string;
  /** 'human', or 'agent:<name>'. */
  by: string;
  object: string;
  from: MeshModel | null;
  to: MeshModel;
  /** One sentence for the card. */
  title: string;
}

// ---------- slides: the ways into a world ----------

/**
 * Where the camera stands when a slide opens its world, and what it sees. A slide's image is exactly this
 * camera's view, so the world can come up behind the image without anything moving, the way it does behind
 * the photo. Scene coordinates of the viewer (three.js; the photo camera at the origin looking down -Z).
 */
export interface SlideEntry {
  position: [number, number, number];
  /** x, y, z, w. */
  quaternion: [number, number, number, number];
  /** Vertical field of view of the image, in degrees. */
  fovY: number;
  /** Width / height of the image. */
  aspect: number;
  /** Distance from the camera to what the centre of the image shows (scene units); the portal camera circles that point. */
  focus?: number;
}

/** A slide made from inside a world, stored in the world's slides.json. The photo slide is not stored: every built world has it. */
export interface SlideRecord {
  id: string;
  title: string;
  /** Optional words the person attached to this bookmarked view. */
  caption?: string;
  createdAt: string;
  /** Relative to the world folder. */
  image: { file: string; thumb: string; width: number; height: number };
  entry: SlideEntry;
  /** The Marble world's calibration when the slide was made. If compose changes it, the entry moves with the world. */
  frame?: { worldScale: number; worldQuaternion: [number, number, number, number] };
}

/** A slide as the web app gets it. */
export interface SlideDoc {
  /** 'photo' for the world's own photo, else the id of a slide made inside the world. */
  id: string;
  world: string;
  worldTitle: string;
  kind: 'photo' | 'view';
  title: string;
  /** Optional words the person attached to this bookmarked view. */
  caption?: string;
  /** When the memory was made: the photo's capture time when its file says, else when the world was made. */
  takenAt: string;
  createdAt: string;
  image: { url: string; thumb: string; width: number; height: number };
  entry: SlideEntry;
}
