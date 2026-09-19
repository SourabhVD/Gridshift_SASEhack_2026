'use client';

/**
 * The rings that mark whatever the agent is looking at right now -- the 3D
 * counterpart of the 2D diagram's `gsflow-pulse` halo.
 *
 * Restrained on purpose: a hairline ring, sky blue, pushed just past the bloom
 * threshold so it reads as drawn light rather than painted paint, held at low
 * opacity and breathing once every 1.4 s. It is a pointer, not a spotlight.
 *
 * One ring per active node, all of them in a single InstancedMesh with a single
 * shared material, so a run costs exactly one extra draw call no matter how
 * many nodes light up. Ground devices get a ring on the pad, rooftop devices
 * get one on the roof plane, and `building` gets one sized to the footprint.
 *
 * Nothing renders when the agent is not running.
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { type InstancedMesh, type MeshBasicMaterial, Object3D } from 'three';
import type { Building } from '@/types/api';
import { BUILDING_SPECS, type SceneNode, roofY } from '../layout';
import { C, type EvPlan, glow, isResidence } from './common';
import { RESIDENCE, residenceSolarOrigin } from './paths';
import { unitCount } from './RoofHvac';

const SCRATCH = new Object3D();
/** Lies the ring flat: ringGeometry is authored in the XY plane. */
const FLAT = -Math.PI / 2;
const GROUND_Y = 0.04;
const BAY_W = 2.6;
/** 1.4 s, as radians per second. */
const PULSE = (Math.PI * 2) / 1.4;

interface Ring {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** Ground anchors, already resolved by `Devices` (the residence battery is a wall mount). */
export interface HighlightAnchors {
  grid: readonly [number, number, number];
  battery: readonly [number, number, number];
  ev: readonly [number, number, number];
}

function buildRings(
  building: Building,
  anchors: HighlightAnchors,
  plan: EvPlan,
  active: ReadonlySet<SceneNode>,
): Ring[] {
  const residence = isResidence(building.type);
  const [width, depth] = BUILDING_SPECS[building.type].footprint;
  const top = roofY(building.type);
  const rings: Ring[] = [];

  if (active.has('building')) {
    rings.push({ x: 0, y: GROUND_Y, z: 0, r: Math.max(width, depth) / 2 + (residence ? 1.6 : 2.5) });
  }
  if (active.has('grid')) {
    rings.push({ x: anchors.grid[0], y: GROUND_Y, z: anchors.grid[2], r: residence ? 1.8 : 6.5 });
  }
  if (active.has('battery')) {
    // On the residence the pack is on a wall, so the ring lands on the ground
    // directly below it rather than around it.
    rings.push({
      x: anchors.battery[0],
      y: GROUND_Y,
      z: anchors.battery[2],
      r: residence ? 1.7 : 3.4,
    });
  }
  if (active.has('ev')) {
    const rowW = residence ? 0 : plan.rendered * BAY_W;
    rings.push({
      x: anchors.ev[0] + rowW / 2,
      y: GROUND_Y,
      z: anchors.ev[2],
      r: residence ? 3.2 : rowW / 2 + 1.8,
    });
  }
  if (active.has('solar')) {
    if (residence) {
      const from = residenceSolarOrigin();
      rings.push({ x: 0, y: from[1] + 0.3, z: 0, r: 4.5 });
    } else {
      rings.push({
        x: 0,
        y: top + 0.12,
        z: -depth * 0.05,
        r: Math.max(3, Math.min(width, depth) / 2 - 1),
      });
    }
  }
  if (active.has('hvac')) {
    if (residence) {
      rings.push({ x: RESIDENCE.heatPump[0], y: GROUND_Y, z: RESIDENCE.heatPump[2], r: 1.1 });
    } else {
      const spread = (unitCount(building) - 1) * 3.4;
      rings.push({ x: 0, y: top + 0.12, z: depth / 2 - 3.2, r: spread / 2 + 2.6 });
    }
  }
  return rings;
}

function Rings({ rings }: { rings: Ring[] }) {
  const meshRef = useRef<InstancedMesh>(null);
  const matRef = useRef<MeshBasicMaterial>(null);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const pulse = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * PULSE);
    const grow = 1 + 0.035 * pulse;
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      SCRATCH.position.set(ring.x, ring.y, ring.z);
      SCRATCH.rotation.set(FLAT, 0, 0);
      SCRATCH.scale.set(ring.r * grow, ring.r * grow, 1);
      SCRATCH.updateMatrix();
      mesh.setMatrixAt(i, SCRATCH.matrix);
    }
    mesh.count = rings.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (matRef.current) matRef.current.opacity = 0.2 + 0.22 * pulse;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, Math.max(1, rings.length)]}
      frustumCulled={false}
    >
      {/* Hairline: 2.8% of the radius, which is a pixel or two at every framing
          the camera rig uses. */}
      <ringGeometry args={[0.972, 1, 96]} />
      <meshBasicMaterial
        ref={matRef}
        color={glow(C.grid, 1.5)}
        toneMapped={false}
        transparent
        opacity={0.3}
        depthWrite={false}
      />
    </instancedMesh>
  );
}

export interface HighlightProps {
  building: Building;
  anchors: HighlightAnchors;
  plan: EvPlan;
  activeNodes: ReadonlySet<SceneNode>;
  running: boolean;
}

export function Highlight({ building, anchors, plan, activeNodes, running }: HighlightProps) {
  const rings = useMemo(
    () => (running ? buildRings(building, anchors, plan, activeNodes) : []),
    [building, anchors, plan, activeNodes, running],
  );
  if (rings.length === 0) return null;
  return <Rings rings={rings} />;
}

export default Highlight;
