'use client';

/**
 * KpiRow -- the five headline numbers for the Energy Command Center.
 *
 * Reads summary (and forecast, for the tariff context line) from useGridShift().
 * Renders skeleton tiles until `summary` arrives so the row never collapses.
 */

import clsx from 'clsx';
import {
  BatteryMedium,
  DollarSign,
  Sun,
  TrendingUp,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Card } from '@/components/ui/Card';
import {
  formatHour,
  formatKw,
  formatPct,
  formatPrice,
  formatTempF,
} from '@/lib/format';
import { useGridShift } from '@/lib/store';

const GRID = 'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5';

/** Number of cells in the battery glyph. */
const BATTERY_SEGMENTS = 5;

/**
 * Splits a formatted stat ("396 kW", "82%", "$0.09/kWh") into the big value and
 * its small trailing unit, so the formatters in @/lib/format stay the single
 * source of truth for rounding.
 */
const STAT_RE = /^(\$?-?[\d.,]+)\s*(.*)$/;

function splitStat(formatted: string): { value: string; unit: string } {
  const match = STAT_RE.exec(formatted);
  if (!match) return { value: formatted, unit: '' };
  return { value: match[1], unit: match[2] };
}

/* -------------------------------------------------------------------------- */
/* Tile                                                                        */
/* -------------------------------------------------------------------------- */

interface TileProps {
  icon: LucideIcon;
  label: string;
  /** Formatted stat, e.g. "522 kW" -- split into value + unit for you. */
  stat: string;
  /** Tone class for the value, e.g. "text-alert". Defaults to text-ink. */
  valueClassName?: string;
  /** Meter, bar or glyph rendered between the value and the context line. */
  meter?: ReactNode;
  context: ReactNode;
}

function Tile({ icon: Icon, label, stat, valueClassName, meter, context }: TileProps) {
  const { value, unit } = splitStat(stat);

  return (
    <Card bodyClassName="px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span className="truncate text-[11px] font-medium tracking-wide text-muted uppercase">
          {label}
        </span>
      </div>

      <div className="mt-2.5 flex items-baseline gap-1.5">
        <span
          className={clsx(
            'text-[26px] leading-none font-semibold tabular-nums',
            valueClassName ?? 'text-ink',
          )}
        >
          {value}
        </span>
        {unit && <span className="text-xs font-medium text-muted">{unit}</span>}
      </div>

      {meter && <div className="mt-3">{meter}</div>}

      <p className="mt-2 truncate text-xs text-muted">{context}</p>
    </Card>
  );
}

function SkeletonTile() {
  return (
    <Card bodyClassName="px-4 py-3.5">
      <div className="h-3 w-24 animate-pulse rounded bg-surface-2" />
      <div className="mt-3.5 h-6 w-20 animate-pulse rounded bg-surface-2" />
      <div className="mt-4 h-2.5 w-full animate-pulse rounded bg-surface-2" />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Meters                                                                      */
/* -------------------------------------------------------------------------- */

const LOAD_BAR_CLASSES = {
  good: 'bg-good',
  peak: 'bg-peak',
  alert: 'bg-alert',
} as const;

function LoadBar({ pct }: { pct: number }) {
  const tone = pct > 100 ? 'alert' : pct >= 80 ? 'peak' : 'good';
  const width = Math.max(0, Math.min(100, pct));

  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className={clsx('h-full rounded-full', LOAD_BAR_CLASSES[tone])}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function BatteryGlyph({ filled }: { filled: number }) {
  return (
    <div className="flex h-1.5 w-full gap-1">
      {Array.from({ length: BATTERY_SEGMENTS }, (_, i) => (
        <div
          key={i}
          className={clsx(
            'h-full flex-1 rounded-[1px]',
            i < filled ? 'bg-battery' : 'bg-surface-2',
          )}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* KpiRow                                                                      */
/* -------------------------------------------------------------------------- */

export function KpiRow() {
  const { summary, forecast } = useGridShift();

  if (!summary) {
    return (
      <div className={GRID}>
        {Array.from({ length: 5 }, (_, i) => (
          <SkeletonTile key={i} />
        ))}
      </div>
    );
  }

  const threshold = summary.peak_threshold_kw;

  /* 1 -- current load vs the billed threshold */
  const loadPct = threshold > 0 ? (summary.current_load_kw / threshold) * 100 : 0;

  /* 2 -- predicted peak */
  const overBy = summary.predicted_peak_kw - threshold;
  const isOverThreshold = overBy > 0;

  /* 3 -- battery */
  const availableKwh = (summary.battery_soc_pct / 100) * summary.battery_capacity_kwh;
  const filledSegments = Math.max(
    0,
    Math.min(
      BATTERY_SEGMENTS,
      Math.round((summary.battery_soc_pct / 100) * BATTERY_SEGMENTS),
    ),
  );

  /* 4 -- tariff. Prefer the forecast's own price curve over a hard-coded hour. */
  const nowHour = new Date(summary.timestamp).getHours();
  const nextPeakPrice = forecast?.points.find(
    (p) =>
      p.price_per_kwh > summary.electricity_price_per_kwh &&
      new Date(p.timestamp).getHours() > nowHour,
  );
  const priceContext = nextPeakPrice
    ? `Peak pricing from ${formatHour(nextPeakPrice.timestamp)}`
    : nowHour >= 14
      ? 'On-peak pricing now'
      : 'Peak pricing from 14:00';

  return (
    <div className={GRID}>
      <Tile
        icon={Zap}
        label="Current load"
        stat={formatKw(summary.current_load_kw)}
        meter={<LoadBar pct={loadPct} />}
        context={`vs ${formatKw(threshold)} threshold`}
      />

      <Tile
        icon={TrendingUp}
        label="Predicted peak"
        stat={formatKw(summary.predicted_peak_kw)}
        valueClassName={isOverThreshold ? 'text-alert' : 'text-ink'}
        context={`${formatHour(summary.predicted_peak_time)} · ${
          isOverThreshold ? `+${formatKw(overBy)} over threshold` : 'under threshold'
        }`}
      />

      <Tile
        icon={BatteryMedium}
        label="Battery"
        stat={formatPct(summary.battery_soc_pct)}
        valueClassName="text-battery"
        meter={<BatteryGlyph filled={filledSegments} />}
        context={`${Math.round(availableKwh)} of ${summary.battery_capacity_kwh} kWh · ${formatKw(
          summary.battery_max_kw,
        )} max`}
      />

      <Tile
        icon={DollarSign}
        label="Electricity price"
        stat={formatPrice(summary.electricity_price_per_kwh)}
        context={priceContext}
      />

      <Tile
        icon={Sun}
        label="Solar"
        stat={formatKw(summary.solar_generation_kw, 1)}
        context={`${formatTempF(summary.outdoor_temp_f)} outdoor · ${formatTempF(
          summary.hvac_setpoint_f,
        )} setpoint`}
      />
    </div>
  );
}

export default KpiRow;
