// The API an application or agent uses to be measured.
//
//   A Task says what is asked: the cases, and how an answer is scored.
//   A Subject answers: a model, an agent with tools, a solver, a script, a person typing. It gets a case
//   and a SolveContext, and returns one Answer per method it can give.
//
// The framework never looks inside a case's `data` or an answer: they belong to the task and its
// subjects. It runs them, scores what comes back, keeps the paid calls honest (budget, cache, ledger) and
// stores the result so the dashboard can show it.
import type { Annotation } from '../core/analyze.ts';
import type {
  ArtifactSpec, CaseRecord, DimensionSpec, Extras, FamilySpec, LabelSpec, MethodSpec, MetricSpec, RunFile, RunView, Scores, TaskInfo,
} from '../core/types.ts';
import type { Spend } from './spend.ts';

/** A case to measure: its public record, plus whatever the task and its subjects share about it. */
export interface Case<D = unknown> extends CaseRecord {
  data: D;
}

/** Which cases a run should cover. The task decides what the keys mean (worlds, objects, models...). */
export type CaseSelection = Record<string, string[] | undefined>;

/** One answer to a case by one method. */
export interface Answer<A = unknown> {
  method: string;
  /** What was answered. Absent when the method failed or did not run. */
  answer?: A;
  costUsd?: number;
  latencyMs?: number;
  calls?: number;
  cachedCalls?: number;
  /** A line in the answerer's own words. */
  note?: string;
  error?: string;
  /**
   * The method did not run, for example because the budget was spent. It is not recorded as a result.
   * A `solve` that throws BudgetExceeded (a `spend.call` over the cap does) skips all of its subject's methods.
   */
  skipped?: boolean;
  details?: Record<string, unknown>;
}

export interface SolveContext {
  /** The run's budget. Wrap every paid call in `spend.call(...)`, so it is capped, cached and booked. */
  spend: Spend;
  /** Ask again instead of using a cached answer. */
  fresh: boolean;
  log(message: string): void;
}

export interface Subject<D = unknown, A = unknown> {
  id: string;
  label: string;
  /** The ways this subject can answer; each becomes a column in the dashboard. */
  methods: MethodSpec[];
  /** Answer a case. Return one entry per method; omit a method to leave it out of the run for this case. */
  solve(c: Case<D>, ctx: SolveContext): Promise<Answer<A>[]>;
}

/** What scoring an answer gives. */
export interface Outcome {
  scores: Scores;
  /** The verdict, for tasks that give them. */
  label?: string;
  note?: string;
  details?: Record<string, unknown>;
  /** Pictures kept in memory for `finish`, which decides what to store. */
  images?: Record<string, Buffer>;
}

export interface ScoredAnswer<A = unknown> {
  answer: Answer<A>;
  outcome: Outcome;
}

export interface ScoreContext {
  /** Store a file in the run's folder (a relative path) and return that path. */
  write(rel: string, data: string | Buffer): Promise<string>;
  log(message: string): void;
}

export interface FinishOutcome {
  /** Files to show with the case: artifact id to the path `ctx.write` returned. */
  artifacts?: Record<string, string>;
  /** Scores to add to a method's result, for example ones that compare it with another method. */
  scores?: Record<string, Scores>;
}

/** What a task says about itself: everything but the code. Runs store it, and the dashboard reads it. */
export interface TaskSpec {
  id: string;
  label: string;
  description?: string;
  kind?: 'metrics' | 'verdicts';
  metrics: MetricSpec[];
  /** The metric that ranks methods. */
  primary: string;
  families: FamilySpec[];
  dimensions?: DimensionSpec[];
  splitBy?: string;
  labels?: LabelSpec[];
  artifacts?: ArtifactSpec[];
  tie?: number;
  gain?: number;
  smallSample?: number;
  revision?: { label: string; hint?: string };
  caveat?: string;
  hardCasesHint?: string;
  howToRun?: string;
  groupLabel?: string;
  question?: string;
}

export interface Task<D = unknown, A = unknown> extends TaskSpec {
  /** The cases to measure, and a line for each that could not be built. */
  cases(selection: CaseSelection, ctx: { log(message: string): void }): Promise<{ cases: Case<D>[]; skipped?: string[] }>;
  /** How good one answer is. */
  score(c: Case<D>, answer: A, ctx: ScoreContext): Promise<Outcome> | Outcome;
  /** After every answer to a case is scored: derived scores, and the files to keep. */
  finish?(c: Case<D>, scored: ScoredAnswer<A>[], ctx: ScoreContext): Promise<FinishOutcome | void> | FinishOutcome | void;

  /** Human notes keyed by the case's `noteKeys`: exclusions, remarks, expected verdicts. Read each time a run is shown. */
  annotations?(): Record<string, Annotation>;
  /** A warning to show on a case, computed from its results, when no person wrote a note. */
  caseNote?(c: CaseRecord, results: RunFile['results']): string | undefined;
  /** Tables and remarks specific to the task, computed when a run is shown. */
  extras?(view: Omit<RunView, 'extras'>): Partial<Extras>;
  /** Read a run stored before the current format. Return null if it cannot be read. */
  upgrade?(raw: unknown, ctx: { id: string; dir: string }): RunFile | null;
}

/** Declare a task. Only checks the shape; returns it unchanged so its types carry through. */
export function defineTask<D, A>(task: Task<D, A>): Task<D, A> {
  if (!task.metrics.some((m) => m.id === task.primary)) throw new Error(`task ${task.id}: primary metric ${task.primary} is not among its metrics`);
  return task;
}

/** Declare a subject. Only checks the shape; returns it unchanged so its types carry through. */
export function defineSubject<D, A>(subject: Subject<D, A>): Subject<D, A> {
  const ids = new Set<string>();
  for (const m of subject.methods) {
    if (ids.has(m.id)) throw new Error(`subject ${subject.id}: method ${m.id} is declared twice`);
    ids.add(m.id);
  }
  return subject;
}

/** What a run and the dashboard get to know about a task. */
export function taskInfo(task: TaskSpec): TaskInfo {
  return {
    id: task.id,
    label: task.label,
    description: task.description,
    kind: task.kind ?? 'metrics',
    metrics: task.metrics,
    primary: task.primary,
    families: task.families,
    dimensions: task.dimensions ?? [],
    splitBy: task.splitBy,
    labels: task.labels,
    artifacts: task.artifacts ?? [],
    tie: task.tie ?? 0.01,
    gain: task.gain ?? 0.02,
    smallSample: task.smallSample ?? 5,
    ...(task.revision ? { revision: task.revision } : {}),
    ...(task.caveat ? { caveat: task.caveat } : {}),
    ...(task.hardCasesHint ? { hardCasesHint: task.hardCasesHint } : {}),
    ...(task.howToRun ? { howToRun: task.howToRun } : {}),
    ...(task.groupLabel ? { groupLabel: task.groupLabel } : {}),
    ...(task.question ? { question: task.question } : {}),
  };
}
