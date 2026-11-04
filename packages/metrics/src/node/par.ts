/** Content-addressed course/evidence verification. Import the pure scoring arithmetic from ./core. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  assertParCourse, assertParFile, parCanonicalJson, scorePar,
  type ParBundle, type ParCourse, type ParFile, type ParOutput, type ParSubmission, type ParTrajectory,
} from '../core/par.ts';

export const parDigest = (value: unknown) => createHash('sha256').update(parCanonicalJson(value)).digest('hex');

export async function parFileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export interface LoadedParCourse {
  course: ParCourse;
  sha256: string;
  root: string;
}

/** Fail closed on missing bytes, drift, symlinks outside the root, cycles and contradictory hashes. */
export async function verifyParFiles(root: string, files: ParFile[]): Promise<void> {
  const base = await realpath(root);
  const checked = new Map<string, string>(), active = new Set<string>();
  const visit = async (f: ParFile): Promise<void> => {
    assertParFile(f);
    const full = await realpath(path.join(base, f.path));
    if (!full.startsWith(base + path.sep)) throw new Error(`WOM Par: file leaves artifact root: ${f.path}`);
    if (active.has(full)) throw new Error(`WOM Par: cyclic bundle: ${f.path}`);
    const prev = checked.get(full);
    if (prev && prev !== f.sha256) throw new Error(`WOM Par: conflicting hashes: ${f.path}`);
    if (!prev && await parFileDigest(full) !== f.sha256) throw new Error(`WOM Par: artifact hash mismatch: ${f.path}`);
    // Include kind in the cache key: mentioning a bundle as a plain file must not skip its children.
    if (checked.get(`${full}:${f.kind ?? 'file'}`)) return;
    checked.set(full, f.sha256);
    checked.set(`${full}:${f.kind ?? 'file'}`, f.sha256);
    if (f.kind === 'bundle') {
      active.add(full);
      const bundle = JSON.parse(await readFile(full, 'utf8')) as ParBundle;
      if (bundle?.format !== 'wom-par-bundle-v1' || !Array.isArray(bundle.files) || !bundle.files.length) {
        throw new Error(`WOM Par: invalid/empty bundle: ${f.path}`);
      }
      const paths = new Set<string>();
      for (const child of bundle.files) {
        if (paths.has(child.path)) throw new Error(`WOM Par: duplicate bundle path: ${child.path}`);
        paths.add(child.path);
        await visit(child);
      }
      active.delete(full);
    }
  };
  for (const f of files) await visit(f);
}

const outputFiles = (o: ParOutput) => o.status === 'ok' ? [o.artifact, o.evidence] : [o.evidence];

async function trajectoryAt(root: string, scene: ParCourse['scenes'][number]): Promise<ParTrajectory> {
  const t = JSON.parse(await readFile(path.join(root, scene.trajectory.path), 'utf8')) as ParTrajectory;
  if (t?.protocol !== 'wom-par-v1' || !Number.isFinite(t.fovY) || t.fovY <= 0 || t.fovY >= 180 ||
      !Number.isFinite(t.aspect) || t.aspect <= 0 || !Array.isArray(t.samples) || !t.samples.length) {
    throw new Error(`WOM Par: invalid camera trajectory: ${scene.trajectory.path}`);
  }
  const ids = new Set<string>();
  for (const s of t.samples) {
    if (!s || typeof s.id !== 'string' || !/^[a-zA-Z0-9._:-]+$/.test(s.id) || ids.has(s.id) ||
        !Array.isArray(s.position) || s.position.length !== 3 || !s.position.every(Number.isFinite) ||
        !Array.isArray(s.quaternion) || s.quaternion.length !== 4 || !s.quaternion.every(Number.isFinite) ||
        Math.abs(Math.hypot(...s.quaternion) - 1) > 1e-5) {
      throw new Error(`WOM Par: invalid/duplicate camera sample: ${scene.trajectory.path}`);
    }
    ids.add(s.id);
  }
  return t;
}

async function checkEvidence(root: string, o: ParOutput, c: ParCourse, scene: ParCourse['scenes'][number], trajectory: ParTrajectory): Promise<void> {
  const evidence = JSON.parse(await readFile(path.join(root, o.evidence.path), 'utf8')) as ParBundle;
  const p = evidence.provenance;
  if (p?.protocol !== c.protocol || p?.status !== o.status || p?.sourceSha256 !== scene.source.sha256 ||
      p?.trajectorySha256 !== scene.trajectory.sha256 || p?.conditionsSha256 !== c.conditions.sha256) {
    throw new Error(`WOM Par: evidence conditions/source/trajectory mismatch: ${o.evidence.path}`);
  }
  if (o.status === 'failed' && !['generation', 'render'].includes(String(p?.phase))) {
    throw new Error(`WOM Par: a failure needs generation/render logs, not missing ratings: ${o.evidence.path}`);
  }
  if (o.status === 'ok') {
    const samples = p?.cameraSamples as { id: string; frameSha256: string }[] | undefined;
    const captured = new Set(evidence.files.filter((f) => /\.jpe?g$/i.test(f.path)).map((f) => f.sha256));
    const clips = new Set(evidence.files.filter((f) => /\.mp4$/i.test(f.path)).map((f) => f.sha256));
    if (!Array.isArray(samples) || samples.length !== trajectory.samples.length ||
        samples.some((s, i) => s?.id !== trajectory.samples[i].id || !captured.has(s.frameSha256)) ||
        typeof p?.walkthroughSha256 !== 'string' || !clips.has(p.walkthroughSha256)) {
      throw new Error(`WOM Par: incomplete camera frames/walkthrough: ${o.evidence.path}`);
    }
  }
}

/** Canonical JSON digest is the competition key; the raw file's whitespace is immaterial. */
export async function readParCourse(file: string, root = path.dirname(file)): Promise<LoadedParCourse> {
  const course = JSON.parse(await readFile(file, 'utf8')) as ParCourse;
  assertParCourse(course);
  root = await realpath(root);
  await verifyParFiles(root, [course.conditions, course.rubric, ...(course.evaluation.configuration ? [course.evaluation.configuration] : []), ...course.scenes.flatMap((s) =>
    [s.source, s.trajectory, ...s.trials.flatMap((t) => outputFiles(t.reference))])]);
  for (const s of course.scenes) {
    const trajectory = await trajectoryAt(root, s);
    for (const t of s.trials) await checkEvidence(root, t.reference, course, s, trajectory);
  }
  return { course, sha256: parDigest(course), root };
}

export async function readParSubmission(file: string, loaded: LoadedParCourse, root = path.dirname(file)): Promise<ParSubmission> {
  const submission = JSON.parse(await readFile(file, 'utf8')) as ParSubmission;
  // Validate structure/provenance before touching paths from a submission.
  scorePar(loaded.course, loaded.sha256, submission);
  root = await realpath(root);
  await verifyParFiles(root, [...(submission.setup?.configuration ? [submission.setup.configuration] : []), ...submission.comparisons.flatMap((x) => outputFiles(x.candidate))]);
  for (const x of submission.comparisons) {
    const scene = loaded.course.scenes.find((s) => s.id === x.scene)!;
    await checkEvidence(root, x.candidate, loaded.course, scene, await trajectoryAt(loaded.root, scene));
  }
  return submission;
}
