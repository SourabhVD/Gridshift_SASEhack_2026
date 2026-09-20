'use client';

/**
 * Makes one device -- or the building -- answer the pointer.
 *
 * A `<Pickable>` is a plain `<group>` with three handlers on it. r3f raycasts
 * only objects that carry handlers (recursively), so wrapping a prop here is
 * also what *excludes* everything else: conduits, flow particles and the
 * shadow catcher are never tested, and a hover costs one ray against six
 * groups rather than against the whole scene graph.
 *
 * Feedback is two things and no more:
 *
 *   ring    a hairline circle on the ground (or on the roof plane) under the
 *           prop, the same drawn-light ring `devices/Highlight` uses for the
 *           agent -- but static, and quieter: 0.18 hovered, 0.35 selected
 *   label   the prop's own kW pill brightens, via the emphasis context below
 *
 * Nothing about hover touches the scene tree: `Pickable` re-renders, its
 * `children` element is unchanged so React bails out of the subtree, and only
 * the `NodeLabel` inside it re-renders because it reads the context.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { Building } from '@/types/api';
import { ANCHORS, BUILDING_SPECS, type SceneNode, roofY } from '../layout';
import { C, glow, isResidence } from '../devices/common';
import { RESIDENCE, residenceSolarOrigin } from '../devices/paths';
import { unitCount } from '../devices/RoofHvac';
import { useHovered, useSelected, useSelectionStore } from './selection';

/* -------------------------------------------------------------------------- */
/* Emphasis                                                                    */
/* -------------------------------------------------------------------------- */

export type Emphasis = 'none' | 'hover' | 'selected';

const EmphasisContext = createContext<Emphasis>('none');

/** Read by `devices/NodeLabel` so a pill lifts with the prop it belongs to. */
export function usePickEmphasis(): Emphasis {
  return useContext(EmphasisContext);
}

/* -------------------------------------------------------------------------- */
/* Rings                                                                       */
/* -------------------------------------------------------------------------- */

export interface Ring {
  x: number;
  y: number;
  z: number;
  r: number;
}

const GROUND_Y = 0.04;
const BAY_W = 2.6;
const MAX_RENDERED_BAYS = 12;
/** ringGeometry is authored in the XY plane; this lies it flat. */
const FLAT = -Math.PI / 2;

/**
 * Where each node's ring sits. Deliberately the same geometry the agent's
 * pulsing highlight uses, so hovering a prop and the agent querying it point at
 * exactly the same footprint.
 */
export function ringsFor(building: Building): Record<SceneNode, Ring | null> {
  const type = building.type;
  const residence = isResidence(type);
  const [width, depth] = BUILDING_SPECS[type].footprint;
  const top = roofY(type);

  if (residence) {
    const solar = residenceSolarOrigin();
    return {
      building: { x: 0, y: GROUND_Y, z: 0, r: Math.max(width, depth) / 2 + 1.6 },
      grid: { x: RESIDENCE.pole[0], y: GROUND_Y, z: RESIDENCE.pole[2], r: 1.8 },
      battery: { x: -7.2, y: GROUND_Y, z: 1.5, r: 1.7 },
      ev: { x: RESIDENCE.bay[0], y: GROUND_Y, z: RESIDENCE.bay[2], r: 3.2 },
      solar: { x: 0, y: solar[1] + 0.3, z: 0, r: 4.5 },
      hvac: { x: RESIDENCE.heatPump[0], y: GROUND_Y, z: RESIDENCE.heatPump[2], r: 1.1 },
    };
  }

  const rowW = Math.max(1, Math.min(building.ev_bays, MAX_RENDERED_BAYS)) * BAY_W;
  const spread = (unitCount(building) - 1) * 3.4;
  return {
    building: { x: 0, y: GROUND_Y, z: 0, r: Math.max(width, depth) / 2 + 2.5 },
    grid: { x: ANCHORS.grid[0], y: GROUND_Y, z: ANCHORS.grid[2], r: 6.5 },
    battery: { x: ANCHORS.battery[0], y: GROUND_Y, z: ANCHORS.battery[2], r: 3.4 },
    ev: { x: ANCHORS.ev[0] + rowW / 2, y: GROUND_Y, z: ANCHORS.ev[2], r: rowW / 2 + 1.8 },
    solar: {
      x: 0,
      y: top + 0.12,
      z: -depth * 0.05,
      r: Math.max(3, Math.min(width, depth) / 2 - 1),
    },
    hvac: { x: 0, y: top + 0.12, z: depth / 2 - 3.2, r: spread / 2 + 2.6 },
  };
}

function PickRing({ ring, opacity }: { ring: Ring; opacity: number }) {
  return (
    <mesh
      position={[ring.x, ring.y, ring.z]}
      rotation={[FLAT, 0, 0]}
      scale={[ring.r, ring.r, 1]}
      raycast={() => null}
    >
      {/* Hairline, as a share of the radius: a pixel or two at every framing. */}
      <ringGeometry args={[0.972, 1, 96]} />
      <meshBasicMaterial
        color={glow(C.grid, 1.5)}
        toneMapped={false}
        transparent
        opacity={opacity}
        depthWrite={false}
      />
    </mesh>
  );
}

/* -------------------------------------------------------------------------- */

const HOVER_OPACITY = 0.18;
const SELECTED_OPACITY = 0.35;

export interface PickableProps {
  node: SceneNode;
  /** Ground/roof ring for the feedback. Omit for a prop that should not show one. */
  ring?: Ring | null;
  children: ReactNode;
}

export function Pickable({ node, ring, children }: PickableProps) {
  const store = useSelectionStore();
  const selected = useSelected();
  const hovered = useHovered();

  const isSelected = selected === node;
  const isHovered = hovered === node;
  const emphasis: Emphasis = isSelected ? 'selected' : isHovered ? 'hover' : 'none';

  const handlers = useMemo(
    () => ({
      onClick: (event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        /* A drag that happens to end on a prop is a look-around, not a pick. */
        if (store.hasMoved()) return;
        store.select(node);
      },
      onPointerOver: (event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        store.hover(node);
      },
      onPointerOut: (event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        store.hover(null);
      },
    }),
    [node, store],
  );

  return (
    <group {...handlers}>
      <EmphasisContext.Provider value={emphasis}>{children}</EmphasisContext.Provider>
      {ring && (isSelected || isHovered) ? (
        <PickRing ring={ring} opacity={isSelected ? SELECTED_OPACITY : HOVER_OPACITY} />
      ) : null}
    </group>
  );
}

export default Pickable;
