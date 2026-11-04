/** Fixed-reference, representation-independent whole-world comparisons. No provider or renderer lives here. */
import { assertAgentSetup, type AgentSetup } from './setup.ts';
export const PAR_PROTOCOL = 'wom-par-v1' as const;

/** Paths are relative to an explicitly supplied artifact root. A bundle lists other hashed files. */
export interface ParFile {
  path: string;
  sha256: string;
  kind?: 'bundle';
}

export interface ParBundle {
  format: 'wom-par-bundle-v1';
  files: ParFile[];
  provenance?: Record<string, unknown>;
}

export interface ParTrajectory {
  protocol: typeof PAR_PROTOCOL;
  fovY: number;
  aspect: number;
  samples: { id: string; position: [number, number, number]; quaternion: [number, number, number, number] }[];
}

export type ParOutput =
  | { status: 'ok'; artifact: ParFile; evidence: ParFile }
  | { status: 'failed'; reason: string; evidence: ParFile };

export interface ParCourse {
  protocol: typeof PAR_PROTOCOL;
  id: string;
  label: string;
  release: 'pilot' | 'release';
  sampling: 'convenience' | 'independent';
  reference: { id: string; label: string; revision: string };
  /** Allowed inputs, resource limits, alignment, render settings and navigation contract. */
  conditions: ParFile;
  rubric: ParFile;
  evaluation: {
    id: string;
    kind: 'human' | 'model';
    /** Human track: exactly this many independent raters per scene/trial, fixed before judging. */
    judgesPerTrial: number;
    /** Model track: every named revision must judge both presentation orders. */
    judges?: { id: string; revision: string }[];
    /** Exact evaluator prompts/settings or human sampling rules; required for a model panel. */
    configuration?: ParFile;
  };
  strata: { id: string; weight: number }[];
  scenes: {
    id: string;
    title: string;
    source: ParFile;
    stratum: string;
    /** Identical frozen poses, intrinsics and order for every entrant. */
    trajectory: ParFile;
    trials: { id: string; reference: ParOutput }[];
  }[];
}

export interface ParBallot {
  judge: string;
  candidateSide: 'A' | 'B';
  choice: 'A' | 'B' | 'tie';
  /** Bind the decision to the exact whole-world evidence the rater saw. */
  candidateEvidence: string;
  referenceEvidence: string;
  note?: string;
}

export interface ParSubmission {
  protocol: typeof PAR_PROTOCOL;
  courseSha256: string;
  method: { id: string; label: string; revision: string };
  /** Standard contribution envelope. Older evaluation files remain readable without one. */
  setup?: AgentSetup;
  comparisons: { scene: string; trial: string; candidate: ParOutput; ballots: ParBallot[] }[];
}

export interface ParSceneScore {
  scene: string;
  weight: number;
  complete: number;
  trials: number;
  preference: number | null;
  par: number | null;
}

export interface ParScore {
  protocol: typeof PAR_PROTOCOL;
  courseSha256: string;
  course: string;
  track: string;
  trackKind: 'human' | 'model';
  release: 'pilot' | 'release';
  method: ParSubmission['method'];
  status: 'anchor' | 'complete' | 'incomplete';
  /** -100 (always preferred) to +100 (always loses). Null unless the ENTIRE course is complete. */
  par: number | null;
  preference: number | null;
  coverage: { complete: number; expected: number; fraction: number };
  photographs: number;
  effectivePhotographs: number;
  ballots: number;
  deterministicTrials: number;
  scenes: ParSceneScore[];
  missing: string[];
  /** Conditional, conservative scene-sampling bound; never a frame/vote IID confidence claim. */
  interval95: [number, number] | null;
  uncertainty: string;
}

/** Public-safe status for a method report; it never includes private evidence or raw ballots. */
export interface ParStatus {
  schema: 'wom-par-status/1';
  protocol: string;
  course: { id: string; label: string; sha256: string; release: 'pilot' | 'release'; photographs: number; trials: number };
  reference: { id: string; label: string; score: 0 };
  track: { id: string; kind: 'human' | 'model' };
  evaluation: { run: string; finishedAt: string | null; actualBallots: number } | null;
  /** One generation does not establish a method's complete-course score. */
  generation: { score: null; status: 'not-ranked' };
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`WOM Par: ${message}`);
}
const word = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
const hash = (s: unknown) => typeof s === 'string' && HASH.test(s);
const id = (s: unknown) => typeof s === 'string' && ID.test(s);
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const parOf = (p: number) => 100 * (1 - 2 * p) || 0;
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function assertParFile(f: ParFile): void {
  check(f && word(f.path) && !f.path.includes('\\') && !f.path.includes('\0') &&
    !f.path.startsWith('/') && !f.path.includes(':') &&
    f.path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'unsafe artifact path');
  check(hash(f.sha256), `invalid SHA-256 for ${f.path}`);
  check(f.kind === undefined || f.kind === 'bundle', `invalid file kind for ${f.path}`);
}

function output(o: ParOutput): void {
  check(o && (o.status === 'ok' || o.status === 'failed'), 'output must be ok or an evidenced failure');
  assertParFile(o.evidence);
  check(o.evidence.kind === 'bundle', 'review/failure evidence must be a bundle');
  if (o.status === 'ok') {
    assertParFile(o.artifact);
    check(o.artifact.kind === 'bundle', 'world artifact must be a bundle');
  } else check(word(o.reason), 'failure needs a reason');
}

/** Reject duplicate photographs, undefined weights and silently changed evaluation conditions. */
export function assertParCourse(c: ParCourse): void {
  check(c && c.protocol === PAR_PROTOCOL && id(c.id) && word(c.label), 'invalid course/protocol');
  check(['pilot', 'release'].includes(c.release) && ['convenience', 'independent'].includes(c.sampling), 'invalid release/sampling');
  check(c.reference && id(c.reference.id) && word(c.reference.label) && word(c.reference.revision), 'reference needs an id, label and revision');
  assertParFile(c.conditions);
  assertParFile(c.rubric);
  const e = c.evaluation;
  check(e && id(e.id) && ['human', 'model'].includes(e.kind), 'invalid evaluation track');
  check(Number.isSafeInteger(e.judgesPerTrial) && e.judgesPerTrial >= (e.kind === 'human' ? 5 : 3), 'specify at least five human raters or three model judges');
  if (e.kind === 'model') {
    check(e.configuration, 'model track needs a hashed evaluator configuration');
    check(Array.isArray(e.judges) && e.judges.length === e.judgesPerTrial, 'model track needs every frozen judge revision');
    const judges = new Set<string>();
    for (const j of e.judges) {
      check(j && id(j.id) && word(j.revision) && !judges.has(j.id), 'duplicate/invalid model judge');
      judges.add(j.id);
    }
  } else check(e.judges === undefined, 'human raters are recorded in ballots, not declared as model judges');
  if (e.configuration) assertParFile(e.configuration);
  check(Array.isArray(c.strata) && c.strata.length > 0, 'course needs fixed strata');
  const strata = new Set<string>();
  for (const s of c.strata) {
    check(s && id(s.id) && !strata.has(s.id) && Number.isFinite(s.weight) && s.weight > 0, 'duplicate/invalid stratum');
    strata.add(s.id);
  }
  check(Math.abs(c.strata.reduce((s, v) => s + v.weight, 0) - 1) < 1e-10, 'stratum weights must sum to one');
  check(Array.isArray(c.scenes) && c.scenes.length > 0, 'course needs photographs');
  const scenes = new Set<string>(), photos = new Set<string>();
  for (const s of c.scenes) {
    check(s && id(s.id) && word(s.title) && !scenes.has(s.id), 'duplicate/invalid scene');
    scenes.add(s.id);
    assertParFile(s.source);
    assertParFile(s.trajectory);
    check(!photos.has(s.source.sha256), 'same source photograph occurs twice; use trials within one scene');
    photos.add(s.source.sha256);
    check(strata.has(s.stratum), `unknown stratum for ${s.id}`);
    check(Array.isArray(s.trials) && s.trials.length > 0, `no frozen trials for ${s.id}`);
    const trials = new Set<string>();
    for (const t of s.trials) {
      check(t && id(t.id) && !trials.has(t.id), `duplicate/invalid trial in ${s.id}`);
      trials.add(t.id);
      output(t.reference);
    }
  }
  for (const s of strata) check(c.scenes.some((x) => x.stratum === s), `empty stratum ${s}`);
}

/** An exact reference replay has par zero without fabricating self-comparison ballots. */
export function parReferenceSubmission(c: ParCourse, courseSha256: string): ParSubmission {
  assertParCourse(c);
  check(hash(courseSha256), 'invalid course hash');
  return {
    protocol: PAR_PROTOCOL, courseSha256, method: { ...c.reference },
    comparisons: c.scenes.flatMap((s) => s.trials.map((t) => ({ scene: s.id, trial: t.id, candidate: structuredClone(t.reference), ballots: [] }))),
  };
}

/** All input is untrusted JSON. Invalid data throws; valid but unfinished data gets NO global score. */
export function scorePar(c: ParCourse, courseSha256: string, submission: ParSubmission): ParScore {
  assertParCourse(c);
  check(hash(courseSha256) && submission?.protocol === PAR_PROTOCOL && submission.courseSha256 === courseSha256, 'course hash/protocol mismatch');
  check(submission.method && id(submission.method.id) && word(submission.method.label) && word(submission.method.revision), 'method needs an id, label and revision');
  if (submission.setup) {
    assertAgentSetup(submission.setup);
    check(submission.setup.id === submission.method.id && submission.setup.label === submission.method.label && submission.setup.revision === submission.method.revision, 'setup and scored method identity/revision differ');
  }
  check(Array.isArray(submission.comparisons), 'comparisons must be an array');
  const comparisons = new Map<string, ParSubmission['comparisons'][number]>();
  for (const x of submission.comparisons) {
    const scene = c.scenes.find((s) => s.id === x?.scene);
    check(scene && scene.trials.some((t) => t.id === x.trial), 'comparison is outside this course');
    const key = `${x.scene}/${x.trial}`;
    check(!comparisons.has(key), `duplicate comparison ${key}`);
    output(x.candidate);
    check(Array.isArray(x.ballots), `ballots must be an array for ${key}`);
    comparisons.set(key, x);
  }
  let complete = 0, expected = 0, ballots = 0, deterministicTrials = 0, allIdentical = true;
  const missing: string[] = [], sceneScores: ParSceneScore[] = [];
  for (const scene of c.scenes) {
    const preferences: number[] = [];
    for (const trial of scene.trials) {
      expected++;
      const key = `${scene.id}/${trial.id}`, x = comparisons.get(key), ref = trial.reference;
      if (!x) { missing.push(`${key}: missing output`); allIdentical = false; continue; }
      const candidate = x.candidate;
      const identical = candidate.status === ref.status && candidate.evidence.sha256 === ref.evidence.sha256 &&
        (candidate.status !== 'ok' || (ref.status === 'ok' && candidate.artifact.sha256 === ref.artifact.sha256));
      if (!identical) allIdentical = false;
      if (submission.method.id === c.reference.id) check(identical && submission.method.revision === c.reference.revision, 'reference id is reserved for an exact replay');
      if (identical || candidate.status === 'failed' || ref.status === 'failed') {
        check(x.ballots.length === 0, `${key}: deterministic outcomes must not carry invented ballots`);
        preferences.push(identical || candidate.status === ref.status ? 0.5 : candidate.status === 'ok' ? 1 : 0);
        deterministicTrials++;
        complete++;
        continue;
      }
      const byJudge = new Map<string, ParBallot[]>();
      for (const b of x.ballots) {
        check(b && id(b.judge) && ['A', 'B'].includes(b.candidateSide) && ['A', 'B', 'tie'].includes(b.choice), `${key}: invalid ballot`);
        check(b.candidateEvidence === candidate.evidence.sha256 && b.referenceEvidence === ref.evidence.sha256, `${key}: ballot evidence mismatch`);
        const prev = byJudge.get(b.judge) ?? [];
        check(!prev.some((p) => p.candidateSide === b.candidateSide), `${key}: duplicate judge/order ballot`);
        check(c.evaluation.kind === 'model' || prev.length === 0, `${key}: human rater voted twice`);
        prev.push(b);
        byJudge.set(b.judge, prev);
      }
      check(byJudge.size <= c.evaluation.judgesPerTrial, `${key}: too many raters; sample size was fixed before judging`);
      if (c.evaluation.kind === 'model') {
        for (const j of byJudge.keys()) check(c.evaluation.judges!.some((v) => v.id === j), `${key}: unknown model judge`);
      }
      ballots += x.ballots.length;
      const quorum = byJudge.size === c.evaluation.judgesPerTrial &&
        (c.evaluation.kind === 'human' || [...byJudge.values()].every((v) => v.length === 2));
      if (!quorum) { missing.push(`${key}: incomplete judge panel/order swaps`); continue; }
      if (c.evaluation.kind === 'human') {
        const left = x.ballots.filter((b) => b.candidateSide === 'A').length;
        check(Math.abs(left - (x.ballots.length - left)) <= 1, `${key}: presentation order is not counterbalanced`);
      }
      // One model does not get twice the influence because it was shown both orders.
      preferences.push(mean([...byJudge.entries()].sort(([a], [b]) => compareId(a, b)).map(([, votes]) =>
        mean(votes.map((b) => b.choice === 'tie' ? 0.5 : b.choice === b.candidateSide ? 1 : 0)))));
      complete++;
    }
    const stratum = c.strata.find((s) => s.id === scene.stratum)!;
    const weight = stratum.weight / c.scenes.filter((s) => s.stratum === scene.stratum).length;
    const preference = preferences.length === scene.trials.length ? mean(preferences) : null;
    sceneScores.push({ scene: scene.id, weight, complete: preferences.length, trials: scene.trials.length, preference, par: preference === null ? null : parOf(preference) });
  }
  const ready = complete === expected;
  const preference = ready ? sceneScores.reduce((s, v) => s + v.weight * v.preference!, 0) /
    sceneScores.reduce((s, v) => s + v.weight, 0) : null;
  const par = preference === null ? null : parOf(preference);
  const sumWeightsSquared = sceneScores.reduce((s, v) => s + v.weight ** 2, 0);
  // Weighted Hoeffding, clustered at the independent photograph (range of each photo's score = 200).
  const radius = 100 * Math.sqrt(2 * Math.log(40) * sumWeightsSquared);
  const identity = ready && allIdentical;
  const interval95: [number, number] | null = par !== null && !identity && c.sampling === 'independent'
    ? [Math.max(-100, par - radius), Math.min(100, par + radius)] : null;
  return {
    protocol: PAR_PROTOCOL, courseSha256, course: c.id, track: c.evaluation.id, trackKind: c.evaluation.kind,
    release: c.release, method: { ...submission.method }, status: !ready ? 'incomplete' : identity ? 'anchor' : 'complete',
    par, preference, coverage: { complete, expected, fraction: complete / expected }, photographs: c.scenes.length,
    effectivePhotographs: 1 / sumWeightsSquared, ballots, deterministicTrials, scenes: sceneScores, missing, interval95,
    uncertainty: identity ? 'Zero by exact reference identity, not an estimated quality or preference.'
      : c.sampling === 'convenience' ? 'Descriptive fixed-course score only: convenience photographs do not support population inference.'
        : '95% weighted Hoeffding bound, conditional on the accepted judging protocol and independent representative photographs; not a confidence interval over frames or repeated votes.',
  };
}

/** A new entrant never changes an earlier score. Different courses or evaluator tracks cannot mix. */
export function rankPar(scores: ParScore[]): ParScore[] {
  const ids = new Set<string>();
  for (const s of scores) {
    check(!ids.has(s.method.id), 'duplicate method in ranking');
    ids.add(s.method.id);
    check(s.courseSha256 === scores[0].courseSha256 && s.track === scores[0].track, 'cannot rank different courses or evaluator tracks together');
  }
  return scores.filter((s) => s.par !== null).sort((a, b) => a.par! - b.par! || compareId(a.method.id, b.method.id));
}

/** Stable JSON for hashing manifests. Arrays retain their declared order; object key order is irrelevant. */
export function parCanonicalJson(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  return JSON.stringify(canonical(value));
}
