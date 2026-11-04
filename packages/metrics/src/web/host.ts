// How an application plugs into the dashboard. The dashboard shows what the benchmark's tasks produced
// (tasks, runs, spend), whatever those tasks measure. What it cannot know, the application adds:
//
//   tabs       extra tabs, built from the dashboard's own pieces (panel, kpi, charts), with an optional
//              headline number and sentences for the overview. WOM adds Camera and Observations.
//   caseLinks  where a case leads in the application (open the world, its masks and models).
import type { CaseView, RunItem, RunView, TaskInfo } from '../core/types.ts';
import type { KpiOptions } from './ui.ts';
import type { MetricsData } from './data.ts';

/** A sentence for "What the numbers say": bold parts are `{ b }`. `tab` makes it link to a tab. */
export type InsightPart = string | { b: string };
export interface DashboardInsight {
  tone: 'good' | 'warn' | 'info';
  parts: InsightPart[];
  tab?: string;
}

/** Where inside a tab to land when another tab links to it. */
export interface ViewTarget {
  /** A case id of the tab's task. */
  case?: string;
}

export interface View {
  el: HTMLElement;
  focus?(target: ViewTarget): void;
}

/** What a tab gets to work with. */
export interface MetricsContext {
  data: MetricsData;
  host: MetricsUiHost;
  /** True once the page was left; a late answer must not draw into it. */
  isDisposed(): boolean;
  go(tab: string, target?: ViewTarget): void;
  href(tab: string): string;
  /** The runs of a task, newest first. */
  runs(task: string): Promise<RunItem[]>;
  /** The run of a task the dashboard shows: the one chosen, else the newest. Null when the task has none. */
  run(task: string): Promise<RunView | null>;
}

export interface HostTab {
  id: string;
  label: string;
  /** The question the tab answers; shown when pointing at it. */
  question: string;
  view(ctx: MetricsContext): View;
  /** One headline card for the overview. */
  headline?(ctx: MetricsContext): Promise<KpiOptions | null>;
  /** Sentences for the overview's findings. */
  insights?(ctx: MetricsContext): Promise<DashboardInsight[]>;
}

export interface MetricsUiHost {
  tabs?: HostTab[];
  /** Links from a case into the application. */
  caseLinks?(task: TaskInfo, c: CaseView): { label: string; href: string }[];
  /** The line under the name. */
  lede?: string;
  /** Where the page's back link leads. */
  back?: { href: string; label: string };
}
