'use client';

/**
 * The charging court: painted bays running along +x from the EV anchor, a
 * pedestal per bay, and a low-poly car in most of them.
 *
 * A bay is "active" when the site's EV draw is high enough to reach it --
 * `round(ev_kw / (ev_bays * 11 kW) * bays)`. Active bays get a lit screen and a
 * glowing cable; the rest sit dim. When `ev_kw` is 0 (night) roughly half the
 * bays are empty, chosen deterministically so the scene never flickers.
 *
 * 6 draw calls regardless of bay count: paint, pedestals, screens, bodies,
 * wheels, cables.
 */

import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import { Color } from 'three';
import { formatKw } from '@/lib/format';
import { C, CAR_PAINTS, type EvPlan, hash01 } from './common';
import { Boxes, Cylinders, type Piece } from './Instanced';
import { NodeLabel } from './NodeLabel';

const BAY_W = 2.6;
const BAY_D = 5.4;
/** Chargers stand on the +z aisle, the side the scene is normally viewed from,
 *  so a lit screen and a live cable are never hidden behind the car. */
const PEDESTAL_Z = BAY_D / 2 + 0.3;
const CAR_Z = -0.3;

const DIM = new Color();
/** Scales a paint toward black: 0.42 for an idle bay, 0.7 for a cabin roof. */
function shade(hex: string, factor: number): string {
  return `#${DIM.set(hex).multiplyScalar(factor).getHexString()}`;
}

interface Built {
  paint: Piece[];
  pedestals: Piece[];
  screens: Piece[];
  bodies: Piece[];
  wheels: Piece[];
  cables: [number, number, number][];
}

function build(bays: number, activeBays: number, evKw: number, accent: string): Built {
  const paint: Piece[] = [];
  const pedestals: Piece[] = [];
  const screens: Piece[] = [];
  const bodies: Piece[] = [];
  const wheels: Piece[] = [];
  const cables: [number, number, number][] = [];

  const rowW = bays * BAY_W;

  // Apron the bays are painted on.
  paint.push({ p: [rowW / 2, 0.005, 0], s: [rowW + 0.6, 0.01, BAY_D + 1.2], c: C.asphalt });
  // Dividing lines, plus the kerb line across the head of the row.
  for (let i = 0; i <= bays; i++) {
    paint.push({ p: [i * BAY_W, 0.02, 0], s: [0.12, 0.02, BAY_D], c: C.paint });
  }
  paint.push({ p: [rowW / 2, 0.02, -BAY_D / 2], s: [rowW, 0.02, 0.12], c: C.paint });

  for (let i = 0; i < bays; i++) {
    const x = i * BAY_W + BAY_W / 2;
    const active = i < activeBays;
    // At night half the bays stand empty; by day every modelled bay is taken.
    const occupied = evKw > 0 || hash01(i * 3 + 7) > 0.45;

    pedestals.push({ p: [x, 0.05, PEDESTAL_Z], s: [0.7, 0.1, 0.7], c: C.concrete });
    pedestals.push({ p: [x, 0.65, PEDESTAL_Z], s: [0.4, 1.1, 0.4], c: C.steel });
    screens.push({
      p: [x, 0.95, PEDESTAL_Z + 0.21],
      s: [0.26, 0.2, 0.04],
      c: active ? accent : '#1f2937',
    });

    if (!occupied) continue;

    const base = CAR_PAINTS[i % CAR_PAINTS.length];
    const body = active ? base : shade(base, 0.42);
    bodies.push({ p: [x, 0.86, CAR_Z], s: [1.9, 0.68, 4.1], c: body });
    // Cabin is the same paint a shade down, so it reads as a roof rather than a hole.
    bodies.push({ p: [x, 1.49, CAR_Z - 0.3], s: [1.64, 0.58, 2.0], c: shade(body, 0.72) });
    // A glass band under the roofline, where a windscreen would be.
    bodies.push({ p: [x, 1.49, CAR_Z + 0.72], s: [1.5, 0.4, 0.06], c: C.glass });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        wheels.push({
          p: [x + sx * 0.96, 0.36, CAR_Z + sz * 1.35],
          s: [0.72, 0.26, 0.72],
          r: [0, 0, Math.PI / 2],
          c: '#111827',
        });
      }
    }

    if (active) {
      // Two short segments so the cable droops between pedestal and inlet.
      const a: [number, number, number] = [x + 0.22, 0.98, PEDESTAL_Z - 0.2];
      const b: [number, number, number] = [x + 0.36, 0.48, PEDESTAL_Z - 0.85];
      const c2: [number, number, number] = [x + 0.22, 0.68, CAR_Z + 2.05];
      cables.push(a, b, b, c2);
    }
  }

  return { paint, pedestals, screens, bodies, wheels, cables };
}

export interface EvBaysProps {
  position: readonly [number, number, number];
  plan: EvPlan;
  /** Real bay count from the building record, for the label. */
  totalBays: number;
  evKw: number;
  accent: string;
}

export function EvBays({ position, plan, totalBays, evKw, accent }: EvBaysProps) {
  const built = useMemo(
    () => build(plan.rendered, plan.activeRendered, evKw, accent),
    [plan.rendered, plan.activeRendered, evKw, accent],
  );

  const rowW = plan.rendered * BAY_W;
  const value =
    plan.multiplier > 1 ? `${formatKw(evKw)} · ×${plan.multiplier}` : formatKw(evKw);

  return (
    <group position={position as [number, number, number]}>
      <Boxes pieces={built.paint} castShadow={false}>
        <meshStandardMaterial color="#ffffff" roughness={0.95} metalness={0} />
      </Boxes>

      <Boxes pieces={built.pedestals}>
        <meshStandardMaterial color="#ffffff" roughness={0.6} metalness={0.35} />
      </Boxes>

      {/* Unlit so a live screen glows without needing a light near it. */}
      <Boxes pieces={built.screens} castShadow={false}>
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </Boxes>

      <Boxes pieces={built.bodies}>
        <meshStandardMaterial color="#ffffff" roughness={0.42} metalness={0.28} />
      </Boxes>

      <Cylinders pieces={built.wheels} radialSegments={10}>
        <meshStandardMaterial color="#ffffff" roughness={0.9} metalness={0.05} />
      </Cylinders>

      {built.cables.length > 0 ? (
        <Line
          points={built.cables}
          segments
          color={accent}
          lineWidth={2.4}
          transparent
          opacity={0.95}
          toneMapped={false}
        />
      ) : null}

      <NodeLabel
        position={[rowW / 2, 3.4, 0]}
        name={`EV · ${plan.activeTotal} of ${totalBays} charging`}
        value={value}
      />
    </group>
  );
}

export default EvBays;
