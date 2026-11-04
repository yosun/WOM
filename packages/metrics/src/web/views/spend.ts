// Spend: what the ledger says was paid for. Every paid call from a world build or a benchmark is in it;
// an answer read from the benchmark cache costs nothing and is not.
import { columns, hbars, stack } from '../charts.ts';
import { h } from '../dom.ts';
import { fDay, fPct, fUsd, fWhen, plural, lower } from '../format.ts';
import type { MetricsContext, View } from '../host.ts';
import { kpi, loadInto, notice, panel } from '../ui.ts';

const BENCH_COLOR = '#bfa4ee';
const BUILD_COLOR = 'var(--accent)';
/** Spend by benchmarks has its own colour: the `bench` context, and the kinds whose id starts with `bench`. */
const isBench = (id: string) => id === 'bench' || id.startsWith('bench');

export function spendView(ctx: MetricsContext): View {
  const host = h('div.tab-spend');
  loadInto(host, ctx.data.spend(), (s) => {
    if (!s.calls) return notice('Nothing paid for yet.');
    const share = (usd: number) => fPct(s.totalUsd ? usd / s.totalUsd : null);
    const contexts = s.byContext.slice(0, 2);
    return [
      h('div.kpis.compact',
        kpi({ label: 'Paid so far', value: fUsd(s.totalUsd), sub: s.firstAt ? `Since ${fWhen(s.firstAt)}` : undefined, hint: 'Every paid call in the ledger' }),
        contexts.map((c) => kpi({ label: c.label, value: fUsd(c.usd), sub: share(c.usd) })),
        kpi({ label: 'Paid calls', value: String(s.calls), sub: s.estimatedUsd > 0 ? `${fUsd(s.estimatedUsd)} of the total is estimated` : 'All charges as billed' }),
      ),
      h('div.cols-2',
        panel({ title: 'What the money bought', lede: 'Largest first. Benchmark spend is violet.' },
          hbars(s.byKind.map((k) => ({
            label: k.label,
            value: k.usd,
            text: fUsd(k.usd),
            sub: share(k.usd),
            color: isBench(k.id) ? BENCH_COLOR : BUILD_COLOR,
            title: `${plural(k.calls, 'paid call')}`,
          })))),
        h('div.stack-col',
          panel({ title: s.byContext.map((c, i) => (i ? lower(c.label) : c.label)).join(' and ') },
            stack(s.byContext.map((c) => ({ label: c.label, value: c.usd, text: `${c.label} ${fUsd(c.usd)}`, color: isBench(c.id) ? BENCH_COLOR : BUILD_COLOR })), { totalText: fUsd(s.totalUsd) }),
            h('p.muted.small', 'Re-running a benchmark with the same inputs is free while the cache holds.')),
          panel({ title: 'By provider', lede: 'Who was paid.' },
            hbars(s.byProvider.map((p) => ({ label: p.label, value: p.usd, text: fUsd(p.usd), sub: share(p.usd), title: plural(p.calls, 'paid call') })))),
        ),
      ),
      h('div.cols-2',
        panel({ title: 'By day', lede: 'Days on the machine that runs the server.' },
          columns(s.byDay.map((d) => ({ label: fDay(d.id), value: d.usd, text: fUsd(d.usd), title: plural(d.calls, 'paid call') })))),
        panel({ title: 'By world', lede: 'Builds, plus the benchmark and asset-check calls about each world.' },
          hbars(s.byWorld.map((w) => ({ label: w.label, value: w.usd, text: fUsd(w.usd), sub: share(w.usd), title: plural(w.calls, 'paid call') })))),
      ),
      s.perCase.length ? panel({
        title: 'What a method costs',
        lede: 'Measured from the ledger: what the calls behind one case cost when they were paid for, averaged over every case that was.',
      },
      h('div.table-wrap', h('table.lb',
        h('thead', h('tr', h('th.left', 'Method'), h('th.left', 'How it was used'), h('th', 'Per case'), h('th', 'Cases paid for'), h('th', 'Calls'), h('th', 'Total'))),
        h('tbody', s.perCase.map((p) => h('tr',
          h('td.left', h('strong', p.label ?? p.method)),
          h('td.left', p.about ?? ''),
          h('td', h('b', fUsd(p.usdPerCase))),
          h('td', String(p.cases)),
          h('td', String(p.calls)),
          h('td', fUsd(p.usd)),
        ))),
      )),
      h('p.muted.small', 'A method made from another\'s answer costs what that answer cost; methods with no model are free.')) : null,
    ];
  }, 'the spend report', ctx.isDisposed);
  return { el: host };
}
