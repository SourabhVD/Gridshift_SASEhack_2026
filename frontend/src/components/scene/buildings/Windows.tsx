'use client';

/**
 * One InstancedMesh holds every window pane of a building.
 *
 * Panes are thin boxes sitting 0.05 m proud of the facade. Colour is per
 * instance (`instanceColor`); emissive intensity is per material and follows
 * `hour`. See materials.ts for the colour model.
 */
import * as THREE from 'three';
import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  emissiveFromInstanceColor,
  panelColor,
  windowEmissiveIntensity,
} from './materials';

/** One window pane in building-local space. */
export interface Pane {
  /** Centre of the pane. */
  p: [number, number, number];
  /** Rotation about Y, so the pane lies flat against its wall. */
  ry: number;
  /** Pane width along the wall. */
  w: number;
  /** Pane height. */
  h: number;
}

/** Which way a wall faces. 'z+' is the front of the building. */
export type Facing = 'z+' | 'x+' | 'z-' | 'x-';

export const FACING_RY: Record<Facing, number> = {
  'z+': 0,
  'x+': Math.PI / 2,
  'z-': Math.PI,
  'x-': -Math.PI / 2,
};

/**
 * Maps a position along a wall (`u`, measured from the wall centre) plus the
 * wall's outward offset to a building-local xz position.
 */
function onWall(
  facing: Facing,
  cx: number,
  cz: number,
  dist: number,
  u: number,
): [number, number] {
  switch (facing) {
    case 'z+':
      return [cx + u, cz + dist];
    case 'x+':
      return [cx + dist, cz - u];
    case 'z-':
      return [cx - u, cz - dist];
    case 'x-':
      return [cx - dist, cz + u];
  }
}

export interface WallGridOptions {
  /** Which face of the mass the panes sit on. */
  facing: Facing;
  /** Centre of the mass in xz. */
  cx?: number;
  cz?: number;
  /** Distance from the mass centre out to the pane surface. */
  dist: number;
  /** Pane columns and the pitch between their centres. */
  cols: number;
  colPitch: number;
  /** Shifts the whole column run along the wall. */
  uOffset?: number;
  /** Pane rows: first centre height and the pitch between floors. */
  rows: number;
  y0: number;
  rowPitch: number;
  /** Pane size. */
  w: number;
  h: number;
}

/** Generates a regular grid of panes on one wall of one box mass. */
export function wallGrid(o: WallGridOptions): Pane[] {
  const panes: Pane[] = [];
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  const uOffset = o.uOffset ?? 0;
  const ry = FACING_RY[o.facing];
  const span = (o.cols - 1) * o.colPitch;
  for (let r = 0; r < o.rows; r++) {
    const y = o.y0 + r * o.rowPitch;
    for (let c = 0; c < o.cols; c++) {
      const u = uOffset - span / 2 + c * o.colPitch;
      const [x, z] = onWall(o.facing, cx, cz, o.dist, u);
      panes.push({ p: [x, y, z], ry, w: o.w, h: o.h });
    }
  }
  return panes;
}

/** Convenience: the same grid repeated on all four faces of a square-ish mass. */
export function wrapGrid(
  base: Omit<WallGridOptions, 'facing' | 'dist'>,
  dists: Record<Facing, number>,
  facings: Facing[] = ['z+', 'x+', 'z-', 'x-'],
): Pane[] {
  return facings.flatMap((facing) => wallGrid({ ...base, facing, dist: dists[facing] }));
}

/** Pane thickness. Panes stand 0.05 m proud of the wall they sit on. */
export const PANE_DEPTH = 0.05;

export interface WindowsProps {
  panes: Pane[];
  hour: number;
  loadRatio: number;
}

const scratchColor = new THREE.Color();
const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();

export function Windows({ panes, hour, loadRatio }: WindowsProps) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = panes.length;

  // Transforms only change when the pane list changes (i.e. building type).
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    for (let i = 0; i < count; i++) {
      const pane = panes[i];
      scratchPos.set(pane.p[0], pane.p[1], pane.p[2]);
      scratchEuler.set(0, pane.ry, 0);
      scratchQuat.setFromEuler(scratchEuler);
      scratchScale.set(pane.w, pane.h, 1);
      scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
      mesh.setMatrixAt(i, scratchMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [panes, count]);

  // Colours change with the timeline hour and the load ratio -- cheap enough to
  // redo on those prop changes, and never touched inside useFrame.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    for (let i = 0; i < count; i++) {
      panelColor(i, hour, loadRatio, scratchColor);
      mesh.setColorAt(i, scratchColor);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [count, hour, loadRatio]);

  const emissiveIntensity = useMemo(() => windowEmissiveIntensity(hour), [hour]);

  if (count === 0) return null;

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, count]}
      castShadow
      receiveShadow
      frustumCulled={false}
    >
      <boxGeometry args={[1, 1, PANE_DEPTH]} />
      <meshStandardMaterial
        color="#ffffff"
        emissive="#ffffff"
        emissiveIntensity={emissiveIntensity}
        metalness={0.15}
        roughness={0.3}
        onBeforeCompile={emissiveFromInstanceColor}
      />
    </instancedMesh>
  );
}

export default Windows;
