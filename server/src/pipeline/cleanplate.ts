// Muse Image erases the chosen objects to produce the "clean plate" the surrounding world grows from.
// Muse Spark reviews each attempt and asks for a follow-up edit when something was left behind.
import sharp from 'sharp';
import { MUSE_IMAGE_PRICE_USD, museImageEdit, toDataUrl } from '../clients/meta.ts';
import type { PlannerModel, ScenePlan } from '../types.ts';
import { errorMessage } from '../util.ts';
import { reviewCleanPlate, type CleanPlateReview } from './analyze.ts';

const KEEP =
  'Also remove the shadows and reflections they cast. Keep everything else exactly as it is: the same camera position, framing, perspective, lighting, colors and style. ' +
  'Do not add anything new, and do not crop, zoom, shift or change the aspect ratio. The result must look like the same image taken without those objects.';

/** Resize an edit result back onto the source pixel grid. */
async function toSourceGrid(png: Buffer, width: number, height: number): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const aspectIn = (meta.width ?? width) / (meta.height ?? height);
  const aspectOut = width / height;
  const fit = Math.abs(aspectIn / aspectOut - 1) < 0.03 ? 'fill' : 'cover';
  return sharp(png).resize(width, height, { fit, kernel: 'lanczos3' }).removeAlpha().jpeg({ quality: 92 }).toBuffer();
}

export async function makeCleanPlate(opts: {
  sourceJpeg: Buffer;
  width: number;
  height: number;
  plan: ScenePlan;
  objectNames: string[];
  reviewer: PlannerModel;
  log: (msg: string) => void;
}): Promise<{ jpeg: Buffer; costUsd: number; review?: CleanPlateReview; attempts: number }> {
  const { sourceJpeg, width, height, plan } = opts;
  let costUsd = 0;
  if (opts.objectNames.length === 0 && !plan.hasOverlayText) {
    return { jpeg: sourceJpeg, costUsd, attempts: 0 };
  }
  const size = `${width}x${height}`;
  const baseInstruction = plan.removalPrompt?.trim() ||
    `Remove ${opts.objectNames.map((n) => `the ${n}`).join(', ')} from this image and fill the revealed areas with what would be behind them.`;

  let current = await toSourceGrid(
    await museImageEdit({ prompt: `${baseInstruction} ${KEEP}`, images: [toDataUrl(sourceJpeg, 'image/jpeg')], size }),
    width,
    height,
  );
  costUsd += MUSE_IMAGE_PRICE_USD;
  let attempts = 1;
  let review: CleanPlateReview | undefined;

  for (let round = 0; round < 2; round++) {
    try {
      const r = await reviewCleanPlate({ originalJpeg: sourceJpeg, cleanJpeg: current, objectNames: opts.objectNames, model: opts.reviewer });
      costUsd += r.costUsd;
      review = r.review;
    } catch (err) {
      opts.log(`Clean plate review skipped: ${errorMessage(err)}`);
      break;
    }
    const remaining = review.remaining.filter((n) => opts.objectNames.some((o) => o.toLowerCase() === n.toLowerCase()));
    const needsText = plan.hasOverlayText && review.overlay_text_remaining;
    if (!review.framing_preserved) {
      opts.log('Muse Spark: the edit changed the framing; retrying from the original');
      current = await toSourceGrid(
        await museImageEdit({
          prompt: `${baseInstruction} ${KEEP} It is essential that the framing and composition stay identical to the input image.`,
          images: [toDataUrl(sourceJpeg, 'image/jpeg')],
          size,
        }),
        width,
        height,
      );
      costUsd += MUSE_IMAGE_PRICE_USD;
      attempts++;
      continue;
    }
    if (remaining.length === 0 && !needsText) break;
    const what = [...remaining.map((n) => `the ${n}`), ...(needsText ? ['all overlaid text, captions and watermarks'] : [])].join(', ');
    opts.log(`Muse Spark: still visible: ${what}; asking Muse Image for another pass`);
    current = await toSourceGrid(
      await museImageEdit({
        prompt: `Remove ${what} completely from this image and fill the area with what would be behind it, continuing the surrounding background. ${KEEP}`,
        images: [toDataUrl(current, 'image/jpeg')],
        size,
      }),
      width,
      height,
    );
    costUsd += MUSE_IMAGE_PRICE_USD;
    attempts++;
  }
  return { jpeg: current, costUsd, review, attempts };
}
