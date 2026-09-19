'use client';

/**
 * Twenty-four hours of one device, in 260 x 72 px of inline SVG.
 *
 * No chart library: the card is an overlay on a WebGL canvas and the whole
 * point of it is that it costs nothing to open. Everything it draws is a rule
 * of the dashboard rather than a decoration —
 *
 *   bars        the baseline forecast, muted
 *   line        the optimized plan, in the win colour, only when a plan exists
 *   hairline    the hour the whole dashboard is showing (`viewHour`)
 *   threshold   the billed demand ceiling, dashed, grid and building only
 *   shading     hours the forecast crosses that ceiling
 *
 * Clicking (or arrowing onto) a column moves `viewHour`, so the chart is a
 * scrubber as well as a readout: the scene, the HUD and the card all follow.
 */

import { useId } from 'react';
import clsx from 'clsx';
import { formatHourIndex } from '@/lib/format';

const W = 260;
const H = 72;
const PAD_T = 6;
const PAD_B = 12;
const PLOT_H = H - PAD_T - PAD_B;
const HOURS = 24;
const COL = W / HOURS;
/** Gap between bars, in px, split either side. */
const BAR_GAP = 2.4;

export interface MiniChartProps {
  /** 24 values, the do-nothing forecast. */
  baseline: readonly number[];
  /** 24 values from the plan, or null when there is no plan. */
  optimized?: readonly number[] | null;
  hour: number;
  onPick: (hour: number) => void;
  /** Billed ceiling; draws a dashed rule and shades the hours above it. */
  threshold?: number | null;
  /** Battery kW is the one signed series: it gets a zero rule and bars both ways. */
  signed?: boolean;
  label: string;
}

function extent(series: readonly number[][], signed: boolean, threshold: number | null) {
  let max = 0;
  let min = 0;
  for (const values of series) {
    for (const value of values) {
      if (value > max) max = value;
      if (value < min) min = value;
    }
  }
  if (threshold != null && threshold > max) max = threshold;
  if (!signed) min = 0;
  /* A flat-zero day still needs a baseline to sit on. */
  if (max - min < 0.001) max = min + 1;
  return { min, max };
}

export function MiniChart({
  baseline,
  optimized,
  hour,
  onPick,
  threshold,
  signed = false,
  label,
}: MiniChartProps) {
  const id = useId();
  const series = optimized ? [baseline as number[], optimized as number[]] : [baseline as number[]];
  const { min, max } = extent(series, signed, threshold ?? null);
  const span = max - min;

  const y = (value: number) => PAD_T + PLOT_H * (1 - (value - min) / span);
  const zeroY = y(signed ? 0 : min);

  const path = optimized
    ? optimized
        .map((value, index) => `${index === 0 ? 'M' : 'L'}${(index + 0.5) * COL},${y(value)}`)
        .join(' ')
    : null;

  const over =
    threshold != null ? baseline.map((value) => value > threshold) : null;

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={`${label}, 24 hours. Use the arrow keys to move the hour.`}
      aria-valuemin={0}
      aria-valuemax={23}
      aria-valuenow={hour}
      aria-valuetext={formatHourIndex(hour)}
      className="rounded-md outline-none focus-visible:ring-1 focus-visible:ring-forecast/60"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          event.preventDefault();
          onPick(Math.max(0, hour - 1));
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          event.preventDefault();
          onPick(Math.min(23, hour + 1));
        } else if (event.key === 'Home') {
          event.preventDefault();
          onPick(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          onPick(23);
        }
      }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="presentation"
        className="overflow-visible"
      >
        {/* peak hours, faintly */}
        {over?.map((isOver, index) =>
          isOver ? (
            <rect
              key={`peak-${id}-${index}`}
              x={index * COL}
              y={PAD_T}
              width={COL}
              height={PLOT_H}
              fill="var(--color-peak)"
              opacity={0.08}
            />
          ) : null,
        )}

        {/* baseline bars */}
        {baseline.map((value, index) => {
          const top = Math.min(y(value), zeroY);
          const height = Math.max(1, Math.abs(zeroY - y(value)));
          return (
            <rect
              key={`bar-${id}-${index}`}
              x={index * COL + BAR_GAP / 2}
              y={top}
              width={COL - BAR_GAP}
              height={height}
              rx={1}
              fill="var(--color-muted)"
              opacity={index === hour ? 0.65 : 0.32}
            />
          );
        })}

        {signed ? (
          <line
            x1={0}
            x2={W}
            y1={zeroY}
            y2={zeroY}
            stroke="var(--color-line)"
            strokeWidth={1}
          />
        ) : null}

        {threshold != null ? (
          <line
            x1={0}
            x2={W}
            y1={y(threshold)}
            y2={y(threshold)}
            stroke="var(--color-alert)"
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.7}
          />
        ) : null}

        {path ? (
          <path
            d={path}
            fill="none"
            stroke="var(--color-good)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {/* the hour the dashboard is on */}
        <line
          x1={(hour + 0.5) * COL}
          x2={(hour + 0.5) * COL}
          y1={PAD_T - 3}
          y2={PAD_T + PLOT_H + 3}
          stroke="var(--color-ink)"
          strokeWidth={1}
          opacity={0.55}
        />

        {/* hit targets */}
        {baseline.map((_, index) => (
          <rect
            key={`hit-${id}-${index}`}
            x={index * COL}
            y={0}
            width={COL}
            height={H}
            fill="transparent"
            className="cursor-pointer"
            onClick={() => onPick(index)}
          >
            <title>{formatHourIndex(index)}</title>
          </rect>
        ))}

        {[0, 6, 12, 18].map((tick) => (
          <text
            key={`tick-${id}-${tick}`}
            x={(tick + 0.5) * COL}
            y={H - 2}
            textAnchor="middle"
            className={clsx('fill-[var(--color-muted)] text-[8px]')}
          >
            {formatHourIndex(tick).slice(0, 2)}
          </text>
        ))}
      </svg>
    </div>
  );
}

export default MiniChart;
