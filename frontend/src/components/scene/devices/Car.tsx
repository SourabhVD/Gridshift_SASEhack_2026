'use client';

/**
 * The car in a charging bay.
 *
 * There are two cars in here, and which one you see depends on whether
 * `/models/sedan.glb` arrives:
 *
 *   model        a generated sedan mesh -- 45 k triangles, vertex-coloured, no
 *                textures -- shared by every car on the lot and drawn as a
 *                single InstancedMesh
 *   procedural   a sedan lofted out of stacked rounded boxes, which is the
 *                `<Suspense>` fallback while the model is in flight and the
 *                permanent stand-in if it fails to load
 *
 * Both are authored nose toward -z, so cars parked nose-in present their tails
 * to the default camera at +z, and the charge port is on the rear left, which
 * is also the side the pedestals stand on. Every coordinate a caller passes --
 * `at`, `chargePort()`, the bay layout -- means the same thing for either one.
 *
 * ## The model, and what has to be done to it
 *
 * The file is a raw generator output: one mesh, POSITION and COLOR_0 and
 * nothing else. No normals, no UVs, no material. `bakeSedan` is what makes it
 * renderable -- it flattens the quantisation transform, turns it nose-first,
 * scales it to 4.75 m, drops the wheels onto y = 0 and computes the normals the
 * file never had. That runs once per page, not once per car.
 *
 * The baked-in vertex colours carry the paint, the glass and the tyres in one
 * attribute, which is what lets twelve cars share a draw call -- but it also
 * means a per-car paint can only ever *multiply* onto them. See `carTint`.
 *
 * ## Three ways in
 *
 * `<CarFleet>`   a whole commercial court: one InstancedMesh for every car.
 * `<Car>`        one car, rotatable -- what the residence drive uses.
 * `pushCar`      the procedural car's parts, appended to shared piece lists.
 *                Only the fallbacks reach for it now.
 */

import { Component, Suspense, useMemo, type ReactNode } from 'react';
import { Box3, BufferAttribute, BufferGeometry, Color, Mesh, Vector3 } from 'three';
import { useGLTF } from '@react-three/drei';
import { C, CAR_PAINTS, MAT } from './common';
import { Boxes, Clones, Cylinders, RoundedBoxes, type Piece } from './Instanced';

/** The procedural car's envelope. The model is a little longer; see MODEL_LENGTH. */
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
/* The model                                                                   */
/* -------------------------------------------------------------------------- */

export const MODEL_URL = '/models/sedan.glb';

/** Overall length the model is scaled to. A mid-size sedan, in metres. */
const MODEL_LENGTH = 4.75;

/**
 * Multiplied onto the model's baked vertex colours, which average a flat
 * neutral grey. This gives the silver a cool cast without taking the albedo
 * outside the [#141414, #f2f2f2] band the tone mapper is happy with, and it
 * stays far below the 1.05 bloom cut -- a parked car never glows.
 */
const MODEL_TINT = '#d9dde3';

/** A car in a bay that is not drawing, echoing the procedural car's half-shade. */
const IDLE_DIM = 0.72;

const TINT_CACHE = new Map<string, Color>();

/**
 * A palette paint reduced to its hue, at unit brightness.
 *
 * The model carries its own light and shade in COLOR_0, so a paint can only
 * multiply onto it -- and `#5f6670` used raw would take a mid-grey panel down
 * to near-black. Dividing by the paint's brightest channel throws the
 * brightness away and keeps the cast, which is what turns four palette entries
 * into four believable silvers instead of one silver and three charcoals.
 */
export function carTint(paint: string, active = true): Color {
  const key = paint + (active ? '|on' : '|off');
  let tint = TINT_CACHE.get(key);
  if (!tint) {
    tint = new Color(paint);
    const peak = Math.max(tint.r, tint.g, tint.b, 1e-4);
    tint.multiplyScalar((active ? 1 : IDLE_DIM) / peak);
    TINT_CACHE.set(key, tint);
  }
  return tint;
}

const BODY_CACHE = new Map<string, Color>();

/** `MODEL_TINT` and one paint's cast folded together, for a car drawn on its own. */
function bodyColor(paint: string): Color {
  let color = BODY_CACHE.get(paint);
  if (!color) {
    color = new Color(MODEL_TINT).multiply(carTint(paint));
    BODY_CACHE.set(paint, color);
  }
  return color;
}

const BAKE_CACHE = new WeakMap<Mesh, BufferGeometry>();

function boundsOf(geometry: BufferGeometry): Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox ?? new Box3();
}

/**
 * The loaded mesh, turned into something this scene can park in a bay.
 *
 * Nothing here can be done in place. `EXT_meshopt_compression` leaves POSITION
 * as normalised int16 and pushes the dequantisation into the node's scale, so
 * writing a metre-scale float back into that attribute would clamp it to the
 * unit cube; the positions are read out through the node's world matrix into a
 * fresh float buffer instead. COLOR_0 is copied across the same way, minus its
 * (always opaque) alpha, so the material never opts into `USE_COLOR_ALPHA`.
 *
 * After that: nose from +z to -z, centre, scale to MODEL_LENGTH, lift the
 * wheels onto y = 0, and compute the normals the generator never wrote. The
 * result is authored exactly like `pushCar`'s output -- origin at the car's
 * ground-level centre -- so the two are interchangeable at every call site.
 */
function bakeSedan(mesh: Mesh): BufferGeometry {
  const hit = BAKE_CACHE.get(mesh);
  if (hit) return hit;

  mesh.updateWorldMatrix(true, false);
  const source = mesh.geometry;
  const position = source.getAttribute('position');
  const color = source.getAttribute('color');

  const geometry = new BufferGeometry();

  const xyz = new Float32Array(position.count * 3);
  const vertex = new Vector3();
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    vertex.toArray(xyz, i * 3);
  }
  geometry.setAttribute('position', new BufferAttribute(xyz, 3));

  if (color) {
    const rgb = new Float32Array(color.count * 3);
    for (let i = 0; i < color.count; i++) {
      rgb[i * 3] = color.getX(i);
      rgb[i * 3 + 1] = color.getY(i);
      rgb[i * 3 + 2] = color.getZ(i);
    }
    geometry.setAttribute('color', new BufferAttribute(rgb, 3));
  }
  if (source.index) geometry.setIndex(source.index.clone());

  // The generator faces the car down +z; every bay in this folder parks one
  // nose toward -z, so the half turn is baked once instead of per instance.
  geometry.rotateY(Math.PI);
  geometry.center();

  const raw = boundsOf(geometry);
  const scale = MODEL_LENGTH / Math.max(raw.max.z - raw.min.z, 1e-6);
  geometry.scale(scale, scale, scale);
  geometry.translate(0, -boundsOf(geometry).min.y, 0);

  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  BAKE_CACHE.set(mesh, geometry);
  return geometry;
}

/** Suspends until the model is in, then hands back the one shared geometry. */
function useSedanGeometry(): BufferGeometry {
  // useDraco false: nothing in this file is Draco, and leaving it on would have
  // drei reach for a decoder on a Google CDN. Meshopt's decoder ships in three.
  const { scene } = useGLTF(MODEL_URL, false, true);
  return useMemo(() => {
    const mesh = scene.getObjectByProperty('isMesh', true) as Mesh | undefined;
    if (!mesh) throw new Error(MODEL_URL + ' has no mesh');
    return bakeSedan(mesh);
  }, [scene]);
}

/**
 * Clearcoated paint over the baked vertex colours.
 *
 * The glazing and the tyres are in COLOR_0 too, so they take the paint's
 * roughness. At the size a car is ever seen here that reads as tinted glass
 * rather than as a mistake, and it is what buys twelve cars in one draw call.
 */
function SedanMaterial({ color }: { color: Color | string }) {
  return (
    <meshPhysicalMaterial
      color={color}
      vertexColors
      roughness={0.32}
      metalness={0.75}
      clearcoat={1}
      clearcoatRoughness={0.08}
      envMapIntensity={1}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Fallback                                                                    */
/* -------------------------------------------------------------------------- */

interface BoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

/**
 * Swaps in the procedural car when the model cannot be had.
 *
 * `useGLTF` reports a failed fetch by throwing out of render, and Suspense only
 * catches the promise, not the error -- so without this a missing or corrupt
 * `sedan.glb` would take the whole Canvas down instead of one prop. There is no
 * retry: if the file is not there on the first paint it will not be there on
 * the second, and a scene that quietly draws boxes is the right outcome.
 */
class ModelBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[scene] ' + MODEL_URL + ' did not load; drawing the procedural car', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Error boundary outside, Suspense inside: one stand-in serves both. */
function WithFallback({ fallback, children }: BoundaryProps) {
  return (
    <ModelBoundary fallback={fallback}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ModelBoundary>
  );
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
   * lenses into.
   */
  withLamps?: boolean;
}

/** The five clusters a procedural car's parts fall into. */
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

/* --- a court's worth of cars ---------------------------------------------- */

/** One car in a court. Axis-aligned, nose toward -z, like every bay. */
export interface CarPlacement {
  /** Ground-level centre, in the fleet group's space. */
  at: readonly [number, number, number];
  /** Index into `CAR_PAINTS`; the bay number does fine. */
  paint: number;
  /** False dims the car, the way an idle bay's car has always been dimmed. */
  active?: boolean;
}

/** The instance scale. Unit, because the model is already baked to metres. */
const UNIT: readonly [number, number, number] = [1, 1, 1];

function GltfFleet({ placements }: { placements: readonly CarPlacement[] }) {
  const geometry = useSedanGeometry();
  const pieces = useMemo<Piece[]>(
    () =>
      placements.map((car) => ({
        p: car.at,
        s: UNIT,
        // Per instance, so a whole court still costs one draw call: three
        // multiplies instanceColor, COLOR_0 and material.color together.
        c: carTint(CAR_PAINTS[car.paint % CAR_PAINTS.length], car.active ?? true),
      })),
    [placements],
  );
  return (
    <Clones geometry={geometry} pieces={pieces}>
      <SedanMaterial color={MODEL_TINT} />
    </Clones>
  );
}

function ProceduralFleet({ placements }: { placements: readonly CarPlacement[] }) {
  const pieces = useMemo(() => {
    const out = emptyCarPieces();
    for (const car of placements) {
      pushCar(out, { at: car.at, color: carPaint(car.paint, car.active ?? true) });
    }
    return out;
  }, [placements]);
  return <CarClusters pieces={pieces} />;
}

/**
 * Every car on a commercial court.
 *
 * One InstancedMesh over the shared model geometry: twelve cars, one draw call,
 * and the per-bay paint rides in `instanceColor`. The fallback is the same
 * twelve cars as stacked boxes, which costs five.
 */
export function CarFleet({ placements }: { placements: readonly CarPlacement[] }) {
  return (
    <WithFallback fallback={<ProceduralFleet placements={placements} />}>
      <GltfFleet placements={placements} />
    </WithFallback>
  );
}

/* --- one car -------------------------------------------------------------- */

export interface CarProps {
  position: readonly [number, number, number];
  /** Euler XYZ radians, applied to the whole car. */
  rotation?: readonly [number, number, number];
  color?: string;
}

function GltfCar({ color }: { color: string }) {
  const geometry = useSedanGeometry();
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <SedanMaterial color={bodyColor(color)} />
    </mesh>
  );
}

/** One car, at a position and a yaw of the caller's choosing. */
export function Car({ position, rotation, color = C.carPaint }: CarProps) {
  return (
    <group
      position={position as [number, number, number]}
      rotation={rotation as [number, number, number] | undefined}
    >
      <WithFallback fallback={<ProceduralCar color={color} />}>
        <GltfCar color={color} />
      </WithFallback>
    </group>
  );
}

/** The stand-in model: one car's worth of pieces at the group origin. */
export function ProceduralCar({ color }: { color: string }) {
  const pieces = emptyCarPieces();
  pushCar(pieces, { at: [0, 0, 0], color });
  return <CarClusters pieces={pieces} />;
}

/* Warms the cache before anything mounts, so the model is in hand on the first
 * paint rather than a frame of boxes. `EnergyScene` is a
 * `dynamic(..., { ssr: false })` import, but the guard keeps this honest for
 * anything that imports the folder directly. */
if (typeof window !== 'undefined') useGLTF.preload(MODEL_URL, false, true);

export default Car;
