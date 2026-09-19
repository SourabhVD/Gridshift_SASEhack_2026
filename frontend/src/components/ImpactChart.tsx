'use client';

/**
 * ImpactChart -- baseline forecast vs the optimized schedule, hour by hour.
 *
 * The story of this panel is the crossover: the optimized curve sits ABOVE the
 * baseline during the 11:00-13:00 pre-cool and again at 18:00-19:00 when the EV
 * sessions land, and below it through the billed peak. The y-axis starts at 0
 * and is never clipped, so that trade is visible rather than flattered.
 *
 * Colors come from the theme tokens in globals.css via CSS variables, which is
 * the only way Recharts can read them from JS.
 */

import { useMemo } from 'react';
import { GitCompareArrows } from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatHour, formatKw } from '@/lib/format';
import { useGridShift } from '@/lib/store';

const CHART_HEIGHT = 260;
const MINUS = '−';

/**
 * Both series are the grid channel: the baseline is the grid blue, the
 * optimized schedule is `good`, which on this page means exactly "the grid came
 * in under the threshold". The two peak rules take the same pair of states, so
 * the legend, the areas and the rules all say the same thing three ways.
 */
const COLOR = {
  baseline: 'var(--color-forecast)',
  optimized: 'var(--color-good)',
  /** The billed ceiling. Alert, like everywhere else -- but held back so it
   *  does not compete with the old-peak rule, which is the louder red here. */
  threshold: 'var(--color-alert)',
  oldPeak: 'var(--color-alert)',
  line: 'var(--line-1, rgba(255,255,255,0.07))',
  muted: 'var(--color-muted)',
} as const;

interface Row {
  hour: string;
  baseline: number;
  optimized: number;
  /** Positive when the optimized schedule pulls load out of this hour. */
  delta: number;
}

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                     */
/* -------------------------------------------------------------------------- */

function TipRow({
  color,
  label,
  value,
  valueClassName,
}: {
  color?: string;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-muted">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: color ?? 'transparent' }}
          aria-hidden="true"
        />
        {label}
      </dt>
      <dd
        className={
          valueClassName ?? 'text-right font-medium text-ink tabular-nums'
        }
      >
        {value}
      </dd>
    </>
  );
}

function ChartTooltip({
  active,
  label,
  rows,
}: {
  active?: boolean;
  label?: string | number;
  rows: Row[];
}) {
  if (!active || label === undefined) return null;

  const row = rows.find((r) => r.hour === String(label));
  if (!row) return null;

  const shed = row.delta > 0;

  return (
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 font-semibold text-ink tabular-nums">{row.hour}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1">
        <TipRow
          color={COLOR.baseline}
          label="Baseline"
          value={formatKw(row.baseline)}
        />
        <TipRow
          color={COLOR.optimized}
          label="Optimized"
          value={formatKw(row.optimized)}
        />
        <TipRow
          label="Delta"
          value={
            (shed ? MINUS : '+') + formatKw(Math.abs(row.delta))
          }
          valueClassName={
            shed
              ? 'text-right font-medium text-good tabular-nums'
              : 'text-right font-medium text-muted tabular-nums'
          }
        />
      </dl>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Legend + stats                                                              */
/* -------------------------------------------------------------------------- */

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted">
      <span
        className="h-0.5 w-4 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-2 p-2.5">
      <p className="text-[11px] tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-1 text-sm font-medium text-ink tabular-nums">{value}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* ImpactChart                                                                 */
/* -------------------------------------------------------------------------- */

export function ImpactChart() {
  const { plan, forecast, runStatus } = useGridShift();

  const rows = useMemo<Row[]>(
    () =>
      (plan?.impact ?? []).map((p) => ({
        hour: formatHour(p.timestamp),
        baseline: p.baseline_kw,
        optimized: p.optimized_kw,
        delta: p.baseline_kw - p.optimized_kw,
      })),
    [plan],
  );

  if (!plan) {
    return (
      <Card
        title="Before vs after"
        subtitle="Baseline forecast vs optimized schedule"
        className="min-h-[300px]"
      >
        <div
          className="flex flex-col items-center justify-center gap-3 text-center"
          style={{ minHeight: CHART_HEIGHT }}
        >
          <GitCompareArrows className="h-6 w-6 text-muted" aria-hidden="true" />
          <p className="text-sm text-muted">
            {runStatus === 'running'
              ? 'Optimizer running…'
              : 'Impact appears once a plan is generated.'}
          </p>
        </div>
      </Card>
    );
  }

  /** Every third hour, so the axis stays legible on a projector. */
  const ticks = rows.filter((_, i) => i % 3 === 0).map((r) => r.hour);

  const pct =
    plan.baseline_peak_kw > 0
      ? (plan.peak_reduction_kw / plan.baseline_peak_kw) * 100
      : 0;
  // Hourly points, so kW over one hour is kWh.
  const shiftedKwh = rows.reduce((sum, r) => sum + Math.max(r.delta, 0), 0);
  const hoursChanged = rows.filter((r) => Math.abs(r.delta) > 0.01).length;

  return (
    <Card
      title="Before vs after"
      subtitle="Baseline forecast vs optimized schedule"
      right={
        <Badge tone="good">{MINUS + formatKw(plan.peak_reduction_kw)}</Badge>
      }
      className="min-h-[300px]"
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <Swatch color={COLOR.baseline} label="Baseline" />
        <Swatch color={COLOR.optimized} label="Optimized" />
        <span className="ml-auto text-[11px] text-muted">kW</span>
      </div>

      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <ComposedChart data={rows} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={COLOR.line} />

          <XAxis
            dataKey="hour"
            ticks={ticks}
            tickLine={false}
            axisLine={{ stroke: COLOR.line }}
            tick={{ fill: COLOR.muted, fontSize: 11 }}
            tickMargin={8}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[0, 'auto']}
            width={44}
            tickLine={false}
            axisLine={false}
            tick={{ fill: COLOR.muted, fontSize: 11 }}
          />

          <Area
            type="monotone"
            dataKey="baseline"
            name="Baseline"
            stroke={COLOR.baseline}
            strokeWidth={1.5}
            fill={COLOR.baseline}
            fillOpacity={0.08}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0, fill: COLOR.baseline }}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="optimized"
            name="Optimized"
            stroke={COLOR.optimized}
            strokeWidth={2}
            fill={COLOR.optimized}
            fillOpacity={0.15}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0, fill: COLOR.optimized }}
            isAnimationActive={false}
          />

          {forecast && (
            <ReferenceLine
              y={forecast.peak_threshold_kw}
              stroke={COLOR.threshold}
              strokeOpacity={0.45}
              strokeDasharray="5 4"
              strokeWidth={1}
            />
          )}
          <ReferenceLine
            y={plan.baseline_peak_kw}
            stroke={COLOR.oldPeak}
            strokeDasharray="5 4"
            strokeWidth={1}
            label={{
              value: 'Old peak',
              position: 'insideTopRight',
              fill: COLOR.oldPeak,
              fontSize: 10,
            }}
          />
          <ReferenceLine
            y={plan.optimized_peak_kw}
            stroke={COLOR.optimized}
            strokeDasharray="5 4"
            strokeWidth={1}
            label={{
              value: 'New peak',
              position: 'insideBottomRight',
              fill: COLOR.optimized,
              fontSize: 10,
            }}
          />

          <Tooltip
            content={<ChartTooltip rows={rows} />}
            cursor={{ stroke: COLOR.line, strokeWidth: 1 }}
          />
        </ComposedChart>
      </ResponsiveContainer>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Stat
          label="Peak reduction"
          value={
            MINUS + formatKw(plan.peak_reduction_kw) + ' (' + pct.toFixed(1) + '%)'
          }
        />
        <Stat label="Energy shifted" value={'≈ ' + shiftedKwh.toFixed(0) + ' kWh'} />
        <Stat label="Hours changed" value={String(hoursChanged)} />
      </div>
    </Card>
  );
}

export default ImpactChart;
