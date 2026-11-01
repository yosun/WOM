// Muse Spark reviews SAM's mask candidates: each candidate is shown as a cutout and rated for how
// cleanly it isolates the named object. One request covers every object.
import sharp from 'sharp';
import { chatJson, toDataUrl } from '../clients/meta.ts';
import type { Mask } from '../geometry/mask.ts';
import type { Box, PlannerModel } from '../types.ts';

export interface MaskCandidate {
  objectId: string;
  objectName: string;
  mask: Mask;
  box: Box;
}

const SCHEMA = {
  type: 'object',
  properties: {
    ratings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidate: { type: 'integer', description: 'Candidate number as labeled.' },
          only_the_object: { type: 'boolean', description: 'No background, ground or other objects are included.' },
          whole_object: { type: 'boolean', description: 'All visible parts of the object are included.' },
          score: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['candidate', 'only_the_object', 'whole_object', 'score'],
        additionalProperties: false,
      },
    },
  },
  required: ['ratings'],
  additionalProperties: false,
};

interface Rating {
  candidate: number;
  only_the_object: boolean;
  whole_object: boolean;
  score: number;
}

async function cutoutPreview(source: Buffer, width: number, height: number, c: MaskCandidate): Promise<Buffer> {
  const pad = 0.08;
  const bw = c.box.x1 - c.box.x0, bh = c.box.y1 - c.box.y0;
  const x0 = Math.max(0, Math.floor(c.box.x0 - bw * pad)), y0 = Math.max(0, Math.floor(c.box.y0 - bh * pad));
  const x1 = Math.min(width, Math.ceil(c.box.x1 + bw * pad)), y1 = Math.min(height, Math.ceil(c.box.y1 + bh * pad));
  const w = x1 - x0, h = y1 - y0;
  const rgb = await sharp(source).removeAlpha().extract({ left: x0, top: y0, width: w, height: h }).raw().toBuffer();
  // Masked pixels keep their color; everything else becomes flat magenta so leaks are obvious.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (c.mask.data[(y0 + y) * width + x0 + x]) continue;
      const q = (y * w + x) * 3;
      rgb[q] = 255; rgb[q + 1] = 0; rgb[q + 2] = 255;
    }
  }
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).resize(384, 384, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
}

/** Returns a 1-5 score per candidate (same order as input). Candidates the model skipped get 3. */
export async function reviewMasks(opts: {
  source: Buffer;
  width: number;
  height: number;
  candidates: MaskCandidate[];
  model: PlannerModel;
}): Promise<{ scores: number[]; costUsd: number }> {
  const content: Parameters<typeof chatJson>[0]['content'] = [
    {
      type: 'text',
      text:
        'Each image is a cutout made by a segmentation model. Pixels it kept show the photo; everything it dropped is flat magenta. ' +
        'Rate how well each cutout isolates exactly the named object: 5 = only that object and all of its visible parts; ' +
        '3 = small leaks or small missing parts; 1 = mostly background, another object, or most of the object missing.',
    },
  ];
  for (let i = 0; i < opts.candidates.length; i++) {
    const c = opts.candidates[i];
    content.push({ type: 'text', text: `Candidate ${i + 1}: should be the ${c.objectName}.` });
    content.push({ type: 'image_url', image_url: { url: toDataUrl(await cutoutPreview(opts.source, opts.width, opts.height, c), 'image/jpeg') } });
  }
  const { data, costUsd } = await chatJson<{ ratings: Rating[] }>({
    model: opts.model,
    system: 'You are a careful image-segmentation reviewer. Judge each cutout only against the object it should contain.',
    content,
    schemaName: 'MaskReview',
    schema: SCHEMA,
    reasoningEffort: 'low',
    maxTokens: 6000,
  });
  const scores = opts.candidates.map(() => 3);
  for (const r of data.ratings ?? []) {
    const i = r.candidate - 1;
    if (i >= 0 && i < scores.length) scores[i] = Math.max(1, Math.min(5, r.score)) - (r.only_the_object ? 0 : 0.5) - (r.whole_object ? 0 : 0.25);
  }
  return { scores, costUsd };
}
