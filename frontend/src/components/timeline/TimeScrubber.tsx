'use client';

/**
 * TimeScrubber -- the 24-hour transport control that sits under the demand
 * chart: play/pause, step, scrub, and the baseline/optimized switch.
 *
 * The switch is the ONE place that comparison lives. It used to be a quiet pair
 * of buttons here with a second copy two clicks deep in the scene's settings
 * menu; the duplicate is gone and this one is promoted -- captioned, ink rather
 * than muted, and with a thumb that slides under the label over --dur instead of
 * blinking to it. After Run GridShift it is the most important control on the
 * page, and it now looks like one.
 *
 * Fully controlled. There is no timer in here on purpose -- playback ticking
 * lives in the store, so this component stays a pure function of its props and
 * can be re-rendered every second without drift. Everything it draws (track,
 * sparkline, ticks) is derived from `hour`, `nowHour` and `loadByHour`.
 *
 * Geometry note: hour `h` occupies the cell [h/24, (h+1)/24] of the track and
 * is anchored at that cell's centre, which is also where the sparkline samples
 * sit. Tick labels use every third hour and the same 'HH:00' style as
 * DemandChart's x-axis so the two read as one axis stacked in one grid cell.
 */

import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

/* -------------------------------------------------------------------------- */
/* Props                                                                       */
/* -------------------------------------------------------------------------- */

export type ScrubberMode = 'baseline' | 'optimized';

export interface TimeScrubberProps {
  /** 0-23, the hour currently being viewed. */
  hour: number;
  /** The "live" hour, drawn as a dashed marker on the track. */
  nowHour: number;
  /** Whether the store is currently advancing `hour`. */
  isPlaying: boolean;
  /** Which series the dashboard is showing. */
  mode: ScrubberMode;
  /** True only when an optimized plan exists; gates the Optimized segment. */
  canToggleMode: boolean;
  /** Hours where the baseline is over threshold, e.g. [13, 14, 15, 16]. */
  peakHours: number[];
  /** 24 values, grid kW for the CURRENT mode. Drives the mini sparkline. */
  loadByHour: number[];
  /** Billed demand threshold, in kW. */
  thresholdKw: number;
  /** Called with the new hour on scrub, step or keyboard nudge. */
  onHourChange: (hour: number) => void;
  /** Called when the play/pause button or Space is pressed. */
  onTogglePlay: () => void;
  /** Called when a mode segment is chosen. */
  onModeChange: (mode: ScrubberMode) => void;
  /** Extra classes on the outer bar. */
  className?: string;
}

/* -------------------------------------------------------------------------- */
/* Constants and pure helpers                                                  */
/* -------------------------------------------------------------------------- */

const HOURS = 24;
const MIN_HOUR = 0;
const MAX_HOUR = 23;
const PAGE_STEP = 6;

/** Sparkline viewBox: 10 units per hour cell, 24 cells. */
const SPARK_W = 240;
const SPARK_H = 24;
const CELL_W = SPARK_W / HOURS;

/** Both segments, identical width -- the sliding thumb is 50 % of the control. */
const MODE_SEGMENT = [
  'relative z-10 w-[5.25rem] rounded-[5px] px-2.5 py-1',
  'text-[11px] font-medium transition-colors duration-[var(--dur)] ease-[var(--ease)]',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
].join(' ');

const HOUR_LIST: readonly number[] = Array.from({ length: HOURS }, (_, i) => i);
/** Every third hour, matching DemandChart's axis ticks. */
const TICK_HOURS: readonly number[] = HOUR_LIST.filter((h) => h % 3 === 0);

/**
 * One-shot attention ring for the whole Baseline/Optimized control, played once
 * when a plan first arrives and unlocks the comparison. The keyframes live here
 * because globals.css is owned elsewhere; the gsscrub- prefix keeps them from
 * colliding with anything the theme adds later.
 *
 * The control's own hairline is carried inside the keyframe rather than left to
 * a utility class: box-shadow is one property, so animating the ring on its own
 * would blow the hairline away for the length of the animation.
 */
const SCRUBBER_CSS = `
@keyframes gsscrub-attention {
  0%, 60% {
    box-shadow:
      inset 0 0 0 1px var(--color-line-2),
      0 0 0 2px color-mix(in srgb, var(--color-ink) 45%, transparent);
  }
  100% {
    box-shadow:
      inset 0 0 0 1px var(--color-line-2),
      0 0 0 2px transparent;
  }
}
.gsscrub-attention { animation: gsscrub-attention 1.5s ease-out 1 both; }
@media (prefers-reduced-motion: reduce) {
  .gsscrub-attention { animation: none; }
}
`;

function clampHour(value: number): number {
  if (!Number.isFinite(value)) return MIN_HOUR;
  return Math.min(MAX_HOUR, Math.max(MIN_HOUR, Math.trunc(value)));
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** "13:00" -- the same shape as DemandChart's axis labels. */
function formatHourLabel(hour: number): string {
  return `${pad2(clampHour(hour))}:00`;
}

/** Deterministic thousands separator; toLocaleString would drift SSR -> client. */
function formatKw(value: number): string {
  if (!Number.isFinite(value)) return '--';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function relativeLabel(hour: number, nowHour: number): string {
  const delta = hour - nowHour;
  if (delta === 0) return 'Now';
  return delta > 0 ? `${delta}h ahead` : `${-delta}h ago`;
}

/** Left offset of an hour's cell centre, as a percentage of track width. */
function cellCenterPct(hour: number): number {
  return ((hour + 0.5) / HOURS) * 100;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* prefers-reduced-motion                                                      */
/* -------------------------------------------------------------------------- */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onStoreChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** The server cannot know; false keeps the first client render in agreement. */
function getReducedMotionServerSnapshot(): boolean {
  return false;
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
}

/* -------------------------------------------------------------------------- */
/* Sparkline                                                                   */
/* -------------------------------------------------------------------------- */

function Sparkline({
  loadByHour,
  thresholdKw,
}: {
  loadByHour: number[];
  thresholdKw: number;
}) {
  const { points, thresholdY } = useMemo(() => {
    const values = HOUR_LIST.map((h) => {
      const raw = loadByHour[h];
      return Number.isFinite(raw) ? raw : 0;
    });
    const threshold = Number.isFinite(thresholdKw) ? thresholdKw : 0;
    const max = Math.max(...values, threshold, 1);
    // 1 unit of breathing room top and bottom so the curve never clips.
    const toY = (value: number) =>
      round2(SPARK_H - 1 - (value / max) * (SPARK_H - 2));

    return {
      points: values
        .map((value, h) => `${round2(h * CELL_W + CELL_W / 2)},${toY(value)}`)
        .join(' '),
      thresholdY: toY(threshold),
    };
  }, [loadByHour, thresholdKw]);

  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <line
        x1={0}
        x2={SPARK_W}
        y1={thresholdY}
        y2={thresholdY}
        stroke="var(--color-alert)"
        strokeWidth={1}
        strokeDasharray="4 3"
        opacity={0.7}
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-forecast)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* TimeScrubber                                                                */
/* -------------------------------------------------------------------------- */

function TimeScrubberImpl({
  hour,
  nowHour,
  isPlaying,
  mode,
  canToggleMode,
  peakHours,
  loadByHour,
  thresholdKw,
  onHourChange,
  onTogglePlay,
  onModeChange,
  className,
}: TimeScrubberProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  /** Live during a pointer drag; read inside handlers without re-rendering. */
  const draggingRef = useRef(false);
  /** Last value handed to onHourChange, so a drag never repeats itself. */
  const lastSentRef = useRef<number | null>(null);
  /** Current hour, so keyboard/step handlers stay referentially stable. */
  const hourRef = useRef(hour);

  const [isDragging, setIsDragging] = useState(false);
  const [hoverHour, setHoverHour] = useState<number | null>(null);
  const [attention, setAttention] = useState(false);

  /** Ties the "View" caption to the segmented group without a duplicate label. */
  const viewLabelId = useId();

  const reducedMotion = usePrefersReducedMotion();

  const safeHour = clampHour(hour);
  const safeNowHour = clampHour(nowHour);

  useEffect(() => {
    hourRef.current = safeHour;
  }, [safeHour]);

  /* -- one-shot attention ring when Optimized first unlocks ---------------- */

  const prevCanToggleRef = useRef(canToggleMode);
  useEffect(() => {
    const justUnlocked = !prevCanToggleRef.current && canToggleMode;
    prevCanToggleRef.current = canToggleMode;
    if (!justUnlocked) return;
    setAttention(true);
    const timer = window.setTimeout(() => setAttention(false), 1600);
    return () => window.clearTimeout(timer);
  }, [canToggleMode]);

  const peakSet = useMemo(() => new Set(peakHours), [peakHours]);

  /* -- hour changes -------------------------------------------------------- */

  const commitHour = useCallback(
    (next: number) => {
      if (lastSentRef.current === next) return;
      lastSentRef.current = next;
      onHourChange(next);
    },
    [onHourChange],
  );

  /** Discrete step from a button or key; independent of the drag dedupe. */
  const stepTo = useCallback(
    (next: number) => {
      const clamped = clampHour(next);
      if (clamped === hourRef.current) return;
      lastSentRef.current = null;
      commitHour(clamped);
    },
    [commitHour],
  );

  const stepBack = useCallback(() => stepTo(hourRef.current - 1), [stepTo]);
  const stepForward = useCallback(() => stepTo(hourRef.current + 1), [stepTo]);

  /* -- pointer scrubbing --------------------------------------------------- */

  const hourFromClientX = useCallback((clientX: number): number | null => {
    const element = trackRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return clampHour(Math.floor(((clientX - rect.left) / rect.width) * HOURS));
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const next = hourFromClientX(event.clientX);
      if (next === null) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      draggingRef.current = true;
      setIsDragging(true);
      setHoverHour(next);
      lastSentRef.current = null;
      // Scrubbing never pauses: playback state belongs to the store.
      commitHour(next);
    },
    [commitHour, hourFromClientX],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const next = hourFromClientX(event.clientX);
      if (next === null) return;
      setHoverHour(next);
      if (draggingRef.current) commitHour(next);
    },
    [commitHour, hourFromClientX],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggingRef.current = false;
    lastSentRef.current = null;
    setIsDragging(false);
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (!draggingRef.current) setHoverHour(null);
  }, []);

  /* -- keyboard ------------------------------------------------------------ */

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const current = hourRef.current;
      let next: number;

      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          next = current - 1;
          break;
        case 'ArrowRight':
        case 'ArrowUp':
          next = current + 1;
          break;
        case 'PageDown':
          next = current - PAGE_STEP;
          break;
        case 'PageUp':
          next = current + PAGE_STEP;
          break;
        case 'Home':
          next = MIN_HOUR;
          break;
        case 'End':
          next = MAX_HOUR;
          break;
        case ' ':
        case 'Spacebar':
          event.preventDefault();
          onTogglePlay();
          return;
        default:
          return;
      }

      event.preventDefault();
      stepTo(next);
    },
    [onTogglePlay, stepTo],
  );

  /* -- mode ---------------------------------------------------------------- */

  const selectBaseline = useCallback(
    () => onModeChange('baseline'),
    [onModeChange],
  );
  const selectOptimized = useCallback(
    () => onModeChange('optimized'),
    [onModeChange],
  );

  /* -- derived readouts ---------------------------------------------------- */

  const currentValue = loadByHour[safeHour];
  const hasCurrentValue = Number.isFinite(currentValue);
  const isOverThreshold = hasCurrentValue && currentValue > thresholdKw;

  const hoverValue = hoverHour === null ? undefined : loadByHour[hoverHour];
  const playheadTransition = !isDragging && !reducedMotion;

  /* Optimized is only a real state once a plan exists; before that the thumb
     stays under Baseline however the prop is spelled. */
  const isOptimized = mode === 'optimized' && canToggleMode;

  return (
    <div
      className={clsx(
        'flex flex-col gap-3 border-y border-line-2 py-3',
        'sm:h-[76px] sm:flex-row sm:items-center sm:gap-5',
        className,
      )}
    >
      <style>{SCRUBBER_CSS}</style>

      {/* ---- transport --------------------------------------------------- */}
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onTogglePlay}
          aria-label={isPlaying ? 'Pause playback' : 'Play 24-hour timeline'}
          aria-pressed={isPlaying}
          className={clsx(
            'flex h-8 w-8 items-center justify-center rounded-md',
            'transition duration-[var(--dur)] ease-[var(--ease)] active:scale-[0.97]',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            isPlaying
              ? 'bg-surface-2 text-ink hover:brightness-125'
              : 'bg-accent text-accent-ink hover:brightness-110',
          )}
        >
          {isPlaying ? (
            <Pause className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="h-4 w-4" aria-hidden="true" />
          )}
        </button>

        <div className="flex items-center">
          <button
            type="button"
            onClick={stepBack}
            disabled={safeHour <= MIN_HOUR}
            aria-label="Step back one hour"
            className={clsx(
              'flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors',
              'hover:bg-surface-2 hover:text-ink',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              'disabled:pointer-events-none disabled:opacity-35',
            )}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={stepForward}
            disabled={safeHour >= MAX_HOUR}
            aria-label="Step forward one hour"
            className={clsx(
              'flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors',
              'hover:bg-surface-2 hover:text-ink',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              'disabled:pointer-events-none disabled:opacity-35',
            )}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="ml-1 w-[4.25rem] shrink-0">
          <div className="text-lg leading-tight font-semibold text-ink tabular-nums">
            {formatHourLabel(safeHour)}
          </div>
          <div className="text-[11px] leading-tight text-muted">
            {relativeLabel(safeHour, safeNowHour)}
          </div>
        </div>
      </div>

      {/* ---- track ------------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="relative">
          {hoverHour !== null && (
            <div
              className={clsx(
                'pointer-events-none absolute bottom-full z-30 mb-2 -translate-x-1/2',
                'rounded-md bg-surface-2 px-2 py-1 shadow-lg shadow-black/60',
                'text-[11px] whitespace-nowrap text-ink tabular-nums',
              )}
              style={{ left: `${cellCenterPct(hoverHour)}%` }}
            >
              {formatHourLabel(hoverHour)}
              {' · '}
              {Number.isFinite(hoverValue) ? formatKw(hoverValue as number) : '--'} kW
            </div>
          )}

          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label="Hour of day"
            aria-orientation="horizontal"
            aria-valuemin={MIN_HOUR}
            aria-valuemax={MAX_HOUR}
            aria-valuenow={safeHour}
            aria-valuetext={formatHourLabel(safeHour)}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={handlePointerLeave}
            onKeyDown={handleKeyDown}
            className={clsx(
              'relative h-8 w-full touch-none select-none',
              'rounded-[5px] bg-surface-2',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              isDragging ? 'cursor-grabbing' : 'cursor-pointer',
            )}
          >
            {/* sparkline; past hours veiled so they read as actuals */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[5px]">
              <Sparkline loadByHour={loadByHour} thresholdKw={thresholdKw} />
              {safeNowHour > MIN_HOUR && (
                <div
                  className="absolute inset-y-0 left-0 bg-base/30"
                  style={{ width: `${(safeNowHour / HOURS) * 100}%` }}
                />
              )}
            </div>

            {/* 24 cells: peak bands, hover highlight, past dimming */}
            <div className="pointer-events-none absolute inset-0 flex overflow-hidden rounded-[5px]">
              {HOUR_LIST.map((h) => (
                <div
                  key={h}
                  className={clsx(
                    'flex-1 border-r border-line last:border-r-0',
                    peakSet.has(h) && 'bg-peak/10',
                    hoverHour === h && 'bg-ink/5',
                    h < safeNowHour && 'opacity-70',
                  )}
                />
              ))}
            </div>

            {/* now marker */}
            <div
              className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-muted/70"
              style={{ left: `${cellCenterPct(safeNowHour)}%` }}
            >
              <span className="absolute top-0 left-1 text-[9px] leading-[10px] tracking-wide text-muted lowercase">
                now
              </span>
            </div>

            {/* playhead */}
            <div
              className={clsx(
                'pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-ink',
                playheadTransition && 'transition-[left] duration-150 ease-out',
              )}
              style={{ left: `${cellCenterPct(safeHour)}%` }}
            >
              <span className="absolute top-1/2 left-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink ring-4 ring-ink/20" />
            </div>
          </div>
        </div>

        {/* tick labels: every 3h, thinned to every 6h once the bar is narrow */}
        <div className="relative h-3 w-full" aria-hidden="true">
          {TICK_HOURS.map((h) => (
            <span
              key={h}
              className={clsx(
                'absolute top-0 text-[10px] leading-none text-muted tabular-nums',
                h === MIN_HOUR ? 'left-0' : '-translate-x-1/2',
                h % 6 !== 0 && 'hidden sm:inline-block',
              )}
              style={h === MIN_HOUR ? undefined : { left: `${cellCenterPct(h)}%` }}
            >
              {formatHourLabel(h)}
            </span>
          ))}
        </div>
      </div>

      {/* ---- mode -------------------------------------------------------- */}
      <div className="flex shrink-0 flex-col gap-1.5 sm:items-end">
        <div className="flex items-center gap-2">
          <span
            id={viewLabelId}
            className="text-[10px] font-medium tracking-[0.09em] text-muted uppercase"
          >
            View
          </span>

          <div
            role="group"
            aria-labelledby={viewLabelId}
            className={clsx(
              'relative inline-flex rounded-md p-0.5',
              'shadow-[inset_0_0_0_1px_var(--color-line-2)]',
              attention && 'gsscrub-attention',
            )}
          >
            {/* The thumb: exactly half the control's inner width, so a 100 %
                translate lands it on the second segment. Transform only, so it
                slides on the compositor and nothing reflows. Reduced motion is
                handled by the global `transition: none` rule -- it jumps. */}
            <span
              aria-hidden="true"
              className={clsx(
                'absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-[5px] bg-surface-2',
                'transition-transform duration-[var(--dur)] ease-[var(--ease)]',
              )}
              style={{ transform: isOptimized ? 'translateX(100%)' : 'translateX(0)' }}
            />

            <button
              type="button"
              onClick={selectBaseline}
              aria-pressed={!isOptimized}
              className={clsx(
                MODE_SEGMENT,
                !isOptimized ? 'text-ink' : 'text-muted hover:text-ink',
              )}
            >
              Baseline
            </button>
            <button
              type="button"
              onClick={selectOptimized}
              disabled={!canToggleMode}
              aria-pressed={isOptimized}
              title={canToggleMode ? undefined : 'Run GridShift to generate a plan'}
              className={clsx(
                MODE_SEGMENT,
                'disabled:cursor-not-allowed disabled:text-muted/40',
                isOptimized ? 'text-ink' : 'text-muted hover:text-ink',
              )}
            >
              Optimized
            </button>
          </div>
        </div>

        <div
          className={clsx(
            'text-[11px] leading-tight tabular-nums',
            isOverThreshold ? 'text-alert' : 'text-muted',
          )}
        >
          {hasCurrentValue
            ? `${formatKw(currentValue)} kW at ${formatHourLabel(safeHour)}`
            : `-- kW at ${formatHourLabel(safeHour)}`}
        </div>
      </div>
    </div>
  );
}

/** Memoized: the store re-renders every second while a run is playing. */
export const TimeScrubber = React.memo(TimeScrubberImpl);
TimeScrubber.displayName = 'TimeScrubber';

export default TimeScrubber;
