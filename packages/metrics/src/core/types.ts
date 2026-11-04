// WOM: World Observation Metrics. The contract between a benchmark, the things it measures and the
// dashboard that shows the results.
//
// Nothing here knows which model, agent or process gives the answers. Who they are (ids, labels, families,
// prices) arrives as data in the specs below, so a new model or a different agent needs no change in this
// package: it declares itself and is measured.
//
// The pieces:
//   Task     what is asked and how an answer is scored: the cases, and the metrics.
//   Subject  anything that answers a case: a model, an agent with tools, a geometric solver, a person.
//            One subject can give several answers (methods), for example "as given" and "then refined".
//   Run      a task measured on some subjects; stored as a RunFile and shown as a RunView.

// ---------- vocabulary: how a task describes itself ----------

export type Tone = 'good' | 'fair' | 'poor' | 'info' | 'muted';

/** Scores of one answer by metric id. A metric that could not be measured is null. */
export type Scores = Record<string, number | null>;

export interface MetricSpec {
  id: string;
  label: string;
  better: 'higher' | 'lower';
  unit?: string;
  /** 'percent' shows a 0 to 1 share as 0% to 100%. */
  format?: 'number' | 'percent';
  /** Decimals when shown. Default 2 (0 for a percent). */
  digits?: number;
  /** The span in which the metric is meaningful, for colouring. Default 0 to 1. */
  range?: [number, number];
  /** How a method's cases add up to one number. Default: the mean of the finite values. */
  aggregate?: 'mean' | 'median' | 'meanAbs' | 'medianAbs';
  /** Where a score turns from poor to fair to good, for colouring (read the right way round for `better`). */
  thresholds?: { good: number; fair: number };
  /** Shown only when asked for. */
  advanced?: boolean;
  description?: string;
}

/** A family groups methods that work alike, so the dashboard can colour and sort them together. */
export interface FamilySpec {
  id: string;
  label: string;
  color: string;
  description?: string;
}

/**
 * One way of answering, and so one column of every table. A subject declares its methods; a task's
 * baseline is the method the others are compared with.
 */
export interface MethodSpec {
  id: string;
  label: string;
  family: string;
  /** Who or what answers: a subject id such as a model's. Used to look up what its calls cost. */
  subject?: string;
  /** A short name for the subject, shown beside the label. */
  subjectLabel?: string;
  description?: string;
  /** The reference the others are compared with. At most one. */
  baseline?: boolean;
  /** Made from another method's output (a refinement of it), so it carries that method's cost and time. */
  via?: string;
  /** Where it sits in the tables, lowest first; methods with the same order stay as declared. */
  order?: number;
}

/** Something a label can be looked up for: a value of a dimension, such as one 3D model or depth model. */
export interface ValueInfo {
  label: string;
  short?: string;
  /** What producing it costs, when that is a fact about the value. */
  priceUsd?: number;
}

/** A way cases differ (world, object, 3D model, depth model), so tables can group and filter by it. */
export interface DimensionSpec {
  id: string;
  label: string;
  values?: Record<string, ValueInfo>;
  /**
   * Whether a case names its value beside its title: 'always', only when the run has several values
   * ('varied', the default), or 'never' when the title or the group already says it.
   */
  show?: 'always' | 'varied' | 'never';
}

/** A category an answer can fall in, for tasks that give verdicts. Ordered from most to least severe. */
export interface LabelSpec {
  id: string;
  label: string;
  tone: Tone;
  description?: string;
}

/** A file kept for each case (an overlay, a contact sheet) and how to caption it. */
export interface ArtifactSpec {
  id: string;
  label: string;
}

/** What a run and the dashboard need to know about a task. */
export interface TaskInfo {
  id: string;
  label: string;
  description?: string;
  /** 'metrics': answers get numbers. 'verdicts': answers get a label, compared with what a person said. */
  kind: 'metrics' | 'verdicts';
  metrics: MetricSpec[];
  /** The metric that ranks methods and colours the matrix. */
  primary: string;
  families: FamilySpec[];
  dimensions: DimensionSpec[];
  /** A dimension whose values are compared side by side as separate rows (for example depth models). */
  splitBy?: string;
  labels?: LabelSpec[];
  artifacts: ArtifactSpec[];
  /** Two scores closer than this are a tie. */
  tie: number;
  /** A method gains on the baseline only by more than this. */
  gain: number;
  /** Fewer cases than this and a mean says little. */
  smallSample: number;
  /** What a case's `revision` counts (a mask, a prompt, a dataset), so the second revision reads "mask v2". */
  revision?: { label: string; hint?: string };
  /** A caution about reading the scores, shown under the guide to the numbers. */
  caveat?: string;
  /** Why every method can score low on a case, shown with the hardest cases. */
  hardCasesHint?: string;
  /** How to make a run, shown where there is none yet. */
  howToRun?: string;
  /** What a case's `group` is (a world, a dataset), for "Every world" in the filters. */
  groupLabel?: string;
  /** The question the task answers, shown when pointing at its tab. */
  question?: string;
}

// ---------- what a run holds ----------

export interface CaseRecord {
  /** Stable and unique within a task, for example `world/object/asset@depth`. */
  id: string;
  title: string;
  /** A heading to group cases under, such as the world's title. */
  group?: string;
  dims: Record<string, string>;
  /** Which version of the thing the case is about this is (a redone mask); notes can be limited to one. */
  revision?: number;
  /** Keys of the human notes that apply, most specific first. */
  noteKeys?: string[];
  /** Files kept for the case: artifact id to path inside the run folder. */
  artifacts?: Record<string, string>;
}

export interface ResultRecord {
  case: string;
  method: string;
  scores: Scores;
  /** The verdict, for tasks that give them. */
  label?: string;
  costUsd: number;
  latencyMs: number;
  calls?: number;
  cachedCalls?: number;
  /** A line in the answerer's own words: why. */
  note?: string;
  error?: string;
  /** Anything else worth keeping, for task-specific views. */
  details?: Record<string, unknown>;
}

export interface RunSpend {
  usd: number;
  newCalls: number;
  cachedCalls: number;
}

/** A finished run as stored: results.json. */
export interface RunFile {
  format: 2;
  id: string;
  task: TaskInfo;
  startedAt?: string;
  finishedAt?: string;
  /** How the run was set up. Free-form; shown, not interpreted. */
  config: Record<string, unknown>;
  methods: MethodSpec[];
  cases: CaseRecord[];
  results: ResultRecord[];
  spend: RunSpend;
  /** Cases or methods that could not be built or run, and why. */
  skipped: string[];
}

/** A run in a list. */
export interface RunItem {
  id: string;
  task: string;
  finishedAt?: string;
  caseCount: number;
  spendUsd: number;
  /** Subjects that answered, by id. */
  subjects: string[];
  /** The values each dimension took in the run. */
  dims: Record<string, string[]>;
}

/** A task in a list. */
export interface TaskItem {
  info: TaskInfo;
  runs: number;
  latest?: string;
}

// ---------- what the dashboard is given ----------

export interface SummaryRow {
  method: string;
  /** The value of the task's `splitBy` dimension this row is about, when the run has several. */
  split?: string;
  n: number;
  failed: number;
  scores: Scores;
  /** Cases where this method had the best primary score of all methods. */
  wins: number;
  costUsd: number;
  latencyS: number | null;
}

export interface ResultView {
  method: string;
  scores: Scores;
  label?: string;
  costUsd: number;
  latencyMs: number;
  note?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface CaseView {
  id: string;
  title: string;
  group?: string;
  dims: Record<string, string>;
  revision?: number;
  /** The human note that applies, if any. */
  note?: string;
  /** A person marked the case as unfit for scoring: it stays in the details but not in the summary. */
  excluded: boolean;
  /** What a person said the verdict should be, for verdict tasks. */
  expected?: string;
  /** Artifact id to a URL. */
  artifacts: Record<string, string>;
  results: ResultView[];
}

/** A grid of numbers coloured by size, with an optional second number in each cell. */
export interface HeatTable {
  id: string;
  title: string;
  caption?: string;
  columns: { id: string; label: string }[];
  rows: {
    id: string;
    label: string;
    sub?: string;
    cells: { value: number | null; secondary?: number | null }[];
    total?: { value: number | null; secondary?: number | null };
  }[];
}

/** A sentence the task has to say about a run. `**bold**` marks the words that carry it. */
export interface Insight {
  tone: 'good' | 'warn' | 'info';
  text: string;
}

export interface Extras {
  tables: HeatTable[];
  /** Heading and lead-in for the tables, shown once above them. */
  tablesTitle?: string;
  tablesCaption?: string;
  notes: string[];
  notesTitle?: string;
  notesCaption?: string;
  /** What the numbers say that only this task can say; shown on the overview. */
  insights?: Insight[];
}

/** Verdicts against what a person said, for verdict tasks. */
export interface Agreement {
  /** matrix[expected][judged] */
  matrix: Record<string, Record<string, number>>;
  labelled: number;
  exact: number;
  /** Cases a person called the most severe: how many the answers called that too. */
  severe: { total: number; caught: number };
  /** Cases a person called clean: how many the answers flagged anyway. */
  clean: { total: number; flagged: number };
}

export interface RunView {
  id: string;
  task: TaskInfo;
  startedAt?: string;
  finishedAt?: string;
  config: Record<string, unknown>;
  spend: RunSpend;
  methods: MethodSpec[];
  summary: SummaryRow[];
  cases: CaseView[];
  /** Ids of the excluded cases. */
  excluded: string[];
  extras: Extras;
  agreement?: Agreement;
  skipped: string[];
}

// ---------- spend ----------

export interface SpendRow {
  id: string;
  label: string;
  usd: number;
  calls: number;
}

/** What one case costs in model calls when they are paid for rather than answered from the cache. */
export interface CostPerCase {
  subject: string;
  method: string;
  /** The method in words (for example "Agent · Muse Spark 1.3") and how it spends, when the application says. */
  label?: string;
  about?: string;
  calls: number;
  usd: number;
  /** Distinct (run, case) pairs that were paid for. */
  cases: number;
  usdPerCase: number;
}

export interface SpendSummary {
  totalUsd: number;
  calls: number;
  /** The part of the total that was estimated instead of read from a provider's charge. */
  estimatedUsd: number;
  firstAt?: string;
  lastAt?: string;
  byContext: SpendRow[];
  byProvider: SpendRow[];
  /** What the money bought, largest first. */
  byKind: SpendRow[];
  /** Calendar days on the machine that runs the server, oldest first. */
  byDay: SpendRow[];
  byWorld: SpendRow[];
  perCase: CostPerCase[];
}

/** What a verdict's checker found. A result lists them in `details.findings`, and the dashboard shows them under the case. */
export interface Finding {
  what: string;
  severity?: string;
  /** Where it shows, in words (the views, the region, the line). */
  where?: string;
}

/** One paid call, as the ledger keeps it. */
export interface LedgerEntry {
  at: string;
  /** Where the money was spent: 'pipeline' for world builds, 'bench' for benchmark runs. */
  context: string;
  /** Who was paid. */
  provider: string;
  label: string;
  usd: number;
  estimated?: boolean;
  worldId?: string;
  model?: string;
  jobId?: string;
  /** A pointer to the full record: a run id and a cache key, for instance. */
  ref?: string;
  /** True for entries rebuilt from records made before the ledger existed. */
  backfilled?: boolean;
}
