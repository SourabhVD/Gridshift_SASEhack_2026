'use client';

/**
 * Two tiny instancing primitives that every prop in this module is built from.
 *
 * A stylized transformer is ~50 boxes and a car park is ~150; drawing those as
 * individual meshes would blow the draw-call budget on its own. `Boxes` and
 * `Cylinders` collapse an arbitrary list of positioned/rotated/scaled pieces
 * into ONE InstancedMesh, so a whole prop costs one draw call per material.
 *
 * The base geometries are unit-sized (a 1x1x1 box, a diameter-1 height-1
 * cylinder) so `s` reads as metres directly.
 */

import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Color, InstancedMesh, Object3D } from 'three';

export interface Piece {
  /** Centre position, metres. */
  p: readonly [number, number, number];
  /** Size in metres (box) or [diameter, height, diameter] (cylinder). */
  s: readonly [number, number, number];
  /** Euler XYZ radians. */
  r?: readonly [number, number, number];
  /** Per-instance tint. Leave the material white if you use this. */
  c?: string;
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

export interface CylinderClusterProps extends ClusterProps {
  /** Low-poly on purpose: 8 reads as faceted, 12 as round. */
  radialSegments?: number;
}

/** One InstancedMesh of unit cylinders (diameter 1, height 1, axis +Y). */
export function Cylinders({
  pieces,
  children,
  radialSegments = 10,
  castShadow = true,
  receiveShadow = true,
}: CylinderClusterProps) {
  const ref = useRef<InstancedMesh>(null);
  useWritePieces(ref, pieces);
  const count = Math.max(1, pieces.length);
  const args = useMemo(
    () => [0.5, 0.5, 1, radialSegments] as [number, number, number, number],
    [radialSegments],
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
