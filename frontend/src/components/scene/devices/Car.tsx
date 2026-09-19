'use client';

/**
 * The car in a charging bay.
 *
 * A procedural sedan lofted out of stacked rounded boxes: a lower body, a
 * beltline that oversails it, a narrower tapered greenhouse, and a bonnet and
 * boot lid pitched a few degrees off level. Wheel arches are implied by dark
 * inner drums, the wheels themselves are a rubber tyre plus a dark disc and a
 * light rim ring, and the glass is the same near-black reflective material the
 * rest of the folder uses.
 *
 * The car is authored nose toward -z, so cars parked nose-in present their
 * tails to the default camera at +z. Its charge port is on the rear left, which
 * is also the side the pedestals stand on.
 *
 * ## Two ways in, on purpose
 *
 * `pushCar` appends one car's parts into shared piece lists, so a twelve-bay
 * court draws every car in five InstancedMeshes instead of sixty. `<Car>`
 * renders a single car from those same lists and is what the residence drive
 * uses -- and it is the seam a real model drops into:
 *
 *     const { scene } = useGLTF('/models/sedan.glb')
 *
 * would go behind a `<Suspense fallback={<ProceduralCar .../>}>` inside `Car`,
 * leaving every call site and every coordinate below unchanged.
 */

import { Color } from 'three';
import { C, CAR_PAINTS, MAT } from './common';
import { Boxes, Cylinders, RoundedBoxes, type Piece } from './Instanced';

export const CAR_LENGTH = 4.5;
export const CAR_WIDTH = 1.9;

/** Rear-left charge port, in the car's own space. */
const PORT_LOCAL: readonly [number, number, number] = [-0.94, 0.86, 1.55];

const DIM = new Color();
/** Scales a paint toward black: 0.5 for a car in an idle bay. */
export function shade(hex: string, factor: number): string {
  return '#' + DIM.set(hex).multiplyScalar(factor).getHexString();
}

/** Paint for bay `i`, dimmed when that bay is not drawing power. */
export function carPaint(index: number, active: boolean): string {
  const base = CAR_PAINTS[index % CAR_PAINTS.length];
  return active ? base : shade(base, 0.5);
}

/* -------------------------------------------------------------------------- */
/* Piece lists                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One bucket per material, which is one InstancedMesh, which is one draw call.
 *
 * The black sill, grille and port flap ride in `paint` rather than earning a
 * cluster of their own: gloss-black cladding under the same clearcoat is what
 * they would be on a real car anyway.
 */
export interface CarPieces {
  /** Clearcoated body panels, plus the gloss-black trim. Rounded boxes. */
  paint: Piece[];
  /** Screens and side glass. Boxes. */
  glass: Piece[];
  /** Arch drums, tyres and hub discs. Cylinders. */
  wheel: Piece[];
  /** Rim rings. Cylinders. */
  rim: Piece[];
  /** Lamp lenses. Unlit and *below* the bloom threshold: a parked car does not glow. */
  lamp: Piece[];
}

export function emptyCarPieces(): CarPieces {
  return { paint: [], glass: [], wheel: [], rim: [], lamp: [] };
}

export interface CarOptions {
  /** Ground-level centre of the car, in the parent group's space. */
  at: readonly [number, number, number];
  color: string;
}

/**
 * Appends one car to `out`. Axis-aligned by design -- a per-car yaw would have
 * to compose with the pitched bonnet and boot, which a flat Euler cannot do;
 * rotate a whole `<Car>` group instead when a lot needs one turned.
 */
export function pushCar(out: CarPieces, { at, color }: CarOptions): void {
  const [x, y, z] = at;
  const roof = shade(color, 0.62);

  /* --- body: four stacked volumes + two pitched lids --------------------- */
  out.paint.push(
    // Lower body.
    { p: [x, y + 0.68, z], s: [1.84, 0.62, 4.3], c: color },
    // Beltline, wider so the shoulder catches a highlight -- but it stops short
    // of both ends, so the bonnet and boot lids are what you actually see on
    // top there. Run it the full length and the car reads as a pickup.
    { p: [x, y + 1.05, z + 0.1], s: [1.9, 0.26, 3], c: color },
    // Bonnet, dropping toward the nose at -z.
    { p: [x, y + 1.02, z - 1.62], s: [1.74, 0.16, 1.5], r: [-0.09, 0, 0], c: color },
    // Boot lid, dropping toward the tail at +z.
    { p: [x, y + 1.08, z + 1.72], s: [1.74, 0.15, 1.05], r: [0.06, 0, 0], c: color },
    // Greenhouse: narrower, shorter and set back.
    { p: [x, y + 1.4, z + 0.15], s: [1.5, 0.44, 1.85], c: color },
    // Roof, narrower again so a lip runs down each side.
    { p: [x, y + 1.6, z + 0.17], s: [1.32, 0.08, 1.5], c: roof },
    // Gloss-black sill, grille and charge-port flap.
    { p: [x, y + 0.3, z], s: [1.88, 0.16, 3.6], c: C.rubber },
    { p: [x, y + 0.72, z - 2.14], s: [1.02, 0.16, 0.06], c: C.rubber },
    {
      p: [x + PORT_LOCAL[0], y + PORT_LOCAL[1], z + PORT_LOCAL[2]],
      s: [0.04, 0.14, 0.2],
      c: C.rubber,
    },
  );

  /* --- glazing ----------------------------------------------------------- */
  out.glass.push(
    // Windscreen, raked back.
    { p: [x, y + 1.4, z - 0.66], s: [1.42, 0.5, 0.05], r: [0.4, 0, 0] },
    // Backlight.
    { p: [x, y + 1.42, z + 0.98], s: [1.42, 0.44, 0.05], r: [-0.34, 0, 0] },
    // Side glass, a hair proud of the greenhouse so it reads as glazing.
    { p: [x - 0.755, y + 1.42, z + 0.15], s: [0.05, 0.3, 1.6] },
    { p: [x + 0.755, y + 1.42, z + 0.15], s: [0.05, 0.3, 1.6] },
  );

  /* --- wheels: arch drum, tyre, hub disc, rim ring ----------------------- */
  const FLAT_X: readonly [number, number, number] = [0, 0, Math.PI / 2];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wz = z + sz * 1.38;
      // Arch drum, inboard of the tyre: reads as the shadow inside an arch.
      out.wheel.push({ p: [x + sx * 0.78, y + 0.46, wz], s: [0.98, 0.3, 0.98], r: FLAT_X });
      out.wheel.push({ p: [x + sx * 0.95, y + 0.37, wz], s: [0.74, 0.25, 0.74], r: FLAT_X });
      out.wheel.push({ p: [x + sx * 1.045, y + 0.37, wz], s: [0.56, 0.02, 0.56], r: FLAT_X });
      out.rim.push({ p: [x + sx * 1.06, y + 0.37, wz], s: [0.46, 0.05, 0.46], r: FLAT_X });
    }
  }

  /* --- lamps ------------------------------------------------------------- */
  for (const sx of [-1, 1]) {
    out.lamp.push({ p: [x + sx * 0.62, y + 0.95, z - 2.17], s: [0.32, 0.1, 0.04], c: C.headLamp });
    out.lamp.push({ p: [x + sx * 0.62, y + 1.02, z + 2.17], s: [0.36, 0.08, 0.04], c: C.tailLamp });
  }
}

/** Where a charging lead has to reach, for a car placed at `at` and yawed `yaw`. */
export function chargePort(
  at: readonly [number, number, number],
  yaw = 0,
): [number, number, number] {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const [px, py, pz] = PORT_LOCAL;
  return [at[0] + px * cos + pz * sin, at[1] + py, at[2] - px * sin + pz * cos];
}

/* -------------------------------------------------------------------------- */
/* Components                                                                  */
/* -------------------------------------------------------------------------- */

export interface CarClustersProps {
  pieces: CarPieces;
  /**
   * Set false when the caller already has an unlit cluster to fold the lamp
   * lenses into -- the charging court puts them in with the pedestal screens
   * and saves a draw call across twelve cars.
   */
  withLamps?: boolean;
}

/** The five clusters a car's parts fall into. Shared by `<Car>` and `<EvBays>`. */
export function CarClusters({ pieces, withLamps = true }: CarClustersProps) {
  return (
    <>
      <RoundedBoxes pieces={pieces.paint} radius={0.035}>
        <meshPhysicalMaterial
          color="#ffffff"
          {...MAT.carPaint}
          clearcoat={1}
          clearcoatRoughness={0.08}
        />
      </RoundedBoxes>
      <Boxes pieces={pieces.glass} castShadow={false}>
        <meshStandardMaterial color={C.glass} {...MAT.glass} />
      </Boxes>
      <Cylinders pieces={pieces.wheel} radialSegments={14}>
        <meshStandardMaterial color={C.rubber} {...MAT.rubber} />
      </Cylinders>
      <Cylinders pieces={pieces.rim} radialSegments={14}>
        <meshStandardMaterial color="#b9bdc4" roughness={0.35} metalness={0.8} />
      </Cylinders>
      {withLamps ? (
        <Boxes pieces={pieces.lamp} castShadow={false}>
          {/* Untonemapped for a clean lens, but the colours stay under 1.0 so a
              parked car never blooms -- only live kit is allowed to. */}
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </Boxes>
      ) : null}
    </>
  );
}

export interface CarProps {
  position: readonly [number, number, number];
  /** Euler XYZ radians, applied to the whole car. */
  rotation?: readonly [number, number, number];
  color?: string;
}

/**
 * One car.
 *
 * TODO(models): when `/models/sedan.glb` lands, this becomes
 *
 *     <Suspense fallback={<ProceduralCar color={color} />}>
 *       <GltfCar color={color} />   // useGLTF('/models/sedan.glb')
 *     </Suspense>
 *
 * and nothing else in the folder has to move: the group transform, the
 * `chargePort()` offset and the bay layout all live outside the model.
 */
export function Car({ position, rotation, color = C.carPaint }: CarProps) {
  return (
    <group
      position={position as [number, number, number]}
      rotation={rotation as [number, number, number] | undefined}
    >
      <ProceduralCar color={color} />
    </group>
  );
}

/** The stand-in model: one car's worth of pieces at the group origin. */
export function ProceduralCar({ color }: { color: string }) {
  const pieces = emptyCarPieces();
  pushCar(pieces, { at: [0, 0, 0], color });
  return <CarClusters pieces={pieces} />;
}

export default Car;
