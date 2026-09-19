'use client';

/**
 * Packaged rooftop units at the front-centre of the roof, one per three HVAC
 * zones up to four. The fans turn at a rate proportional to `hvac_kw` and stop
 * dead below the 0.5 kW dormant threshold -- the same cut-off that fades the
 * HVAC conduit, so a still fan never sits on a live wire.
 *
 * 3 draw calls: cabinets, fan housings, blades.
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { type InstancedMesh, Object3D } from 'three';
import type { Building } from '@/types/api';
import { formatKw } from '@/lib/format';
import { BUILDING_SPECS, roofY } from '../layout';
import { C, DORMANT_KW, clamp } from './common';
import { Boxes, Cylinders, type Piece } from './Instanced';
import { NodeLabel } from './NodeLabel';

const MAX_UNITS = 4;
const SPACING = 3.4;
/** Distance from the roof front edge to the unit centreline. */
const SETBACK = 3.2;
const BLADES_PER_UNIT = 3;
const BLADE_R = 0.4;

const SCRATCH = new Object3D();

export function unitCount(building: Building): number {
  return Math.max(1, Math.min(MAX_UNITS, Math.round(building.hvac_zones / 3)));
}

function unitX(index: number, count: number): number {
  return (index - (count - 1) / 2) * SPACING;
}

interface FanBladesProps {
  count: number;
  z: number;
  y: number;
  /** Radians per second; 0 parks the fans. */
  speed: number;
}

/** Every blade of every unit in one InstancedMesh, driven by one useFrame. */
function FanBlades({ count, z, y, speed }: FanBladesProps) {
  const ref = useRef<InstancedMesh>(null);
  const spin = useRef(0);

  useFrame((_, delta) => {
    const mesh = ref.current;
    if (!mesh) return;
    spin.current += delta * speed;
    const total = count * BLADES_PER_UNIT;
    for (let i = 0; i < total; i++) {
      const unit = Math.floor(i / BLADES_PER_UNIT);
      const angle = spin.current + (i % BLADES_PER_UNIT) * ((Math.PI * 2) / BLADES_PER_UNIT);
      SCRATCH.position.set(
        unitX(unit, count) + Math.cos(angle) * BLADE_R,
        y,
        z + Math.sin(angle) * BLADE_R,
      );
      // A box long axis is +x; rotating by -angle about y aims it radially.
      SCRATCH.rotation.set(0, -angle, 0);
      SCRATCH.scale.set(0.78, 0.06, 0.18);
      SCRATCH.updateMatrix();
      mesh.setMatrixAt(i, SCRATCH.matrix);
    }
    mesh.count = total;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, MAX_UNITS * BLADES_PER_UNIT]}
      frustumCulled={false}
      castShadow
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#d1d5db" roughness={0.5} metalness={0.4} />
    </instancedMesh>
  );
}

export interface RoofHvacProps {
  building: Building;
  hvacKw: number;
  maxKw: number;
}

export function RoofHvac({ building, hvacKw, maxKw }: RoofHvacProps) {
  const [, depth] = BUILDING_SPECS[building.type].footprint;
  const top = roofY(building.type);
  const z = depth / 2 - SETBACK;
  const count = unitCount(building);

  const cabinets = useMemo<Piece[]>(() => {
    const pieces: Piece[] = [];
    for (let i = 0; i < count; i++) {
      const x = unitX(i, count);
      pieces.push({ p: [x, top + 0.09, z], s: [2.8, 0.18, 2.4], c: C.cabinet });
      pieces.push({ p: [x, top + 0.73, z], s: [2.6, 1.1, 2.2], c: C.hvac });
      pieces.push({ p: [x - 1.1, top + 0.73, z], s: [0.1, 0.8, 1.6], c: C.cabinet });
    }
    return pieces;
  }, [count, top, z]);

  const housings = useMemo<Piece[]>(() => {
    const pieces: Piece[] = [];
    for (let i = 0; i < count; i++) {
      const x = unitX(i, count);
      pieces.push({ p: [x, top + 1.45, z], s: [1.5, 0.34, 1.5], c: C.steel });
      pieces.push({ p: [x, top + 1.66, z], s: [0.3, 0.14, 0.3], c: C.cabinet });
    }
    return pieces;
  }, [count, top, z]);

  const speed = hvacKw < DORMANT_KW ? 0 : 1.5 + 5.5 * clamp(hvacKw / maxKw, 0, 1);

  return (
    <group>
      <Boxes pieces={cabinets}>
        <meshStandardMaterial color="#ffffff" roughness={0.7} metalness={0.25} />
      </Boxes>
      <Cylinders pieces={housings} radialSegments={12}>
        <meshStandardMaterial color="#ffffff" roughness={0.55} metalness={0.4} />
      </Cylinders>
      <FanBlades count={count} z={z} y={top + 1.7} speed={speed} />
      <NodeLabel position={[0, top + 3.2, z]} name="HVAC" value={formatKw(hvacKw)} />
    </group>
  );
}

export default RoofHvac;
