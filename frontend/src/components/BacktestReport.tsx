'use client';

/**
 * What GridShift would have done across every metered day on disk.
 *
 * Deliberately not called "performance". Nothing here was dispatched: each row
 * is the model's forecast for a real date put through the same optimizer the
 * live product runs, priced on the same tariff. Calling that a track record
 * would be inventing one.
 *
 * The number that matters is the one a single day cannot give you. A demand
 * charge is billed on the worst interval in the whole month, so quoting one
 * day's peak cut assumes that day set the bill and that every other day stayed
 * under it. The panel shows both figures side by side, because the gap between
 * them is the honest part -- and on real data it is not small.
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';

import { formatKw, formatUsd } from '@/lib/format';
import { useGridShift } from '@/lib/store';
import type { ReportDay } from '@/types/api';
import { Button } from '@/components/ui/Button';

/** Every column the report carries, in the order the rows define them. */
function toCsv(days: readonly ReportDay[]): string {
  if (days.length === 0) return '';
  const columns = Object.keys(days[0]) as (keyof ReportDay)[];
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return [
    columns.join(','),
    ...days.map((day) => columns.map((column) => cell(day[column])).join(',')),
  ].join('\n');
}

function download(name: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Figure({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: string;
  note?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] tracking-[0.09em] text-muted uppercase">{label}</p>
      <p className={clsx('mt-1 text-2xl font-semibold tabular-nums', tone ?? 'text-ink')}>{value}</p>
      {note && <p className="mt-0.5 truncate text-xs text-muted">{note}</p>}
    </div>
  );
}

export function BacktestReport() {
  const { report, isReportLoading, loadReport, backtestDates } = useGridShift();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open && !report && !isReportLoading) void loadReport();
  }, [open, report, isReportLoading, loadReport]);

  // Nothing to report on: one day is not a period.
  if (backtestDates.length < 2) return null;

  const summary = report?.summary ?? null;

  return (
    <section className="border-t border-line py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink">Backtest across {backtestDates.length} metered days</h2>
          <p className="mt-0.5 text-xs text-muted">
            Every day put through the same optimizer · nothing here was dispatched
          </p>
        </div>
        <div className="flex items-center gap-2">
          {summary && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                download(
                  `gridshift-backtest-${summary.first_date}-to-${summary.last_date}.csv`,
                  toCsv(report?.days ?? []),
                )
              }
            >
              Export CSV
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show report'}
          </Button>
        </div>
      </div>

      {open && isReportLoading && <p className="mt-4 text-sm text-muted">Solving every day…</p>}

      {open && !isReportLoading && !summary && (
        <p className="mt-4 text-sm text-muted">No backtested days are available from this backend.</p>
      )}

      {open && summary && (
        <>
          <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            <Figure
              label="Billed peak"
              value={`${formatKw(summary.billed_peak_baseline_kw)} → ${formatKw(summary.billed_peak_optimized_kw)}`}
              tone="text-good"
              note={`worst interval of ${summary.days_covered} days`}
            />
            <Figure
              label="Demand charge saved"
              value={formatUsd(summary.demand_charge_usd)}
              tone="text-good"
              note={`${formatKw(summary.billed_peak_reduction_kw)} at $${summary.demand_charge_usd_per_kw}/kW`}
            />
            <Figure
              label="Day-ahead energy"
              value={formatUsd(Math.abs(summary.energy_savings_usd))}
              tone={summary.energy_savings_usd >= 0 ? 'text-good' : 'text-peak'}
              note={summary.energy_savings_usd >= 0 ? 'saved over the period' : 'extra, to buy the peak down'}
            />
            <Figure
              label="Forecast accuracy"
              value={summary.mean_mape_pct != null ? `${summary.mean_mape_pct.toFixed(1)}%` : '—'}
              note={summary.mean_mae_kw != null ? `${summary.mean_mae_kw.toFixed(2)} kW mean error` : undefined}
            />
          </div>

          {/* The honest caveat, stated rather than buried. */}
          <p className="mt-5 max-w-3xl text-xs leading-relaxed text-muted">
            Quoting the best single day ({summary.best_day}, a{' '}
            {formatKw(summary.best_day_peak_reduction_kw)} cut) would claim{' '}
            <span className="text-ink tabular-nums">{formatUsd(summary.best_day_claim_usd)}</span>. The
            period actually delivers{' '}
            <span className="text-ink tabular-nums">{formatUsd(summary.demand_charge_usd)}</span>,
            because the demand charge is billed once on the worst interval — and the day that sets the
            optimized peak is not the day we shaved hardest. The difference is{' '}
            <span className="text-peak tabular-nums">{formatUsd(summary.best_day_overstates_by_usd)}</span>.
          </p>

          <div className="mt-5 max-h-72 overflow-auto">
            <table className="w-full text-left text-xs tabular-nums">
              <thead className="sticky top-0 bg-base text-[11px] tracking-[0.06em] text-muted uppercase">
                <tr>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Peak</th>
                  <th className="py-2 pr-4 font-medium">Optimized</th>
                  <th className="py-2 pr-4 font-medium">Cut</th>
                  <th className="py-2 pr-4 font-medium">Energy</th>
                  <th className="py-2 pr-4 font-medium">MAPE</th>
                </tr>
              </thead>
              <tbody className="text-ink-2">
                {report?.days.map((day) => (
                  <tr key={day.date} className="border-t border-line">
                    <td className="py-1.5 pr-4 text-ink">{day.date}</td>
                    <td className="py-1.5 pr-4">{formatKw(day.baseline_peak_kw)}</td>
                    <td className="py-1.5 pr-4 text-good">{formatKw(day.optimized_peak_kw)}</td>
                    <td className="py-1.5 pr-4">−{formatKw(day.peak_reduction_kw)}</td>
                    <td className={clsx('py-1.5 pr-4', day.energy_savings_usd < 0 && 'text-peak')}>
                      {day.energy_savings_usd < 0 ? '+' : '−'}
                      {formatUsd(Math.abs(day.energy_savings_usd))}
                    </td>
                    <td className="py-1.5 pr-4">
                      {day.mape_pct != null ? `${day.mape_pct.toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export default BacktestReport;
