'use client';

/**
 * One world. Four sites on one campus around one substation, and a camera that
 * either looks straight down at all of it or stands inside one lot.
 *
 * This file owns only composition. The building shells, the device props, the
 * substation and the feeders each live in their own module behind the contracts
 * in ./contracts and ./world, which is why the imports below are the only thing
 * that changes when a model is swapped.
 *
 * ## The two levels
 *
 * `level` comes from the store, not from props: it is a page-wide fact (the
 * breadcrumb, the chapter column and the KPI strip all read it), and threading
 * it through `EnergySceneProps` would have made the scene the odd one out.
 * r3f bridges React context across the Canvas, so everything inside reads the
 * same store the dashboard does -- the same reason `devices/index` reads
 * `runStatus` directly.
 *
 *   portfolio  every site is `lite` (see devices/lite.ts): static props, no
 *              particles, no pills, no pick targets. What IS live is the four
 *              feeders, the four name pills and each building's own windows,
 *              because those are the three things that carry the hour from
 *              400 metres up.
 *   site       the active lot is full-fat and behaves exactly as it did before
 *              the campus existed; the other three stay lite in the distance.
 *
 * ## Picking a site
 *
 * At portfolio level a lot is picked through an invisible proxy box that
 * encloses it. That is not a shortcut -- the building shell owns a `Pickable`
 * of its own (it selects the *building node* at site level) and would swallow
 * the click. The proxy is nearer to a top-down camera than anything inside it,
 * so it wins the raycast and stops propagation. It is `visible={false}`, which
 * three skips when rendering and does NOT skip when raycasting: zero draw
 * calls, one pick target per site.
 *
 * Load it through next/dynamic with `ssr: false`. Nothing here reads `window`
 * at module scope, but there is no point shipping a WebGL tree to the server.
 */

import { Suspense, useEffect, useMemo, useRef } from 'react';
import clsx from 'clsx';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { formatHourIndex, formatKw } from '@/lib/format';
import { useGridShift, type ViewLevel } from '@/lib/store';
import type { Building, EnergyFlows } from '@/types/api';
import type { EnergySceneProps } from './contracts';
import { TOOL_NODES, ridgeY, type SceneNode } from './layout';
import { SITE_OFFSETS, checkCampus, localLotBox } from './world';
import { InteractionLayer } from './interaction/InteractionLayer';
import {
  SelectionProvider,
  useHoveredSite,
  useSelectionStore,
} from './interaction/selection';
import SceneEnvironment from './Environment';
import Stage from './Stage';
import Effects from './Effects';
import CameraRig from './CameraRig';
import SceneHud from './SceneHud';
import Substation from './Substation';
import CampusGround from './CampusGround';
import FeedLines, { type FeedReading } from './FeedLines';
/* --- swap these two for the real models when they land --- */
import { BuildingModel } from '@/components/scene/buildings';
import { Devices } from '@/components/scene/devices';
import { C, glow } from './devices/common';
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

  /* NOT keyed on the building any more. The campus is one continuous world and
     the camera flies between its lots, so remounting the canvas on a site
     switch would cut the one move the whole layer exists to make. The
     selection is cleared by `SceneBody` instead. */
  return (
    <SelectionProvider>
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

/* -------------------------------------------------------------------------- */
/* One site                                                                    */
/* -------------------------------------------------------------------------- */

interface SiteProps {
  building: Building;
  flows: EnergyFlows;
  hour: number;
  mode: EnergySceneProps['mode'];
  /** True for the site the dashboard is about. */
  active: boolean;
  level: ViewLevel;
  activeNodes: ReadonlySet<SceneNode>;
  running: boolean;
  onEnter: (id: string) => void;
}

/** The hover ring under a lot, in the lot's own coordinates. */
function LotRing({ type, on }: { type: Building['type']; on: boolean }) {
  const ring = useMemo(() => {
    const box = localLotBox(type);
    return {
      x: (box.minX + box.maxX) / 2,
      z: (box.minZ + box.maxZ) / 2,
      r: Math.max(box.maxX - box.minX, box.maxZ - box.minZ) / 2,
    };
  }, [type]);

  if (!on) return null;
  return (
    <mesh
      position={[ring.x, 0.05, ring.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[ring.r, ring.r, 1]}
      raycast={() => null}
    >
      {/* Same hairline the device rings use, so hovering a lot and hovering a
          battery speak the same language at two scales. */}
      <ringGeometry args={[0.986, 1, 128]} />
      <meshBasicMaterial
        color={glow(C.grid, 1.5)}
        toneMapped={false}
        transparent
        opacity={0.3}
        depthWrite={false}
      />
    </mesh>
  );
}

function Site({
  building,
  flows,
  hour,
  mode,
  active,
  level,
  activeNodes,
  running,
  onEnter,
}: SiteProps) {
  const store = useSelectionStore();
  const hoveredSite = useHoveredSite();
  const portfolio = level === 'portfolio';
  const hovered = portfolio && hoveredSite === building.id;

  const offset = SITE_OFFSETS[building.type];
  const threshold = building.peak_threshold_kw;
  const over = threshold > 0 && flows.grid_kw > threshold;
  const loadRatio = threshold > 0 ? flows.grid_kw / threshold : 0;

  /* The pill's figure. A meter can run backwards -- an array beating its own
     house exports -- and "-3 kW" reads as an error, so the direction goes in a
     word rather than in a minus sign. A house runs on single digits and a
     warehouse on hundreds, so the decimal follows the magnitude. */
  const magnitude = Math.abs(flows.grid_kw);
  const gridLabel =
    formatKw(magnitude, magnitude < 20 ? 1 : 0) + (flows.grid_kw < 0 ? ' out' : '');

  /* The pick proxy: a box the size of the lot with head-room for the label.
     Only at portfolio, where a whole site is the thing you click. */
  const proxy = useMemo(() => {
    const box = localLotBox(building.type);
    const height = ridgeY(building.type) + 26;
    return {
      position: [
        (box.minX + box.maxX) / 2,
        height / 2,
        (box.minZ + box.maxZ) / 2,
      ] as [number, number, number],
      size: [box.maxX - box.minX, height, box.maxZ - box.minZ] as [number, number, number],
    };
  }, [building.type]);

  const handlers = useMemo(
    () => ({
      onClick: (event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        /* A drag that happens to end on a lot is a look-around, not a pick. */
        if (store.hasMoved()) return;
        onEnter(building.id);
      },
      onPointerOver: (event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        store.hoverSite(building.id);
      },
      onPointerOut: (event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        store.hoverSite(null);
      },
    }),
    [building.id, onEnter, store],
  );

  return (
    <group position={[offset[0], offset[1], offset[2]]}>
      {portfolio && (
        <mesh visible={false} position={proxy.position} {...handlers}>
          <boxGeometry args={proxy.size} />
        </mesh>
      )}

      <LotRing type={building.type} on={hovered} />

      <BuildingModel
        building={building}
        loadRatio={loadRatio}
        hour={hour}
        highlighted={active && activeNodes.has('building')}
      />
      <Devices
        building={building}
        flows={flows}
        mode={mode}
        overThreshold={over}
        activeNodes={active ? activeNodes : NO_NODES}
        running={active && running}
        lite={!active || portfolio}
      />

      {portfolio && (
        <Html
          position={[0, ridgeY(building.type) + 11, 0]}
          center
          occlude={false}
          zIndexRange={[24, 0]}
          wrapperClass="pointer-events-none"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          <div
            className={clsx(
              'pointer-events-none flex items-center gap-2 rounded-full border px-2.5 py-1',
              'text-[11px] font-medium whitespace-nowrap backdrop-blur-sm',
              'transition-colors duration-150',
              hovered
                ? 'border-white/35 bg-black/75 text-white'
                : 'border-white/10 bg-black/55 text-white/85',
            )}
          >
            <span>{building.name}</span>
            <span
              className="tabular-nums"
              style={{ color: over ? 'var(--color-alert)' : 'var(--color-ink-2)' }}
            >
              {gridLabel}
            </span>
          </div>
        </Html>
      )}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* The scene                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The scene itself, inside the selection provider.
 *
 * Split out so that nothing which subscribes to the selection can force a
 * re-render of this tree: `useSelectionStore()` returns the same object for the
 * life of the page, and the components that actually watch the selection (the
 * camera rig, the pickables, the HUD hint) are leaves.
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

let campusChecked = false;

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
  const { buildings, sites, level, enterSite, siteFlowsAt, portfolioAt } = useGridShift();
  const store = useSelectionStore();
  const containerRef = useRef<HTMLDivElement>(null);

  /* The campus is one continuous world, so the canvas is never remounted on a
     site switch -- which means the selection has to be released by hand. */
  useEffect(() => {
    store.select(null);
    store.hoverSite(null);
  }, [store, building.id, level]);

  useEffect(() => {
    if (campusChecked || process.env.NODE_ENV === 'production') return;
    campusChecked = true;
    const violations = checkCampus();
    if (violations.length > 0) {
      console.warn('[gridshift] campus clearance violations', violations);
    }
  }, []);

  /**
   * Every site on the campus, with its own flows for this hour. The ACTIVE
   * site takes the flows handed down as props rather than re-deriving them, so
   * the run, the approve moment and the baseline/optimized switch keep working
   * off exactly the numbers the rest of the page is showing.
   */
  const campus = useMemo(() => {
    const out: { building: Building; flows: EnergyFlows }[] = [];
    for (const b of buildings) {
      if (b.id === building.id) {
        out.push({ building, flows });
        continue;
      }
      const siteFlows = siteFlowsAt(b.id, hour);
      if (siteFlows && sites[b.id]) out.push({ building: b, flows: siteFlows });
    }
    if (out.length === 0) out.push({ building, flows });
    return out;
  }, [buildings, sites, building, flows, hour, siteFlowsAt]);

  const campusTypes = useMemo(() => campus.map((site) => site.building.type), [campus]);

  const feeds = useMemo<FeedReading[]>(
    () =>
      campus.map((site) => {
        const cap = site.building.peak_threshold_kw;
        const over = cap > 0 && site.flows.grid_kw > cap;
        /* `sites` is the single source of truth for who holds a plan -- the
           active site's copy is kept in step by the store, so the feeder does
           not need to know which lot the dashboard is about. */
        const hasPlan = sites[site.building.id]?.plan != null;
        return {
          id: site.building.id,
          building: site.building,
          gridKw: site.flows.grid_kw,
          over,
          good: !over && mode === 'optimized' && hasPlan,
        };
      }),
    [campus, mode, sites],
  );

  const portfolio = level === 'portfolio';
  const reading = useMemo(
    () => (portfolio ? portfolioAt(hour) : null),
    [portfolio, portfolioAt, hour],
  );

  const summary = portfolio
    ? `Top-down campus view at ${formatHourIndex(hour)}. ` +
      `${campus.length} sites drawing ${formatKw(reading?.total_grid_kw ?? 0)} in total, ` +
      `${reading?.sites_over_cap.length ?? 0} over their cap.`
    : `3D energy scene for ${building.name} at ${formatHourIndex(hour)}, ${mode} plan. ` +
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
        /* Clicking past every prop is how you get out of a close-up: same as
           Escape. On the campus there is nothing to get out of, so a click on
           empty ground does nothing at all. A drag that merely ended on
           nothing is not a click, which is what the gesture flag is for. */
        onPointerMissed={() => {
          if (level === 'portfolio') return;
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
          <SceneEnvironment
            hour={hour}
            type={building.type}
            level={level}
            campusTypes={campusTypes}
          />
          <Stage hour={hour} type={building.type} level={level} campusTypes={campusTypes} />
          <CameraRig
            type={building.type}
            activeNodes={activeNodes}
            evBays={building.ev_bays}
            hvacZones={building.hvac_zones}
            level={level}
            campusTypes={campusTypes}
          />

          <CampusGround types={campusTypes} />
          <Substation labelled={portfolio} />
          <FeedLines readings={feeds} />

          {campus.map((site) => (
            <Site
              key={site.building.id}
              building={site.building}
              flows={site.flows}
              hour={hour}
              mode={mode}
              active={site.building.id === building.id}
              level={level}
              activeNodes={activeNodes}
              running={runStatus === 'running'}
              onEnter={enterSite}
            />
          ))}

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
        level={level}
        portfolio={reading}
        siteCount={campus.length}
      />

      <InteractionLayer containerRef={containerRef} type={building.type} />
    </div>
  );
}

export default EnergyScene;
