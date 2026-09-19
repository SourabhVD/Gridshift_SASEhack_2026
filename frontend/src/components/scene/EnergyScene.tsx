'use client';

/**
 * The 3D sibling of EnergyFlowDiagram: the same props, the same hour, the same
 * story — told as a little site rather than a single-line diagram.
 *
 * This file owns only composition. The building shell, the device props and the
 * conduits each live in their own module behind the contracts in ./contracts,
 * which is why the two imports below are the only thing that changes when the
 * real models land.
 *
 * Load it through next/dynamic with `ssr: false`. Nothing here reads `window`
 * at module scope, but there is no point shipping a WebGL tree to the server.
 */

import { Suspense, useMemo } from 'react';
import clsx from 'clsx';
import { Canvas } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { formatHourIndex, formatKw } from '@/lib/format';
import type { EnergySceneProps } from './contracts';
import { TOOL_NODES, type SceneNode } from './layout';
import SceneEnvironment from './Environment';
import CameraRig from './CameraRig';
import SceneHud from './SceneHud';
/* --- swap these two for the real models when they land --- */
import { BuildingModel } from '@/components/scene/buildings';
import { Devices } from '@/components/scene/devices';
import { useWebGL } from './useWebGL';

const NO_NODES: ReadonlySet<SceneNode> = new Set();

/** Same framing as the 2D diagram, so the two views swap without a reflow. */
const FRAME = 'relative aspect-[16/9] w-full overflow-hidden rounded-lg';

function Skeleton({ className, label }: { className?: string; label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className={clsx(FRAME, 'animate-pulse bg-surface-2', className)}
    />
  );
}

export function EnergyScene({
  building,
  flows,
  hour,
  mode,
  overThreshold,
  activeTool,
  runStatus,
  className,
}: EnergySceneProps) {
  const webgl = useWebGL();

  const activeNodes = useMemo<ReadonlySet<SceneNode>>(() => {
    if (runStatus !== 'running' || !activeTool) return NO_NODES;
    const nodes = TOOL_NODES[activeTool];
    return nodes ? new Set(nodes) : NO_NODES;
  }, [activeTool, runStatus]);

  if (!building || !flows) {
    return <Skeleton className={className} label="Energy scene loading" />;
  }

  /* 'unknown' is the first paint, before the capability probe has run. */
  if (webgl === 'unknown') {
    return <Skeleton className={className} label="Energy scene starting" />;
  }

  if (webgl === 'unsupported') {
    return (
      <div
        className={clsx(
          FRAME,
          'flex items-center justify-center border border-line bg-surface-2 px-6 text-center',
          className,
        )}
      >
        <p className="text-xs text-muted">
          This browser has no WebGL context, so the 3D view is unavailable. Switch to the 2D
          diagram.
        </p>
      </div>
    );
  }

  const loadRatio =
    building.peak_threshold_kw > 0 ? flows.grid_kw / building.peak_threshold_kw : 0;

  const summary =
    `3D energy scene for ${building.name} at ${formatHourIndex(hour)}, ${mode} plan. ` +
    `Grid ${formatKw(flows.grid_kw)}${overThreshold ? ' (over peak threshold)' : ''}, ` +
    `solar ${formatKw(flows.solar_kw)}, battery ${formatKw(flows.battery_kw)}, ` +
    `EV ${formatKw(flows.ev_kw)}, HVAC ${formatKw(flows.hvac_kw)}.`;

  return (
    <div className={clsx(FRAME, 'bg-base', className)} role="img" aria-label={summary}>
      <Canvas
        shadows="soft"
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        frameloop="always"
      >
        <Suspense
          fallback={
            <Html center>
              <span className="text-[11px] tracking-wide text-muted">loading scene…</span>
            </Html>
          }
        >
          <SceneEnvironment hour={hour} />
          <CameraRig type={building.type} activeNodes={activeNodes} />

          <BuildingModel
            building={building}
            loadRatio={loadRatio}
            hour={hour}
            highlighted={activeNodes.has('building')}
          />
          <Devices
            building={building}
            flows={flows}
            mode={mode}
            overThreshold={overThreshold}
            activeNodes={activeNodes}
            running={runStatus === 'running'}
          />
        </Suspense>
      </Canvas>

      <SceneHud
        hour={hour}
        mode={mode}
        gridKw={flows.grid_kw}
        overThreshold={overThreshold}
        label={building.name}
      />
    </div>
  );
}

export default EnergyScene;
