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

import { Suspense, useMemo, useRef } from 'react';
import clsx from 'clsx';
import { Canvas } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { formatHourIndex, formatKw } from '@/lib/format';
import type { Building, EnergyFlows } from '@/types/api';
import type { EnergySceneProps } from './contracts';
import { TOOL_NODES, type SceneNode } from './layout';
import { InteractionLayer } from './interaction/InteractionLayer';
import { SelectionProvider, useSelectionStore } from './interaction/selection';
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
 * The card-free panel takes its size from its grid cell, not from an aspect
 * ratio, and it has no corners to round: there must be no rectangle anywhere.
 */
const FILL_FRAME = 'relative h-full min-h-[520px] w-full overflow-hidden';

function frameOf(fill: boolean | undefined): string {
  return fill ? FILL_FRAME : FRAME;
}

/**
 * The soft edge that dissolves the viewport into whatever it sits on.
 *
 * The Canvas clears to transparent and the scene has no background, so what
 * you see behind the models is the page. This gradient walks that back to the
 * surrounding colour over the outer ~12 % of the frame, on all four sides,
 * which removes the hard rectangle and makes the scene read as part of the page
 * rather than as a picture hung inside it. Two of them, because the card's
 * colour and the page's are not the same black: blending a card-free panel to
 * `--color-surface` would draw exactly the box this is here to remove.
 */
const EDGE_BLEND =
  'radial-gradient(118% 118% at 50% 46%, transparent 58%, var(--color-surface) 100%)';
const EDGE_BLEND_PAGE =
  'radial-gradient(118% 118% at 50% 46%, transparent 54%, var(--color-base) 100%)';

function Skeleton({
  className,
  label,
  fill,
}: {
  className?: string;
  label: string;
  fill?: boolean;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={clsx(frameOf(fill), 'animate-pulse', fill ? 'bg-base' : 'bg-surface-2', className)}
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
  fill,
}: EnergySceneProps) {
  const webgl = useWebGL();
  const quality = useQuality();

  const activeNodes = useMemo<ReadonlySet<SceneNode>>(() => {
    if (runStatus !== 'running' || !activeTool) return NO_NODES;
    const nodes = TOOL_NODES[activeTool];
    return nodes ? new Set(nodes) : NO_NODES;
  }, [activeTool, runStatus]);

  if (!building || !flows) {
    return <Skeleton className={className} fill={fill} label="Energy scene loading" />;
  }

  /* 'unknown' is the first paint, before the capability probe has run. */
  if (webgl === 'unknown') {
    return <Skeleton className={className} fill={fill} label="Energy scene starting" />;
  }

  if (webgl === 'unsupported') {
    return (
      <div
        className={clsx(
          frameOf(fill),
          'flex items-center justify-center px-6 text-center',
          fill ? 'bg-base' : 'border border-line bg-surface-2',
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

  /* Keyed on the building: a new site is a new set of props, so the store --
     and with it any selection -- is rebuilt rather than migrated. */
  return (
    <SelectionProvider key={building.id}>
      <SceneBody
        building={building}
        flows={flows}
        hour={hour}
        mode={mode}
        overThreshold={overThreshold}
        activeNodes={activeNodes}
        runStatus={runStatus}
        quality={quality}
        className={className}
        fill={fill}
      />
    </SelectionProvider>
  );
}

/**
 * The scene itself, inside the selection provider.
 *
 * Split out so that nothing which subscribes to the selection can force a
 * re-render of this tree: `useSelectionStore()` returns the same object for the
 * life of the site, and the components that actually watch the selection (the
 * camera rig, the pickables, the HUD hint) are leaves. The readout that used to
 * float over the canvas is now the open chapter in the tour beside it.
 */
interface SceneBodyProps {
  building: Building;
  flows: EnergyFlows;
  hour: number;
  mode: EnergySceneProps['mode'];
  overThreshold: boolean;
  activeNodes: ReadonlySet<SceneNode>;
  runStatus: EnergySceneProps['runStatus'];
  quality: 'high' | 'low';
  className?: string;
  fill?: boolean;
}

function SceneBody({
  building,
  flows,
  hour,
  mode,
  overThreshold,
  activeNodes,
  runStatus,
  quality,
  className,
  fill,
}: SceneBodyProps) {
  const store = useSelectionStore();
  const containerRef = useRef<HTMLDivElement>(null);

  const loadRatio =
    building.peak_threshold_kw > 0 ? flows.grid_kw / building.peak_threshold_kw : 0;

  const summary =
    `3D energy scene for ${building.name} at ${formatHourIndex(hour)}, ${mode} plan. ` +
    `Grid ${formatKw(flows.grid_kw)}${overThreshold ? ' (over peak threshold)' : ''}, ` +
    `solar ${formatKw(flows.solar_kw)}, battery ${formatKw(flows.battery_kw)}, ` +
    `EV ${formatKw(flows.ev_kw)}, HVAC ${formatKw(flows.hvac_kw)}.`;

  return (
    <div
      ref={containerRef}
      className={clsx(frameOf(fill), 'bg-base', className)}
      role="img"
      aria-label={summary}
    >
      <Canvas
        /* Clicking past every prop is how you get out: same as Escape, same as
           the card's Back button. A drag that merely ended on nothing is not a
           click, which is what the gesture flag is for. */
        onPointerMissed={() => {
          if (store.hasMoved()) return;
          store.select(null);
        }}
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
          <CameraRig
            type={building.type}
            activeNodes={activeNodes}
            evBays={building.ev_bays}
            hvacZones={building.hvac_zones}
          />

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

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: fill ? EDGE_BLEND_PAGE : EDGE_BLEND }}
      />

      <SceneHud
        gridKw={flows.grid_kw}
        overThreshold={overThreshold}
        containerRef={containerRef}
        fill={fill}
      />

      <InteractionLayer containerRef={containerRef} type={building.type} />
    </div>
  );
}

export default EnergyScene;
