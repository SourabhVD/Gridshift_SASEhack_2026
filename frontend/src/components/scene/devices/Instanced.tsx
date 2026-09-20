'use client';

/**
 * The instancing primitives every prop in this module is built from.
 *
 * A charging court is ~200 pieces and the pylon alone is ~90; drawing those as
 * individual meshes would blow the draw-call budget on its own. `Boxes`,
 * `RoundedBoxes`, `Cylinders` and `Clones` each collapse an arbitrary list of
 * positioned/rotated/scaled pieces into ONE InstancedMesh, so a whole prop costs
 * one draw call per *material*, not per part.
 *
 * That is also why the props group their geometry by material rather than by
 * object: all the powder-coated white in a lot is one cluster, all the rubber is
 * another. It keeps the physically-plausible material story honest -- two things
 * that claim to be the same material share the same material object -- and it is
 * what keeps the whole folder inside 32 draw calls.
 *
 * The base geometries are unit-sized (a 1x1x1 box, a diameter-1 height-1
 * cylinder) so `s` reads as metres directly.
 */

import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  type BufferGeometry,
  Color,
  ExtrudeGeometry,
  InstancedMesh,
  Object3D,
  Shape,
} from 'three';

export interface Piece {
  /** Centre position, metres. */
  p: readonly [number, number, number];
  /** Size in metres (box) or [diameter, height, diameter] (cylinder). */
  s: readonly [number, number, number];
  /** Euler XYZ radians. */
  r?: readonly [number, number, number];
  /**
   * Per-instance tint. Leave the material white if you use this.
   *
   * A `Color` is copied raw, so a value from `glow()` keeps its >1 components
   * and blooms; a hex string goes through the usual sRGB -> linear conversion.
   */
  c?: string | Color;
}

/* Module-scope scratch: instance writes happen in layout effects, never
 * concurrently, so a single temporary is safe and allocates nothing. */
const SCRATCH = new Object3D();
const TINT = new Color();

function useWritePieces(ref: React.RefObject<InstancedMesh | null>, pieces: readonly Piece[]) {
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const tinted = pieces.some((piece) => piece.c !== undefined);
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      SCRATCH.position.set(piece.p[0], piece.p[1], piece.p[2]);
      SCRATCH.rotation.set(piece.r?.[0] ?? 0, piece.r?.[1] ?? 0, piece.r?.[2] ?? 0);
      SCRATCH.scale.set(piece.s[0], piece.s[1], piece.s[2]);
      SCRATCH.updateMatrix();
      mesh.setMatrixAt(i, SCRATCH.matrix);
      if (tinted) mesh.setColorAt(i, TINT.set(piece.c ?? '#ffffff'));
    }
    mesh.count = pieces.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [ref, pieces]);
}

export interface ClusterProps {
  pieces: readonly Piece[];
  /** The material element. One cluster = one material = one draw call. */
  children: ReactNode;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** One InstancedMesh of unit boxes. */
export function Boxes({ pieces, children, castShadow = true, receiveShadow = true }: ClusterProps) {
  const ref = useRef<InstancedMesh>(null);
  useWritePieces(ref, pieces);
  // `args` is only re-evaluated when the count changes, which recreates the
  // mesh -- that happens on a building/flow change, never per frame.
  const count = Math.max(1, pieces.length);
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, count]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      <boxGeometry args={[1, 1, 1]} />
      {children}
    </instancedMesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Rounded boxes                                                               */
/* -------------------------------------------------------------------------- */

const EPS = 0.00001;

/**
 * drei's `<RoundedBox>` recipe, but as a plain geometry so it can be instanced.
 *
 * The result is a *unit* rounded box: 1 x 1 x 1 with a `radius` fillet, centred
 * on the origin. Because each instance then applies its own non-uniform scale,
 * the fillet scales with it -- a 3 m wide cabinet built from `radius 0.02` ends
 * up with a 60 mm horizontal and a 24 mm vertical bevel. That anisotropy is
 * invisible at the sizes used here and it is what buys one draw call for a
 * dozen bevelled objects; pick `radius` per cluster to land the shortest axis
 * somewhere in the 30-80 mm band.
 */
const ROUNDED_CACHE = new Map<number, ExtrudeGeometry>();

function unitRoundedBox(radius: number): ExtrudeGeometry {
  const key = Math.round(radius * 1000);
  const hit = ROUNDED_CACHE.get(key);
  if (hit) return hit;

  const r = radius - EPS;
  const shape = new Shape();
  shape.absarc(EPS, EPS, EPS, -Math.PI / 2, -Math.PI, true);
  shape.absarc(EPS, 1 - r * 2, EPS, Math.PI, Math.PI / 2, true);
  shape.absarc(1 - r * 2, 1 - r * 2, EPS, Math.PI / 2, 0, true);
  shape.absarc(1 - r * 2, EPS, EPS, 0, -Math.PI / 2, true);

  const geometry = new ExtrudeGeometry(shape, {
    depth: 1 - radius * 2,
    bevelEnabled: true,
    bevelSegments: 3,
    steps: 1,
    bevelSize: r,
    bevelThickness: radius,
    curveSegments: 2,
  });
  geometry.center();
  ROUNDED_CACHE.set(key, geometry);
  return geometry;
}

export interface RoundedClusterProps extends ClusterProps {
  /** Fillet in *unit* space; multiply by a piece's size to get metres. */
  radius?: number;
}

/**
 * One InstancedMesh of unit rounded boxes -- the workhorse for anything with a
 * machined edge: cabinets, pedestals, wall units, car bodies.
 */
export function RoundedBoxes({
  pieces,
  children,
  radius = 0.03,
  castShadow = true,
  receiveShadow = true,
}: RoundedClusterProps) {
  const ref = useRef<InstancedMesh>(null);
  useWritePieces(ref, pieces);
  const geometry = useMemo(() => unitRoundedBox(radius), [radius]);
  const count = Math.max(1, pieces.length);
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, count]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      {/* Cached at module scope and shared between clusters, so never disposed. */}
      <primitive object={geometry} attach="geometry" dispose={null} />
      {children}
    </instancedMesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Cylinders                                                                   */
/* -------------------------------------------------------------------------- */

export interface CylinderClusterProps extends ClusterProps {
  /** Low-poly on purpose: 8 reads as faceted, 16 as round. */
  radialSegments?: number;
  /** Open-ended cylinders make usable fan guards and rings. */
  openEnded?: boolean;
}

/** One InstancedMesh of unit cylinders (diameter 1, height 1, axis +Y). */
export function Cylinders({
  pieces,
  children,
  radialSegments = 12,
  openEnded = false,
  castShadow = true,
  receiveShadow = true,
}: CylinderClusterProps) {
  const ref = useRef<InstancedMesh>(null);
  useWritePieces(ref, pieces);
  const count = Math.max(1, pieces.length);
  const args = useMemo(
    () => [0.5, 0.5, 1, radialSegments, 1, openEnded] as [number, number, number, number, number, boolean],
    [radialSegments, openEnded],
  );
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, count]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      <cylinderGeometry args={args} />
      {children}
    </instancedMesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Arbitrary geometry                                                          */
/* -------------------------------------------------------------------------- */

export interface ClonesProps extends ClusterProps {
  /**
   * Any geometry, authored at its real size around the origin. The caller owns
   * it (build it in a `useMemo`, dispose it in an effect); this component never
   * disposes it, so one geometry can back several clusters.
   */
  geometry: BufferGeometry;
}

/**
 * The same instancing deal for a geometry we had to build ourselves -- the
 * coiled charging leads are one extruded helix repeated per live bay.
 */
export function Clones({
  geometry,
  pieces,
  children,
  castShadow = true,
  receiveShadow = true,
}: ClonesProps) {
  const ref = useRef<InstancedMesh>(null);
  useWritePieces(ref, pieces);
  const count = Math.max(1, pieces.length);
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, count]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      <primitive object={geometry} attach="geometry" dispose={null} />
      {children}
    </instancedMesh>
  );
}
