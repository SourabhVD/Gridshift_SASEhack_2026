'use client';

/**
 * DemandChart -- 24 hourly intervals of forecast vs metered load, with the
 * billed demand threshold, the peak window and (once a plan lands) the
 * optimized curve on the same axis.
 *
 * One y-axis on purpose: price is carried by the tooltip rather than a second
 * scale, because two scales on one plot invent correlations that are not in the
 * data. Colors come from the theme tokens in globals.css via CSS variables,
 * which is the only way Recharts can read them from JS.
 */

import { useCallback, useMemo, useRef } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatHour, formatKw, formatPrice } from '@/lib/format';
import { useGridShift } from '@/lib/store';

const CHART_HEIGHT = 300;

/** Last index of the 24-hour day. */
const LAST_HOUR = 23;

/**
 * The panel's whole colour vocabulary, in one place.
 *
 * Two facts used to share the amber: the billed threshold and the peak-price
 * window. They are different facts, so the threshold takes `alert` -- crossing
 * it is the failure the product exists to prevent -- and the band behind it
 * keeps the amber, which is what "peak pricing" has always meant here.
 *
 * `optimized` is `good`, and `good` means exactly one thing on this page: the
 * grid came in under the threshold. It is the same line as `forecast`, one plan
 * later, which is why it is the only series allowed to change colour.
 */
const COLOR = {
  /** The grid channel. Forecast and the viewing rule. */
  forecast: 'var(--color-forecast)',
  /** Metered load. Pure ink: a 2 px line that has to beat the coloured ones. */
  actual: 'var(--color-ink)',
  /** Grid under threshold, optimized. */
  optimized: 'var(--color-good)',
  /** The billed ceiling. */
  threshold: 'var(--color-alert)',
  /** Peak-price hours. Fill only, never text. */
  peakBand: 'var(--color-peak)',
  /** Divider hairline: alpha, so it holds on the panel and on the page alike. */
  line: 'var(--line-1, rgba(255,255,255,0.07))',
  muted: 'var(--color-muted)',
  ink: 'var(--color-ink)',
} as const;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "2025-09-18T10:00:00-07:00" -> "Sep 18, 2025". Deterministic, unlike toLocaleDateString. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

interface Row {
  hour: string;
  predicted: number;
  actual: number | null;
  optimized: number | null;
  price: number;
  isPeak: boolean;
}

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                     */
/* -------------------------------------------------------------------------- */

function TipRow({
  color,
  label,
  value,
}: {
  color?: string;
  label: string;
  value: string;
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
      <dd className="text-right font-medium text-ink tabular-nums">{value}</dd>
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

  return (
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-semibold text-ink tabular-nums">{row.hour}</span>
        {row.isPeak && (
          <span className="rounded-sm bg-alert/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-alert uppercase">
            Peak
          </span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1">
        <TipRow color={COLOR.forecast} label="Forecast" value={formatKw(row.predicted)} />
        {row.actual !== null && (
          <TipRow color={COLOR.actual} label="Actual" value={formatKw(row.actual)} />
        )}
        {row.optimized !== null && (
          <TipRow
            color={COLOR.optimized}
            label="Optimized"
            value={formatKw(row.optimized)}
          />
        )}
        <TipRow label="Price" value={formatPrice(row.price)} />
      </dl>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Legend                                                                      */
/* -------------------------------------------------------------------------- */

function Swatch({
  color,
  dashed,
  label,
}: {
  color: string;
  dashed?: boolean;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted">
      <span
        className="h-0.5 w-4 shrink-0 rounded-full"
        style={
          dashed
            ? {
                backgroundImage: `repeating-linear-gradient(to right, ${color} 0 4px, transparent 4px 7px)`,
              }
            : { backgroundColor: color }
        }
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* DemandChart                                                                 */
/* -------------------------------------------------------------------------- */

export function DemandChart() {
  const { forecast, building, plan, viewMode, viewHour, nowHour, setViewHour } =
    useGridShift();

  /**
   * Click-to-scrub. `rows` is in forecast order, so recharts' active index IS
   * the hour -- but recharts 3 clears the active index before it calls the
   * click handler, so the last hovered index is kept in a ref and used as the
   * fallback. State is typed `unknown` deliberately: the chart-state shape is
   * not a public recharts type worth depending on.
   */
  const hoveredHourRef = useRef<number | null>(null);

  const activeHour = (state: unknown): number | null => {
    const raw = (state as { activeTooltipIndex?: number | string | null } | null)
      ?.activeTooltipIndex;
    if (raw === null || raw === undefined) return null;
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 && index <= LAST_HOUR ? index : null;
  };

  const onChartMove = useCallback((state: unknown) => {
    hoveredHourRef.current = activeHour(state);
  }, []);

  const onChartClick = useCallback(
    (state: unknown) => {
      const hour = activeHour(state) ?? hoveredHourRef.current;
      if (hour !== null) setViewHour(hour);
    },
    [setViewHour],
  );

  const rows = useMemo<Row[]>(() => {
    if (!forecast) return [];
    const optimizedByTimestamp = new Map<string, number>();
    for (const point of plan?.impact ?? []) {
      optimizedByTimestamp.set(point.timestamp, point.optimized_kw);
    }
    return forecast.points.map((p) => ({
      hour: formatHour(p.timestamp),
      predicted: p.predicted_load_kw,
      actual: p.actual_load_kw,
      optimized: optimizedByTimestamp.get(p.timestamp) ?? null,
      price: p.price_per_kwh,
      isPeak: p.is_peak,
    }));
  }, [forecast, plan]);

  /** Contiguous runs of is_peak hours, as first/last axis labels. */
  const peakWindows = useMemo(() => {
    const windows: { x1: string; x2: string }[] = [];
    let start: string | null = null;
    let end: string | null = null;
    for (const row of rows) {
      if (row.isPeak) {
        if (start === null) start = row.hour;
        end = row.hour;
      } else if (start !== null && end !== null) {
        windows.push({ x1: start, x2: end });
        start = null;
        end = null;
      }
    }
    if (start !== null && end !== null) windows.push({ x1: start, x2: end });
    return windows;
  }, [rows]);

  if (!forecast) {
    return (
      <Card title="24-hour demand forecast" className="min-h-[380px]">
        <div className="h-3 w-56 animate-pulse rounded bg-surface-2" />
        <div
          className="mt-4 w-full animate-pulse rounded-md bg-surface-2"
          style={{ height: CHART_HEIGHT }}
        />
      </Card>
    );
  }

  const threshold = forecast.peak_threshold_kw;
  const peakHours = rows.filter((r) => r.isPeak).length;
  /** `rows` is in forecast order, so an hour index addresses its own row. */
  const nowLabel = rows[nowHour]?.hour ?? null;
  const viewLabel = rows[viewHour]?.hour ?? null;
  const isScrubbed = viewHour !== nowHour;
  /** With a plan on screen in optimized mode, the baseline steps back. */
  const dimBaseline = viewMode === 'optimized' && plan !== null;
  /** Every third hour, so the axis stays legible on a projector. */
  const ticks = rows.filter((_, i) => i % 3 === 0).map((r) => r.hour);

  return (
    <Card
      title="24-hour demand forecast"
      subtitle={`${building?.name ?? forecast.building_name} · generated ${formatDate(
        forecast.generated_at,
      )}`}
      right={
        peakHours > 0 ? (
          <Badge tone="alert">{`${peakHours}h over threshold`}</Badge>
        ) : undefined
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <Swatch color={COLOR.forecast} label="Forecast" />
        <Swatch color={COLOR.actual} label="Actual" />
        {plan && <Swatch color={COLOR.optimized} dashed label="Optimized" />}
        <span className="ml-auto text-[11px] text-muted">kW</span>
      </div>

      <ResponsiveContainer width="100%" height={CHART_HEIGHT} className="cursor-pointer">
        <ComposedChart
          data={rows}
          margin={{ top: 12, right: 8, bottom: 0, left: 0 }}
          onClick={onChartClick}
          onMouseMove={onChartMove}
        >
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

          {peakWindows.map((w) => (
            <ReferenceArea
              key={w.x1}
              x1={w.x1}
              x2={w.x2}
              fill={COLOR.peakBand}
              fillOpacity={0.1}
              strokeOpacity={0}
            />
          ))}

          <Area
            type="monotone"
            dataKey="predicted"
            name="Forecast"
            stroke={COLOR.forecast}
            strokeWidth={2}
            strokeOpacity={dimBaseline ? 0.6 : 1}
            fill={COLOR.forecast}
            fillOpacity={dimBaseline ? 0.06 : 0.1}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0, fill: COLOR.forecast }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="actual"
            name="Actual"
            stroke={COLOR.actual}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            activeDot={{ r: 3, strokeWidth: 0, fill: COLOR.actual }}
            isAnimationActive={false}
          />
          {plan && (
            <Line
              type="monotone"
              dataKey="optimized"
              name="Optimized"
              stroke={COLOR.optimized}
              strokeWidth={2}
              strokeDasharray="4 2"
              dot={false}
              connectNulls={false}
              activeDot={{ r: 3, strokeWidth: 0, fill: COLOR.optimized }}
              isAnimationActive={false}
            />
          )}

          <ReferenceLine
            y={threshold}
            stroke={COLOR.threshold}
            strokeDasharray="5 4"
            strokeWidth={1}
            label={{
              value: `Threshold ${formatKw(threshold)}`,
              position: 'insideTopRight',
              fill: COLOR.threshold,
              fontSize: 11,
            }}
          />

          {nowLabel !== null && (
            <ReferenceLine
              x={nowLabel}
              stroke={COLOR.muted}
              strokeDasharray="3 3"
              strokeWidth={1}
              label={{
                value: 'Now',
                position: 'top',
                fill: COLOR.muted,
                fontSize: 11,
              }}
            />
          )}

          {viewLabel !== null && (
            <ReferenceLine
              x={viewLabel}
              /* Ink, not the grid blue: the rule says which hour, not which
                  series, and a blue rule on a blue area reads as data. */
              stroke={COLOR.ink}
              strokeWidth={1.5}
              strokeOpacity={0.8}
              label={
                isScrubbed
                  ? {
                      value: 'Viewing',
                      position: 'top',
                      fill: COLOR.ink,
                      fontSize: 11,
                    }
                  : undefined
              }
            />
          )}

          <Tooltip
            cursor={{ stroke: COLOR.line, strokeWidth: 1 }}
            content={(props) => (
              <ChartTooltip active={props.active} label={props.label} rows={rows} />
            )}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </Card>
  );
}

export default DemandChart;
