'use client';

/**
 * The pulsing rings that mark whatever the agent is looking at right now --
 * the 3D counterpart of the 2D diagram's `gsflow-pulse` halo.
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
import { ANCHORS, BUILDING_SPECS, type SceneNode, roofY } from '../layout';
import { C, type EvPlan } from './common';
import { unitCount } from './RoofHvac';

const SCRATCH = new Object3D();
/** Lies the ring flat: ringGeometry is authored in the XY plane. */
const FLAT = -Math.PI / 2;
const GROUND_Y = 0.04;
const BAY_W = 2.6;

interface Ring {
  x: number;
  y: number;
  z: number;
  r: number;
}

function buildRings(
  building: Building,
  plan: EvPlan,
  active: ReadonlySet<SceneNode>,
): Ring[] {
  const [width, depth] = BUILDING_SPECS[building.type].footprint;
  const top = roofY(building.type);
  const rings: Ring[] = [];

  if (active.has('building')) {
    rings.push({ x: 0, y: GROUND_Y, z: 0, r: Math.max(width, depth) / 2 + 2.5 });
  }
  if (active.has('grid')) {
    rings.push({ x: ANCHORS.grid[0], y: GROUND_Y, z: ANCHORS.grid[2], r: 6.5 });
  }
  if (active.has('battery')) {
    rings.push({ x: ANCHORS.battery[0], y: GROUND_Y, z: ANCHORS.battery[2], r: 3.4 });
  }
  if (active.has('ev')) {
    const rowW = plan.rendered * BAY_W;
    rings.push({
      x: ANCHORS.ev[0] + rowW / 2,
      y: GROUND_Y,
      z: ANCHORS.ev[2],
      r: rowW / 2 + 1.8,
    });
  }
  if (active.has('solar')) {
    rings.push({ x: 0, y: top + 0.12, z: -depth * 0.05, r: Math.max(3, Math.min(width, depth) / 2 - 1) });
  }
  if (active.has('hvac')) {
    const spread = (unitCount(building) - 1) * 3.4;
    rings.push({ x: 0, y: top + 0.12, z: depth / 2 - 3.2, r: spread / 2 + 2.6 });
  }
  return rings;
}

function Rings({ rings }: { rings: Ring[] }) {
  const meshRef = useRef<InstancedMesh>(null);
  const matRef = useRef<MeshBasicMaterial>(null);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const pulse = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 2.4);
    const grow = 1 + 0.07 * pulse;
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
    if (matRef.current) matRef.current.opacity = 0.35 + 0.5 * pulse;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, Math.max(1, rings.length)]}
      frustumCulled={false}
    >
      <ringGeometry args={[0.955, 1, 64]} />
      <meshBasicMaterial
        ref={matRef}
        color={C.grid}
        toneMapped={false}
        transparent
        opacity={0.4}
        depthWrite={false}
      />
    </instancedMesh>
  );
}

export interface HighlightProps {
  building: Building;
  plan: EvPlan;
  activeNodes: ReadonlySet<SceneNode>;
  running: boolean;
}

export function Highlight({ building, plan, activeNodes, running }: HighlightProps) {
  const rings = useMemo(
    () => (running ? buildRings(building, plan, activeNodes) : []),
    [building, plan, activeNodes, running],
  );
  if (rings.length === 0) return null;
  return <Rings rings={rings} />;
}

export default Highlight;
