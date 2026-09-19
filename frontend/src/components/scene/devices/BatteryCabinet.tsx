'use client';

/**
 * Storage, in two very different enclosures.
 *
 * Commercial -- a 3 x 1.2 x 2.4 m outdoor cabinet: powder-coated white with a
 * dark weather cap, louvred at the bottom, and a slim violet state-of-charge
 * bar sitting behind a glass strip across the face.
 *
 * Residence -- two 0.75 x 1.15 x 0.16 m wall units bolted to the -x gable end,
 * side by side with a 120 mm gap, their bottoms 0.6 m off the ground. Matte
 * white with a single dark seam and a 20 mm status LED each. There is no bar on
 * a domestic unit; the state of charge lives in the label instead.
 *
 * The LED reads the same on both:
 *
 *   green   idle          (|battery_kw| < 0.5)
 *   violet  discharging   (battery_kw > 0)
 *   teal    charging      (battery_kw < 0)
 *
 * Only the LED and the SOC bar cross the bloom threshold -- they are the one
 * emissive cluster per variant, and a discharging pack breathes by scaling that
 * material's colour rather than by touching 2 x 40 instance tints.
 *
 * Draw calls -- commercial 5, residence 3.
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { MeshBasicMaterial } from 'three';
import type { BuildingType } from '@/types/api';
import { C, DORMANT_KW, MAT, batteryPhrase, clamp, glow, isResidence } from './common';
import { Boxes, RoundedBoxes, type Piece } from './Instanced';
import { NodeLabel } from './NodeLabel';

/* -------------------------------------------------------------------------- */
/* Commercial cabinet                                                          */
/* -------------------------------------------------------------------------- */

const W = 3;
const D = 1.2;
const H = 2.4;
const PLINTH_H = 0.18;
/** Front face of the cabinet, where the readouts live. */
const FACE_Z = D / 2;
const TRACK_W = 2.5;
const BAR_Y = PLINTH_H + H * 0.62;

/** Depths of the three readout layers, measured off the cabinet face. */
const TRACK_Z = FACE_Z + 0.01;
const FILL_Z = FACE_Z + 0.028;
const COVER_Z = FACE_Z + 0.048;

const PLINTH: Piece[] = [
  { p: [0, PLINTH_H / 2, 0], s: [W + 0.4, PLINTH_H, D + 0.4] },
];

const SHELL: Piece[] = [
  { p: [0, PLINTH_H + H / 2, 0], s: [W, H, D], c: C.powder },
  // Dark weather cap, slightly proud all round so the roofline catches light.
  { p: [0, PLINTH_H + H + 0.055, 0], s: [W + 0.14, 0.11, D + 0.14], c: C.dark },
];

const TRIM: Piece[] = (() => {
  const pieces: Piece[] = [
    // Recessed track the SOC bar sits in. The three layers of the readout are
    // stacked in z with real gaps -- coplanar plates would z-fight and the dark
    // track would simply swallow the bar.
    { p: [0, BAR_Y, TRACK_Z], s: [TRACK_W, 0.34, 0.02], c: '#141414' },
    // Door seams.
    { p: [-0.02, PLINTH_H + H / 2, FACE_Z + 0.004], s: [0.016, H - 0.2, 0.012], c: C.dark },
  ];
  // Louvred vents down the lower half of the face.
  for (let i = 0; i < 6; i++) {
    pieces.push({
      p: [0, PLINTH_H + 0.36 + i * 0.14, FACE_Z + 0.004],
      s: [TRACK_W * 0.82, 0.06, 0.02],
      c: C.dark,
    });
  }
  return pieces;
})();

/** The glass strip in front of the bar. Reflective, near-black, and see-through. */
const GLASS: Piece[] = [{ p: [0, BAR_Y, COVER_Z], s: [TRACK_W + 0.12, 0.44, 0.016] }];

/* -------------------------------------------------------------------------- */
/* Residence wall units                                                        */
/* -------------------------------------------------------------------------- */

const UNIT_W = 0.75;
const UNIT_H = 1.15;
const UNIT_T = 0.16;
const UNIT_GAP = 0.12;
/** Units run along z on the gable wall, so "side by side" separates them in z. */
const UNIT_DZ = (UNIT_W + UNIT_GAP) / 2;
/** They face -x; everything applied has to sit just outboard of the shell. */
const UNIT_FACE_X = -UNIT_T / 2;

const WALL_UNITS: Piece[] = [-1, 1].map((sz) => ({
  p: [0, 0, sz * UNIT_DZ] as const,
  s: [UNIT_T, UNIT_H, UNIT_W] as const,
  c: C.powder,
}));

const WALL_TRIM: Piece[] = (() => {
  const pieces: Piece[] = [];
  for (const sz of [-1, 1]) {
    // The single dark seam across the face.
    pieces.push({
      p: [UNIT_FACE_X - 0.004, 0.2, sz * UNIT_DZ],
      s: [0.012, 0.01, UNIT_W - 0.1],
      c: C.dark,
    });
    // Mounting rail, bridging the 120 mm gap between the unit's back face
    // (x = -7.12) and the gable wall itself (x = -7.0), so nothing floats.
    pieces.push({
      p: [UNIT_T / 2 + 0.06, 0, sz * UNIT_DZ],
      s: [0.12, UNIT_H - 0.22, UNIT_W - 0.12],
      c: C.dark,
    });
  }
  return pieces;
})();

/* -------------------------------------------------------------------------- */

export interface BatteryCabinetProps {
  type: BuildingType;
  /** Ground anchor on a commercial lot; the wall mount point on the residence. */
  position: readonly [number, number, number];
  batteryKw: number;
  socPct: number;
  /** Violet normally; emerald once an optimized plan is leaning on the battery. */
  accent: string;
}

export function BatteryCabinet({
  type,
  position,
  batteryKw,
  socPct,
  accent,
}: BatteryCabinetProps) {
  const residence = isResidence(type);

  const soc = clamp(socPct, 0, 100) / 100;
  const discharging = batteryKw > DORMANT_KW;
  const charging = batteryKw < -DORMANT_KW;
  const ledHex = discharging ? C.battery : charging ? C.ev : C.good;

  /* One emissive cluster per variant: every pixel in it is meant to bloom. */
  const lights = useMemo<Piece[]>(() => {
    if (residence) {
      return [-1, 1].map((sz) => ({
        p: [UNIT_FACE_X - 0.006, -UNIT_H / 2 + 0.16, sz * UNIT_DZ - UNIT_W / 2 + 0.11] as const,
        // 45 mm rather than the nominal 20: at the framing the camera rig
        // actually uses, a true 20 mm LED is sub-pixel even with bloom on.
        s: [0.014, 0.045, 0.045] as const,
        c: glow(ledHex),
      }));
    }
    const fillW = Math.max(0.03, TRACK_W * 0.94 * soc);
    return [
      {
        p: [-TRACK_W * 0.47 + fillW / 2, BAR_Y, FILL_Z],
        s: [fillW, 0.2, 0.016],
        c: glow(C.battery, 1.8),
      },
      {
        p: [W / 2 - 0.22, PLINTH_H + H - 0.2, FACE_Z + 0.01],
        s: [0.1, 0.1, 0.02],
        c: glow(ledHex),
      },
    ];
  }, [residence, soc, ledHex]);

  /* Only the discharging state breathes; idle and charging sit steady. Scaling
   * the shared material keeps 1 draw call and never rewrites instance colours. */
  const lightMat = useRef<MeshBasicMaterial>(null);
  useFrame((state) => {
    const mat = lightMat.current;
    if (!mat) return;
    const k = discharging ? 1 + 0.28 * Math.sin(state.clock.elapsedTime * 3.4) : 1;
    mat.color.setScalar(k);
  });

  const emissive = (
    <Boxes pieces={lights} castShadow={false} receiveShadow={false}>
      <meshBasicMaterial ref={lightMat} color="#ffffff" toneMapped={false} />
    </Boxes>
  );

  if (residence) {
    return (
      <group position={position as [number, number, number]}>
        <RoundedBoxes pieces={WALL_UNITS} radius={0.035}>
          <meshStandardMaterial color="#ffffff" roughness={0.55} metalness={0.05} />
        </RoundedBoxes>
        <Boxes pieces={WALL_TRIM}>
          <meshStandardMaterial color="#ffffff" {...MAT.rubber} />
        </Boxes>
        {emissive}
        <NodeLabel
          position={[-1.3, 0.92, 0]}
          name={`Battery · ${Math.round(socPct)}%`}
          value={batteryPhrase(batteryKw)}
          valueColor={discharging ? accent : undefined}
        />
      </group>
    );
  }

  return (
    <group position={position as [number, number, number]}>
      <Boxes pieces={PLINTH}>
        <meshStandardMaterial color={C.concrete} {...MAT.concrete} />
      </Boxes>

      <RoundedBoxes pieces={SHELL} radius={0.022}>
        <meshStandardMaterial color="#ffffff" {...MAT.powder} />
      </RoundedBoxes>

      <Boxes pieces={TRIM}>
        <meshStandardMaterial color="#ffffff" roughness={0.6} metalness={0.2} />
      </Boxes>

      {/* Transparent, or it would simply hide the bar it is supposed to cover. */}
      <Boxes pieces={GLASS} castShadow={false}>
        <meshStandardMaterial
          color={C.glass}
          {...MAT.glass}
          transparent
          opacity={0.42}
          depthWrite={false}
        />
      </Boxes>

      {emissive}

      <NodeLabel
        position={[0, H + 1.4, 0]}
        name={`Battery · ${Math.round(socPct)}%`}
        value={batteryPhrase(batteryKw)}
        valueColor={discharging ? accent : undefined}
      />
    </group>
  );
}

export default BatteryCabinet;
