'use client';

/**
 * Cooling plant.
 *
 * Commercial -- packaged rooftop units at the front-centre of the roof, one per
 * three HVAC zones up to four: a bevelled cabinet on a curb, a louvred coil
 * bank down one flank, and a fan sunk behind a guard ring.
 *
 * Residence -- no rooftop plant at all. A 0.9 x 0.7 x 0.3 m air-source heat
 * pump stands on a small pad off the +x elevation, fan on the face toward the
 * camera.
 *
 * The fans turn at a rate proportional to `hvac_kw` and stop dead below the
 * 0.5 kW dormant threshold -- the same cut-off that fades the HVAC conduit, so
 * a still fan never sits on a live wire. That threshold also hides the label.
 *
 * Draw calls: 3 either way (bevelled boxes, the ring cylinders, the blades).
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { DoubleSide, type InstancedMesh, Object3D } from 'three';
import type { Building } from '@/types/api';
import { formatKw } from '@/lib/format';
import { BUILDING_SPECS, roofY } from '../layout';
import { C, DORMANT_KW, MAT, clamp, isResidence } from './common';
import { Cylinders, RoundedBoxes, type Piece } from './Instanced';
import { NodeLabel } from './NodeLabel';
import { RESIDENCE } from './paths';

const MAX_UNITS = 4;
const SPACING = 3.4;
/** Distance from the roof front edge to the unit centreline. */
const SETBACK = 3.2;
const BLADES_PER_UNIT = 3;

const SCRATCH = new Object3D();

export function unitCount(building: Building): number {
  if (isResidence(building.type)) return 1;
  return Math.max(1, Math.min(MAX_UNITS, Math.round(building.hvac_zones / 3)));
}

function unitX(index: number, count: number): number {
  return (index - (count - 1) / 2) * SPACING;
}

/* -------------------------------------------------------------------------- */
/* Fans                                                                        */
/* -------------------------------------------------------------------------- */

interface FanBladesProps {
  /** Hub centre of each fan. */
  centres: readonly (readonly [number, number, number])[];
  /** Orbit radius of a blade's midpoint. */
  radius: number;
  /** Blade length along its own long axis. */
  length: number;
  /** 'y' for an upward-throwing rooftop fan, 'z' for a wall-style face fan. */
  axis: 'y' | 'z';
  /** Radians per second; 0 parks the fans. */
  speed: number;
}

/** Every blade of every fan in one InstancedMesh, driven by one useFrame. */
function FanBlades({ centres, radius, length, axis, speed }: FanBladesProps) {
  const ref = useRef<InstancedMesh>(null);
  const spin = useRef(0);

  useFrame((_, delta) => {
    const mesh = ref.current;
    if (!mesh) return;
    spin.current += delta * speed;
    const total = centres.length * BLADES_PER_UNIT;
    for (let i = 0; i < total; i++) {
      const centre = centres[Math.floor(i / BLADES_PER_UNIT)];
      const angle = spin.current + (i % BLADES_PER_UNIT) * ((Math.PI * 2) / BLADES_PER_UNIT);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      if (axis === 'y') {
        SCRATCH.position.set(centre[0] + cos * radius, centre[1], centre[2] + sin * radius);
        // A box's long axis is +x; a yaw of -angle aims it radially.
        SCRATCH.rotation.set(0, -angle, 0);
        SCRATCH.scale.set(length, 0.05, length * 0.24);
      } else {
        SCRATCH.position.set(centre[0] + cos * radius, centre[1] + sin * radius, centre[2]);
        SCRATCH.rotation.set(0, 0, angle);
        SCRATCH.scale.set(length, length * 0.3, 0.04);
      }
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
      <meshStandardMaterial color="#c7cad0" roughness={0.5} metalness={0.45} />
    </instancedMesh>
  );
}

/* -------------------------------------------------------------------------- */

export interface RoofHvacProps {
  building: Building;
  hvacKw: number;
  maxKw: number;
}

export function RoofHvac({ building, hvacKw, maxKw }: RoofHvacProps) {
  const residence = isResidence(building.type);
  const [width, depth] = BUILDING_SPECS[building.type].footprint;
  const top = roofY(building.type);
  const z = depth / 2 - SETBACK;
  const count = unitCount(building);

  const speed = hvacKw < DORMANT_KW ? 0 : 1.5 + 5.5 * clamp(hvacKw / maxKw, 0, 1);
  const show = hvacKw >= DORMANT_KW;

  /* ---- residence: one ground-pad heat pump ----------------------------- */
  const pump = useMemo(() => {
    const [px, , pz] = RESIDENCE.heatPump;
    const boxes: Piece[] = [
      { p: [px, 0.05, pz], s: [1.24, 0.1, 0.62], c: C.concrete },
      { p: [px, 0.45, pz], s: [0.9, 0.7, 0.3], c: C.powder },
      // Coil louvres wrap the -z face and both ends.
      { p: [px, 0.45, pz - 0.155], s: [0.86, 0.6, 0.02], c: C.dark },
    ];
    for (let i = 0; i < 4; i++) {
      boxes.push({ p: [px, 0.24 + i * 0.05, pz - 0.162], s: [0.84, 0.02, 0.015], c: C.dark });
    }
    const rings: Piece[] = [
      // Fan guard, on the +z face: an open ring the blades sit behind.
      { p: [px, 0.52, pz + 0.16], s: [0.56, 0.035, 0.56], r: [Math.PI / 2, 0, 0], c: C.dark },
      { p: [px, 0.52, pz + 0.152], s: [0.2, 0.05, 0.2], r: [Math.PI / 2, 0, 0], c: C.dark },
    ];
    const centres: [number, number, number][] = [[px, 0.52, pz + 0.135]];
    return { boxes, rings, centres };
  }, []);

  /* ---- commercial: packaged rooftop units ------------------------------ */
  const roof = useMemo(() => {
    const boxes: Piece[] = [];
    const rings: Piece[] = [];
    const centres: [number, number, number][] = [];
    for (let i = 0; i < count; i++) {
      const x = unitX(i, count);
      boxes.push({ p: [x, top + 0.09, z], s: [2.8, 0.18, 2.4], c: C.dark });
      boxes.push({ p: [x, top + 0.73, z], s: [2.6, 1.1, 2.2], c: C.hvac });
      // Coil bank down the -x flank, louvred.
      boxes.push({ p: [x - 1.32, top + 0.73, z], s: [0.06, 0.86, 1.7], c: C.dark });
      for (let k = 0; k < 6; k++) {
        boxes.push({
          p: [x - 1.35, top + 0.4 + k * 0.13, z],
          s: [0.03, 0.05, 1.66],
          c: C.frame,
        });
      }
      // Access panel seam on the front.
      boxes.push({ p: [x, top + 0.73, z + 1.11], s: [1.6, 0.02, 0.02], c: C.dark });

      rings.push({ p: [x, top + 1.32, z], s: [1.55, 0.14, 1.55], c: C.steel });
      rings.push({ p: [x, top + 1.42, z], s: [1.62, 0.05, 1.62], c: C.dark });
      rings.push({ p: [x, top + 1.5, z], s: [0.28, 0.14, 0.28], c: C.dark });
      centres.push([x, top + 1.4, z]);
    }
    return { boxes, rings, centres };
  }, [count, top, z]);

  const active = residence ? pump : roof;

  return (
    <group>
      <RoundedBoxes pieces={active.boxes} radius={0.03}>
        <meshStandardMaterial color="#ffffff" {...MAT.powder} />
      </RoundedBoxes>
      <Cylinders pieces={active.rings} radialSegments={16} openEnded>
        <meshStandardMaterial color="#ffffff" {...MAT.paintedSteel} side={DoubleSide} />
      </Cylinders>
      <FanBlades
        centres={active.centres}
        radius={residence ? 0.13 : 0.4}
        length={residence ? 0.3 : 0.78}
        axis={residence ? 'z' : 'y'}
        speed={speed}
      />
      <NodeLabel
        position={
          residence
            ? [RESIDENCE.heatPump[0] + 1.2, 1.5, RESIDENCE.heatPump[2] - 1.4]
            : [width * 0.3, top + 2.2, z]
        }
        name="HVAC"
        value={formatKw(hvacKw)}
        show={show}
      />
    </group>
  );
}

export default RoofHvac;
