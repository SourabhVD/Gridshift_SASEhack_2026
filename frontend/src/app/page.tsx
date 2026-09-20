'use client';

/**
 * Energy Command Center -- the single page of the GridShift frontend.
 *
 * This file owns the header bar and the grid. Everything inside the grid is a
 * separate component in src/components/; each one reads its own slice of
 * useGridShift(). Keep the layout here and the rendering there.
 *
 * The grid is NOT keyed on the building. It used to be, so that switching sites
 * dropped every panel's local UI state; the campus took that away, because the
 * 3D world in row 3 is one continuous scene the camera flies through and a
 * remount would cut the flight. Panels that care clear their own state now.
 *
 * Layout is option C: the hero canvas sits on the page with no container, the
 * controls around it are hairline-separated rows, and only the two chart panels
 * keep a fill. Columns and spans are unchanged -- flattening removed the
 * borders that were competing with the rhythm, not the rhythm.
 *
 * Row 3 is the tour: a column of chapters on the left third and the world on
 * the right two thirds, sharing one selection store mounted here. Both halves
 * follow `level` -- four sites and a top-down campus at 'portfolio', one lot's
 * seven chapters at 'site'. The agent log moved down to sit beside the action
 * plan, which is the list it produced.
 *
 * Load motion: five groups rise 10px over 330ms on a 60ms cascade, and only on
 * the first paint of the session. The module-level latch below is what keeps it
 * to once; replaying it would read as a bug.
 *
 * Two narrative beats are mounted here rather than inside a panel, because both
 * are about the page as a whole:
 *
 *   cold open   `useColdOpen()` walks the scrubber to the peak hour once per
 *               session, ~1s after the stagger settles.
 *   run moment  while the agent is working, `data-run="live"` on <main> dims
 *               the regions nobody should be reading yet. The rule lives in
 *               globals.css; the wrappers below carry `data-quiet`. The KPI
 *               strip is deliberately NOT one of them -- those five numbers are
 *               the only thing readable from the back of a room.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import clsx from 'clsx';

import { ActionPlan } from '@/components/ActionPlan';
import { AgentActivity } from '@/components/AgentActivity';
import { BuildingSelector } from '@/components/BuildingSelector';
import { DemandChart } from '@/components/DemandChart';
import { EnergyFlowPanel } from '@/components/EnergyFlowPanel';
import { ImpactChart } from '@/components/ImpactChart';
import { KpiRow } from '@/components/KpiRow';
import { PeakAlert } from '@/components/PeakAlert';
import { SelectionProvider } from '@/components/scene/interaction/selection';
import { TimelinePanel } from '@/components/TimelinePanel';
import { ChapterTour } from '@/components/tour/ChapterTour';
import { Button } from '@/components/ui/Button';
import { DataSourceBadge } from '@/components/ui/DataSourceBadge';
import { useGridShift } from '@/lib/store';
import { useColdOpen } from '@/lib/useColdOpen';

/** Module-level, so the entrance runs once per page load and never again. */
let hasPlayedEntrance = false;

/** Total stagger: 5 groups x 60ms + one 330ms animation, with headroom. */
const ENTRANCE_MS = 900;

export default function Page() {
  const { forecast, sites, level, isLoading, runStatus, reset } = useGridShift();

  /* At portfolio level the alert row is about the campus, so it appears if ANY
     site crosses its own cap -- not only the one the dashboards below are
     about. `PeakAlert` returns null on its own if none does. */
  const hasPeak =
    level === 'portfolio'
      ? Object.values(sites).some((site) => site.forecast?.points.some((pt) => pt.is_peak))
      : (forecast?.points.some((pt) => pt.is_peak) ?? false);

  useColdOpen();

  const [entrance, setEntrance] = useState(!hasPlayedEntrance);

  useEffect(() => {
    if (!entrance) return;
    hasPlayedEntrance = true;
    const timer = window.setTimeout(() => setEntrance(false), ENTRANCE_MS);
    return () => window.clearTimeout(timer);
  }, [entrance]);

  /** Places a block in the 60ms cascade. Five groups, hard cap. */
  const riseClass = entrance ? 'gs-rise' : undefined;
  const riseStyle = (group: 0 | 1 | 2 | 3 | 4): CSSProperties | undefined =>
    entrance ? ({ '--i': group } as CSSProperties) : undefined;

  return (
    <div className="min-h-screen bg-base">
      <header className="sticky top-0 z-10 border-b border-line-2 bg-base/90 backdrop-blur">
        <div
          className={clsx(
            'mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3.5',
            riseClass,
          )}
          style={riseStyle(0)}
        >
          <div className="flex items-baseline gap-2.5">
            <span className="text-lg font-semibold -tracking-[0.02em] text-ink">
              Grid<span className="text-accent">Shift</span>
            </span>
            <span className="hidden text-[11px] font-medium tracking-[0.09em] text-muted uppercase sm:inline">
              Energy Command Center
            </span>
          </div>

          <span className="hidden h-4 w-px bg-line-2 sm:block" />

          <BuildingSelector />

          <div className="ml-auto flex items-center gap-3">
            <DataSourceBadge />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void reset()}
              disabled={isLoading}
            >
              Reset demo
            </Button>
          </div>
        </div>
      </header>

      {/* Deliberately NOT keyed on the building any more.
          The campus is one continuous world and the camera flies between its
          lots, so remounting the grid on a site switch would tear down the
          WebGL context in the middle of the one move this layout is for. The
          local UI state that the key used to drop -- expanded rows, scrolled
          logs -- is cheap to keep and, on a portfolio, arguably wants keeping.
          The scene clears its own selection on a site change instead. */}
      <main
        data-run={runStatus === 'running' ? 'live' : undefined}
        className="mx-auto max-w-[1600px] px-6 pt-8 pb-16 sm:pt-10"
      >
        {/* 24px between the two halves of a row; 32px between sections on a
            phone and 48px on desktop, because space is the only separator
            left once the borders are gone. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-8 lg:grid-cols-3 lg:gap-y-12">
          {/* Row 1 -- full width */}
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-3', riseClass)}
              style={riseStyle(1)}>
            <KpiRow />
          </div>

          {/* Row 2 -- full width, only when the forecast crosses the threshold */}
          {hasPeak && (
            <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-3', riseClass)}
              style={riseStyle(2)}>
              <PeakAlert />
            </div>
          )}

          {/* Row 3 -- the tour. A column of chapter pills 1/3, the world 2/3.
              Both cells read and write ONE selection store, mounted here rather
              than inside the scene, which is what makes opening a chapter and
              clicking a device -- or a whole site -- the same event. It lives
              for the life of the page now, like the campus it describes. */}
          <SelectionProvider>
            <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-1', riseClass)}
                style={riseStyle(3)}>
              <ChapterTour />
            </div>
            <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-2', riseClass)}
                style={riseStyle(3)}>
              <EnergyFlowPanel />
            </div>
          </SelectionProvider>

          {/* Row 4 -- time scrubber full width; drives the diagram above and
              the chart below */}
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-3', riseClass)}
              style={riseStyle(4)}>
            <TimelinePanel />
          </div>

          {/* Row 5 -- demand chart 2/3, impact 1/3 */}
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-2', riseClass)}
              style={riseStyle(4)} data-quiet>
            <DemandChart />
          </div>
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-1', riseClass)}
              style={riseStyle(4)} data-quiet>
            <ImpactChart />
          </div>

          {/* Row 6 -- action plan 2/3, agent log 1/3 beside it: the log is the
              working that produced the list, so they belong on one row. The log
              is deliberately NOT [data-quiet] -- it is what the run is about. */}
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-2', riseClass)}
              style={riseStyle(4)} data-quiet>
            <ActionPlan />
          </div>
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-1', riseClass)}
              style={riseStyle(4)}>
            <AgentActivity />
          </div>
        </div>
      </main>
    </div>
  );
}
