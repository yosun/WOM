// SAM 3.1 turns Muse Spark's boxes into pixel masks. For every object we run two prompts:
// a box+point prompt (all objects in one request) and a concept prompt (the object's noun phrase).
// Box prompts are precise for solid objects; concept prompts capture foliage, spokes and other
// fragmented shapes far better. The candidate that best fits the planned box wins.
import { buildObjectPrompt, decodeMaskToRaster, formats, recordsOfKind } from '@meta-sam/parser';
import { SAM_IMAGE_PRICE_USD, samSegment } from '../clients/meta.ts';
import { boxArea, boxIou, cleanComponents, emptyMask, gridBoxToPixels, maskArea, maskBox, type Mask } from '../geometry/mask.ts';
import type { Box, PlannedObject } from '../types.ts';
import { errorMessage } from '../util.ts';

interface SamInstance {
  objectId: string;
  mask: Mask;
  box: Box;
  confidence?: number;
}

export function parseSamOutput(text: string, width: number, height: number): SamInstance[] {
  const parser = formats.segmentation.image().createParser();
  parser.push(text);
  const { result } = parser.finish({ status: 'completed' });
  const out: SamInstance[] = [];
  for (const rec of recordsOfKind(result.records, 'mask')) {
    const raster = decodeMaskToRaster(rec.mask);
    const full = emptyMask(width, height);
    const { left, top } = rec.bounds;
    for (let y = 0; y < rec.mask.height; y++) {
      const fy = top + y;
      if (fy < 0 || fy >= height) continue;
      for (let x = 0; x < rec.mask.width; x++) {
        const fx = left + x;
        if (fx < 0 || fx >= width) continue;
        if (raster[y * rec.mask.width + x]) full.data[fy * width + fx] = 1;
      }
    }
    const box = maskBox(full);
    if (!box) continue;
    out.push({ objectId: rec.objectId, mask: full, box, confidence: rec.confidence });
  }
  return out;
}

export interface SegmentResult {
  id: string;
  mask: Mask;
  box: Box;
  area: number;
  method: 'box' | 'concept';
  /** Other candidates (best first), for review by Muse Spark. */
  alternatives: { mask: Mask; box: Box; area: number; method: 'box' | 'concept' }[];
}

function expandBox(b: Box, frac: number, width: number, height: number): Box {
  const dx = (b.x1 - b.x0) * frac, dy = (b.y1 - b.y0) * frac;
  return { x0: Math.max(0, b.x0 - dx), y0: Math.max(0, b.y0 - dy), x1: Math.min(width, b.x1 + dx), y1: Math.min(height, b.y1 + dy) };
}

interface Planned {
  obj: PlannedObject;
  box: Box;
  region: Box;
  point: { x: number; y: number };
}

interface Candidate {
  mask: Mask;
  box: Box;
  area: number;
  method: 'box' | 'concept';
  score: number;
}

/** How well a mask matches the planned object: box agreement, how much of the box it fills, spill outside it. */
function scoreCandidate(mask: Mask, box: Box, area: number, p: Planned, confidence?: number) {
  const iou = boxIou(box, p.box);
  const fill = area / Math.max(1, boxArea(p.box));
  let outside = 0;
  const r = p.region;
  for (let y = box.y0; y < box.y1; y++) {
    const row = y * mask.width;
    for (let x = box.x0; x < box.x1; x++) {
      if (mask.data[row + x] && (x < r.x0 || x >= r.x1 || y < r.y0 || y >= r.y1)) outside++;
    }
  }
  const spill = outside / Math.max(1, area);
  const px = p.point.x, py = p.point.y;
  const hitsPoint = mask.data[py * mask.width + px] === 1;
  return iou + 0.6 * Math.min(fill, 1) - 1.5 * spill + (hitsPoint ? 0.1 : 0) + 0.2 * (confidence ?? 0.8);
}

function toCandidate(inst: SamInstance, p: Planned, method: 'box' | 'concept', width: number, height: number): Candidate | null {
  const mask = cleanComponents(inst.mask, p.region);
  const box = maskBox(mask);
  if (!box) return null;
  const area = maskArea(mask);
  if (boxIou(box, p.box) < 0.35) return null;
  void width; void height;
  return { mask, box, area, method, score: scoreCandidate(mask, box, area, p, inst.confidence) };
}

export async function segmentObjects(opts: {
  imageDataUrl: string;
  width: number;
  height: number;
  objects: PlannedObject[];
  log: (msg: string) => void;
}): Promise<{ results: SegmentResult[]; costUsd: number }> {
  const { width, height, objects } = opts;
  if (objects.length === 0) return { results: [], costUsd: 0 };
  let requests = 0;
  const planned: Planned[] = objects.map((o) => {
    const b = gridBoxToPixels(o.box, width, height);
    const box = { x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(width, Math.max(b.x0 + 2, b.x1)), y1: Math.min(height, Math.max(b.y0 + 2, b.y1)) };
    const point = {
      x: Math.min(width - 1, Math.max(0, Math.round((o.point.x / 1000) * width))),
      y: Math.min(height - 1, Math.max(0, Math.round((o.point.y / 1000) * height))),
    };
    return { obj: o, box, region: expandBox(box, 0.1, width, height), point };
  });

  const candidates = new Map<string, Candidate[]>(planned.map((p) => [p.obj.id, []]));

  const boxPass = async () => {
    // SAM accepts up to 16 prompted objects per request.
    for (let start = 0; start < planned.length; start += 16) {
      const chunk = planned.slice(start, start + 16);
      const prompt = buildObjectPrompt({
        size: { width, height },
        objects: chunk.map((p, i) => ({
          id: start + i + 1,
          prompts: [{ box: { left: p.box.x0, top: p.box.y0, right: p.box.x1, bottom: p.box.y1 }, points: [{ x: p.point.x, y: p.point.y }] }],
        })),
      });
      requests++;
      const instances = parseSamOutput(await samSegment(opts.imageDataUrl, prompt), width, height);
      for (const inst of instances) {
        const p = planned[Number(inst.objectId) - 1];
        if (!p) continue;
        const c = toCandidate(inst, p, 'box', width, height);
        if (c) candidates.get(p.obj.id)!.push(c);
      }
    }
  };

  const conceptPass = (p: Planned) => async () => {
    requests++;
    const instances = parseSamOutput(await samSegment(opts.imageDataUrl, p.obj.segmentPrompt), width, height);
    let best: Candidate | null = null;
    for (const inst of instances) {
      const c = toCandidate(inst, p, 'concept', width, height);
      if (c && (!best || c.score > best.score)) best = c;
    }
    if (best) candidates.get(p.obj.id)!.push(best);
  };

  const tasks = [boxPass, ...planned.map(conceptPass)].map((t) =>
    t().catch((err) => opts.log(`SAM request failed: ${errorMessage(err)}`)),
  );
  await Promise.all(tasks);

  const results: SegmentResult[] = [];
  for (const p of planned) {
    const list = candidates.get(p.obj.id)!;
    if (list.length === 0) {
      opts.log(`SAM found no mask for ${p.obj.name}; it stays part of the background`);
      continue;
    }
    list.sort((a, b) => b.score - a.score);
    const [best, ...rest] = list;
    results.push({
      id: p.obj.id,
      mask: best.mask,
      box: best.box,
      area: best.area,
      method: best.method,
      alternatives: rest.map((c) => ({ mask: c.mask, box: c.box, area: c.area, method: c.method })),
    });
  }
  return { results, costUsd: requests * SAM_IMAGE_PRICE_USD };
}
