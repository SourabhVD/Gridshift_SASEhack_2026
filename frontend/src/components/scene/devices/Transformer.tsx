'use client';

/**
 * Grid intake. Two completely different pieces of kit share this file, because
 * they are the same *node*: the thing the utility owns, at the edge of the lot.
 *
 * Commercial -- a pad-mount transformer (2.2 m across, utility green-grey) on a
 * cast pad, louvred down both flanks, with a warning placard on the door, and a
 * 16 m lattice pylon carrying two sagging conductors off toward -x. The cabinet
 * is a generated model where `/models/transformer.glb` loads and the bevelled
 * procedural tank where it does not; everything else on the lot is the same
 * either way, the pad included.
 *
 * Residence -- a pylon on a suburban lawn is absurd, so the lot gets a 9 m
 * timber pole with a pot-mounted can transformer and a wall meter box beside
 * the junction. The service drop itself is *not* drawn here: the grid conduit
 * starts at this pole's insulator, so the span you see is the live run with its
 * beads of light, drawn once rather than twice.
 *
 * Draw calls -- commercial 5 with the model (concrete, the cabinet, ceramics,
 * the whole lattice as one InstancedMesh, conductors), 6 on the procedural
 * branch, which splits the cabinet into tank and trim. Residence 3.
 */

import { useLayoutEffect, useMemo, useRef, type ComponentRef } from 'react';
import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { CatmullRomCurve3, Color, Vector3 } from 'three';
import type { BuildingType } from '@/types/api';
import { formatKw } from '@/lib/format';
import { settle, usePrefersReducedMotion } from './ApprovePulse';
import { GlbOrFallback } from '../glb/GlbOrFallback';
import { preloadGlb, useBakedGlb, type GlbTransform } from '../glb/useBakedGlb';
import { C, MAT, isResidence } from './common';
import { Boxes, Cylinders, RoundedBoxes, type Piece } from './Instanced';
import { NodeLabel } from './NodeLabel';
import { RESIDENCE } from './paths';

/* -------------------------------------------------------------------------- */
/* Commercial: pad-mount transformer + lattice pylon                           */
/* -------------------------------------------------------------------------- */

const PAD_W = 3.6;
const PAD_D = 2.9;
const PAD_H = 0.16;

/** The tank itself: the brief's 2.2 x 1.6 x 1.8, as [x, y, z] = [2.2, 1.8, 1.6]. */
const TANK_W = 2.2;
const TANK_H = 1.8;
const TANK_D = 1.6;
const TANK_Y = PAD_H + TANK_H / 2;
/** Door face, where the placard and the seams live. */
const FACE_Z = TANK_D / 2 + 0.012;

const PYLON_X = -7;
const PYLON_H = 16;
const PYLON_STAGES = 6;
const STAGE_H = PYLON_H / PYLON_STAGES;
const ARM_Y = 12.8;
const ARM_HALF = 2.6;
/** Where the conductors hang: one insulator bell below the arm. */
const CONDUCTOR_Y = ARM_Y - 0.62;

/** Square half-width of the lattice at height y -- a linear taper. */
function pylonHalf(y: number): number {
  return 1.35 + (0.42 - 1.35) * (y / PYLON_H);
}

/** Concrete: the pad and its kerb. */
function buildPad(): Piece[] {
  return [
    { p: [0, PAD_H / 2, 0], s: [PAD_W, PAD_H, PAD_D] },
    // A 100 mm kerb round the back three sides, so the pad is not a bare slab.
    { p: [0, PAD_H + 0.05, -PAD_D / 2 + 0.06], s: [PAD_W, 0.1, 0.12] },
    { p: [-PAD_W / 2 + 0.06, PAD_H + 0.05, 0], s: [0.12, 0.1, PAD_D] },
    { p: [PAD_W / 2 - 0.06, PAD_H + 0.05, 0], s: [0.12, 0.1, PAD_D] },
    // Pylon footing.
    { p: [PYLON_X, 0.09, 0], s: [3.4, 0.18, 3.4] },
  ];
}

/** Bevelled volumes: the tank and its lid. */
function buildTank(): Piece[] {
  return [
    { p: [0, TANK_Y, 0], s: [TANK_W, TANK_H, TANK_D], c: C.transformer },
    { p: [0, PAD_H + TANK_H + 0.035, 0], s: [TANK_W + 0.12, 0.07, TANK_D + 0.12], c: C.dark },
  ];
}

/**
 * Painted-steel trim on the tank: the louvre banks, the door seams and the
 * placard. Split from the lattice because the generated cabinet carries its own
 * louvres and door -- when that model is in, this list is simply not drawn.
 */
function buildTankSteel(): Piece[] {
  const pieces: Piece[] = [];

  // --- louvred flanks ----------------------------------------------------
  for (let i = 0; i < 7; i++) {
    const y = PAD_H + 0.5 + i * 0.13;
    for (const sx of [-1, 1]) {
      pieces.push({
        p: [sx * (TANK_W / 2 + 0.012), y, 0],
        s: [0.02, 0.055, TANK_D * 0.72],
        c: C.dark,
      });
    }
  }
  // --- door seams + handle ----------------------------------------------
  for (const dx of [-0.52, 0.52]) {
    pieces.push({ p: [dx, TANK_Y, FACE_Z], s: [0.018, TANK_H - 0.26, 0.016], c: C.dark });
  }
  pieces.push({ p: [0, PAD_H + 0.9, FACE_Z], s: [0.14, 0.05, 0.03], c: C.steel });
  // --- warning placard: paint, deliberately below the bloom threshold -----
  pieces.push({ p: [0.58, PAD_H + 1.34, FACE_Z + 0.006], s: [0.3, 0.22, 0.012], c: C.placard });
  pieces.push({ p: [0.58, PAD_H + 1.34, FACE_Z + 0.002], s: [0.34, 0.26, 0.01], c: C.dark });

  return pieces;
}

/** The pylon lattice: legs, horizontal braces, crossing diagonals, arm. */
function buildPylonSteel(): Piece[] {
  const pieces: Piece[] = [];

  for (let k = 0; k < PYLON_STAGES; k++) {
    const yMid = (k + 0.5) * STAGE_H;
    const hw = pylonHalf(yMid);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pieces.push({
          p: [PYLON_X + sx * hw, yMid, sz * hw],
          s: [0.14, STAGE_H, 0.14],
          c: C.steel,
        });
      }
    }
  }
  for (let k = 0; k <= PYLON_STAGES; k++) {
    const y = k * STAGE_H;
    const hw = pylonHalf(y);
    pieces.push({ p: [PYLON_X, y, -hw], s: [hw * 2, 0.1, 0.1], c: C.steel });
    pieces.push({ p: [PYLON_X, y, hw], s: [hw * 2, 0.1, 0.1], c: C.steel });
    pieces.push({ p: [PYLON_X - hw, y, 0], s: [0.1, 0.1, hw * 2], c: C.steel });
    pieces.push({ p: [PYLON_X + hw, y, 0], s: [0.1, 0.1, hw * 2], c: C.steel });
  }
  // Diagonals. A unit box's long axis is +x; for the two faces whose normal is
  // +-z a roll about z aims it along the brace, and for the +-x faces a yaw of
  // 90 degrees first swings it into the z direction (Euler XYZ = Rx * Ry * Rz,
  // so the pitch applied afterwards tilts it inside that face).
  for (let k = 0; k < PYLON_STAGES; k++) {
    const y0 = k * STAGE_H;
    const y1 = y0 + STAGE_H;
    const hw = (pylonHalf(y0) + pylonHalf(y1)) / 2;
    const span = hw * 2;
    const len = Math.hypot(span, STAGE_H);
    const angle = Math.atan2(STAGE_H, span);
    const yMid = y0 + STAGE_H / 2;
    for (const sz of [-1, 1]) {
      for (const sign of [-1, 1]) {
        pieces.push({
          p: [PYLON_X, yMid, sz * hw],
          s: [len, 0.08, 0.07],
          r: [0, 0, sign * angle],
          c: C.steel,
        });
      }
    }
    for (const sx of [-1, 1]) {
      for (const sign of [-1, 1]) {
        pieces.push({
          p: [PYLON_X + sx * hw, yMid, 0],
          s: [len, 0.08, 0.07],
          r: [sign * angle, Math.PI / 2, 0],
          c: C.steel,
        });
      }
    }
  }
  // Cross arm + earth peak.
  pieces.push({ p: [PYLON_X, ARM_Y, 0], s: [0.18, 0.16, ARM_HALF * 2], c: C.steel });
  pieces.push({ p: [PYLON_X, ARM_Y - 0.5, 0], s: [0.12, 1, 0.12], c: C.steel });
  pieces.push({ p: [PYLON_X, PYLON_H + 0.45, 0], s: [0.1, 0.9, 0.1], c: C.steel });

  return pieces;
}

/**
 * Ceramics: the two tank bushings, which stand on whichever lid is in front of
 * them, plus the suspension bells at the arm tips.
 */
function buildCeramics(lidY: number): Piece[] {
  const pieces: Piece[] = [];
  for (const dx of [-0.5, 0.5]) {
    pieces.push({ p: [dx, lidY + 0.28, 0], s: [0.22, 0.44, 0.22] });
  }
  for (const sz of [-1, 1]) {
    pieces.push({ p: [PYLON_X, ARM_Y - 0.3, sz * ARM_HALF], s: [0.2, 0.44, 0.2] });
  }
  return pieces;
}

/**
 * A sagging span, as a Catmull-Rom through parabolically-drooped control
 * points -- close enough to a catenary at this scale, and it cannot cusp.
 */
function sagSpan(a: Vector3, b: Vector3, sag: number, samples = 20): Vector3[] {
  const control: Vector3[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const p = a.clone().lerp(b, t);
    p.y -= sag * (1 - (2 * t - 1) * (2 * t - 1));
    control.push(p);
  }
  return new CatmullRomCurve3(control, false, 'centripetal', 0.5).getPoints(samples);
}

/** Bare aluminium: the conductors' resting colour, dark against the sky. */
export const CONDUCTOR_IDLE = '#6b7280';

/** Both conductors as one segment soup, so the pair costs a single Line. */
function buildConductors(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const sz of [-1, 1]) {
    const z = sz * ARM_HALF;
    // Arm tip -> first span -> off the edge of the lot.
    const points = [
      ...sagSpan(
        new Vector3(PYLON_X, CONDUCTOR_Y, z),
        new Vector3(PYLON_X - 26, CONDUCTOR_Y + 0.4, z),
        2.6,
      ),
      ...sagSpan(
        new Vector3(PYLON_X - 26, CONDUCTOR_Y + 0.4, z),
        new Vector3(PYLON_X - 54, CONDUCTOR_Y + 1.6, z),
        2.4,
      ),
    ];
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i];
      const q = points[i + 1];
      out.push([p.x, p.y, p.z], [q.x, q.y, q.z]);
    }
  }
  return out;
}

/* The lot never changes shape, so it is laid out once at module scope rather
 * than memoised per instance. */
const PAD = buildPad();
const TANK = buildTank();
const TANK_STEEL = buildTankSteel();
const PYLON_STEEL = buildPylonSteel();
const CERAMICS = buildCeramics(PAD_H + TANK_H);
const CONDUCTORS = buildConductors();

/* -------------------------------------------------------------------------- */
/* The generated cabinet                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A pad-mount transformer out of the model pipeline: green-grey paint, louvred
 * door, finned radiator bank on the +z face and its own cast plinth, all in
 * COLOR_0. It stands on the procedural pad rather than replacing it, because
 * the pad is what the conduit run and the kerb are drawn against.
 *
 * Scaled to the brief's 2.2 m across and left at its own proportions from
 * there, which puts the lid at 1.52 m rather than the procedural 1.8 m -- so
 * the bushings are rebuilt onto whichever lid is actually underneath them.
 */
const CABINET_URL = '/models/transformer.glb';
const CABINET_FIT: GlbTransform = { width: 2.2, baseY: PAD_H };
/** The generator's green is dull under a sky HDRI; this is a small lift only. */
const CABINET_TINT = '#c8d2c6';

function GeneratedCabinet() {
  const { geometry, size } = useBakedGlb(CABINET_URL, CABINET_FIT);
  const ceramics = useMemo(() => buildCeramics(PAD_H + size.y), [size.y]);
  return (
    <>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial
          color={CABINET_TINT}
          vertexColors
          roughness={0.55}
          metalness={0}
        />
      </mesh>
      <Cylinders pieces={ceramics} radialSegments={10}>
        <meshStandardMaterial color="#d6d3d1" roughness={0.35} metalness={0.05} />
      </Cylinders>
    </>
  );
}

/** The bevelled tank, its louvres and placard, and the bushings on its lid. */
function ProceduralCabinet() {
  return (
    <>
      <RoundedBoxes pieces={TANK} radius={0.035}>
        <meshStandardMaterial color="#ffffff" {...MAT.paintedSteel} />
      </RoundedBoxes>
      <Boxes pieces={TANK_STEEL}>
        <meshStandardMaterial color="#ffffff" {...MAT.paintedSteel} />
      </Boxes>
      <Cylinders pieces={CERAMICS} radialSegments={10}>
        <meshStandardMaterial color="#d6d3d1" roughness={0.35} metalness={0.05} />
      </Cylinders>
    </>
  );
}

preloadGlb(CABINET_URL);

/* -------------------------------------------------------------------------- */
/* Residence: timber pole + can transformer + meter                            */
/* -------------------------------------------------------------------------- */

const POLE_H = 9;

/** Local space: the group sits on `anchorsFor('residence').grid`. */
function residenceLocal(world: readonly [number, number, number]): [number, number, number] {
  return [world[0] - RESIDENCE.pole[0], world[1], world[2] - RESIDENCE.pole[2]];
}

const POLE: Piece[] = [{ p: [0, POLE_H / 2, 0], s: [0.3, POLE_H, 0.3] }];

const POLE_METAL: Piece[] = (() => {
  const pieces: Piece[] = [];
  // Can transformer, strapped to the pole below the crossarm.
  pieces.push({ p: [0.42, 6.5, 0], s: [0.52, 0.72, 0.52], c: C.steel });
  pieces.push({ p: [0.42, 6.92, 0], s: [0.56, 0.08, 0.56], c: C.dark });
  // Pin insulators on the crossarm.
  for (const sz of [-1, 1]) {
    pieces.push({ p: [0, 7.98, sz * 0.62], s: [0.14, 0.18, 0.14], c: '#d6d3d1' });
  }
  // Meter dome.
  const meter = residenceLocal(RESIDENCE.meter);
  pieces.push({
    p: [meter[0] - 0.1, meter[1] + 0.06, meter[2]],
    s: [0.17, 0.06, 0.17],
    r: [0, 0, Math.PI / 2],
    c: C.glass,
  });
  return pieces;
})();

const POLE_BOXES: Piece[] = (() => {
  const meter = residenceLocal(RESIDENCE.meter);
  return [
    // Crossarm.
    { p: [0, 7.85, 0], s: [0.12, 0.1, 1.5], c: C.wood },
    { p: [0, 7.6, 0], s: [0.1, 0.42, 0.1], c: C.wood },
    // Meter box + its dark back plate, on the -x gable wall by the corner.
    { p: meter, s: [0.16, 0.44, 0.32], c: C.powder },
    { p: [meter[0] + 0.09, meter[1], meter[2]], s: [0.03, 0.5, 0.38], c: C.dark },
    // Service head on the gable, where the drop lands.
    {
      p: residenceLocal([RESIDENCE.eave[0] - 0.06, RESIDENCE.eave[1] - 0.15, RESIDENCE.eave[2]]),
      s: [0.1, 0.3, 0.1],
      c: C.dark,
    },
  ];
})();

/* -------------------------------------------------------------------------- */

export interface TransformerProps {
  type: BuildingType;
  position: readonly [number, number, number];
  gridKw: number;
  overThreshold: boolean;
  /**
   * What the span off the pylon should be showing. Like the conduits, this is a
   * target the material walks to over SETTLE_MS rather than a value that is
   * re-applied on render -- so an approved plan settles the whole grid channel,
   * conductors included, instead of cutting it.
   */
  conductorColor?: string;
}

export function Transformer({
  type,
  position,
  gridKw,
  overThreshold,
  conductorColor = CONDUCTOR_IDLE,
}: TransformerProps) {
  const residence = isResidence(type);
  const label = useMemo<[number, number, number]>(
    // On the pole, above the house's eave line and clear of the battery pill.
    () => (residence ? [1.2, 5.6, -0.6] : [0, 3.5, 0]),
    [residence],
  );

  /* The residence has no pylon, so these three do nothing on that lot -- but
     they are hooks, so they are called unconditionally all the same. */
  const conductors = useRef<ComponentRef<typeof Line>>(null);
  const conductorTarget = useMemo(() => new Color(conductorColor), [conductorColor]);
  const reduced = usePrefersReducedMotion();

  const seeded = useRef(false);
  useLayoutEffect(() => {
    const material = conductors.current?.material;
    if (!material || seeded.current) return;
    seeded.current = true;
    material.color.copy(conductorTarget);
  }, [conductorTarget]);

  useFrame((_, delta) => {
    const material = conductors.current?.material;
    if (!material) return;
    if (reduced) {
      material.color.copy(conductorTarget);
      return;
    }
    const alpha = settle(delta);
    if (alpha > 0) material.color.lerp(conductorTarget, alpha);
  });

  if (residence) {
    return (
      <group position={position as [number, number, number]}>
        <Cylinders pieces={POLE} radialSegments={10}>
          <meshStandardMaterial color={C.wood} {...MAT.timber} />
        </Cylinders>
        <Cylinders pieces={POLE_METAL} radialSegments={12}>
          <meshStandardMaterial color="#ffffff" {...MAT.paintedSteel} />
        </Cylinders>
        <Boxes pieces={POLE_BOXES}>
          <meshStandardMaterial color="#ffffff" {...MAT.powder} />
        </Boxes>
        <NodeLabel
          position={label}
          name="Grid"
          value={formatKw(gridKw)}
          valueColor={overThreshold ? C.alert : undefined}
        />
      </group>
    );
  }

  return (
    <group position={position as [number, number, number]}>
      <Boxes pieces={PAD}>
        <meshStandardMaterial color={C.concrete} {...MAT.concrete} />
      </Boxes>

      <GlbOrFallback src={CABINET_URL} fallback={<ProceduralCabinet />}>
        <GeneratedCabinet />
      </GlbOrFallback>

      <Boxes pieces={PYLON_STEEL}>
        <meshStandardMaterial color="#ffffff" {...MAT.paintedSteel} />
      </Boxes>

      {/* Never bright enough to bloom; its colour is walked in the frame loop. */}
      <Line
        ref={conductors}
        points={CONDUCTORS}
        segments
        lineWidth={1.4}
        transparent
        opacity={0.8}
      />

      <NodeLabel
        position={label}
        name="Grid"
        value={formatKw(gridKw)}
        valueColor={overThreshold ? C.alert : undefined}
      />
    </group>
  );
}

export default Transformer;
