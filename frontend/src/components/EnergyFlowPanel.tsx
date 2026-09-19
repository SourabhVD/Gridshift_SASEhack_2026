'use client';

/**
 * EnergyFlowPanel -- the animated device view for the hour being viewed.
 *
 * It sits in the grid where a card would, but it is not one: no border, no
 * surface, no heading row, no rounded inner viewport. The scene's background is
 * the page's own `bg-base`, the radial edge blend walks out to `bg-base` on all
 * four sides, and `Stage` fogs to the same colour, so the site dissolves into
 * the page instead of ending at a rectangle beside the agent log.
 *
 * Reads everything from the shared store and hands it to one of two
 * presentations of the same props: the 3D scene (default) or the 2D single-line
 * diagram. The choice is the viewer's and is remembered across reloads; a
 * browser with no WebGL context is pinned to 2D.
 *
 * Follows the time scrubber (viewHour), the baseline / optimized switch
 * (viewMode) and the agent's current tool call (activeTool).
 *
 * What floats over it is deliberately thin: the hour and plan you are looking
 * at, one line of context about the day, the net grid draw (owned by SceneHud,
 * inside the scene), and a single overflow button for the two settings that
 * would otherwise need permanent chrome. The legend only appears while the
 * pointer is over the scene. Nothing else announces the section.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { SlidersHorizontal } from 'lucide-react';
import EnergyFlowDiagram from '@/components/flow/EnergyFlowDiagram';
import { useWebGL } from '@/components/scene/useWebGL';
import { setQuality, useQuality, type SceneQuality } from '@/components/scene/useQuality';
import { FLOW_VIEWS, setFlowView, useFlowView, type FlowView } from '@/components/useFlowView';
import { formatHour, formatHourIndex, formatKw } from '@/lib/format';
import { useGridShift } from '@/lib/store';

/**
 * Tall enough for the site to have air around it in a two-thirds column, and on
 * a phone -- where the cell is a portrait box barely wider than it is tall --
 * still the same 520 px rather than a letterbox.
 */
const PANEL_BOX = 'relative isolate min-h-[520px] w-full overflow-hidden bg-base lg:h-full';

/** The scene pulls in three.js; it must never run on the server. */
const EnergyScene = dynamic(() => import('@/components/scene/EnergyScene'), {
  ssr: false,
  loading: () => (
    <div
      role="status"
      aria-label="Energy scene loading"
      className="h-full min-h-[520px] w-full animate-pulse bg-base"
    />
  ),
});

const QUALITIES: readonly SceneQuality[] = ['high', 'low'];

export function EnergyFlowPanel() {
  const {
    building,
    currentFlows,
    forecast,
    summary,
    viewHour,
    viewMode,
    activeTool,
    runStatus,
  } = useGridShift();

  const view = useFlowView();
  const webgl = useWebGL();
  const webglSupported = webgl !== 'unsupported';
  const effectiveView: FlowView = webglSupported ? view : '2d';

  const threshold = building?.peak_threshold_kw ?? Infinity;
  const overThreshold = currentFlows != null && currentFlows.grid_kw > threshold;

  const viewProps = {
    building,
    flows: currentFlows,
    hour: viewHour,
    mode: viewMode,
    overThreshold,
    activeTool,
    runStatus,
  };

  /** One line about the day as a whole, under the hour pill. */
  const status = useMemo(() => {
    if (!forecast) return null;
    const peaks = forecast.points.filter((point) => point.is_peak);
    if (peaks.length === 0) return 'Under threshold all day';

    const worst = peaks.reduce((hi, point) =>
      point.predicted_load_kw > hi.predicted_load_kw ? point : hi,
    );
    const peakKw = Math.max(worst.predicted_load_kw, summary?.predicted_peak_kw ?? 0);
    return (
      `Peak ${formatKw(peakKw)} at ${formatHour(worst.timestamp)} · ` +
      `${peaks.length} h over ${formatKw(forecast.peak_threshold_kw)}`
    );
  }, [forecast, summary]);

  return (
    /* `isolate`: the detail card and drei's in-world labels stack against each
       other inside this cell, not against the panels around it. */
    <section aria-label="Site energy flow" className={PANEL_BOX}>
      {effectiveView === '3d' ? (
        <EnergyScene fill {...viewProps} />
      ) : (
        <div className="flex h-full min-h-[520px] w-full items-center justify-center px-4 py-8 sm:px-8">
          <div className="h-full w-full max-w-[1100px]">
            {/* The SVG already centres and letterboxes itself; the override
                just stops its intrinsic height from outgrowing the cell. */}
            <EnergyFlowDiagram {...viewProps} className="h-full [&>svg]:h-full!" />
          </div>
        </div>
      )}

      {/* top-left: the hour you are looking at, and how the day goes */}
      <div className="pointer-events-none absolute top-4 left-4 sm:left-5">
        {effectiveView === '3d' && (
          <span
            className={clsx(
              'inline-flex items-center rounded-full border border-line bg-surface-2/80 px-3 py-1',
              'text-[11px] tracking-wide text-muted backdrop-blur-sm',
            )}
          >
            {formatHourIndex(viewHour)} ·{' '}
            {viewMode === 'optimized' ? 'Optimized' : 'Baseline'}
          </span>
        )}
        {status && (
          <p
            className={clsx(
              'max-w-[15rem] text-xs text-muted sm:max-w-none',
              effectiveView === '3d' && 'mt-2',
            )}
          >
            {status}
          </p>
        )}
      </div>

      <SceneMenu view={effectiveView} webglSupported={webglSupported} />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Overflow menu                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The two settings that do not earn permanent chrome: which view, and how
 * expensive it is allowed to be. Closes on outside click and on Escape, which
 * is bound only while it is open so the detail card keeps Escape otherwise.
 */
function SceneMenu({ view, webglSupported }: { view: FlowView; webglSupported: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const quality = useQuality();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  return (
    /* Above the detail card, which parks itself at z-30. */
    <div ref={rootRef} className="absolute right-4 bottom-4 z-40 sm:right-5">
      {open && (
        <div
          role="menu"
          aria-label="Scene settings"
          className={clsx(
            'absolute right-0 bottom-9 w-44 rounded-xl border border-white/10 p-1.5',
            'bg-[#0a0f1a]/90 shadow-2xl backdrop-blur-md',
          )}
        >
          <MenuRow
            label="View"
            options={FLOW_VIEWS}
            value={view}
            onPick={setFlowView}
            disabledOption={webglSupported ? undefined : '3d'}
            disabledTitle="WebGL is not available in this browser"
          />
          <MenuRow label="Quality" options={QUALITIES} value={quality} onPick={setQuality} />
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Scene settings"
        className={clsx(
          'flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/40',
          'text-muted backdrop-blur-sm transition-colors hover:text-ink',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forecast',
          open && 'text-ink',
        )}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function MenuRow<T extends string>({
  label,
  options,
  value,
  onPick,
  disabledOption,
  disabledTitle,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onPick: (next: T) => void;
  /** Rendered but unselectable, e.g. 3D with no WebGL context. */
  disabledOption?: T;
  disabledTitle?: string;
}) {
  return (
    <div className="px-1 py-1.5">
      <p className="mb-1.5 px-1 text-[10px] tracking-[0.08em] text-muted uppercase">{label}</p>
      <div
        role="group"
        aria-label={label}
        className="flex rounded-full border border-white/10 bg-white/5 p-0.5"
      >
        {options.map((option) => {
          const disabled = option === disabledOption;
          const selected = value === option;
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              title={disabled ? disabledTitle : undefined}
              onClick={() => onPick(option)}
              className={clsx(
                'flex-1 rounded-full px-2 py-1 text-[11px] font-medium tracking-wide uppercase',
                'transition-colors',
                selected ? 'bg-forecast/15 text-forecast' : 'text-muted hover:text-ink',
                disabled && 'cursor-not-allowed opacity-40 hover:text-muted',
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default EnergyFlowPanel;
