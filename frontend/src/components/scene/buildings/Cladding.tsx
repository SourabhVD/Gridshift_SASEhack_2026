'use client';

/**
 * Textured wall shell for the residence.
 *
 * The other three buildings get their facade texture from geometry -- mullions,
 * corrugation strips, spandrel bands -- because at 16 to 40 m across, a tiling
 * bitmap reads as noise. A 14 m house is close enough to the camera that the
 * grain has to be real, so its walls are one custom BufferGeometry carrying
 * per-face UVs in metres, wrapped in a CC0 cedar-plank set.
 *
 * Authoring the UVs by hand (rather than using a BoxGeometry) is the whole
 * point: a box's UVs are 0..1 per face, so a 14 x 6 m wall and a 10 x 6 m wall
 * would stretch the same tile by different amounts. Here `u` and `v` are both
 * "metres / TILE_M", so one plank is the same width on every facade and on the
 * gable triangles, and the four walls plus both gables stay in ONE draw call.
 *
 * Board joints are still geometry: `boardSeams()` returns the thin proud strips
 * that catch a highlight along every plank edge. The bitmap carries the grain,
 * the strips carry the relief.
 */

import * as THREE from 'three';
import { useEffect, useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import type { BoxInstance } from './Common';

/** Metres of wall per texture tile. The source is ~1.1 m of cedar planking. */
export const TILE_M = 1.1;

const CEDAR_URLS = {
  map: '/textures/cedar/diff.jpg',
  normalMap: '/textures/cedar/normal.jpg',
  roughnessMap: '/textures/cedar/rough.jpg',
} as const;

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

type Vec3 = [number, number, number];
/** A corner: world position plus its (across, up) position on the wall, in metres. */
interface Corner {
  p: Vec3;
  u: number;
  v: number;
}

function pushTri(
  pos: number[],
  nor: number[],
  uv: number[],
  n: Vec3,
  a: Corner,
  b: Corner,
  c: Corner,
): void {
  for (const corner of [a, b, c]) {
    pos.push(corner.p[0], corner.p[1], corner.p[2]);
    nor.push(n[0], n[1], n[2]);
    uv.push(corner.u / TILE_M, corner.v / TILE_M);
  }
}

/** Splits a quad (given counter-clockwise from outside) into two triangles. */
function pushQuad(
  pos: number[],
  nor: number[],
  uv: number[],
  n: Vec3,
  q: [Corner, Corner, Corner, Corner],
): void {
  pushTri(pos, nor, uv, n, q[0], q[1], q[2]);
  pushTri(pos, nor, uv, n, q[0], q[2], q[3]);
}

export interface WallShellSpec {
  /** Half-width along x, out to the cladding surface. */
  hx: number;
  /** Half-depth along z, out to the cladding surface. */
  hz: number;
  /** Bottom of the cladding (top of the plinth). */
  y0: number;
  /** Eaves: top of the four rectangular walls. */
  y1: number;
  /** Ridge height, the apex of the two gable triangles. */
  ridge: number;
}

/**
 * Four rectangular walls plus the two gable triangles, as one non-indexed
 * BufferGeometry with outward normals and metre-scaled UVs.
 */
export function buildWallShell(s: WallShellSpec): THREE.BufferGeometry {
  const { hx, hz, y0, y1, ridge } = s;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const h = y1 - y0;

  // +z (front)
  pushQuad(pos, nor, uv, [0, 0, 1], [
    { p: [-hx, y0, hz], u: 0, v: 0 },
    { p: [hx, y0, hz], u: 2 * hx, v: 0 },
    { p: [hx, y1, hz], u: 2 * hx, v: h },
    { p: [-hx, y1, hz], u: 0, v: h },
  ]);
  // -z (back)
  pushQuad(pos, nor, uv, [0, 0, -1], [
    { p: [hx, y0, -hz], u: 0, v: 0 },
    { p: [-hx, y0, -hz], u: 2 * hx, v: 0 },
    { p: [-hx, y1, -hz], u: 2 * hx, v: h },
    { p: [hx, y1, -hz], u: 0, v: h },
  ]);
  // +x (gable end, right)
  pushQuad(pos, nor, uv, [1, 0, 0], [
    { p: [hx, y0, hz], u: 0, v: 0 },
    { p: [hx, y0, -hz], u: 2 * hz, v: 0 },
    { p: [hx, y1, -hz], u: 2 * hz, v: h },
    { p: [hx, y1, hz], u: 0, v: h },
  ]);
  // -x (gable end, left -- the battery wall)
  pushQuad(pos, nor, uv, [-1, 0, 0], [
    { p: [-hx, y0, -hz], u: 0, v: 0 },
    { p: [-hx, y0, hz], u: 2 * hz, v: 0 },
    { p: [-hx, y1, hz], u: 2 * hz, v: h },
    { p: [-hx, y1, -hz], u: 0, v: h },
  ]);
  // gable triangles, continuing the same UV run up past the eaves
  pushTri(pos, nor, uv, [1, 0, 0],
    { p: [hx, y1, hz], u: 0, v: h },
    { p: [hx, y1, -hz], u: 2 * hz, v: h },
    { p: [hx, ridge, 0], u: hz, v: ridge - y0 },
  );
  pushTri(pos, nor, uv, [-1, 0, 0],
    { p: [-hx, y1, -hz], u: 0, v: h },
    { p: [-hx, y1, hz], u: 2 * hz, v: h },
    { p: [-hx, ridge, 0], u: hz, v: ridge - y0 },
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Proud strips at every board joint, all four facades in one instanced pass.
 * `pitch` is the board width; the strips are the shadow gaps between them.
 */
export function boardSeams(s: WallShellSpec, pitch: number, proud = 0.05): BoxInstance[] {
  const out: BoxInstance[] = [];
  const cy = (s.y0 + s.y1) / 2;
  const height = s.y1 - s.y0;
  const t = 0.025;
  const half = proud / 2;

  for (let x = -s.hx + pitch; x < s.hx - pitch / 2; x += pitch) {
    out.push({ p: [x, cy, s.hz + half], s: [t, height, proud] });
    out.push({ p: [x, cy, -s.hz - half], s: [t, height, proud] });
  }
  for (let z = -s.hz + pitch; z < s.hz - pitch / 2; z += pitch) {
    out.push({ p: [s.hx + half, cy, z], s: [proud, height, t] });
    out.push({ p: [-s.hx - half, cy, z], s: [proud, height, t] });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Components                                                                  */
/* -------------------------------------------------------------------------- */

export interface WallsProps {
  geometry: THREE.BufferGeometry;
  /** Flat colour used by the fallback, and as a tint under the texture. */
  color: string;
}

/** Untextured shell. Rendered while the cedar bitmaps are still loading. */
export function PlainWalls({ geometry, color }: WallsProps) {
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial color={color} roughness={0.8} metalness={0} />
    </mesh>
  );
}

/**
 * Cedar-clad shell. Suspends on the three bitmaps, so it always renders behind
 * a <Suspense fallback={<PlainWalls .../>}>.
 */
export function CedarWalls({ geometry }: Omit<WallsProps, 'color'>) {
  const { map, normalMap, roughnessMap } = useTexture(CEDAR_URLS);

  /* useTexture hands back the loader's cached textures, which are shared with
     anything else that asks for the same files. Clone before configuring:
     clones share the decoded image but carry their own wrapping, so setting
     RepeatWrapping here cannot reach into another component's material. UVs
     are already in tile units (see TILE_M), so `repeat` stays at 1. */
  const cedar = useMemo(() => {
    const cloned = {
      map: map.clone(),
      normalMap: normalMap.clone(),
      roughnessMap: roughnessMap.clone(),
    };
    cloned.map.colorSpace = THREE.SRGBColorSpace;
    for (const texture of Object.values(cloned)) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 8;
      texture.needsUpdate = true;
    }
    return cloned;
  }, [map, normalMap, roughnessMap]);

  useEffect(
    () => () => {
      for (const texture of Object.values(cedar)) texture.dispose();
    },
    [cedar],
  );

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        map={cedar.map}
        normalMap={cedar.normalMap}
        roughnessMap={cedar.roughnessMap}
        color="#ffffff"
        roughness={1}
        metalness={0}
      />
    </mesh>
  );
}
