// The alignment of a split person, as one job with files in and files out. It runs in a worker thread (alignWorker.ts) so the
// server stays responsive: the chain takes a minute or two of plain CPU work.
//
//   1. warp each part onto the photo's pixels (warp.ts),
//   2. close the gaps that open between the parts when the camera moves (holefill.ts), into the body,
//   3. make the head's eyes, brows, lips and nose reproduce the photo (corrector.ts).
//
// The poses are the silhouette fitter's and do not change: the warp moves Gaussians sideways in the photo's view, so depth stays as it was.
// Steps 2 and 3 are improvements on a result that is already usable: if one fails, the job reports it in `notes` and carries on without it.
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { correctRegions, type Region } from './corrector.ts';
import { FILL_VIEWS, appendFillers, fillSeamGaps, type OrbitSettings } from './holefill.ts';
import { makeCamera, readSplatPly, writeSplatPly, type SplatPose } from './splat.ts';
import { warpAlign } from './warp.ts';

export interface AlignJob {
  photoFile: string;
  /** The picture behind the person (the clean plate), seen through any gap. */
  backdropFile: string;
  headPly: string;
  bodyPly: string;
  headPose: SplatPose;
  bodyPose: SplatPose;
  headMask: string;
  bodyMask: string;
  /** Face region masks by name (eyes, brows, lips, nose). */
  regions: Record<string, string>;
  fovY: number;
  outHead: string;
  outBody: string;
  options?: { warpPasses?: number; seamFill?: boolean; corrector?: boolean };
}

export interface AlignResult {
  warp: { head: { warped: number; meanShiftPx: number }; body: { warped: number; meanShiftPx: number } };
  seamPatches: number;
  seamPhotoChange: number;
  corrector: { added: number; refit: number; regions: string[]; outsideMaxChange: number; metrics: { name: string; colorErrorBefore: number; colorErrorAfter: number; detailBefore: number; detailAfter: number }[] } | null;
  /** Parts of the job that failed and were left out (the warp itself either applies or the whole job fails). */
  notes: string[];
  seconds: number;
}

/** How far each region's mask is grown first: SAM draws the eyes tightly, the lips and nose less so. */
const GROW: Record<string, number> = { eyes: 8, brows: 5, lips: 4, nose: 3 };

async function maskBytes(file: string, size?: { w: number; h: number }): Promise<Uint8Array> {
  const img = sharp(file);
  if (size) {
    const meta = await img.metadata();
    if (meta.width !== size.w || meta.height !== size.h) throw new Error(`${file} is ${meta.width}x${meta.height}, the photo is ${size.w}x${size.h}`);
  }
  return Uint8Array.from(await img.extractChannel(0).raw().toBuffer(), (v) => (v >= 128 ? 1 : 0));
}

const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 160);

export async function runAlignJob(job: AlignJob, log: (msg: string) => void = () => undefined): Promise<AlignResult> {
  const t0 = Date.now();
  const meta = await sharp(job.photoFile).metadata();
  const W = meta.width!, H = meta.height!;
  const photo = new Uint8Array(await sharp(job.photoFile).removeAlpha().raw().toBuffer());
  const backdrop = new Uint8Array(await sharp(job.backdropFile).removeAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer());
  const headMask = await maskBytes(job.headMask, { w: W, h: H }), bodyMask = await maskBytes(job.bodyMask, { w: W, h: H });
  const woman = Uint8Array.from(headMask, (v, i) => (v | bodyMask[i]) as number);
  const opts = job.options ?? {};
  const notes: string[] = [];

  // 1. warp (required)
  const passes = opts.warpPasses ?? 3;
  const head = warpAlign({ width: W, height: H, fovY: job.fovY, photo, ply: readSplatPly(job.headPly), pose: job.headPose, partMask: headMask, otherMask: bodyMask, woman, passes }, (m) => log(`head ${m}`));
  const body = warpAlign({ width: W, height: H, fovY: job.fovY, photo, ply: readSplatPly(job.bodyPly), pose: job.bodyPose, partMask: bodyMask, otherMask: headMask, woman, passes }, (m) => log(`body ${m}`));
  // the displacement that mattered is the first pass's (later passes only polish)
  const shift = (r: typeof head) => ({ warped: r.stats[0].moved, meanShiftPx: r.stats[0].meanShift });

  // 2. seam fill, into the body: the cameras look at the middle of the two parts, from a distance that frames them
  let bodyPly = body.ply, patches = 0, photoChange = 0;
  const photoCam = makeCamera({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: job.fovY, width: W, height: H });
  if (opts.seamFill !== false) {
    try {
      const mid = [0, 1, 2].map((i) => (job.headPose.position[i] + job.bodyPose.position[i]) / 2) as [number, number, number];
      const orbit: OrbitSettings = { target: mid, dist: Math.max(0.6, Math.hypot(mid[0], mid[1], mid[2]) * 1.0), fovY: 30, width: 640, height: 512 };
      const fill = fillSeamGaps({ ply: head.ply, pose: job.headPose }, { ply: body.ply, pose: job.bodyPose }, orbit, photoCam, { views: FILL_VIEWS }, (m) => log(m));
      bodyPly = appendFillers(body.ply, job.bodyPose, fill.fillers);
      patches = fill.fillers.length;
      photoChange = fill.photoChange.colour;
    } catch (err) {
      notes.push(`the seam fill was skipped: ${why(err)}`);
      log(`seam fill failed, carrying on without it: ${why(err)}`);
      bodyPly = body.ply; patches = 0; photoChange = 0;
    }
  }

  // 3. the corrector, on the head
  let headPly = head.ply;
  let corrector: AlignResult['corrector'] = null;
  if (opts.corrector !== false) {
    const regions: Region[] = [];
    for (const name of Object.keys(job.regions)) {
      if (!existsSync(job.regions[name])) continue;
      try { regions.push({ name, mask: await maskBytes(job.regions[name], { w: W, h: H }), grow: GROW[name] ?? 4 }); }
      catch (err) { notes.push(`the ${name} region was skipped: ${why(err)}`); log(`the ${name} region is unusable, leaving it out: ${why(err)}`); }
    }
    if (regions.length) {
      try {
        const res = correctRegions({ width: W, height: H, fovY: job.fovY, photo, backdrop, parts: [{ ply: head.ply, pose: job.headPose }, { ply: bodyPly, pose: job.bodyPose }], target: 0, regions }, (m) => log(m));
        headPly = res.ply;
        corrector = {
          added: res.added, refit: res.refit, regions: regions.map((r) => r.name), outsideMaxChange: res.outside.maxChange,
          metrics: res.before.fit.map((b, i) => ({ name: b.name, colorErrorBefore: b.colorError, colorErrorAfter: res.after.fit[i].colorError, detailBefore: b.detailMatch, detailAfter: res.after.fit[i].detailMatch })),
        };
      } catch (err) {
        notes.push(`the detail corrector was skipped: ${why(err)}`);
        log(`the detail corrector failed, carrying on without it: ${why(err)}`);
        headPly = head.ply;
      }
    }
  }
  await writeSplatPly(job.outHead, headPly);
  await writeSplatPly(job.outBody, bodyPly);
  return { warp: { head: shift(head), body: shift(body) }, seamPatches: patches, seamPhotoChange: photoChange, corrector, notes, seconds: (Date.now() - t0) / 1000 };
}
