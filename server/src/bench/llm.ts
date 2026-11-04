// Muse Spark / Muse Wonder as object placers. Both protocols get the same conventions: the asset's
// canonical frame, its base pivot, the yaw convention (with a turntable rendered from the photo camera's
// elevation), and how their answer is turned into 3D. They can also hand any part to geometry:
//
//   direct  one structured answer with per-quantity "defer to the fitter" flags and a preference
//   agent   tool loop: render_placement (overlay + scores), auto_fit (the geometric fitter),
//           measure_depth (MoGe-2), then submit_placement
import { toDataUrl, type ChatContent, type ChatMessage, type ToolDef } from '../clients/meta.ts';
import type { Vec3 } from '../geometry/math.ts';
import type { Placement } from '../geometry/pose.ts';
import { PLACEMENT_AGENT_REVISION } from '../placement.ts';
import { errorMessage } from '../util.ts';
import { BudgetExceeded, cachedChat, type Spend } from './cache.ts';
import type { PlacementMetrics } from './metrics.ts';

export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PlacementArgs {
  base_x: number;
  base_y: number;
  height_m: number;
  yaw_deg: number;
  pitch_deg?: number;
  roll_deg?: number;
}

export interface Scored {
  placement: Placement;
  metrics: PlacementMetrics;
  overlay: Buffer;
  grid: { x: number; y: number };
}

export interface PlacementTask {
  label: string;
  objectName: string;
  description: string;
  assetKind: 'splat' | 'mesh';
  assetModel: string;
  /** Canonical bounding box proportions, height = 1. */
  proportions: Vec3;
  facts: { imageWidth: number; imageHeight: number; hfovDeg: number; cameraHeightM: number; cameraPitchDownDeg: number; viewElevationDeg: number };
  photo: Buffer;
  turntable: Buffer;
  yaws: number[];
  /** Grid answer → 3D placement (ray through the base point meets the ground plane). */
  place: (a: PlacementArgs) => Placement | null;
  score: (p: Placement) => Promise<Scored>;
  autoFit: (yawCenter?: number, yawWindow?: number) => Promise<Scored>;
  measure: (pts: { x: number; y: number }[]) => unknown[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function conventions(task: PlacementTask) {
  const [pw, , pd] = task.proportions;
  return `You place a reconstructed 3D asset back into the photo it was made from, for "World of a Memory", an app that turns one photo into a walkable 3D scene. Seen from the photo's camera, the asset must line up with the object in the photo: same spot on the ground, same size, same facing.

Image coordinates: a 0-1000 grid over image 1 (the photo). x runs from left (0) to right (1000), y from top (0) to bottom (1000). Decimals are allowed.

The asset (image 2 is a turntable of it):
- It is a ${task.assetKind === 'splat' ? `Gaussian-splat object made by ${task.assetModel === 'idol' ? 'IDOL' : 'TripoSplat'}` : `textured mesh made by ${task.assetModel}`} from a cutout of the object. Its units are arbitrary; you give its real height.
- Canonical frame: +Y is up. Bounding box proportions are width ${pw.toFixed(2)} : height 1 : depth ${pd.toFixed(2)}.
- Base pivot: the centre of the bottom of the bounding box, i.e. the point on the ground under the middle of the object's footprint. Each turntable tile marks it with a red cross.
- Yaw: rotation about the vertical (gravity) axis. Tile "yaw N°" shows exactly how the asset looks from the photo camera's viewpoint (same ${r1(task.facts.viewElevationDeg)}° downward viewing angle) when placed with yaw N. Pick the tile that matches the object in the photo and interpolate between tiles when the photo is in between. Positive yaw turns the asset counter-clockwise seen from above: going from yaw 0 to yaw 90, the side that faced the camera at yaw 0 turns toward the right of the image.
- Tilt: pitch_deg leans the asset forward or back, roll_deg leans it sideways. Objects standing on the ground are upright (0 and 0).

How an answer becomes a 3D placement:
1. A ray from the camera through (base_x, base_y) is intersected with the ground plane measured by a metric depth model (MoGe-2). The base pivot goes there. So the base point is the image position of the centre of the object's footprint on the ground. For an object standing on the ground this is usually above its lowest visible pixel, because the footprint centre lies behind the front of the object (often hidden by the object itself).
2. The asset is scaled uniformly so its bounding box is height_m metres tall.
3. It stands upright along gravity, turned by yaw_deg and leaned by pitch_deg and roll_deg.

The camera: the photo is ${task.facts.imageWidth}×${task.facts.imageHeight} px with a ${r1(task.facts.hfovDeg)}° horizontal field of view. It is about ${task.facts.cameraHeightM.toFixed(2)} m above the ground and looks ${r1(task.facts.cameraPitchDownDeg)}° below the horizon.

Other systems: a geometric fitter can place the asset too. It keeps the asset upright, adjusts position, scale and yaw until the rendered silhouette matches the object's segmentation mask (outlined in magenta in image 1), then rests the base pivot on the measured ground plane. It is precise when the mask is clean and the object is fully visible. It can pick a wrong yaw when the silhouette looks similar from several sides, and it can be misled by a mask that includes background or misses parts.`;
}

function objectText(task: PlacementTask) {
  return `Object: ${task.objectName}.${task.description ? ` ${task.description}` : ''}
Image 1: the photo, with this object outlined in magenta. Image 2: turntable of the asset at yaws ${task.yaws.join(', ')}°.`;
}

function images(task: PlacementTask): ChatContent[] {
  return [
    { type: 'text', text: 'Image 1 (photo):' },
    { type: 'image_url', image_url: { url: toDataUrl(task.photo, 'image/jpeg') } },
    { type: 'text', text: 'Image 2 (asset turntable):' },
    { type: 'image_url', image_url: { url: toDataUrl(task.turntable, 'image/jpeg') } },
  ];
}

// ---------- direct ----------

const DIRECT_SCHEMA = {
  type: 'object',
  properties: {
    observations: { type: 'string', description: 'Which way the object faces in the photo, where it meets the ground, what is hidden or cut off.' },
    base_point: {
      type: 'object',
      properties: { x: { type: 'number', minimum: 0, maximum: 1000 }, y: { type: 'number', minimum: 0, maximum: 1000 } },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    height_m: { type: 'number', description: 'Real height of the object, metres.' },
    yaw_deg: { type: 'number', minimum: 0, maximum: 360 },
    pitch_deg: { type: 'number', minimum: -90, maximum: 90 },
    roll_deg: { type: 'number', minimum: -90, maximum: 90 },
    confidence: {
      type: 'object',
      properties: { position: { type: 'number', minimum: 0, maximum: 1 }, scale: { type: 'number', minimum: 0, maximum: 1 }, yaw: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['position', 'scale', 'yaw'],
      additionalProperties: false,
    },
    defer: {
      type: 'object',
      description: 'For each quantity, true if the geometric fitter should decide it instead of you.',
      properties: { position: { type: 'boolean' }, scale: { type: 'boolean' }, yaw: { type: 'boolean' } },
      required: ['position', 'scale', 'yaw'],
      additionalProperties: false,
    },
    preference: {
      type: 'string',
      enum: ['own', 'refine', 'fitter'],
      description: '"own": use your placement as is. "refine": start the fitter from your placement and let it refine. "fitter": let the fitter decide everything.',
    },
    rationale: { type: 'string', description: 'One or two sentences on why.' },
  },
  required: ['observations', 'base_point', 'height_m', 'yaw_deg', 'pitch_deg', 'roll_deg', 'confidence', 'defer', 'preference', 'rationale'],
  additionalProperties: false,
};

export interface DirectAnswer {
  observations: string;
  base_point: { x: number; y: number };
  height_m: number;
  yaw_deg: number;
  pitch_deg: number;
  roll_deg: number;
  confidence: { position: number; scale: number; yaw: number };
  defer: { position: boolean; scale: boolean; yaw: boolean };
  preference: 'own' | 'refine' | 'fitter';
  rationale: string;
}

export interface LlmRunInfo {
  costUsd: number;
  latencyMs: number;
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export async function directPlacement(task: PlacementTask, model: string, opts: { spend: Spend; fresh: boolean; effort: Effort }): Promise<{ answer: DirectAnswer | null; placement: Placement | null; info: LlmRunInfo }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: conventions(task) },
    {
      role: 'user',
      content: [
        { type: 'text', text: `${objectText(task)}\nPlace the asset. Give your own best estimate for every field, and mark in "defer" what the geometric fitter should decide instead.` },
        ...images(task),
      ],
    },
  ];
  const info: LlmRunInfo = { costUsd: 0, latencyMs: 0, calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0 };
  try {
    const r = await cachedChat(
      { model, messages, schema: { name: 'Placement', schema: DIRECT_SCHEMA }, reasoningEffort: opts.effort, maxTokens: 24000 },
      { spend: opts.spend, fresh: opts.fresh, label: `bench placement direct ${model}: ${task.label}` },
    );
    Object.assign(info, { latencyMs: r.latencyMs, calls: 1, cachedCalls: r.cached ? 1 : 0, costUsd: r.cached ? 0 : r.costUsd, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens });
    if (!r.message.content) throw new Error(`no content (finish_reason ${r.finishReason})`);
    const answer = JSON.parse(r.message.content) as DirectAnswer;
    const placement = task.place({ base_x: answer.base_point.x, base_y: answer.base_point.y, height_m: answer.height_m, yaw_deg: answer.yaw_deg, pitch_deg: answer.pitch_deg, roll_deg: answer.roll_deg });
    return { answer, placement, info };
  } catch (err) {
    info.error = err instanceof BudgetExceeded ? `skipped: ${err.message}` : errorMessage(err);
    return { answer: null, placement: null, info };
  }
}

// ---------- agent ----------

const placementParams = (extra: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties: {
    base_x: { type: 'number', description: 'Base pivot x on the 0-1000 grid of image 1.' },
    base_y: { type: 'number', description: 'Base pivot y on the 0-1000 grid of image 1.' },
    height_m: { type: 'number', description: 'Real height of the object, metres.' },
    yaw_deg: { type: 'number', description: 'Yaw in degrees, turntable convention.' },
    pitch_deg: { type: 'number', description: 'Forward/back lean in degrees (0 = upright).' },
    roll_deg: { type: 'number', description: 'Sideways lean in degrees (0 = upright).' },
    ...extra,
  },
  required: ['base_x', 'base_y', 'height_m', 'yaw_deg', ...required],
  additionalProperties: false,
});

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'render_placement',
      description: 'Place the asset with these parameters and score it against the photo. Returns the silhouette IoU with the object mask, the depth agreement with MoGe-2, the gap between the asset bottom and the ground, and sends an overlay image (asset blended in, its outline in cyan, the mask in magenta) in the next message.',
      parameters: placementParams(),
    },
  },
  {
    type: 'function',
    function: {
      name: 'auto_fit',
      description: 'Run the updated geometric fitter: compare the original search with 32-round refinement that preserves fitted position and scale while trying angle changes. Both stay upright and rest on the ground; return the placement with higher scored silhouette IoU, keeping the original on ties. Optionally restrict yaw to yaw_center_deg ± yaw_window_deg. Returns placement parameters, scores, and an overlay image in the next message.',
      parameters: {
        type: 'object',
        properties: {
          yaw_center_deg: { type: 'number', description: 'Centre of the yaw search, degrees.' },
          yaw_window_deg: { type: 'number', description: 'Half-width of the yaw search, 10-180 degrees. Omit both for a full search.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'measure_depth',
      description: 'Metric depth (MoGe-2) at up to 8 points of image 1: distance from the camera, whether the surface there is ground, and where the camera ray through the point meets the ground plane.',
      parameters: {
        type: 'object',
        properties: {
          points: {
            type: 'array',
            maxItems: 8,
            items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
          },
        },
        required: ['points'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_placement',
      description: 'Submit the final placement. Call exactly once, at the end.',
      parameters: placementParams(
        {
          source: { type: 'string', enum: ['own', 'fitter', 'fitter_refined', 'mixed'], description: 'Where the final numbers come from.' },
          rationale: { type: 'string', description: 'One or two sentences.' },
        },
        ['pitch_deg', 'roll_deg', 'source', 'rationale'],
      ),
    },
  },
];

export interface ToolStep {
  tool: string;
  args: unknown;
  result: unknown;
}

export interface AgentOutcome {
  placement: Placement | null;
  submitted: (PlacementArgs & { source: string; rationale: string }) | null;
  steps: ToolStep[];
  info: LlmRunInfo;
}

const MAX_TOOL_CALLS = 8;

export async function agentPlacement(
  task: PlacementTask,
  model: string,
  opts: { spend: Spend; fresh: boolean; effort: Effort; ledger?: boolean; /** Accept the last scored placement when the run stops early (default true). */ partialOk?: boolean },
): Promise<AgentOutcome> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${conventions(task)}

Placement technique: ${PLACEMENT_AGENT_REVISION}.
You have tools. Start with auto_fit to establish a checked placement using the updated fitter. It compares the original and polished upright fits and keeps the one with higher silhouette IoU. Inspect its overlay; render_placement scores any adjustment you propose, and measure_depth reads metric depth. Then call submit_placement once. When keeping an auto_fit result, copy its returned placement parameters exactly. You may make at most ${MAX_TOOL_CALLS} tool calls before submitting.`,
    },
    { role: 'user', content: [{ type: 'text', text: `${objectText(task)}\nPlace the asset, then call submit_placement.` }, ...images(task)] },
  ];
  const info: LlmRunInfo = { costUsd: 0, latencyMs: 0, calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0 };
  const steps: ToolStep[] = [];
  const fitted: { args: PlacementArgs; placement: Placement }[] = [];
  let lastScored: Placement | null = null;
  let submitted: AgentOutcome['submitted'] = null;
  let nudged = false;
  try {
    for (let turn = 0; turn < MAX_TOOL_CALLS + 3 && !submitted; turn++) {
      const r = await cachedChat(
        { model, messages, tools: TOOLS, reasoningEffort: opts.effort, maxTokens: 16000, parallelToolCalls: false },
        { spend: opts.spend, fresh: opts.fresh, ledger: opts.ledger, label: `bench placement agent ${model}: ${task.label} turn ${turn}` },
      );
      info.calls++;
      info.cachedCalls += r.cached ? 1 : 0;
      info.costUsd += r.cached ? 0 : r.costUsd;
      info.latencyMs += r.latencyMs;
      info.inputTokens += r.usage.inputTokens;
      info.outputTokens += r.usage.outputTokens;
      const calls = r.message.tool_calls ?? [];
      if (!calls.length) {
        if (nudged) break;
        nudged = true;
        messages.push({ role: 'assistant', content: r.message.content ?? '', ...(r.message.responseItems ? { responseItems: r.message.responseItems } : {}) });
        messages.push({ role: 'user', content: 'Call submit_placement with your final placement now.' });
        continue;
      }
      messages.push({ role: 'assistant', content: r.message.content ?? '', tool_calls: calls, ...(r.message.responseItems ? { responseItems: r.message.responseItems } : {}) });
      const followUps: ChatContent[] = [];
      for (const tc of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          // leave empty; the tool reports the problem
        }
        let result: unknown;
        const budgetLeft = MAX_TOOL_CALLS - steps.length;
        if (tc.function.name === 'submit_placement') {
          submitted = args as unknown as NonNullable<AgentOutcome['submitted']>;
          result = { ok: true };
        } else if (budgetLeft <= 0) {
          result = { error: 'Tool budget used up. Call submit_placement now.' };
        } else if (tc.function.name === 'render_placement') {
          const p = task.place(args as unknown as PlacementArgs);
          if (!p) {
            result = { error: 'That base point does not reach the ground or a valid depth; move it onto the ground.' };
          } else {
            const s = await task.score(p);
            lastScored = p;
            result = summarize(s);
            followUps.push({ type: 'text', text: `Overlay for render_placement (yaw ${r1(p.yawDeg)}°, height ${p.heightM.toFixed(2)} m):` }, { type: 'image_url', image_url: { url: toDataUrl(s.overlay, 'image/jpeg') } });
          }
        } else if (tc.function.name === 'auto_fit') {
          const c = typeof args.yaw_center_deg === 'number' ? args.yaw_center_deg : undefined;
          const w = typeof args.yaw_window_deg === 'number' ? Math.min(180, Math.max(10, args.yaw_window_deg)) : undefined;
          const s = await task.autoFit(c, c === undefined ? undefined : w ?? 30);
          lastScored = s.placement;
          const fitArgs = { base_x: r1(s.grid.x), base_y: r1(s.grid.y), height_m: r3(s.placement.heightM), yaw_deg: r1(s.placement.yawDeg), pitch_deg: 0, roll_deg: 0 };
          fitted.push({ args: fitArgs, placement: s.placement });
          result = { placement: fitArgs, ...summarize(s) };
          followUps.push({ type: 'text', text: `Overlay for auto_fit (yaw ${r1(s.placement.yawDeg)}°, height ${s.placement.heightM.toFixed(2)} m):` }, { type: 'image_url', image_url: { url: toDataUrl(s.overlay, 'image/jpeg') } });
        } else if (tc.function.name === 'measure_depth') {
          const pts = Array.isArray(args.points) ? (args.points as { x: number; y: number }[]).slice(0, 8) : [];
          result = { points: task.measure(pts) };
        } else {
          result = { error: `unknown tool ${tc.function.name}` };
        }
        if (tc.function.name !== 'submit_placement') steps.push({ tool: tc.function.name, args, result });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      if (followUps.length && !submitted) messages.push({ role: 'user', content: followUps });
    }
  } catch (err) {
    info.error = err instanceof BudgetExceeded ? `stopped: ${err.message}` : errorMessage(err);
  }
  let placement: Placement | null = null;
  if (submitted) {
    // Reuse the exact scored pose when the agent copies a fit, rather than round-tripping 1 mm / 0.1°.
    const keys = ['base_x', 'base_y', 'height_m', 'yaw_deg', 'pitch_deg', 'roll_deg'] as const;
    const fit = submitted.source === 'fitter' || submitted.source === 'fitter_refined'
      ? fitted.findLast((f) => keys.every((k) => submitted![k] === f.args[k])) : undefined;
    placement = fit?.placement ?? task.place(submitted);
  }
  if (!placement && lastScored && (opts.partialOk ?? true)) {
    placement = lastScored;
    info.error ??= 'did not submit; using its last scored placement';
  }
  return { placement, submitted, steps, info };
}

function summarize(s: Scored) {
  return {
    iou_with_mask: r3(s.metrics.iou),
    depth_error_ln: Number.isFinite(s.metrics.depthErr) ? r3(s.metrics.depthErr) : null,
    color_error: r3(s.metrics.colorErr),
    bottom_above_ground_m: r3(s.metrics.contactGapM),
    note: 'Overlay image follows in the next message.',
  };
}
