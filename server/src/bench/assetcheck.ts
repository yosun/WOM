// Asset check: does a reconstructed 3D asset hold anything that is not the object?
//
// Objects are cut out of the photo with a mask and rebuilt from that cutout. Whatever the photo showed
// through gaps in the mask (lawn between wheel spokes, a hedge behind bench slats) is rebuilt too, as flat
// sheets or lumps hanging off the object. It cannot be seen from the photo's own camera, so neither the
// placement benchmark nor compose's reprojection notices it; it shows as soon as someone walks around.
//
// The check renders the asset's turntable (the same renderer the placement agents use), asks Muse Spark
// which parts of it are not the object, and decides the verdict from the findings in code. One call per
// asset, cached by content, so repeating it is free.
//
// The same function runs in the pipeline (right after the 3D models are made), from the viewer ("Check
// assets") and in the asset-check benchmark (assets-task.ts, `npm run bench:assets`), which compares the
// verdicts with the labels in data/bench/asset-labels.json.
import type { Spend } from '@wom/metrics';
import { toDataUrl, type ChatMessage } from '../clients/meta.ts';
import type { AssetCheck, AssetFinding, AssetVerdict } from '../types.ts';
import { nowIso } from '../util.ts';
import { cachedChat } from './cache.ts';
import type { BenchAsset } from './context.ts';
import type { Effort } from './llm.ts';
import { renderTurntable, turntableTileBox } from './render.ts';

const YAWS = [0, 45, 90, 135, 180, 225, 270, 315];
/** Slightly above the horizon, like a person looking at an object while walking. */
const ELEVATION_DEG = 15;
const TILE = 288;
export const CHECK_MODEL = 'muse-spark-1.3';

const SYSTEM = `You check 3D reconstructions of single objects for "World of a Memory", an app that turns one photo into a walkable 3D scene. Each object was cut out of the photo with a mask and rebuilt as a Gaussian-splat cloud or a textured mesh.

The known failure: whatever the photo showed through gaps in the cutout (lawn between wheel spokes, a hedge behind bench slats, a wall between railings, sky between leaves) can be rebuilt as part of the object. It then appears as flat sheets or slabs filling the gaps, patches of ground, or lumps of foliage hanging off the object, and it becomes obvious when someone walks around the object.

You get eight renders of one reconstruction, turned in 45° steps and labelled with their yaw. A red cross marks the point on the ground under the object.

Belongs to the object, however thin or sparse: frame, spokes, slats, handles, leaves, stems, fur, the pot and the soil in it. Does not belong: sheets or slabs that fill the gaps between parts of the object, grass or ground wider than the object's base, chunks of hedge, foliage, wall, fence or sky attached to or floating near the object, and other objects. Do not report isolated specks, noise, low detail or sparseness.`;

const SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          what: { type: 'string', description: 'What it is, e.g. "green lawn sheet filling the front wheel".' },
          yaws: { type: 'array', items: { type: 'integer' }, description: 'Yaws (degrees, as labelled) of the views where it can be seen.' },
          severity: { type: 'string', enum: ['minor', 'major'] },
        },
        required: ['what', 'yaws', 'severity'],
        additionalProperties: false,
      },
    },
    foreign_share: { type: 'number', minimum: 0, maximum: 1, description: 'Share of the reconstruction\'s visible area, averaged over the views, that is not the object.' },
    rationale: { type: 'string', description: 'One or two sentences.' },
  },
  required: ['findings', 'foreign_share', 'rationale'],
  additionalProperties: false,
};

export interface AssetJudgement {
  verdict: AssetVerdict;
  foreignShare: number;
  findings: AssetFinding[];
  rationale: string;
}

/**
 * The verdict follows from the findings, not from the model's own label, so the thresholds are visible:
 * any major finding, or more than 12% of the visible area, is contaminated; any finding, or more than 3%,
 * is minor.
 */
export function verdictOf(findings: AssetFinding[], foreignShare: number): AssetVerdict {
  if (findings.some((f) => f.severity === 'major') || foreignShare >= 0.12) return 'contaminated';
  if (findings.length > 0 || foreignShare >= 0.03) return 'minor';
  return 'clean';
}

function parseJudgement(content: string): AssetJudgement {
  const raw = JSON.parse(content) as { findings?: unknown; foreign_share?: unknown; rationale?: unknown };
  const findings: AssetFinding[] = [];
  for (const f of Array.isArray(raw.findings) ? raw.findings.slice(0, 6) : []) {
    const o = f as Record<string, unknown>;
    const what = typeof o.what === 'string' ? o.what.trim().slice(0, 200) : '';
    if (!what) continue;
    const yaws = Array.isArray(o.yaws) ? o.yaws.filter((y): y is number => typeof y === 'number' && Number.isFinite(y)).map((y) => ((Math.round(y) % 360) + 360) % 360) : [];
    findings.push({ what, yaws: [...new Set(yaws)].sort((a, b) => a - b), severity: o.severity === 'major' ? 'major' : 'minor' });
  }
  const foreignShare = typeof raw.foreign_share === 'number' && Number.isFinite(raw.foreign_share) ? Math.min(1, Math.max(0, raw.foreign_share)) : 0;
  return { verdict: verdictOf(findings, foreignShare), foreignShare, findings, rationale: typeof raw.rationale === 'string' ? raw.rationale.trim().slice(0, 600) : '' };
}

export interface JudgeResult {
  judgement: AssetJudgement;
  /** The turntable the model saw. */
  sheet: Buffer;
  costUsd: number;
  cached: boolean;
  latencyMs: number;
}

/** Render the asset's turntable and ask the model what in it is not the object. Throws BudgetExceeded over budget. */
export async function judgeAsset(args: {
  objectName: string;
  description?: string;
  asset: BenchAsset;
  model?: string;
  effort?: Effort;
  spend: Spend;
  fresh?: boolean;
  label: string;
  /** False when the caller books the cost itself (the pipeline does, per world). */
  ledger?: boolean;
}): Promise<JudgeResult> {
  const { objectName, asset } = args;
  const sheet = await renderTurntable(asset, ELEVATION_DEG, YAWS, TILE);
  const desc = args.description?.trim();
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Object: ${objectName}.${desc ? ` ${desc}` : ''}

Look at the eight views. List each thing that is not part of the ${objectName}: what it is, the yaws where you can see it, and its severity: "major" if it is large or striking at normal viewing size (a sheet filling a wheel, a slab of hedge), "minor" if it is small or easy to miss. Then estimate foreign_share: the share of the reconstruction's visible area, averaged over the views, that is not the ${objectName} (0 when everything is the object). Return no findings when everything is the object.`,
        },
        { type: 'image_url', image_url: { url: toDataUrl(sheet, 'image/jpeg') } },
      ],
    },
  ];
  const r = await cachedChat(
    { model: args.model ?? CHECK_MODEL, messages, schema: { name: 'AssetCheck', schema: SCHEMA }, reasoningEffort: args.effort ?? 'medium', maxTokens: 8000 },
    { spend: args.spend, fresh: args.fresh ?? false, label: args.label, ledger: args.ledger },
  );
  if (!r.message.content) throw new Error(`the checker returned no answer (finish_reason ${r.finishReason})`);
  return { judgement: parseJudgement(r.message.content), sheet, costUsd: r.cached ? 0 : r.costUsd, cached: r.cached, latencyMs: r.latencyMs };
}

/**
 * The turntable tile where the worst finding shows (x0, y0, x1, y1 in sheet pixels): the first yaw of the
 * first major finding, else of the first finding. Null when no finding names one of the sheet's yaws.
 */
export function findingTile(findings: AssetFinding[]): [number, number, number, number] | null {
  for (const f of [...findings.filter((x) => x.severity === 'major'), ...findings.filter((x) => x.severity !== 'major')]) {
    const i = f.yaws.map((y) => YAWS.indexOf(y)).find((k) => k >= 0);
    if (i !== undefined) return turntableTileBox(i, TILE);
  }
  return null;
}

/** The record kept on an asset: the judgement plus which file it is about. */
export function toAssetCheck(j: AssetJudgement, meta: { model?: string; file: string; bytes: number; sheet?: string }): AssetCheck {
  return { ...j, model: meta.model ?? CHECK_MODEL, at: nowIso(), file: meta.file, bytes: meta.bytes, ...(meta.sheet ? { sheet: meta.sheet } : {}) };
}

/** A stored check still describes the asset on disk when it was made from the same file and size. */
export function checkIsCurrent(check: AssetCheck | undefined, asset: { file?: string }, bytes: number): check is AssetCheck {
  return Boolean(check && asset.file && check.file === asset.file && check.bytes === bytes);
}
