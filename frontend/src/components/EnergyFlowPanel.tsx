'use client';

/**
 * EnergyFlowPanel -- the animated device-flow diagram for the hour being viewed.
 *
 * Reads everything from the shared store and hands it to the presentational
 * EnergyFlowDiagram. Follows the time scrubber (viewHour), the baseline /
 * optimized switch (viewMode) and the agent's current tool call (activeTool).
 */

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import EnergyFlowDiagram from '@/components/flow/EnergyFlowDiagram';
import { formatHourIndex, formatKw } from '@/lib/format';
import { useGridShift } from '@/lib/store';

export function EnergyFlowPanel() {
  const { building, currentFlows, viewHour, viewMode, activeTool, runStatus } =
    useGridShift();

  const threshold = building?.peak_threshold_kw ?? Infinity;
  const overThreshold = currentFlows != null && currentFlows.grid_kw > threshold;

  const right =
    currentFlows == null ? null : overThreshold ? (
      <Badge tone="alert">{formatKw(currentFlows.grid_kw)} · over threshold</Badge>
    ) : (
      <Badge tone={viewMode === 'optimized' ? 'good' : 'neutral'}>
        {formatKw(currentFlows.grid_kw)} from grid
      </Badge>
    );

  return (
    <Card
      title="Energy flow"
      subtitle={`${viewMode === 'optimized' ? 'Optimized schedule' : 'Baseline forecast'} · ${formatHourIndex(viewHour)}`}
      right={right}
      className="h-full"
      bodyClassName="flex flex-col justify-center"
    >
      <EnergyFlowDiagram
        building={building}
        flows={currentFlows}
        hour={viewHour}
        mode={viewMode}
        overThreshold={overThreshold}
        activeTool={activeTool}
        runStatus={runStatus}
      />
    </Card>
  );
}

export default EnergyFlowPanel;
