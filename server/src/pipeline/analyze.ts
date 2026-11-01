// Muse Spark (or Muse Wonder) reads the photo and writes the scene plan: which objects become their own
// meshes, where they are, how to erase them, and how the surrounding world should look.
import { chatJson, toDataUrl } from '../clients/meta.ts';
import type { Box, PlannedObject, PlannerModel, ScenePlan } from '../types.ts';
import { clamp } from '../util.ts';

const box = {
  type: 'object',
  properties: {
    x_min: { type: 'integer', minimum: 0, maximum: 1000 },
    y_min: { type: 'integer', minimum: 0, maximum: 1000 },
    x_max: { type: 'integer', minimum: 0, maximum: 1000 },
    y_max: { type: 'integer', minimum: 0, maximum: 1000 },
  },
  required: ['x_min', 'y_min', 'x_max', 'y_max'],
  additionalProperties: false,
};

const SCENE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short evocative title for this memory, 2-6 words.' },
    summary: { type: 'string', description: 'One or two sentences describing the scene.' },
    style: { type: 'string', enum: ['photo', 'illustration', 'render', 'other'] },
    setting: { type: 'string', enum: ['indoor', 'outdoor', 'mixed'] },
    objects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Specific name, e.g. "golden retriever".' },
          segment_prompt: { type: 'string', description: 'Short noun phrase (1-3 words) naming this object for a segmentation model.' },
          description: { type: 'string', description: 'For a 3D artist: shape, materials, colors and distinctive details. 1-2 sentences. No background.' },
          box,
          point: {
            type: 'object',
            properties: { x: { type: 'integer', minimum: 0, maximum: 1000 }, y: { type: 'integer', minimum: 0, maximum: 1000 } },
            required: ['x', 'y'],
            additionalProperties: false,
          },
          occluded: { type: 'boolean', description: 'True if another object hides a noticeable part of it.' },
          truncated: { type: 'boolean', description: 'True if the image border cuts it off.' },
          contact: { type: 'string', enum: ['floor', 'surface', 'wall', 'hanging', 'held', 'free'] },
          importance: { type: 'integer', minimum: 1, maximum: 5 },
          approx_size_m: {
            type: 'object',
            properties: {
              width: { type: 'number' },
              height: { type: 'number' },
              depth: { type: 'number' },
            },
            required: ['width', 'height', 'depth'],
            additionalProperties: false,
          },
        },
        required: ['name', 'segment_prompt', 'description', 'box', 'point', 'occluded', 'truncated', 'contact', 'importance', 'approx_size_m'],
        additionalProperties: false,
      },
    },
    has_overlay_text: { type: 'boolean', description: 'True if captions, titles, watermarks or logos are overlaid on the image.' },
    removal_prompt: { type: 'string' },
    world_prompt: { type: 'string' },
  },
  required: ['title', 'summary', 'style', 'setting', 'objects', 'has_overlay_text', 'removal_prompt', 'world_prompt'],
  additionalProperties: false,
};

interface RawPlan {
  title: string;
  summary: string;
  style: ScenePlan['style'];
  setting: ScenePlan['setting'];
  objects: {
    name: string;
    segment_prompt: string;
    description: string;
    box: { x_min: number; y_min: number; x_max: number; y_max: number };
    point: { x: number; y: number };
    occluded: boolean;
    truncated: boolean;
    contact: PlannedObject['contact'];
    importance: number;
    approx_size_m: { width: number; height: number; depth: number };
  }[];
  has_overlay_text: boolean;
  removal_prompt: string;
  world_prompt: string;
}

function systemPrompt(maxObjects: number) {
  return `You are the scene director for "World of a Memory", an app that rebuilds one photo as an explorable 3D world.
The world is assembled from two parts:
1. A surrounding world generated from a copy of the photo with the chosen objects erased.
2. A separate, high-quality 3D mesh for each chosen object, placed back where it stands using a depth map.

Choose up to ${maxObjects} objects to rebuild as separate meshes, most important first.
Good choices: people, animals, furniture, vehicles, bicycles, sculptures, potted plants, and other solid, compact things in the foreground or middle ground that a viewer would want to walk around.
Do not choose: ground, floors, lawns, roads, walls, ceilings, fences, hedges, sky, water, terrain, trees rooted in the landscape, buildings or structures that make up the environment, flat things (rugs, posters, paintings), thin things (wires, poles, railings), objects smaller than about 2% of the image, crowds, or anything mostly hidden.
Never split one object into parts and never pick an object that is part of another chosen object. Choose fewer objects, or none, when nothing qualifies.

Coordinates use a 0-1000 grid over the image: x from left (0) to right (1000), y from top (0) to bottom (1000).
For each object:
- box: tight box around its visible pixels.
- point: a point clearly inside the object, away from its edges and not on another object.
- segment_prompt: a short noun phrase such as "dog" or "red bicycle", no articles or verbs.
- description: what a 3D artist needs: shape, materials, colors and distinctive details of the object alone.
- occluded / truncated: whether something in front hides part of it, or the image border cuts it off.
- contact: what it rests on. approx_size_m: real-world size in meters.

removal_prompt: an instruction for an image editor that removes exactly the chosen objects (name each one and where it is) and any overlaid captions, titles, watermarks or logos, and fills the revealed areas with what would be behind them, continuing the existing ground, walls and background. If no objects are chosen, only remove overlaid text, or say to keep the image unchanged.
world_prompt: 2-4 sentences describing the environment without the removed objects, including what plausibly lies beyond the frame, the materials, the time of day and the lighting, in the same visual style as the image. This guides a 3D world generator.
title: a short, warm title for the memory.`;
}

function toBox(b: RawPlan['objects'][number]['box']): Box {
  const x0 = clamp(Math.min(b.x_min, b.x_max), 0, 1000);
  const x1 = clamp(Math.max(b.x_min, b.x_max), 0, 1000);
  const y0 = clamp(Math.min(b.y_min, b.y_max), 0, 1000);
  const y1 = clamp(Math.max(b.y_min, b.y_max), 0, 1000);
  return { x0, y0, x1, y1 };
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'object';
}

export async function analyzeScene(opts: {
  imageJpeg: Uint8Array;
  model: PlannerModel;
  maxObjects: number;
}): Promise<{ plan: ScenePlan; costUsd: number }> {
  const { data, costUsd } = await chatJson<RawPlan>({
    model: opts.model,
    system: systemPrompt(Math.max(0, opts.maxObjects)),
    content: [
      { type: 'text', text: 'Here is the memory to rebuild. Return the scene plan as JSON.' },
      { type: 'image_url', image_url: { url: toDataUrl(opts.imageJpeg, 'image/jpeg') } },
    ],
    schemaName: 'ScenePlan',
    schema: SCENE_SCHEMA,
    reasoningEffort: opts.model === 'muse-wonder-1.0' ? 'medium' : 'high',
  });

  const used = new Set<string>();
  const objects: PlannedObject[] = [];
  const sorted = [...(data.objects ?? [])].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  for (const o of sorted) {
    if (objects.length >= opts.maxObjects) break;
    const b = toBox(o.box);
    // Skip degenerate boxes (less than 1% of the image in either direction).
    if (b.x1 - b.x0 < 10 || b.y1 - b.y0 < 10) continue;
    let id = slug(o.name);
    for (let i = 2; used.has(id); i++) id = `${slug(o.name)}-${i}`;
    used.add(id);
    const px = clamp(o.point?.x ?? (b.x0 + b.x1) / 2, b.x0, b.x1);
    const py = clamp(o.point?.y ?? (b.y0 + b.y1) / 2, b.y0, b.y1);
    objects.push({
      id,
      name: o.name,
      segmentPrompt: (o.segment_prompt || o.name).trim(),
      description: o.description ?? '',
      box: b,
      point: { x: px, y: py },
      occluded: Boolean(o.occluded),
      truncated: Boolean(o.truncated),
      contact: o.contact ?? 'floor',
      importance: clamp(Math.round(o.importance ?? 3), 1, 5),
      approxSizeM: {
        width: Math.max(0.01, Number(o.approx_size_m?.width) || 0.5),
        height: Math.max(0.01, Number(o.approx_size_m?.height) || 0.5),
        depth: Math.max(0.01, Number(o.approx_size_m?.depth) || 0.5),
      },
    });
  }

  const plan: ScenePlan = {
    title: (data.title || 'A memory').trim(),
    summary: data.summary ?? '',
    style: data.style ?? 'photo',
    setting: data.setting ?? 'outdoor',
    objects,
    removalPrompt: data.removal_prompt ?? '',
    worldPrompt: data.world_prompt ?? '',
    hasOverlayText: Boolean(data.has_overlay_text),
  };
  return { plan, costUsd };
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    remaining: {
      type: 'array',
      description: 'Names (exactly as listed) of objects that are still visible, fully or partly, in the edited image.',
      items: { type: 'string' },
    },
    overlay_text_remaining: { type: 'boolean' },
    framing_preserved: { type: 'boolean', description: 'True if the edited image keeps the same camera, framing and background layout.' },
    notes: { type: 'string' },
  },
  required: ['remaining', 'overlay_text_remaining', 'framing_preserved', 'notes'],
  additionalProperties: false,
};

export interface CleanPlateReview {
  remaining: string[];
  overlay_text_remaining: boolean;
  framing_preserved: boolean;
  notes: string;
}

/** Muse Spark checks Muse Image's object removal against the original. */
export async function reviewCleanPlate(opts: {
  originalJpeg: Uint8Array;
  cleanJpeg: Uint8Array;
  objectNames: string[];
  model: PlannerModel;
}): Promise<{ review: CleanPlateReview; costUsd: number }> {
  const { data, costUsd } = await chatJson<CleanPlateReview>({
    model: opts.model,
    system:
      'You are a meticulous photo editor reviewing an object-removal edit. Image 1 is the original, image 2 is the edit. ' +
      'Report which of the listed objects are still visible in image 2, whether overlaid text or watermarks remain, and whether the edit kept the same camera framing and background layout. ' +
      'Ignore small inpainting artifacts.',
    content: [
      { type: 'text', text: `Objects that should be gone: ${opts.objectNames.map((n) => `"${n}"`).join(', ') || '(none)'}.` },
      { type: 'text', text: 'Image 1 (original):' },
      { type: 'image_url', image_url: { url: toDataUrl(opts.originalJpeg, 'image/jpeg') } },
      { type: 'text', text: 'Image 2 (edited):' },
      { type: 'image_url', image_url: { url: toDataUrl(opts.cleanJpeg, 'image/jpeg') } },
    ],
    schemaName: 'CleanPlateReview',
    schema: REVIEW_SCHEMA,
    reasoningEffort: 'low',
    maxTokens: 4000,
  });
  return { review: data, costUsd };
}
