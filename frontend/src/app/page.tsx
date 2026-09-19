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
 */

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
import { useGridShift } from '@/lib/store';

export default function Page() {
  const { forecast, buildingId, isMock, isLoading, reset } = useGridShift();
  const hasPeak = forecast?.points.some((pt) => pt.is_peak) ?? false;

  return (
    <div className="min-h-screen bg-base">
      <header className="sticky top-0 z-10 border-b border-line bg-base/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tracking-tight text-ink">
              Grid<span className="text-forecast">Shift</span>
            </span>
            <span className="hidden text-xs text-muted sm:inline">
              Energy Command Center
            </span>
          </div>

          <span className="hidden h-5 w-px bg-line sm:block" />

          <BuildingSelector />

          <div className="ml-auto flex items-center gap-3">
            {isMock && <Badge tone="warn">Mock data</Badge>}
            <button
              type="button"
              onClick={() => void reset()}
              disabled={isLoading}
              className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-forecast/40 hover:text-ink disabled:opacity-50"
            >
              Reset demo
            </button>
          </div>
        </div>
      </header>

      <main key={buildingId} className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Row 1 -- full width */}
          <div className="grid min-w-0 grid-cols-1 lg:col-span-3">
            <KpiRow />
          </div>

          {/* Row 2 -- full width, only when the forecast crosses the threshold */}
          {hasPeak && (
            <div className="grid min-w-0 grid-cols-1 lg:col-span-3">
              <PeakAlert />
            </div>
          )}

          {/* Row 3 -- flow diagram 2/3 (hero), agent log 1/3 beside it so tool
              calls and node pulses read together */}
          <div className="grid min-w-0 grid-cols-1 lg:col-span-2">
            <EnergyFlowPanel />
          </div>
          <div className="grid min-w-0 grid-cols-1 lg:col-span-1">
            <AgentActivity />
          </div>

          {/* Row 4 -- time scrubber full width; drives the diagram above and
              the chart below */}
          <div className="grid min-w-0 grid-cols-1 lg:col-span-3">
            <TimelinePanel />
          </div>

          {/* Row 5 -- demand chart 2/3, impact 1/3 */}
          <div className="grid min-w-0 grid-cols-1 lg:col-span-2">
            <DemandChart />
          </div>
          <div className="grid min-w-0 grid-cols-1 lg:col-span-1">
            <ImpactChart />
          </div>

          {/* Row 6 -- full width */}
          <div className="grid min-w-0 grid-cols-1 lg:col-span-3">
            <ActionPlan />
          </div>
        </div>
      </main>
    </div>
  );
}
