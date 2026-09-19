'use client';

/**
 * Grid intake: a fenced pad with a pole-mounted transformer, and the lattice
 * pylon that carries the feeder off the edge of the scene toward -x.
 *
 * All of it is one instanced box cluster (pad, fence posts, tank, cooling
 * fins, 38 pylon members) plus one translucent cluster for the fence mesh,
 * one cylinder cluster for the ceramics, and one line for the conductors:
 * 4 draw calls for ~60 pieces.
 */

import { Line } from '@react-three/drei';
import { formatKw } from '@/lib/format';
import { C } from './common';
import { Boxes, Cylinders, type Piece } from './Instanced';
import { NodeLabel } from './NodeLabel';

const PAD_W = 9;
const PAD_D = 7;
const PAD_H = 0.16;
const FENCE_H = 2.2;
const PYLON_X = -7;
const PYLON_H = 14;
const ARM_HALF = 3.2;

/** Square half-width of the lattice at height y -- a linear taper. */
function pylonHalf(y: number): number {
  return 1.7 + (0.5 - 1.7) * (y / PYLON_H);
}

function buildStructure(): Piece[] {
  const pieces: Piece[] = [];

  // --- pad + fence posts -------------------------------------------------
  pieces.push({ p: [0, PAD_H / 2, 0], s: [PAD_W, PAD_H, PAD_D], c: C.concrete });
  const postXs = [-PAD_W / 2, -PAD_W / 6, PAD_W / 6, PAD_W / 2];
  for (const x of postXs) {
    pieces.push({ p: [x, FENCE_H / 2, -PAD_D / 2], s: [0.12, FENCE_H, 0.12], c: C.steel });
    pieces.push({ p: [x, FENCE_H / 2, PAD_D / 2], s: [0.12, FENCE_H, 0.12], c: C.steel });
  }
  pieces.push({ p: [-PAD_W / 2, FENCE_H / 2, 0], s: [0.12, FENCE_H, 0.12], c: C.steel });
  pieces.push({ p: [PAD_W / 2, FENCE_H / 2, 0], s: [0.12, FENCE_H, 0.12], c: C.steel });

  // --- transformer tank + cooling fins + bushings base -------------------
  const tankY = PAD_H + 1.1;
  pieces.push({ p: [0.4, tankY, 0], s: [2.6, 2.2, 1.8], c: C.steel });
  pieces.push({ p: [0.4, PAD_H + 2.28, 0], s: [2.8, 0.16, 2.0], c: C.cabinet });
  for (let i = 0; i < 4; i++) {
    const z = -0.6 + i * 0.4;
    pieces.push({ p: [0.4 - 1.42, tankY, z], s: [0.3, 1.7, 0.1], c: C.cabinet });
    pieces.push({ p: [0.4 + 1.42, tankY, z], s: [0.3, 1.7, 0.1], c: C.cabinet });
  }

  // --- lattice pylon: 4 stepped stages of legs, 5 rings of braces, 2 arms --
  const stages = 4;
  const stageH = PYLON_H / stages;
  for (let k = 0; k < stages; k++) {
    const yMid = (k + 0.5) * stageH;
    const hw = pylonHalf(yMid);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pieces.push({ p: [PYLON_X + sx * hw, yMid, sz * hw], s: [0.18, stageH, 0.18], c: C.steel });
      }
    }
  }
  for (let k = 0; k <= stages; k++) {
    const y = k * stageH;
    const hw = pylonHalf(y);
    pieces.push({ p: [PYLON_X, y, -hw], s: [hw * 2, 0.14, 0.14], c: C.steel });
    pieces.push({ p: [PYLON_X, y, hw], s: [hw * 2, 0.14, 0.14], c: C.steel });
    pieces.push({ p: [PYLON_X - hw, y, 0], s: [0.14, 0.14, hw * 2], c: C.steel });
    pieces.push({ p: [PYLON_X + hw, y, 0], s: [0.14, 0.14, hw * 2], c: C.steel });
  }
  pieces.push({ p: [PYLON_X, 11.4, 0], s: [0.2, 0.2, ARM_HALF * 2], c: C.steel });
  pieces.push({ p: [PYLON_X, 13.2, 0], s: [0.2, 0.2, ARM_HALF * 2 * 0.72], c: C.steel });

  return pieces;
}

function buildFence(): Piece[] {
  return [
    { p: [0, FENCE_H / 2, -PAD_D / 2], s: [PAD_W, FENCE_H, 0.03] },
    { p: [0, FENCE_H / 2, PAD_D / 2], s: [PAD_W, FENCE_H, 0.03] },
    { p: [-PAD_W / 2, FENCE_H / 2, 0], s: [0.03, FENCE_H, PAD_D] },
    { p: [PAD_W / 2, FENCE_H / 2, 0], s: [0.03, FENCE_H, PAD_D] },
  ];
}

function buildCeramics(): Piece[] {
  const pieces: Piece[] = [];
  // Two bushings on the tank.
  for (const dx of [-0.55, 0.55]) {
    pieces.push({ p: [0.4 + dx, PAD_H + 2.7, 0], s: [0.3, 0.72, 0.3] });
  }
  // Suspension bells at the cross-arm tips.
  for (const sz of [-1, 1]) {
    pieces.push({ p: [PYLON_X, 11.05, sz * ARM_HALF], s: [0.26, 0.5, 0.26] });
    pieces.push({ p: [PYLON_X, 12.85, sz * ARM_HALF * 0.72], s: [0.26, 0.5, 0.26] });
  }
  return pieces;
}

/** Two conductors leaving toward -x, drawn as segment pairs so they cost one call. */
function buildConductors(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const sz of [-1, 1]) {
    const z = sz * ARM_HALF;
    const spans: [number, number][] = [
      [PYLON_X, 10.8],
      [PYLON_X - 16, 9.4],
      [PYLON_X - 34, 9.0],
      [PYLON_X - 56, 10.8],
    ];
    for (let i = 0; i < spans.length - 1; i++) {
      out.push([spans[i][0], spans[i][1], z]);
      out.push([spans[i + 1][0], spans[i + 1][1], z]);
    }
  }
  return out;
}

export interface TransformerProps {
  position: readonly [number, number, number];
  gridKw: number;
  overThreshold: boolean;
}

/* The pad never changes shape, so it is laid out once at module scope rather
 * than memoised per instance. */
const STRUCTURE = buildStructure();
const FENCE = buildFence();
const CERAMICS = buildCeramics();
const CONDUCTORS = buildConductors();

export function Transformer({ position, gridKw, overThreshold }: TransformerProps) {

  return (
    <group position={position as [number, number, number]}>
      <Boxes pieces={STRUCTURE}>
        <meshStandardMaterial color="#ffffff" roughness={0.72} metalness={0.25} />
      </Boxes>

      <Boxes pieces={FENCE} castShadow={false}>
        <meshStandardMaterial
          color="#94a3b8"
          roughness={0.9}
          transparent
          opacity={0.14}
          depthWrite={false}
        />
      </Boxes>

      <Cylinders pieces={CERAMICS} radialSegments={8}>
        <meshStandardMaterial color={C.ceramic} roughness={0.35} metalness={0.05} />
      </Cylinders>

      <Line
        points={CONDUCTORS}
        segments
        color={overThreshold ? C.alert : '#64748b'}
        lineWidth={1.5}
        transparent
        opacity={0.75}
        toneMapped={false}
      />

      <NodeLabel
        position={[0.4, 4.6, 0]}
        name="Grid"
        value={formatKw(gridKw)}
        valueColor={overThreshold ? C.alert : undefined}
      />
    </group>
  );
}

export default Transformer;
