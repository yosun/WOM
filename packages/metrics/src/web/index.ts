// @wom/metrics/web: the dashboard, and the pieces an application builds its own tabs from.
//
//   import '@wom/metrics/web/styles.css';
//   import { matchMetricsRoute, mountMetrics } from '@wom/metrics/web';
//
//   const route = matchMetricsRoute(location.hash);
//   if (route) teardown = mountMetrics(root, route, host);   // host: MetricsUiHost
//
// The dashboard reads the routes that createMetricsRoutes serves (@wom/metrics), so it shows whatever tasks the
// benchmark has, and the application adds only what it alone knows: tabs, and where a case leads.
export { matchMetricsRoute, mountMetrics, runLabel, type MetricsRoute } from './shell.ts';
export { WOM_NAME, WOM_TITLE, womHeader, womTitle } from './brand.ts';
export { MetricsData } from './data.ts';
export type { DashboardInsight, HostTab, InsightPart, MetricsContext, MetricsUiHost, View, ViewTarget } from './host.ts';

// The pieces a tab of the application's own is made of.
export { clear, h, richText, type Child } from './dom.ts';
export { diverge, columns, hbars, heat, legend, meter, scatter, stack, TONE_COLOR, type HBar, type Part, type ScatterPoint, type Tone } from './charts.ts';
export { clamp01, DASH, fDay, fPct, fSec, fSigned, fUsd, fWhen, fx, isNum, mean, plural } from './format.ts';
export { chip, dot, errorNote, kpi, loadInto, notice, panel, segmented, StaleServerError, toneDot, type KpiOptions } from './ui.ts';
export { goodness, methodLabel, methodStats, toneOf, type MethodStat } from './analytics.ts';
