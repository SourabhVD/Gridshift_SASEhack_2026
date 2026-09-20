'use client';

/**
 * KpiRow -- the five headline numbers for the Energy Command Center.
 *
 * Four of the five follow the scrubber: load, battery, solar and price are read
 * out of `flowsAt(viewHour)` / `forecast.points[viewHour]`, so the row always
 * agrees with the flow diagram and the chart marker. Only the predicted peak is
 * a day-level number and stays put.
 *
 * Presentation is one flat strip, not five cards: ten borders and five fills
 * left, two hairlines and four verticals arrived. With nothing boxing them in,
 * the values have to carry the separation themselves -- hence 38px at -0.025em
 * against an 11px tracked label. The hairlines are drawn as 1px grid gaps over
 * `bg-line`, which keeps them correct at every breakpoint without per-cell
 * border juggling.
 *
 * Count-up: values ease over 400ms when the data behind them changes, and snap
 * when the change came from the scrubber. Direct manipulation is 1:1 or it
 * feels broken.
 *
 * The approve moment lands on the second cell: once the plan is approved the
 * predicted peak stops being a forecast and becomes a commitment, so the value
 * counts DOWN from the baseline peak to the optimized one and the tone goes from
 * alert to good. Nothing about the cell's shape changes -- the footer swaps its
 * sentence, it does not appear -- so the strip cannot shift under it.
 *
 * Renders skeleton cells until `summary` arrives so the row never collapses.
 *
 * ## Two levels
 *
 * At portfolio level the same five cells answer about the campus instead of
 * about one site: the summed load, the summed peak and its hour, how many sites
 * are over their own cap right now, the average state of charge and the total
 * generation. Same strip, same rhythm, same count -- flying down to a site
 * swaps five numbers and never the shape of the row, which is what keeps the
 * transition from reading as a page change.
 */

import clsx from 'clsx';
import { useMemo, type ReactNode } from 'react';

import {
  formatHour,
  formatHourIndex,
  formatKw,
  formatPct,
  formatPrice,
  formatTempF,
} from '@/lib/format';
import { useGridShift } from '@/lib/store';
import { useCountUp } from '@/lib/useCountUp';

/** 1px gaps over bg-line draw every hairline; each cell repaints bg-base. */
const STRIP = [
  'grid grid-cols-2 gap-px bg-line md:grid-cols-3 xl:grid-cols-5',
  'border-y border-line-2',
].join(' ');

const CELL = 'flex min-w-0 flex-col bg-base px-5 py-[18px]';

/** Number of cells in the battery glyph. */
const BATTERY_SEGMENTS = 5;

/* -------------------------------------------------------------------------- */
/* Cell                                                                        */
/* -------------------------------------------------------------------------- */

interface CellProps {
  label: string;
  /** The big number, already formatted and already counted up. */
  value: string;
  /** Trailing unit: "kW", "%". Rendered small and muted beside the value. */
  unit?: string;
  /** Tone class for the value, e.g. "text-alert". Defaults to text-ink. */
  valueClassName?: string;
  /** 2px meter or glyph rendered between the value and the context line. */
  meter?: ReactNode;
  context: ReactNode;
  /** Optional second context line, e.g. the optimized peak. */
  footer?: ReactNode;
}

function Cell({
  label,
  value,
  unit,
  valueClassName,
  meter,
  context,
  footer,
}: CellProps) {
  return (
    <div className={CELL}>
      <span className="truncate text-[11px] font-medium tracking-[0.09em] text-muted uppercase">
        {label}
      </span>

      <div className="mt-3.5 flex items-baseline gap-1.5">
        <span
          className={clsx(
            'text-[38px] leading-none font-semibold -tracking-[0.025em] tabular-nums',
            'transition-colors duration-[var(--dur)] ease-[var(--ease)]',
            valueClassName ?? 'text-ink',
          )}
        >
          {value}
        </span>
        {unit && (
          <span className="text-[13px] font-medium text-muted">{unit}</span>
        )}
      </div>

      {meter && <div className="mt-3.5">{meter}</div>}

      <p className="mt-2.5 truncate text-xs text-ink-2">{context}</p>
      {footer && <p className="mt-1 truncate text-xs">{footer}</p>}
    </div>
  );
}

function SkeletonCell() {
  return (
    <div className={CELL} aria-hidden="true">
      <div className="h-3 w-24 animate-pulse rounded bg-surface-2" />
      <div className="mt-4 h-9 w-24 animate-pulse rounded bg-surface-2" />
      <div className="mt-5 h-2.5 w-full animate-pulse rounded bg-surface-2" />
    </div>
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
    <div className="h-0.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className={clsx(
          'h-full rounded-full transition-[width] duration-[var(--dur)] ease-[var(--ease)]',
          LOAD_BAR_CLASSES[tone],
        )}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function BatteryGlyph({ filled }: { filled: number }) {
  return (
    <div className="flex h-0.5 w-full gap-1">
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

/** The "this is not now" marker on the cells that follow the scrubber. */
function PreviewDot() {
  return (
    <span className="mr-1.5 inline-flex items-center gap-1 text-muted">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-forecast align-middle" />
      preview
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* KpiRow                                                                      */
/* -------------------------------------------------------------------------- */

export function KpiRow() {
  const {
    summary,
    forecast,
    building,
    plan,
    runStatus,
    viewMode,
    viewHour,
    nowHour,
    flowsAt,
    level,
  } = useGridShift();

  const isApproved = runStatus === 'approved';

  const flows = summary ? flowsAt(viewHour) : null;
  const threshold = building?.peak_threshold_kw ?? summary?.peak_threshold_kw ?? 0;

  /* Raw values first, so the count-ups are unconditional hooks. */
  const rawLoadKw = flows?.grid_kw ?? summary?.current_load_kw ?? 0;
  const baselinePeakKw = summary?.predicted_peak_kw ?? 0;
  /* An approved plan is what the site will actually do, so the headline peak
     becomes the optimized one -- and `useCountUp` walks the 522 -> 448 itself. */
  const rawPeakKw = isApproved && plan ? plan.optimized_peak_kw : baselinePeakKw;
  const rawSocPct = flows?.battery_soc_pct ?? summary?.battery_soc_pct ?? 0;
  const rawSolarKw = flows?.solar_kw ?? summary?.solar_generation_kw ?? 0;

  /* Scrubber-driven numbers snap on scrub and ease on everything else. */
  const loadKw = useCountUp(rawLoadKw, { snapKey: viewHour });
  const socPct = useCountUp(rawSocPct, { snapKey: viewHour });
  const solarKw = useCountUp(rawSolarKw, { snapKey: viewHour });
  /* The day-level peak is the demo's punchline; it always counts. */
  const peakKw = useCountUp(rawPeakKw);
  const optimizedPeakKw = useCountUp(plan?.optimized_peak_kw ?? 0);

  if (level === 'portfolio') return <PortfolioKpis />;

  if (!summary) {
    return (
      <div className={STRIP}>
        {Array.from({ length: 5 }, (_, i) => (
          <SkeletonCell key={i} />
        ))}
        <div className="bg-base xl:hidden" aria-hidden="true" />
      </div>
    );
  }

  const isScrubbed = viewHour !== nowHour;

  /* 1 -- load at the viewed hour, against the billed threshold */
  const loadPct = threshold > 0 ? (loadKw / threshold) * 100 : 0;

  /* 2 -- predicted peak: a day-level number, so it ignores the scrubber */
  const overBy = rawPeakKw - threshold;
  const isOverThreshold = overBy > 0;
  const showOptimizedPeak = viewMode === 'optimized' && plan !== null;
  const savedKw = plan ? baselinePeakKw - plan.optimized_peak_kw : 0;

  /* 3 -- battery at the viewed hour */
  const batteryKw = flows?.battery_kw ?? 0;
  const availableKwh = (socPct / 100) * summary.battery_capacity_kwh;
  const filledSegments = Math.max(
    0,
    Math.min(BATTERY_SEGMENTS, Math.round((socPct / 100) * BATTERY_SEGMENTS)),
  );
  const batteryState =
    batteryKw > 0
      ? `discharging ${formatKw(batteryKw)}`
      : batteryKw < 0
        ? `charging ${formatKw(Math.abs(batteryKw))}`
        : 'idle';

  /* 4 -- tariff. Prefer the forecast's own price curve over a hard-coded hour.
     Not counted up: at two decimals a count-up is noise, not information. */
  const priceNow =
    forecast?.points[viewHour]?.price_per_kwh ?? summary.electricity_price_per_kwh;
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
    <div className={STRIP}>
      <Cell
        label={isScrubbed ? `Load at ${formatHourIndex(viewHour)}` : 'Current load'}
        value={Math.round(loadKw).toString()}
        unit="kW"
        valueClassName={rawLoadKw > threshold ? 'text-alert' : 'text-ink'}
        meter={<LoadBar pct={loadPct} />}
        context={
          <>
            {isScrubbed && <PreviewDot />}
            {`vs ${formatKw(threshold)} threshold`}
          </>
        }
      />

      <Cell
        label="Predicted peak"
        value={Math.round(peakKw).toString()}
        unit="kW"
        valueClassName={
          isOverThreshold ? 'text-alert' : isApproved ? 'text-good' : 'text-ink'
        }
        context={`${formatHour(summary.predicted_peak_time)} · ${
          isOverThreshold ? `+${formatKw(overBy)} over threshold` : 'under threshold'
        }`}
        footer={
          isApproved && plan ? (
            <span className="text-good tabular-nums">
              {`↓ ${formatKw(savedKw)} vs ${formatKw(baselinePeakKw)} baseline`}
            </span>
          ) : showOptimizedPeak ? (
            <span className="text-good tabular-nums">
              {`→ ${Math.round(optimizedPeakKw)} kW optimized`}
            </span>
          ) : undefined
        }
      />

      <Cell
        label="Battery"
        value={formatPct(socPct).replace('%', '')}
        unit="%"
        valueClassName="text-battery"
        meter={<BatteryGlyph filled={filledSegments} />}
        context={`${batteryState} · ${Math.round(availableKwh)} of ${
          summary.battery_capacity_kwh
        } kWh · ${formatKw(summary.battery_max_kw)} max`}
      />

      <Cell
        label="Electricity price"
        value={formatPrice(priceNow).replace('/kWh', '')}
        unit="/kWh"
        context={
          <>
            {isScrubbed && <PreviewDot />}
            {priceContext}
          </>
        }
      />

      <Cell
        label="Solar"
        value={solarKw.toFixed(1)}
        unit="kW"
        context={`${formatTempF(summary.outdoor_temp_f)} outdoor · ${formatTempF(
          summary.hvac_setpoint_f,
        )} setpoint`}
      />

      {/* Five cells into two or three columns leaves a hole, and the hole
          shows the hairline colour the gaps are painted with. Fill it. */}
      <div className="bg-base xl:hidden" aria-hidden="true" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Portfolio                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The same five cells, asked about the campus.
 *
 * Every figure except the peak follows the scrubber, exactly as the site row
 * does -- one clock for everything. The peak is a day-level fact about the
 * summed curve, which is not the same thing as the sum of the four sites'
 * individual peaks: they do not all peak in the same hour, and the number that
 * matters to a portfolio is the worst hour of the total.
 */
function PortfolioKpis() {
  const { buildings, viewHour, nowHour, portfolioAt, siteFlowsAt } = useGridShift();

  const now = useMemo(() => portfolioAt(viewHour), [portfolioAt, viewHour]);

  const peak = useMemo(() => {
    let kw = -Infinity;
    let hour = 0;
    for (let h = 0; h < 24; h += 1) {
      const total = portfolioAt(h).total_grid_kw;
      if (total > kw) {
        kw = total;
        hour = h;
      }
    }
    return { kw: kw === -Infinity ? 0 : kw, hour };
  }, [portfolioAt]);

  const onSite = useMemo(() => {
    let soc = 0;
    let solar = 0;
    let counted = 0;
    for (const b of buildings) {
      const flows = siteFlowsAt(b.id, viewHour);
      if (!flows) continue;
      soc += flows.battery_soc_pct;
      solar += flows.solar_kw;
      counted += 1;
    }
    return { soc: counted > 0 ? soc / counted : 0, solar, counted };
  }, [buildings, siteFlowsAt, viewHour]);

  const totalKw = useCountUp(now.total_grid_kw, { snapKey: viewHour });
  const peakKw = useCountUp(peak.kw);
  const socPct = useCountUp(onSite.soc, { snapKey: viewHour });
  const solarKw = useCountUp(onSite.solar, { snapKey: viewHour });

  if (buildings.length === 0) {
    return (
      <div className={STRIP}>
        {Array.from({ length: 5 }, (_, i) => (
          <SkeletonCell key={i} />
        ))}
        <div className="bg-base xl:hidden" aria-hidden="true" />
      </div>
    );
  }

  const isScrubbed = viewHour !== nowHour;
  const overNow = now.sites_over_cap.length;
  const capTotal = now.per_site.reduce((sum, site) => sum + site.threshold, 0);
  const headroomPct = capTotal > 0 ? (now.total_grid_kw / capTotal) * 100 : 0;
  const filledSegments = Math.max(
    0,
    Math.min(BATTERY_SEGMENTS, Math.round((socPct / 100) * BATTERY_SEGMENTS)),
  );

  return (
    <div className={STRIP}>
      <Cell
        label={isScrubbed ? `Portfolio at ${formatHourIndex(viewHour)}` : 'Portfolio load'}
        value={Math.round(totalKw).toString()}
        unit="kW"
        valueClassName={overNow > 0 ? 'text-alert' : 'text-ink'}
        meter={<LoadBar pct={headroomPct} />}
        context={
          <>
            {isScrubbed && <PreviewDot />}
            {`across ${buildings.length} sites`}
          </>
        }
      />

      <Cell
        label="Portfolio peak"
        value={Math.round(peakKw).toString()}
        unit="kW"
        context={`${formatHourIndex(peak.hour)} · summed across the campus`}
      />

      {/* This counts the sites over cap AT THE VIEWED HOUR, while the peak
          alert underneath counts the sites that go over at any point in the
          day. Both are true and they are rarely the same number -- 1 here
          against 4 there, on the same screen -- so each has to say which
          question it is answering. Unlabelled, the pair reads as a bug, and
          the empty state read worse: "every site under its threshold" sitting
          directly above "4 of 4 sites exceed their cap today". */}
      <Cell
        label={isScrubbed ? `Over cap at ${formatHourIndex(viewHour)}` : 'Sites over cap now'}
        value={String(overNow)}
        unit={`of ${buildings.length}`}
        valueClassName={overNow > 0 ? 'text-alert' : 'text-good'}
        context={
          <>
            {isScrubbed && <PreviewDot />}
            {overNow > 0
              ? now.sites_over_cap
                  .map((id) => buildings.find((b) => b.id === id)?.name ?? id)
                  .join(', ')
              : `all ${buildings.length} under threshold at ${formatHourIndex(viewHour)}`}
          </>
        }
      />

      <Cell
        label="Average battery"
        value={formatPct(socPct).replace('%', '')}
        unit="%"
        valueClassName="text-battery"
        meter={<BatteryGlyph filled={filledSegments} />}
        context={`mean state of charge · ${onSite.counted} packs`}
      />

      <Cell
        label="Total solar"
        value={solarKw.toFixed(1)}
        unit="kW"
        context={
          <>
            {isScrubbed && <PreviewDot />}
            generated on site right now
          </>
        }
      />

      <div className="bg-base xl:hidden" aria-hidden="true" />
    </div>
  );
}

export default KpiRow;
