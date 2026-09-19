'use client';

/**
 * Energy Command Center -- the single page of the GridShift frontend.
 *
 * This file owns the header bar and the grid. Everything inside the grid is a
 * separate component in src/components/; each one reads its own slice of
 * useGridShift(). Keep the layout here and the rendering there.
 *
 * The grid is keyed on the building, so switching sites remounts every panel
 * and drops local UI state (expanded action rows, scrolled logs) with it.
 *
 * Layout is option C: the hero canvas sits on the page with no container, the
 * controls around it are hairline-separated rows, and only the two chart panels
 * keep a fill. Columns and spans are unchanged -- flattening removed the
 * borders that were competing with the rhythm, not the rhythm.
 *
 * Load motion: five groups rise 10px over 330ms on a 60ms cascade, and only on
 * the first paint of the session. `main` is keyed on the building, so without
 * the latch below every site switch would replay the entrance -- which the
 * motion study calls out as reading like a bug.
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
import { TimelinePanel } from '@/components/TimelinePanel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useGridShift } from '@/lib/store';

/** Module-level, so the entrance runs once per page load and never again. */
let hasPlayedEntrance = false;

/** Total stagger: 5 groups x 60ms + one 330ms animation, with headroom. */
const ENTRANCE_MS = 900;

export default function Page() {
  const { forecast, buildingId, isMock, isLoading, reset } = useGridShift();
  const hasPeak = forecast?.points.some((pt) => pt.is_peak) ?? false;

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
            {isMock && <Badge tone="warn">Mock data</Badge>}
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

      <main
        key={buildingId}
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

          {/* Row 3 -- flow diagram 2/3 (hero), agent log 1/3 beside it so tool
              calls and node pulses read together */}
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-2', riseClass)}
              style={riseStyle(3)}>
            <EnergyFlowPanel />
          </div>
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-1', riseClass)}
              style={riseStyle(3)}>
            <AgentActivity />
          </div>

          {/* Row 4 -- time scrubber full width; drives the diagram above and
              the chart below */}
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-3', riseClass)}
              style={riseStyle(4)}>
            <TimelinePanel />
          </div>

          {/* Row 5 -- demand chart 2/3, impact 1/3 */}
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-2', riseClass)}
              style={riseStyle(4)}>
            <DemandChart />
          </div>
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-1', riseClass)}
              style={riseStyle(4)}>
            <ImpactChart />
          </div>

          {/* Row 6 -- full width */}
          <div className={clsx('grid min-w-0 grid-cols-1 lg:col-span-3', riseClass)}
              style={riseStyle(4)}>
            <ActionPlan />
          </div>
        </div>
      </main>
    </div>
  );
}
