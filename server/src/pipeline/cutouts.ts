// Cut each object out of the photo using its SAM mask. When Muse Spark flagged the object as occluded
// or cut off by the frame, Muse Image completes it into a clean, whole, isolated view for Tripo.
import sharp, { type Sharp } from 'sharp';
import { MUSE_IMAGE_PRICE_USD, museImageEdit, toDataUrl } from '../clients/meta.ts';
import { maskBox, type Mask } from '../geometry/mask.ts';
import type { PlannedObject } from '../types.ts';
import { errorMessage } from '../util.ts';

export interface CutoutResult {
  rawPng: Buffer;
  finalPng: Buffer;
  completed: boolean;
  costUsd: number;
}

/** Square crop region around a box, padded, in source pixel coordinates (may extend past the image). */
function squareRegion(box: { x0: number; y0: number; x1: number; y1: number }, padFrac: number) {
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  const side = Math.ceil(Math.max(w, h) * (1 + 2 * padFrac));
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  return { left: Math.round(cx - side / 2), top: Math.round(cy - side / 2), side };
}

/** Extract a region that may extend beyond the image, padding with `background`. */
async function extractPadded(
  src: Sharp,
  width: number,
  height: number,
  region: { left: number; top: number; side: number },
  channels: 3 | 4,
  background: { r: number; g: number; b: number; alpha: number },
) {
  const { left, top, side } = region;
  const ix0 = Math.max(0, left), iy0 = Math.max(0, top);
  const ix1 = Math.min(width, left + side), iy1 = Math.min(height, top + side);
  const piece = await src.clone().extract({ left: ix0, top: iy0, width: ix1 - ix0, height: iy1 - iy0 }).png().toBuffer();
  return sharp({ create: { width: side, height: side, channels, background } })
    .composite([{ input: piece, left: ix0 - left, top: iy0 - top }])
    .png()
    .toBuffer();
}

export async function makeCutout(opts: {
  sourceJpeg: Buffer;
  width: number;
  height: number;
  mask: Mask;
  object: PlannedObject;
  complete: boolean;
  log: (msg: string) => void;
}): Promise<CutoutResult> {
  const { width, height, mask, object } = opts;
  const box = maskBox(mask);
  if (!box) throw new Error(`empty mask for ${object.name}`);

  // RGBA cutout: the photo with the mask as alpha, softened by a fraction of a pixel.
  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = mask.data[i] ? 255 : 0;
  // extractChannel keeps the output single-channel (sharp would otherwise emit sRGB with 3 channels).
  const alphaSoft = await sharp(alpha, { raw: { width, height, channels: 1 } }).blur(0.6).extractChannel(0).raw().toBuffer();
  if (alphaSoft.length !== width * height) throw new Error('unexpected alpha buffer size');
  // Materialize RGBA first: sharp applies extract() before joinChannel(), so they cannot share one pipeline.
  // (removeAlpha() would run after joinChannel() and strip the new alpha, so flatten the RGB separately.)
  const rgbRaw = await sharp(opts.sourceJpeg).removeAlpha().raw().toBuffer();
  const rgbaRaw = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgbaRaw[i * 4] = rgbRaw[i * 3];
    rgbaRaw[i * 4 + 1] = rgbRaw[i * 3 + 1];
    rgbaRaw[i * 4 + 2] = rgbRaw[i * 3 + 2];
    rgbaRaw[i * 4 + 3] = alphaSoft[i];
  }
  const rgba = sharp(rgbaRaw, { raw: { width, height, channels: 4 } });
  const region = squareRegion(box, 0.1);
  const target = Math.max(512, Math.min(1024, region.side));
  const rawPng = await sharp(await extractPadded(rgba, width, height, region, 4, { r: 0, g: 0, b: 0, alpha: 0 }))
    .resize(target, target, { kernel: 'lanczos3' })
    .png()
    .toBuffer();

  let costUsd = 0;
  const needsCompletion = opts.complete && (object.occluded || object.truncated);
  if (!needsCompletion) return { rawPng, finalPng: rawPng, completed: false, costUsd };

  // Context crop (no alpha) gives Muse Image the full picture of what hides the object.
  const contextRegion = squareRegion(box, 0.35);
  const contextPng = await sharp(
    await extractPadded(sharp(opts.sourceJpeg).removeAlpha(), width, height, contextRegion, 3, { r: 255, g: 255, b: 255, alpha: 1 }),
  )
    .resize(1024, 1024, { fit: 'inside' })
    .jpeg({ quality: 90 })
    .toBuffer();
  const onWhite = await sharp(rawPng).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
  const why = [object.occluded ? 'partly hidden by other things' : '', object.truncated ? 'cut off by the edge of the photo' : '']
    .filter(Boolean)
    .join(' and ');
  const prompt =
    `The first image is a crop of a photo showing a ${object.name} that is ${why}. The second image is the visible part of it, cut out. ` +
    `Create one clean image of the complete ${object.name} alone (${object.description}), centered with a small margin, on a plain pure white background. ` +
    'Keep exactly the same viewing angle, pose, proportions, colors, materials and details as in the photo, and reconstruct the hidden parts plausibly. ' +
    'Show nothing else: no other objects, no ground, no shadows, no text.';
  try {
    const png = await museImageEdit({
      prompt,
      images: [toDataUrl(contextPng, 'image/jpeg'), toDataUrl(onWhite, 'image/jpeg')],
      size: '1024x1024',
    });
    costUsd += MUSE_IMAGE_PRICE_USD;
    const finalPng = await sharp(png).resize(1024, 1024, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).png().toBuffer();
    return { rawPng, finalPng, completed: true, costUsd };
  } catch (err) {
    opts.log(`Muse Image could not complete ${object.name} (${errorMessage(err)}); using the visible cutout`);
    return { rawPng, finalPng: rawPng, completed: false, costUsd };
  }
}
