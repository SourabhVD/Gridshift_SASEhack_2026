'use client';

/**
 * The battery: a 3 x 1.2 x 2.4 m outdoor cabinet with a state-of-charge bar
 * across its face and a status light that says, at a glance, which way the
 * energy is moving.
 *
 *   green   idle          (|battery_kw| < 0.5)
 *   violet  discharging   (battery_kw > 0), pulsing
 *   sky     charging      (battery_kw < 0)
 *
 * 4 draw calls: the shell cluster, the vent cluster, the SOC fill, the light.
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { MeshStandardMaterial } from 'three';
import { C, DORMANT_KW, batteryPhrase, clamp } from './common';
import { Boxes, type Piece } from './Instanced';
import { NodeLabel } from './NodeLabel';

const W = 3;
const D = 1.2;
const H = 2.4;
const PLINTH_H = 0.18;
/** Front face of the cabinet, where the readouts live. */
const FACE_Z = D / 2 + 0.03;
const TRACK_W = 2.4;
const BAR_Y = PLINTH_H + H * 0.62;

function buildShell(): Piece[] {
  const pieces: Piece[] = [
    { p: [0, PLINTH_H / 2, 0], s: [W + 0.4, PLINTH_H, D + 0.4], c: C.concrete },
    { p: [0, PLINTH_H + H / 2, 0], s: [W, H, D], c: C.cabinet },
    // Slight overhanging roof, so the box does not read as a plain cube.
    { p: [0, PLINTH_H + H + 0.06, 0], s: [W + 0.22, 0.12, D + 0.22], c: C.steel },
    // Recessed track the SOC bar fills.
    { p: [0, BAR_Y, FACE_Z], s: [TRACK_W, 0.42, 0.04], c: '#111827' },
  ];
  // Louvred vents down the lower half of the face.
  for (let i = 0; i < 5; i++) {
    pieces.push({
      p: [0, PLINTH_H + 0.45 + i * 0.16, FACE_Z],
      s: [TRACK_W * 0.8, 0.07, 0.03],
      c: '#1f2937',
    });
  }
  return pieces;
}

export interface BatteryCabinetProps {
  position: readonly [number, number, number];
  batteryKw: number;
  socPct: number;
  /** Violet normally; emerald once an optimized plan is leaning on the battery. */
  accent: string;
}

/* Fixed geometry: laid out once, not per instance. */
const SHELL = buildShell();

export function BatteryCabinet({ position, batteryKw, socPct, accent }: BatteryCabinetProps) {

  const soc = clamp(socPct, 0, 100) / 100;
  const fillW = Math.max(0.02, TRACK_W * 0.96 * soc);

  const discharging = batteryKw > DORMANT_KW;
  const charging = batteryKw < -DORMANT_KW;
  const lightColor = discharging ? C.battery : charging ? C.grid : C.good;

  const lightRef = useRef<MeshStandardMaterial>(null);
  useFrame((state) => {
    const mat = lightRef.current;
    if (!mat) return;
    // Only the discharging state breathes; idle and charging sit steady.
    mat.emissiveIntensity = discharging
      ? 1.1 + 0.9 * (0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 3.4))
      : 1.1;
  });

  return (
    <group position={position as [number, number, number]}>
      <Boxes pieces={SHELL}>
        <meshStandardMaterial color="#ffffff" roughness={0.65} metalness={0.3} />
      </Boxes>

      {/* SOC fill -- left-anchored inside the track. */}
      {/* Scaled, not rebuilt: the width changes every hour the slider moves. */}
      <mesh
        position={[-TRACK_W * 0.48 + fillW / 2, BAR_Y, FACE_Z + 0.02]}
        scale={[fillW, 1, 1]}
        castShadow={false}
      >
        <boxGeometry args={[1, 0.3, 0.03]} />
        <meshStandardMaterial
          color={C.battery}
          emissive={C.battery}
          emissiveIntensity={0.9}
          toneMapped={false}
        />
      </mesh>

      {/* Status light. */}
      <mesh position={[W / 2 - 0.26, PLINTH_H + H - 0.26, FACE_Z]} castShadow={false}>
        <boxGeometry args={[0.18, 0.18, 0.06]} />
        <meshStandardMaterial
          ref={lightRef}
          color={lightColor}
          emissive={lightColor}
          emissiveIntensity={1.1}
          toneMapped={false}
        />
      </mesh>

      <NodeLabel
        position={[0, H + 1.5, 0]}
        name={`Battery · ${Math.round(socPct)}%`}
        value={batteryPhrase(batteryKw)}
        valueColor={discharging ? accent : undefined}
      />
    </group>
  );
}

export default BatteryCabinet;
