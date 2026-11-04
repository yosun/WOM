// Standardized visual patrol benchmark.
//
// Every judge receives the same original photo, the same deterministic set of camera poses, the same
// prompt and the same JSON schema. The current judges are Muse Spark, Gemini 3.8 Flash and GPT-6.1 Terra.
// A finding can also be sent through the viewer's observe-to-fix API, so a person can confirm or reject it
// in the existing Observations page.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import {
  BudgetExceeded, defineSubject, defineTask, errorMessage, mapLimit, slug,
  type Answer, type Case, type CaseSelection, type CaseView, type Finding, type FinishOutcome, type HeatTable, type MethodSpec, type Outcome, type RunView, type ScoredAnswer, type Subject,
} from '@wom/metrics';
import { chatCompletion, toDataUrl, type ChatContent, type ChatMessage } from '../clients/meta.ts';
import { geminiChatJson, geminiConfigured } from '../clients/gemini.ts';
import { openAiChatJson, openAiConfigured } from '../clients/openai.ts';
import { keysConfigured, ROOT, WORLDS_DIR } from '../config.ts';
import type { DepthModel, MeshModel, ObservationCategory, SceneDoc, WorldManifest } from '../types.ts';
import { ASSET_DIMENSION, ASSET_MODELS, DEPTH_DIMENSION, DEPTH_MODELS, WORLD_DIMENSION, WORLD_MODEL_DIMENSION, WORLD_MODELS } from './catalog.ts';
import { contactSheet } from './render.ts';

export type PatrolModel = 'muse-spark-1.3' | 'gemini-3.8-flash' | 'gpt-6.1-terra';
export const PATROL_MODELS: PatrolModel[] = ['muse-spark-1.3', 'gemini-3.8-flash', 'gpt-6.1-terra'];
// The benchmark's definition: the path's rules, the prompt, the schema and the scoring. Scores from different versions are
// not comparable, so it is recorded with every run.
const PATROL_VERSION = 'patrol-v3';
// What a judge is shown and asked for a given pose. It is part of every cached answer's key, so bump it only when that
// changes (the prompt, the schema, how a frame is drawn): a change to which poses the path picks needs no bump, because
// the pose itself is in the key.
const REQUEST_VERSION = 'patrol-v2'; // the value cached answers were keyed with; renaming the constant must not change it
const PATROL_MAX_TOKENS = 4000;
const VIEWS_AT_ONCE = 4;
/** How long Spark needs after the camera moves before the splats are drawn in the right order again. */
const SETTLE_MS = 900;
/** A frame whose brightness barely varies (a flat colour: the camera is in a wall) shows nothing to judge, and would score as perfect. */
const MIN_SPREAD = 6;
// Seven views of the world, then two of each object: room for six objects.
const DEFAULT_MAX_VIEWS = 20;
/** How much of a minor defect's box counts against a view, next to a major defect's whole box. */
const MINOR_WEIGHT = 0.5;

export interface ViewPose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export interface PatrolFinding {
  kind: ObservationCategory;
  severity: 'minor' | 'major';
  confidence: number;
  box: [number, number, number, number];
  description: string;
}

export interface PatrolView {
  id: string;
  pose: ViewPose;
  findings: PatrolFinding[];
  rationale: string;
  error?: string;
  flags?: { finding: number; id?: string; error?: string }[];
}

interface CapturedFrame {
  id: string;
  pose: ViewPose;
  image: Buffer;
  width: number;
  height: number;
}

export interface PatrolAnswer {
  model: PatrolModel;
  frames: CapturedFrame[];
  views: PatrolView[];
  /** Views the path left out, and why. */
  leftOut: string[];
}

/**
 * How a world was made, read from what it contains rather than from what was asked for: the model each
 * object's file comes from, whether it has a surrounding (Marble) world, and the depth model that read the photo.
 * These become the case's dimensions, so worlds from different approaches can be grouped and compared.
 */
export interface Approach {
  /** The 3D model(s) of the world's objects, e.g. 'idol', or 'idol+tripo-v31' when objects differ. */
  asset: string;
  /** 'worldlabs', 'worldlabs-draft' or 'none' (the depth relief alone). */
  worldModel: string;
  depth: string;
}

export interface PatrolWorld {
  id: string;
  title: string;
  approach: Approach;
  photo: Buffer;
  /** Stable hash of the scene and of any saved layout; a changed world gets new answers instead of cached ones. */
  sceneHash: string;
  /** Distance from the photo camera to what the photo is about, and the camera's height above the ground, in metres. */
  focusDist: number;
  /** The photo camera's height above the ground when the world recorded it; otherwise the walker's measurement is used. */
  camHeight?: number;
  /** What the photo is about, in scene coordinates (the photo camera is the origin). */
  target: [number, number, number];
  /** The source image's file, kept for diagnostics and cache provenance. */
  photoFile: string;
}

export interface PatrolOptions {
  maxViews?: number;
  recordObservations?: boolean;
  recordCached?: boolean;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  baseUrl?: string;
}

const PATROL_FAMILY = { id: 'patrol', label: 'VLM patrol judge', color: '#d8a4ee', description: 'A frontier vision model inspects the same deterministic camera path.' };

export const PATROL_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['floating-bits', 'background-in-object', 'smeared', 'hole', 'placement', 'other'] },
          severity: { type: 'string', enum: ['minor', 'major'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          box: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number', minimum: 0, maximum: 1 } },
          description: { type: 'string' },
        },
        required: ['kind', 'severity', 'confidence', 'box', 'description'],
        additionalProperties: false,
      },
    },
    rationale: { type: 'string' },
  },
  required: ['findings', 'rationale'],
  additionalProperties: false,
} as const;

const PATROL_SYSTEM = `You are a strict visual quality inspector for World of a Memory (WOM). WOM reconstructs a walkable 3D world from one observed photograph.

Inspect the current rendered view for visible reconstruction failures, not for ordinary perspective change. Report only localized defects that a person could point to in the current frame:
- floating bits, sheets or detached geometry;
- background baked into an object, such as grass, hedge, wall or sky filling a gap;
- smeared, stretched or melted geometry;
- holes or implausible gaps;
- an object visibly in the wrong place, size or facing when the reference photo supports that judgment.

Do not report low detail, harmless splat noise, a normal unseen backside, lighting differences, or a difference that is only caused by looking from a new viewpoint. Something that is also in the reference photograph itself, such as an object cut off by the photo's edge or the photo's own blur, is not a reconstruction defect. A novel-view frame has no photographic ground truth, so be conservative unless the artifact is directly visible. If there is no defensible defect, return an empty findings array.

Use a normalized image box [x0, y0, x1, y1], where (0,0) is the top-left and (1,1) is the bottom-right. Keep the box tight around the visible defect. Severity is major when the defect is large or striking at normal viewing size, and minor when it is small or easy to miss. Confidence is your confidence that the reported visible defect is real. Return JSON matching the supplied schema.`;

const PATROL_PROMPT = (viewId: string) => `Reference image: the original observation that this world was reconstructed from.
Current image: the world rendered from the standardized patrol viewpoint "${viewId}".

Compare the current image with the reference where comparison is meaningful, then inspect the whole current image for view-dependent reconstruction artifacts. Do not infer a defect from the fact that the view is different from the reference. List each separate visible problem with its category, severity, confidence, tight normalized box and a short description. Return no findings when the view is clean.`;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round = (v: number, digits = 4) => Number(v.toFixed(digits));

function hashBytes(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeWorldFile(worldId: string, rel: string) {
  const dir = path.resolve(WORLDS_DIR, worldId);
  const file = path.resolve(dir, rel);
  if (!file.startsWith(`${dir}${path.sep}`)) throw new Error(`world file escapes its directory: ${rel}`);
  return file;
}

export function listPatrolWorldIds(): string[] {
  if (!existsSync(WORLDS_DIR)) return [];
  return readdirSync(WORLDS_DIR).filter((id) => existsSync(path.join(WORLDS_DIR, id, 'scene.json')) && existsSync(path.join(WORLDS_DIR, id, 'manifest.json')));
}

/** Object files are `objects/<object>/[m<n>/]<model>/model*.ply|glb`: the folder above the file names the 3D model. */
const MODEL_IN_URL = /\/objects\/[^/]+\/(?:m\d+\/)?([a-z0-9-]+)\/[^/]+$/i;

export function approachOf(manifest: Pick<WorldManifest, 'depth' | 'options'>, scene: Pick<SceneDoc, 'world' | 'objects'>): Approach {
  const models = [...new Set(scene.objects.map((o) => MODEL_IN_URL.exec(o.url)?.[1]).filter((m): m is string => Boolean(m)))].sort();
  // Whether there is a surrounding world is a fact of the scene; which Marble model made it is what the build asked for.
  const asked = manifest.options?.worldModel;
  const marble = scene.world ? (asked === 'worldlabs-draft' ? 'worldlabs-draft' : 'worldlabs') : 'none';
  return {
    asset: models.join('+') || 'none',
    worldModel: marble,
    depth: (manifest.depth?.original?.job?.model ?? 'moge2') as string,
  };
}

export async function readPatrolWorld(id: string): Promise<PatrolWorld> {
  const manifest = JSON.parse(readFileSync(safeWorldFile(id, 'manifest.json'), 'utf8')) as WorldManifest;
  const sceneBytes = readFileSync(safeWorldFile(id, 'scene.json'));
  const layoutFile = safeWorldFile(id, 'layout.json');
  const layoutBytes = existsSync(layoutFile) ? readFileSync(layoutFile) : Buffer.alloc(0);
  if (!manifest.image?.file) throw new Error(`${id} has no source image`);
  const photoFile = safeWorldFile(id, manifest.image.file);
  const scene = JSON.parse(sceneBytes.toString('utf8')) as SceneDoc;
  const [tx, ty, tz] = scene.camera.target;
  return {
    id,
    title: manifest.title,
    approach: approachOf(manifest, scene),
    focusDist: Math.min(12, Math.max(1.5, Math.hypot(tx, ty, tz) || 3)),
    camHeight: scene.camera.heightM === undefined ? undefined : Math.min(3, Math.max(0.5, scene.camera.heightM)),
    target: [tx, ty, tz],
    photo: await sharp(photoFile).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer(),
    sceneHash: hashBytes(Buffer.concat([sceneBytes, layoutBytes])),
    photoFile,
  };
}

function methodOf(model: PatrolModel): MethodSpec {
  return {
    id: `patrol:${model}`,
    label: 'Patrol',
    family: PATROL_FAMILY.id,
    subject: model,
    subjectLabel: model,
    description: `Inspects a standardized camera path with ${model}.`,
  };
}

function providerOf(model: PatrolModel) {
  return model === 'muse-spark-1.3' ? 'meta' : model === 'gemini-3.8-flash' ? 'google' : 'openai';
}

function effortForGemini(effort: PatrolOptions['effort']): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (effort === 'high' || effort === 'xhigh' || effort === 'max') return 'HIGH';
  if (effort === 'medium') return 'MEDIUM';
  return 'LOW';
}

function estimateUsd(model: PatrolModel, prompt: string) {
  const inTokens = prompt.length / 3.5 + 2 * 1800;
  const outTokens = PATROL_MAX_TOKENS;
  const prices = model === 'muse-spark-1.3' ? [1.25, 4.25] : model === 'gemini-3.8-flash' ? [0.75, 3.75] : [1, 5];
  return (inTokens * prices[0] + outTokens * prices[1]) / 1e6;
}

function parseJudgement(raw: unknown): { findings: PatrolFinding[]; rationale: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: PatrolFinding[] = [];
  for (const item of Array.isArray(o.findings) ? o.findings.slice(0, 6) : []) {
    const f = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const kind = ['floating-bits', 'background-in-object', 'smeared', 'hole', 'placement', 'other'].includes(String(f.kind)) ? f.kind as ObservationCategory : 'other';
    const severity = f.severity === 'major' ? 'major' : 'minor';
    const confidence = finite(f.confidence) ? clamp01(f.confidence) : 0.5;
    let box = Array.isArray(f.box) && f.box.length === 4 && f.box.every(finite) ? f.box as number[] : [];
    // Accept a model that used the common 0–1000 image convention despite the prompt's 0–1 contract.
    if (box.some((v) => v > 1) && box.every((v) => v >= 0 && v <= 1000)) box = box.map((v) => v / 1000);
    if (box.length !== 4) continue;
    const x0 = clamp01(Math.min(box[0], box[2])), x1 = clamp01(Math.max(box[0], box[2]));
    const y0 = clamp01(Math.min(box[1], box[3])), y1 = clamp01(Math.max(box[1], box[3]));
    if (x1 - x0 < 0.006 || y1 - y0 < 0.006) continue;
    const description = typeof f.description === 'string' ? f.description.trim().slice(0, 320) : '';
    if (!description) continue;
    out.push({ kind, severity, confidence: round(confidence, 3), box: [round(x0), round(y0), round(x1), round(y1)], description });
  }
  return { findings: out, rationale: typeof o.rationale === 'string' ? o.rationale.trim().slice(0, 600) : '' };
}

function messagesFor(world: PatrolWorld, frame: CapturedFrame): { messages: ChatMessage[]; geminiContent: { text?: string; inlineData?: { mimeType: string; data: string } }[] } {
  const reference = toDataUrl(world.photo, 'image/jpeg');
  const current = toDataUrl(frame.image, 'image/jpeg');
  const text = PATROL_PROMPT(frame.id);
  const messages: ChatMessage[] = [
    { role: 'system', content: PATROL_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Reference image (the original observation):' },
        { type: 'image_url', image_url: { url: reference } },
        { type: 'text', text: text },
        { type: 'image_url', image_url: { url: current } },
      ],
    },
  ];
  const data = (url: string) => url.slice(url.indexOf(',') + 1);
  const geminiContent = [
    { text: 'Reference image (the original observation):' },
    { inlineData: { mimeType: 'image/jpeg', data: data(reference) } },
    { text },
    { inlineData: { mimeType: 'image/jpeg', data: data(current) } },
  ];
  return { messages, geminiContent };
}

interface JudgedFrame {
  judgement: { findings: PatrolFinding[]; rationale: string };
  cached: boolean;
  costUsd: number;
  latencyMs: number;
}

async function callModel(model: PatrolModel, world: PatrolWorld, frame: CapturedFrame, options: PatrolOptions): Promise<{ judgement: { findings: PatrolFinding[]; rationale: string }; costUsd: number }> {
  const { messages, geminiContent } = messagesFor(world, frame);
  const schema = PATROL_SCHEMA as unknown as Record<string, unknown>;
  if (model === 'muse-spark-1.3') {
    const r = await chatCompletion({ model, messages, schema: { name: 'PatrolFinding', schema }, reasoningEffort: options.effort ?? 'low', maxTokens: PATROL_MAX_TOKENS });
    if (!r.message.content) throw new Error(`Muse returned no patrol answer (finish_reason ${r.finishReason})`);
    return { judgement: parseJudgement(JSON.parse(r.message.content)), costUsd: r.costUsd };
  }
  if (model === 'gemini-3.8-flash') {
    const r = await geminiChatJson<unknown>({ model, system: PATROL_SYSTEM, content: geminiContent, schema, thinkingLevel: effortForGemini(options.effort), maxTokens: PATROL_MAX_TOKENS });
    return { judgement: parseJudgement(r.data), costUsd: r.costUsd };
  }
  const r = await openAiChatJson<unknown>({ model, system: PATROL_SYSTEM, content: messages[1].content as ChatContent[], schemaName: 'PatrolFinding', schema, reasoningEffort: options.effort === 'minimal' ? 'low' : options.effort, maxTokens: PATROL_MAX_TOKENS });
  return { judgement: parseJudgement(r.data), costUsd: r.costUsd };
}

async function judgeFrame(world: PatrolWorld, frame: CapturedFrame, model: PatrolModel, spend: import('@wom/metrics').Spend, options: PatrolOptions, fresh: boolean): Promise<JudgedFrame> {
  // The pose is rounded (1 cm, 0.001 of a quaternion): a re-run of the same path lands on the same key despite float
  // noise, while a changed path asks again instead of reusing an answer given for a different picture.
  const pose = [...frame.pose.position.map((v) => Math.round(v * 100) / 100), ...frame.pose.quaternion.map((v) => Math.round(v * 1000) / 1000)].map((v) => (Object.is(v, -0) ? 0 : v));
  const promptKey = JSON.stringify({ version: REQUEST_VERSION, model, world: world.id, scene: world.sceneHash, view: frame.id, pose, photo: hashBytes(world.photo), system: PATROL_SYSTEM, prompt: PATROL_PROMPT(frame.id), schema: PATROL_SCHEMA, effort: options.effort ?? 'low', maxTokens: PATROL_MAX_TOKENS });
  const r = await spend.call<{ judgement: { findings: PatrolFinding[]; rationale: string }; costUsd: number }>(
    {
      key: promptKey,
      label: `patrol ${model}: ${world.id}/${frame.id}`,
      estimateUsd: estimateUsd(model, promptKey),
      namespace: 'patrol',
      costOf: (v) => v.costUsd,
      ledger: { context: 'bench', provider: providerOf(model), model },
    },
    async () => {
      const value = await callModel(model, world, frame, options);
      return { value, costUsd: value.costUsd };
    },
    { fresh },
  );
  return { judgement: r.value.judgement, cached: r.cached, costUsd: r.costUsd, latencyMs: r.latencyMs };
}

function assertModelConfigured(model: PatrolModel) {
  if (model === 'muse-spark-1.3' && !keysConfigured().meta) throw new Error('MUSE_API_KEY is not configured.');
  if (model === 'gemini-3.8-flash' && !geminiConfigured()) throw new Error('Gemini needs GEMINI_API_KEY, or a verified GCP project in .kiro/gcp-project.json.');
  if (model === 'gpt-6.1-terra' && !openAiConfigured()) throw new Error('OPENAI_KEY is not configured.');
}

async function loadPlaywright(): Promise<any> {
  const candidates = [
    process.env.PLAYWRIGHT_CORE?.trim(),
    path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs'),
    path.join(ROOT, 'node_modules', 'playwright', 'index.mjs'),
  ].filter((x): x is string => Boolean(x));
  for (const candidate of candidates) {
    const file = existsSync(candidate) ? candidate : existsSync(path.join(candidate, 'index.mjs')) ? path.join(candidate, 'index.mjs') : '';
    if (!file) continue;
    try {
      return await import(pathToFileURL(path.resolve(file)).href);
    } catch (err) {
      throw new Error(`Could not load Playwright from ${file}: ${errorMessage(err)}`);
    }
  }
  throw new Error('Patrol needs Playwright. Install playwright-core or set PLAYWRIGHT_CORE to its index.mjs.');
}

function browserArgs() {
  const args = ['--enable-gpu', '--ignore-gpu-blocklist'];
  if (process.platform === 'darwin') args.push('--use-angle=metal');
  if (process.env.BROWSER_ARGS) args.push(...process.env.BROWSER_ARGS.split(/\s+/).filter(Boolean));
  return args;
}

/** How much a frame's brightness varies, as a standard deviation on a 0 to 255 scale. A healthy frame is 30 or more; a flat one is about 1. */
async function lumaSpread(image: Buffer): Promise<number> {
  const raw = await sharp(image).resize(128, 80, { fit: 'fill' }).greyscale().raw().toBuffer();
  let sum = 0, sq = 0;
  for (const v of raw) { sum += v; sq += v * v; }
  const mean = sum / raw.length;
  return Math.sqrt(Math.max(0, sq / raw.length - mean * mean));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface PatrolSession {
  page: any;
  browser: any;
  frames: Promise<CapturedFrame[]>;
  /** Views the path could not use, and why: nothing is dropped without a trace. */
  notes: string[];
  tail: Promise<void>;
  closed: boolean;
  flag(pose: ViewPose, finding: PatrolFinding, model: PatrolModel, viewId: string): Promise<string>;
  close(): Promise<void>;
}

async function createSession(world: PatrolWorld, options: PatrolOptions): Promise<PatrolSession> {
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chromium', headless: true, args: browserArgs() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const base = (options.baseUrl ?? process.env.BASE ?? 'http://localhost:5173').replace(/\/$/, '');
  await page.goto(`${base}/u/local/${encodeURIComponent(world.id)}?debug`);
  await page.waitForFunction(() => Boolean((window as any).__wom?.viewer), null, { timeout: 60_000 });
  const phase = await page.evaluate(() => (window as any).__wom.viewer.ready(180_000));
  if (phase !== 'portal') throw new Error(`world ${world.id} opened in unexpected phase ${phase}`);
  await page.evaluate(() => (window as any).__wom.viewer.enter());
  await sleep(800);
  await page.waitForFunction(() => Boolean((window as any).__wom?.camera), null, { timeout: 30_000 });
  // The path is worked out in the page, where the scene is: the same rules in every world, and each world's own
  // geometry decides where they land. Distances scale with how far away the photo's subject is, eye height is the
  // photo camera's, and objects are framed by their collision hulls (a splat has no bounding box of its own).
  // A camera is used only where a person could stand and look: the walker's colliders (the world, the relief and
  // every object) leave room around it, a straight walk from the photo camera reaches it, the ground is at standing
  // height below it, and it can see some distance ahead. A cramped world therefore gets fewer views, never views
  // from inside a table.
  const planned = await page.evaluate((arg: { maxViews: number; focusDist: number; camHeight?: number; target: number[] }) => {
    const w = (window as any).__wom;
    const THREE = w.THREE;
    const walker = w.walker;
    const clamp = THREE.MathUtils.clamp;
    const up = w.camera.up.clone().normalize();
    const home = w.viewer.home();
    const O = new THREE.Vector3(...home.position);
    const qHome = new THREE.Quaternion(...home.quaternion);
    const horiz = (v: any) => v.clone().addScaledVector(up, -v.dot(up));
    let fwd = horiz(new THREE.Vector3(0, 0, -1).applyQuaternion(qHome));
    if (fwd.lengthSq() < 1e-6) fwd = horiz(new THREE.Vector3(0, 0, -1));
    fwd.normalize();
    const rgt = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const D = arg.focusDist;
    // The eye height the world recorded, else what the walker measured under the photo camera.
    const H = arg.camHeight ?? clamp(walker.eyeHeight > 0 ? walker.eyeHeight : 1.2, 0.5, 3);
    const F = new THREE.Vector3(...arg.target);
    const notes: string[] = [];
    const room = clamp(walker.radius || 0.25, 0.15, 0.35);

    // Where the objects are: the world-space box of each one's collision hull.
    const entries = (typeof w.objects === 'function' ? w.objects() : []).filter((o: any) => o?.group?.visible);
    const objs = entries.map((o: any) => {
      o.group.updateWorldMatrix(true, true);
      const pos = o.collider?.geometry?.attributes?.position;
      const box = new THREE.Box3();
      if (pos) box.setFromBufferAttribute(pos).applyMatrix4(o.group.matrixWorld);
      if (box.isEmpty()) {
        notes.push('object ' + o.id + ' has no collision hull; using a 0.8 m box');
        box.setFromCenterAndSize(o.group.getWorldPosition(new THREE.Vector3()).addScaledVector(up, 0.4), new THREE.Vector3(0.8, 0.8, 0.8));
      }
      return { id: o.id as string, box };
    });

    // Directions to look for walls and furniture around a camera: the six axes and the eight corners, in the up frame.
    const dirs: any[] = [];
    for (const a of [fwd, fwd.clone().negate(), rgt, rgt.clone().negate(), up, up.clone().negate()]) dirs.push(a);
    for (const f of [1, -1]) for (const r of [1, -1]) for (const u of [1, -1]) dirs.push(fwd.clone().multiplyScalar(f).addScaledVector(rgt, r).addScaledVector(up, u * 0.7).normalize());
    const hit = (p: any, d: any, max: number): number | null => walker.hitDistance(p, d, max);

    /** Why a camera at p looking toward 'at' would not do, or null when it would. */
    const refuse = (p: any, at: any, minAhead: number): string | null => {
      for (const d of dirs) {
        const t = hit(p, d, room);
        if (t !== null && t < room) return 'inside or against something';
      }
      const toP = p.clone().sub(O);
      const len = toP.length();
      if (len > 0.05) {
        const t = hit(O, toP.clone().normalize(), len);
        if (t !== null && t < len - 0.05) return 'something is in the way from the photo camera';
      }
      const g = walker.groundBelow(p, 8);
      if (g !== null && (g < 0.35 * H || g > 2.5 * H)) return 'not at standing height';
      const look = at.clone().sub(p);
      const dist = look.length();
      const ahead = hit(p, look.normalize(), Math.max(minAhead, dist) + 1);
      if (ahead !== null && ahead < Math.min(minAhead, dist * 0.6)) return 'the view is blocked';
      return null;
    };
    const lookQ = (eye: any, at: any) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, at, up));
    const result: { id: string; position: number[]; quaternion: number[] }[] = [];
    const push = (id: string, p: any, at: any) => result.push({ id, position: p.toArray(), quaternion: lookQ(p, at).toArray() });
    /** The first of several candidate positions that passes; says why when none does. */
    const place = (id: string, candidates: any[], at: any, minAhead: number, minFromPhoto = 0) => {
      const why = new Set<string>();
      for (const p of candidates) {
        if (p.distanceTo(O) < minFromPhoto) { why.add('too close to the photo camera'); continue; }
        const r = refuse(p, at, minAhead);
        if (r) { why.add(r); continue; }
        return push(id, p, at);
      }
      notes.push(id + ': left out (' + [...why].join('; ') + ')');
    };

    const side = clamp(0.24 * D, 0.4, 2), ahead = clamp(0.18 * D, 0.2, 1.5), dolly = Math.min(clamp(0.5 * D, 0.8, 4), Math.max(0.5, D - 0.8));
    const around = (...ts: number[]) => (to: any) => ts.map((t) => O.clone().lerp(to, t));
    push('photo', O, O.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(qHome)));
    result[0].quaternion = qHome.toArray();
    result[0].position = O.toArray();
    const minAhead = clamp(0.35 * D, 0.8, 3);
    place('left', around(1, 0.75, 0.5)(O.clone().addScaledVector(rgt, -side).addScaledVector(fwd, ahead)), F, minAhead, 0.25);
    place('right', around(1, 0.75, 0.5)(O.clone().addScaledVector(rgt, side).addScaledVector(fwd, ahead)), F, minAhead, 0.25);
    place('forward', around(1, 0.75, 0.5)(O.clone().addScaledVector(fwd, dolly)), F, minAhead, 0.25);
    place('low', around(1, 0.75, 0.5)(O.clone().addScaledVector(fwd, 0.2 * D).addScaledVector(up, -Math.max(0, H - 0.3))), F, minAhead, 0.25);
    place('high', [0.9, 0.6, 0.3].map((u) => O.clone().addScaledVector(fwd, -0.1 * D).addScaledVector(up, u)), F, minAhead, 0.25);

    // Two views of each object, from either side of the line between it and the photo camera.
    for (const o of objs) {
      const c = o.box.getCenter(new THREE.Vector3());
      const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => new THREE.Vector3(x ? o.box.max.x : o.box.min.x, y ? o.box.max.y : o.box.min.y, z ? o.box.max.z : o.box.min.z))));
      const heights = corners.map((v: any) => v.dot(up));
      const lo = Math.min(...heights), hi = Math.max(...heights);
      const h = Math.max(0.2, hi - lo);
      const base = c.clone().addScaledVector(up, lo - c.dot(up));
      const r = Math.max(0.15, ...corners.map((v: any) => horiz(v.clone().sub(c)).length()));
      const eye = clamp(H, 0.4, 2.2);
      const at = base.clone().addScaledVector(up, clamp(h * 0.5, 0.2, eye + 0.3));
      let d0 = horiz(O.clone().sub(base));
      if (d0.length() < 0.5) d0 = fwd.clone().negate();
      d0.normalize();
      const R = Math.max(clamp(2 * Math.max(h, 2 * r), 1, 4), r + 0.8);
      for (const [name, sign] of [['left', -1], ['right', 1]] as [string, number][]) {
        const candidates: any[] = [];
        for (const [deg, mul] of [[50, 1], [50, 1.4], [85, 1], [85, 1.4], [115, 1], [30, 1.4]]) {
          const d = d0.clone().applyAxisAngle(up, sign * deg * (Math.PI / 180));
          candidates.push(base.clone().addScaledVector(d, R * mul).addScaledVector(up, eye));
        }
        place('object:' + o.id + ':' + name, candidates, at, Math.max(0.6, 0.6 * (R - r)));
      }
    }
    const limit = Math.max(1, Number(arg.maxViews) || 20);
    if (result.length > limit) notes.push('the path has ' + result.length + ' views and --max-views is ' + limit + ': the last ' + (result.length - limit) + ' are left out');
    return { poses: result.slice(0, limit), notes };
  }, { maxViews: Math.max(1, options.maxViews ?? DEFAULT_MAX_VIEWS), focusDist: world.focusDist, camHeight: world.camHeight, target: world.target }) as { poses: { id: string; position: number[]; quaternion: number[] }[]; notes: string[] };
  const notes = [...planned.notes];
  for (const note of notes) console.warn(`[patrol] ${world.id}: ${note}`);
  const poses = planned.poses;

  const frames: CapturedFrame[] = [];
  for (const p of poses) {
    const pose: ViewPose = { position: p.position as ViewPose['position'], quaternion: p.quaternion as ViewPose['quaternion'] };
    await page.evaluate((next: ViewPose) => (window as any).__wom.viewer.setPose(next), pose);
    // Spark sorts its splats again after the camera moves; a frame taken before that shows the old order as smearing.
    await sleep(SETTLE_MS);
    const encoded = await page.evaluate(async () => {
      const blob = await (window as any).__wom.viewer.frame({ maxWidth: 1024, type: 'jpeg' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    }) as string;
    const image = Buffer.from(encoded, 'base64');
    const spread = await lumaSpread(image);
    if (spread < MIN_SPREAD) {
      const note = p.id + ': left out (a flat frame: nothing to judge)';
      notes.push(note);
      console.warn('[patrol] ' + world.id + ': ' + note);
      continue;
    }
    const meta = await sharp(image).metadata();
    frames.push({ id: p.id, pose, image, width: meta.width ?? 0, height: meta.height ?? 0 });
  }

  const session: PatrolSession = {
    page,
    browser,
    frames: Promise.resolve(frames),
    notes,
    tail: Promise.resolve(),
    closed: false,
    async flag(pose, finding, model, viewId) {
      let release!: () => void;
      const previous = session.tail;
      session.tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        await page.evaluate((next: ViewPose) => (window as any).__wom.viewer.setPose(next), pose);
        await sleep(220);
        return await page.evaluate(async (input: { finding: PatrolFinding; model: string; view: string; version: string }) => {
          const { finding: f, model: m, view, version } = input;
          const viewer = (window as any).__wom.viewer;
          const size = viewer.frameSize();
          const mark = { kind: 'box', px: [f.box[0] * size.width, f.box[1] * size.height, f.box[2] * size.width, f.box[3] * size.height] };
          const created = await viewer.flag({
            mark,
            category: f.kind,
            author: `agent:patrol-${m}`,
            note: `[WOM patrol ${version}; model=${m}; view=${view}; severity=${f.severity}; confidence=${f.confidence.toFixed(2)}] ${f.description}`,
          });
          return created.id as string;
        }, { finding, model, view: viewId, version: PATROL_VERSION });
      } finally {
        release();
      }
    },
    async close() {
      if (session.closed) return;
      session.closed = true;
      await session.tail.catch(() => undefined);
      await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
  return session;
}

async function sessionFor(data: PatrolData, options: PatrolOptions): Promise<PatrolSession> {
  if (!data.session) data.session = createSession(data.world, options);
  return data.session;
}

export interface PatrolData {
  world: PatrolWorld;
  session?: Promise<PatrolSession>;
}

export function patrolMethod(model: PatrolModel): MethodSpec {
  return methodOf(model);
}

const GRID_W = 64;
const GRID_H = 40;

/**
 * How much of a view is broken, 0 to 1: the share of the frame covered by the judge's defect boxes. A major
 * defect counts in full and a minor one at MINOR_WEIGHT; where boxes overlap, the heavier one counts, so
 * a defect reported twice is not counted twice.
 */
export function damageOf(findings: Pick<PatrolFinding, 'box' | 'severity'>[]): number {
  if (!findings.length) return 0;
  const cell = new Float32Array(GRID_W * GRID_H);
  for (const f of findings) {
    const w = f.severity === 'major' ? 1 : MINOR_WEIGHT;
    const x0 = Math.max(0, Math.floor(f.box[0] * GRID_W)), x1 = Math.min(GRID_W, Math.ceil(f.box[2] * GRID_W));
    const y0 = Math.max(0, Math.floor(f.box[1] * GRID_H)), y1 = Math.min(GRID_H, Math.ceil(f.box[3] * GRID_H));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (w > cell[y * GRID_W + x]) cell[y * GRID_W + x] = w;
  }
  let sum = 0;
  for (const v of cell) sum += v;
  return sum / cell.length;
}

/** What a judge found, in a few sentences for the case card's "why": major findings first, then the rest. */
/** The views the path wanted but could not use (no standing room, flat frame), not counting a --max-views cut. */
const leftOutViews = (notes: string[]) => notes.filter((n) => n.includes(': left out ('));

function noteOf(views: PatrolView[], leftOut: string[] = []): string {
  const skipped = leftOutViews(leftOut).length;
  const coverage = skipped ? ` ${views.length} of ${views.length + skipped} planned views could be inspected; the rest had no room to stand or nothing to see.` : '';
  const all = views.filter((v) => !v.error).flatMap((v) => v.findings.map((f) => ({ view: v.id, f })));
  const failed = views.filter((v) => v.error).length;
  const tail = (failed ? ` ${failed} view${failed === 1 ? '' : 's'} could not be inspected.` : '') + coverage;
  if (!all.length) return `No defects reported in ${views.length - failed} view${views.length - failed === 1 ? '' : 's'}.${tail}`;
  const ranked = [...all].sort((a, b) => (b.f.severity === 'major' ? 1 : 0) - (a.f.severity === 'major' ? 1 : 0) || b.f.confidence - a.f.confidence);
  const shown = ranked.slice(0, 6).map(({ view, f }) => `${view}: ${f.severity} ${f.kind.replace(/-/g, ' ')}, ${f.description.replace(/[.\s]+$/, '')}`);
  const more = ranked.length > shown.length ? ` (+${ranked.length - shown.length} more)` : '';
  return `${ranked.length} finding${ranked.length === 1 ? '' : 's'}: ${shown.join(' · ')}${more}.${tail}`.slice(0, 1500);
}

function answerOutcome(answer: PatrolAnswer): Outcome {
  const valid = answer.views.filter((v) => !v.error);
  if (!valid.length) return { scores: { intact: null, cleanViewRate: null, worstView: null, coverage: 0 }, note: noteOf(answer.views, answer.leftOut), details: { views: answer.views, viewCount: 0 } };
  const damage = valid.map((v) => damageOf(v.findings));
  const details: Record<string, unknown> = {
    viewCount: valid.length,
    leftOut: answer.leftOut,
    errors: answer.views.filter((v) => v.error).length,
    damagePerView: Object.fromEntries(valid.map((v, i) => [v.id, Number(damage[i].toFixed(4))])),
    views: answer.views,
    findings: valid.flatMap((v) => v.findings.map((f) => ({ what: f.description, severity: f.severity, where: `${v.id} · box ${f.box.map((n) => n.toFixed(2)).join(',')}` } satisfies Finding))),
  };
  return {
    scores: {
      intact: 1 - damage.reduce((a, b) => a + b, 0) / damage.length,
      cleanViewRate: valid.filter((v) => !v.findings.length).length / valid.length,
      worstView: 1 - Math.max(...damage),
      coverage: valid.length / (answer.views.length + leftOutViews(answer.leftOut).length),
    },
    note: noteOf(answer.views, answer.leftOut),
    details,
  };
}

function boxIou(a: PatrolFinding, b: PatrolFinding) {
  const x0 = Math.max(a.box[0], b.box[0]), y0 = Math.max(a.box[1], b.box[1]);
  const x1 = Math.min(a.box[2], b.box[2]), y1 = Math.min(a.box[3], b.box[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const aa = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]);
  const ab = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
  return inter / Math.max(1e-9, aa + ab - inter);
}

function matches(a: PatrolFinding, b: PatrolFinding) {
  return a.kind === b.kind && boxIou(a, b) >= 0.2;
}

interface Consensus {
  byView: Map<string, PatrolFinding[]>;
  cleanRate: number | null;
  /** Like a judge's `intact`, from the findings that at least half of the judges support. */
  intact: number | null;
  support: Map<string, Set<string>>;
}

function consensusOf(scored: ScoredAnswer<PatrolAnswer>[]): Consensus {
  const answers = scored.map((s) => ({ method: s.answer.method, answer: s.answer.answer })).filter((x): x is { method: string; answer: PatrolAnswer } => Boolean(x.answer));
  const methods = new Set(answers.map((x) => x.method));
  const quorum = Math.max(1, Math.ceil(methods.size / 2));
  const byView = new Map<string, PatrolFinding[]>();
  const support = new Map<string, Set<string>>();
  const viewIds = [...new Set(answers.flatMap((x) => x.answer.views.map((v) => v.id)))];
  for (const viewId of viewIds) {
    const all = answers.flatMap((x) => {
      const view = x.answer.views.find((v) => v.id === viewId);
      return (view?.findings ?? []).map((finding) => ({ method: x.method, finding }));
    });
    const used = new Set<number>();
    for (let i = 0; i < all.length; i++) {
      if (used.has(i)) continue;
      const cluster = all.filter((x, j) => !used.has(j) && matches(all[i].finding, x.finding));
      const methodsIn = new Set(cluster.map((x) => x.method));
      if (methodsIn.size < quorum) continue;
      cluster.forEach((x) => { const j = all.indexOf(x); used.add(j); });
      const representative = cluster.slice().sort((a, b) => (b.finding.severity === 'major' ? 1 : 0) - (a.finding.severity === 'major' ? 1 : 0))[0].finding;
      byView.set(viewId, [...(byView.get(viewId) ?? []), representative]);
      support.set(`${viewId}:${representative.box.join(',')}:${representative.kind}`, methodsIn);
    }
  }
  const n = viewIds.length;
  const clean = n ? viewIds.filter((id) => !(byView.get(id)?.length)).length / n : null;
  const intact = n ? 1 - viewIds.reduce((sum, id) => sum + damageOf(byView.get(id) ?? []), 0) / n : null;
  return { byView, cleanRate: clean, intact, support };
}

function agreementFor(answer: PatrolAnswer, consensus: Consensus, method: string) {
  const findings = answer.views.flatMap((v) => v.findings.map((f) => ({ view: v.id, finding: f })));
  if (!findings.length) return consensus.byView.size ? 0 : 1;
  let agreed = 0;
  for (const item of findings) if ((consensus.byView.get(item.view) ?? []).some((f) => matches(f, item.finding))) agreed++;
  void method;
  return agreed / findings.length;
}

export const PATROL_SPEC = {
  id: 'patrol',
  label: 'Patrol',
  description: 'The same camera path is rendered in every world and inspected for visible reconstruction aberrations by independent vision models.',
  kind: 'metrics' as const,
  metrics: [
    { id: 'intact', label: 'Intact', better: 'higher' as const, format: 'percent' as const, digits: 0, range: [0, 1] as [number, number], thresholds: { good: 0.95, fair: 0.85 }, description: 'How much of what the patrol sees is free of reported defects: 100% minus the mean share of a view covered by the judge\'s defect boxes (a major defect counts in full, a minor one at half, overlaps once).' },
    { id: 'cleanViewRate', label: 'Clean views', better: 'higher' as const, format: 'percent' as const, digits: 0, range: [0, 1] as [number, number], description: 'Share of patrol views in which the judge reported no defect at all. Strict: one small defect makes a view unclean.' },
    { id: 'worstView', label: 'Worst view', better: 'higher' as const, format: 'percent' as const, digits: 0, range: [0, 1] as [number, number], description: 'Intact share of the worst patrol view: how bad the single worst place is.' },
    { id: 'coverage', label: 'Coverage', better: 'higher' as const, format: 'percent' as const, digits: 0, range: [0, 1] as [number, number], advanced: true, description: 'Share of the planned patrol views that could be inspected. A cramped world has fewer places to stand, so it is judged on fewer views, usually the easier ones: read its Intact with that in mind.' },
    { id: 'consensusIntact', label: 'Consensus intact', better: 'higher' as const, format: 'percent' as const, digits: 0, range: [0, 1] as [number, number], advanced: true, description: 'Intact, counting only defects that at least half of the judges report in the same place and category. The same value for every judge on a world.' },
    { id: 'consensusCleanViewRate', label: 'Consensus clean views', better: 'higher' as const, format: 'percent' as const, digits: 0, range: [0, 1] as [number, number], advanced: true, description: 'Share of patrol views with no defect supported by at least half of the judges.' },
    { id: 'judgeAgreement', label: 'Judge agreement', better: 'higher' as const, format: 'percent' as const, digits: 0, range: [0, 1] as [number, number], advanced: true, description: 'Share of a judge\'s findings that another judge also supports. This measures how much judges agree, not whether they are right.' },
  ],
  primary: 'intact',
  families: [PATROL_FAMILY],
  // How the world was made. They are shown on a case only when the run has worlds made in different ways.
  dimensions: [WORLD_DIMENSION, ASSET_DIMENSION, WORLD_MODEL_DIMENSION, DEPTH_DIMENSION],
  // Only images are declared: the dashboard draws every artifact as an <img>. The per-view evidence is a JSON
  // file kept beside them (evidence/<world>.json), reachable at /bench-files/patrol/<run>/evidence/<world>.json.
  artifacts: [
    { id: 'sheet', label: 'The patrol frames, in path order.' },
  ],
  tie: 0.01,
  gain: 0.02,
  smallSample: 3,
  caveat: 'This is a standardized VLM-reported aberration score, not a human-verified absolute reconstruction score. A clean report can still miss an error, and a judge can hallucinate one. Confirmed and false-alarm statuses in Observations provide the calibration set.',
  hardCasesHint: 'A defect that several judges report in the same place is stronger evidence than one judge\'s finding.',
  howToRun: 'Run npm run bench:patrol. It needs Playwright, the app running, and a key for each judge (Gemini: GEMINI_API_KEY, or a verified GCP project in .kiro/gcp-project.json).',
  groupLabel: 'world',
  question: 'What aberrations appear while walking around the world?',
};

const meanOf = (xs: (number | null | undefined)[]) => {
  const v = xs.filter(finite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/**
 * How intact each judge finds the worlds, for every way the worlds in the run were made: the table that compares
 * generation approaches rather than judges. A cell is the mean over the worlds made that way, with the share of
 * clean views after the slash; the last column averages the judges. Only for runs that hold worlds made in different ways.
 */
function approachTables(view: Pick<RunView, 'cases' | 'methods'>): HeatTable[] {
  const kept = view.cases.filter((c) => !c.excluded);
  const key = (c: CaseView) => `${c.dims.asset}|${c.dims.worldModel}|${c.dims.depth}`;
  const keys = [...new Set(kept.map(key))].sort();
  if (keys.length < 2) return [];
  const judges = view.methods;
  const score = (cases: CaseView[], method: string, metric: string) => meanOf(cases.map((c) => c.results.find((r) => r.method === method)?.scores[metric]));
  return [{
    id: 'approach',
    title: 'By how the world was made',
    caption: 'Intact per judge, averaged over the worlds made each way, with the share of clean views after the slash. The last column averages the judges. Read a row made from few worlds as a hint, not a result.',
    columns: judges.map((m) => ({ id: m.id, label: m.subjectLabel ?? m.label })),
    rows: keys.map((k) => {
      const cases = kept.filter((c) => key(c) === k);
      const [asset, worldModel, depth] = k.split('|');
      const cell = (ms: string[]) => ({ value: meanOf(ms.map((m) => score(cases, m, 'intact'))), secondary: meanOf(ms.map((m) => score(cases, m, 'cleanViewRate'))) });
      return {
        id: k,
        label: asset.split('+').map((a) => ASSET_MODELS[a as MeshModel]?.label ?? a).join(' + '),
        sub: `${WORLD_MODELS[worldModel]?.label ?? worldModel} · ${DEPTH_MODELS[depth as DepthModel]?.label ?? depth} · ${cases.length} world${cases.length === 1 ? '' : 's'}`,
        cells: judges.map((m) => cell([m.id])),
        total: cell(judges.map((m) => m.id)),
      };
    }),
  }];
}

export const patrolTask = defineTask<PatrolData, PatrolAnswer>({
  ...PATROL_SPEC,
  extras(view) {
    return {
      tables: approachTables(view),
      tablesTitle: 'Generation approaches',
      tablesCaption: 'The same patrol and the same judges on worlds made in different ways: the comparison the patrol exists for.',
    };
  },
  async cases(selection: CaseSelection) {
    const ids = selection.worlds?.length ? selection.worlds : listPatrolWorldIds();
    const cases: Case<PatrolData>[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      try {
        const world = await readPatrolWorld(id);
        const { asset, worldModel, depth } = world.approach;
        cases.push({ id, title: world.title, group: world.title, dims: { world: id, asset, worldModel, depth }, data: { world } });
      } catch (err) {
        skipped.push(`${id} (${errorMessage(err)})`);
      }
    }
    return { cases, skipped };
  },
  async score(_c, answer) {
    return answerOutcome(answer);
  },
  async finish(c, scored, ctx): Promise<FinishOutcome> {
    const consensus = consensusOf(scored);
    const scores: Record<string, Record<string, number | null>> = {};
    for (const s of scored) {
      if (!s.answer.answer) continue;
      scores[s.answer.method] = {
        consensusIntact: consensus.intact,
        consensusCleanViewRate: consensus.cleanRate,
        judgeAgreement: agreementFor(s.answer.answer, consensus, s.answer.method),
      };
    }
    const evidence = {
      version: PATROL_VERSION,
      world: c.id,
      leftOut: scored.find((x) => x.answer.answer)?.answer.answer?.leftOut ?? [],
      views: scored.flatMap((s) => s.answer.answer?.views.map((v) => ({ method: s.answer.method, ...v })) ?? []),
      consensus: [...consensus.byView].map(([view, findings]) => ({ view, findings })),
    };
    const first = scored.find((s) => s.answer.answer?.frames.length)?.answer.answer;
    const artifacts: Record<string, string> = {};
    if (first?.frames.length) artifacts.sheet = await ctx.write(`frames/${slug(c.id)}.jpg`, await contactSheet(first.frames.map((f) => f.image), Math.min(4, first.frames.length)));
    await ctx.write(`evidence/${slug(c.id)}.json`, JSON.stringify(evidence, null, 2));
    const session = c.data.session ? await c.data.session : null;
    await session?.close();
    return { artifacts, scores };
  },
});

export function patrolSubject(model: PatrolModel, options: PatrolOptions = {}): Subject<PatrolData, PatrolAnswer> {
  const method = methodOf(model);
  return defineSubject<PatrolData, PatrolAnswer>({
    id: `patrol-${model}`,
    label: `Patrol · ${model}`,
    methods: [method],
    async solve(c, ctx): Promise<Answer<PatrolAnswer>[]> {
      assertModelConfigured(model);
      const session = await sessionFor(c.data, options);
      const frames = await session.frames;
      let costUsd = 0, latencyMs = 0, calls = 0, cachedCalls = 0;
      // A few views at a time: the judges answer in seconds, so a sequential walk of 16 views is minutes of waiting.
      // Results keep the path's order. `latencyMs` is the summed model time, as it is for a cached answer.
      const settled = await mapLimit(frames, VIEWS_AT_ONCE, async (frame): Promise<PatrolView> => {
        try {
          const judged = await judgeFrame(c.data.world, frame, model, ctx.spend, options, ctx.fresh);
          calls++;
          if (judged.cached) cachedCalls++;
          costUsd += judged.costUsd;
          latencyMs += judged.latencyMs;
          const flags: PatrolView['flags'] = [];
          for (let i = 0; i < judged.judgement.findings.length; i++) {
            const finding = judged.judgement.findings[i];
            if (options.recordObservations !== false && (!judged.cached || options.recordCached)) {
              try {
                const id = await session.flag(frame.pose, finding, model, frame.id);
                flags.push({ finding: i, id });
              } catch (err) {
                flags.push({ finding: i, error: errorMessage(err) });
              }
            }
          }
          return { id: frame.id, pose: frame.pose, findings: judged.judgement.findings, rationale: judged.judgement.rationale, flags };
        } catch (err) {
          if (err instanceof BudgetExceeded) throw err;
          return { id: frame.id, pose: frame.pose, findings: [], rationale: '', error: errorMessage(err) };
        }
      });
      // A call the budget could not cover leaves this judge out of the run, as it did when the views were sequential.
      const stopped = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (stopped) throw stopped.reason;
      const views = settled.map((s) => (s as PromiseFulfilledResult<PatrolView>).value);
      return [{ method: method.id, answer: { model, frames, views, leftOut: session.notes }, costUsd, latencyMs, calls, cachedCalls }];
    },
  });
}

export { DEFAULT_MAX_VIEWS };
