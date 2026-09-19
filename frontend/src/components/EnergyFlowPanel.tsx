'use client';

/**
 * EnergyFlowPanel -- the animated device-flow diagram for the hour being viewed.
 *
 * Reads everything from the shared store and hands it to one of two
 * presentations of the same props: the 3D scene (default) or the 2D single-line
 * diagram. The choice is the viewer's and is remembered across reloads; a
 * browser with no WebGL context is pinned to 2D.
 *
 * Follows the time scrubber (viewHour), the baseline / optimized switch
 * (viewMode) and the agent's current tool call (activeTool).
 */

import { useSyncExternalStore } from 'react';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import EnergyFlowDiagram from '@/components/flow/EnergyFlowDiagram';
import { useWebGL } from '@/components/scene/useWebGL';
import { formatHourIndex, formatKw } from '@/lib/format';
import { useGridShift } from '@/lib/store';

/** The scene pulls in three.js; it must never run on the server. */
const EnergyScene = dynamic(() => import('@/components/scene/EnergyScene'), {
  ssr: false,
  loading: () => (
    <div
      role="status"
      aria-label="Energy scene loading"
      className="aspect-[16/9] w-full animate-pulse rounded-lg bg-surface-2"
    />
  ),
});

type FlowView = '3d' | '2d';

/** localStorage key holding the last view the user picked. */
const FLOW_VIEW_STORAGE_KEY = 'gridshift.flowView';

const VIEWS: readonly FlowView[] = ['3d', '2d'];

const DEFAULT_VIEW: FlowView = '3d';

/**
 * localStorage as a tiny external store, so the preference can be read during
 * render without a setState-in-effect round trip. The server snapshot is the
 * default view, which is what the first client paint renders too.
 */
let currentView: FlowView | null = null;
const viewListeners = new Set<() => void>();

function getView(): FlowView {
  if (currentView === null) {
    try {
      const stored = localStorage.getItem(FLOW_VIEW_STORAGE_KEY);
      currentView = stored === '3d' || stored === '2d' ? stored : DEFAULT_VIEW;
    } catch {
      currentView = DEFAULT_VIEW;
    }
  }
  return currentView;
}

function getServerView(): FlowView {
  return DEFAULT_VIEW;
}

function subscribeView(onChange: () => void): () => void {
  viewListeners.add(onChange);
  return () => viewListeners.delete(onChange);
}

function chooseView(next: FlowView): void {
  currentView = next;
  try {
    localStorage.setItem(FLOW_VIEW_STORAGE_KEY, next);
  } catch {
    /* private mode, quota, disabled storage -- the choice just will not stick */
  }
  for (const listener of viewListeners) listener();
}

export function EnergyFlowPanel() {
  const { building, currentFlows, viewHour, viewMode, activeTool, runStatus } =
    useGridShift();

  const view = useSyncExternalStore(subscribeView, getView, getServerView);
  const webgl = useWebGL();
  const webglSupported = webgl !== 'unsupported';

  const effectiveView: FlowView = webglSupported ? view : '2d';

  const threshold = building?.peak_threshold_kw ?? Infinity;
  const overThreshold = currentFlows != null && currentFlows.grid_kw > threshold;

  const badge =
    currentFlows == null ? null : overThreshold ? (
      <Badge tone="alert">{formatKw(currentFlows.grid_kw)} · over threshold</Badge>
    ) : (
      <Badge tone={viewMode === 'optimized' ? 'good' : 'neutral'}>
        {formatKw(currentFlows.grid_kw)} from grid
      </Badge>
    );

  const right = (
    <div className="flex items-center gap-2">
      {badge}
      <div
        role="group"
        aria-label="Flow view"
        className="inline-flex rounded-full border border-line bg-surface-2 p-0.5"
      >
        {VIEWS.map((option) => {
          const disabled = option === '3d' && !webglSupported;
          const selected = effectiveView === option;
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              title={disabled ? 'WebGL is not available in this browser' : undefined}
              onClick={() => chooseView(option)}
              className={clsx(
                'rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide uppercase',
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

  const viewProps = {
    building,
    flows: currentFlows,
    hour: viewHour,
    mode: viewMode,
    overThreshold,
    activeTool,
    runStatus,
  };

  return (
    <Card
      title="Energy flow"
      subtitle={`${viewMode === 'optimized' ? 'Optimized schedule' : 'Baseline forecast'} · ${formatHourIndex(viewHour)}`}
      right={right}
      className="h-full"
      bodyClassName="flex flex-col justify-center"
    >
      {effectiveView === '3d' ? (
        <EnergyScene {...viewProps} />
      ) : (
        <EnergyFlowDiagram {...viewProps} />
      )}
    </Card>
  );
}

export default EnergyFlowPanel;
