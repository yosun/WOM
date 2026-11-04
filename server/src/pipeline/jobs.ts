// Run one AI3D job with resume support: the job reference lives in the manifest, so a restarted server
// keeps polling the same job instead of paying for a new one.
import {
  chargedUsd,
  findJobByKey,
  jobErrorText,
  reservedUsd,
  submitJob,
  waitForJob,
  type Ai3dJob,
  type SubmitJobBody,
} from '../clients/ai3d.ts';
import type { WorldHandle } from '../store.ts';
import type { Ai3dJobRef } from '../types.ts';

export interface JobSlot {
  get: () => Ai3dJobRef | undefined;
  set: (ref: Ai3dJobRef) => void;
}

export async function runAi3dJob(opts: {
  world: WorldHandle;
  name: string; // stable per world, e.g. "mesh-dog"
  label: string; // for logs and cost lines
  body: SubmitJobBody;
  slot: JobSlot;
  timeoutMs: number;
  path?: string;
  onStatus?: (status: string) => void;
}): Promise<Ai3dJob> {
  const { world, slot } = opts;
  let ref = slot.get();

  // A failed job (never billed) gets a fresh idempotency key; otherwise reuse the existing one.
  // `submission_unknown` jobs are never resubmitted automatically: AI3D may still bill them, so we only re-check them.
  if (!ref || ref.status === 'failed' || ref.model !== opts.body.model) {
    const attempt = ref ? Number(/-a(\d+)$/.exec(ref.idempotencyKey)?.[1] ?? 0) + 1 : 1;
    ref = { model: opts.body.model, idempotencyKey: `wom-${world.id}-${opts.name}-a${attempt}`.slice(0, 128), status: 'new' };
    await world.update(() => slot.set(ref!));
  }

  let job: Ai3dJob | null = null;
  if (ref.jobId) {
    world.log(`${opts.label}: resuming AI3D job ${ref.jobId}`);
  } else {
    // If we crashed after submitting but before saving the id, AI3D can find the job by key.
    if (ref.status === 'submitting') job = await findJobByKey(ref.idempotencyKey).catch(() => null);
    if (!job) {
      await world.update(() => slot.set({ ...ref!, status: 'submitting' }));
      job = await submitJob(opts.body, ref.idempotencyKey, opts.path);
    }
    ref = { ...ref, jobId: job.id, status: job.status, viewerUrl: job.viewer_url };
    const reserve = reservedUsd(job);
    world.log(`${opts.label}: submitted AI3D ${opts.body.model} job ${job.id}${reserve ? ` (reserved $${reserve.toFixed(2)})` : ''}`);
    await world.update(() => slot.set(ref!));
  }

  const done = await waitForJob(ref.jobId!, {
    timeoutMs: opts.timeoutMs,
    onUpdate: (j) => {
      opts.onStatus?.(j.status);
      void world.update(() => slot.set({ ...slot.get()!, status: j.status }));
    },
  });
  const charged = chargedUsd(done) ?? (done.status === 'succeeded' ? reservedUsd(done) : undefined);
  const finalRef: Ai3dJobRef = {
    ...ref,
    status: done.status,
    error: done.status === 'succeeded' ? undefined : jobErrorText(done),
    chargedUsd: charged,
    viewerUrl: done.viewer_url ?? ref.viewerUrl,
  };
  await world.update(() => slot.set(finalRef));
  if (charged) {
    await world.addCost(
      { label: opts.label, usd: charged, provider: 'ai3d', estimated: chargedUsd(done) === undefined },
      { model: opts.body.model, jobId: done.id },
    );
  }
  if (done.status !== 'succeeded') {
    if (done.status === 'submission_unknown') {
      throw new Error(`${opts.label}: AI3D reports submission_unknown for job ${done.id}; not resubmitting automatically (it may still be billed). Check the AI3D dashboard before retrying.`);
    }
    throw new Error(`${opts.label}: ${jobErrorText(done)}`);
  }
  return done;
}
