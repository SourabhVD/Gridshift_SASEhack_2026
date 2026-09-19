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
import * as THREE from 'three';
import { formatHourIndex, formatKw } from '@/lib/format';
import type { EnergySceneProps } from './contracts';
import { TOOL_NODES, type SceneNode } from './layout';
import SceneEnvironment from './Environment';
import Stage from './Stage';
import Effects from './Effects';
import CameraRig from './CameraRig';
import SceneHud from './SceneHud';
/* --- swap these two for the real models when they land --- */
import { BuildingModel } from '@/components/scene/buildings';
import { Devices } from '@/components/scene/devices';
import { useWebGL } from './useWebGL';
import { QualityGovernor, useQuality } from './useQuality';

const NO_NODES: ReadonlySet<SceneNode> = new Set();

/** Same framing as the 2D diagram, so the two views swap without a reflow. */
const FRAME = 'relative aspect-[16/9] w-full overflow-hidden rounded-lg';

/**
 * The soft edge that dissolves the viewport into the card it sits in.
 *
 * The Canvas clears to transparent and the scene has no background, so what
 * you see behind the models is `bg-base`. This gradient walks that back to
 * `--color-surface` -- the card's own colour -- over the outer ~12 % of the
 * frame, which removes the hard rectangle and makes the scene read as part of
 * the panel rather than as a picture hung inside it.
 */
const EDGE_BLEND =
  'radial-gradient(118% 118% at 50% 46%, transparent 58%, var(--color-surface) 100%)';

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
  const quality = useQuality();

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
        /* The two quality levels need different `gl` flags -- in 'high' the
           composer's SMAA does the antialiasing, so the context's own MSAA is
           dead weight. Keying on quality re-creates the context on a switch,
           which is the only honest way to change a WebGL context attribute. */
        key={quality}
        /* three 0.186 removed PCFSoftShadowMap, so r3f's "soft" now falls back
           to PCF with a console warning. Asking for PCF outright is the same
           map without the warning -- and PCF is the one that honours the
           sun's `shadow.radius`, which is where the soft edge comes from. */
        shadows="percentage"
        dpr={[1, 1.5]}
        performance={{ min: 0.6 }}
        gl={{
          antialias: quality === 'low',
          /* Transparent clear: the dashboard is the background. */
          alpha: true,
          powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping,
          /* The single source of exposure for both quality levels: the
             ToneMapping effect reads gl.toneMappingExposure too. */
          toneMappingExposure: 1.05,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
        frameloop="always"
      >
        <Suspense
          fallback={
            <Html center>
              <span className="text-[11px] tracking-wide text-muted">loading scene…</span>
            </Html>
          }
        >
          <SceneEnvironment hour={hour} type={building.type} />
          <Stage hour={hour} type={building.type} />
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

          {quality === 'high' ? <Effects /> : null}
        </Suspense>

        <QualityGovernor />
      </Canvas>

      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: EDGE_BLEND }} />

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
