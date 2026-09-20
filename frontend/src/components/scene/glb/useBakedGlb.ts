'use client';

/**
 * Loading a generated GLB and turning it into something this scene can place.
 *
 * Every model under `public/models` comes out of the same pipeline: one mesh,
 * POSITION and COLOR_0 and nothing else -- no normals, no UVs, no material --
 * normalised to roughly a metre on its longest axis and pointing whichever way
 * the generator felt like. `devices/Car.tsx` was the first of them and worked
 * all this out by hand; this module is that work factored out, so a second
 * asset costs a transform spec rather than another eighty lines.
 *
 * ## Why nothing can be done in place
 *
 * `EXT_meshopt_compression` leaves POSITION as normalised int16 and pushes the
 * dequantisation into the node's scale. Writing a metre-scale float back into
 * that attribute would clamp it to the unit cube, so the positions are read out
 * *through the node's world matrix* into a fresh float buffer. COLOR_0 is
 * copied the same way, minus its (always opaque) alpha, so the material never
 * opts into `USE_COLOR_ALPHA`.
 *
 * ## What the bake does, in order
 *
 *   1. yaw      turn the model's front toward +z, the scene's building front
 *   2. centre   on all three axes
 *   3. scale    to the caller's target size (per axis, so a building can be
 *               held to its footprint *and* to `roofY` at once)
 *   4. seat     lift the lowest vertex onto `baseY`, then apply `offset`
 *   5. normals  the generator never wrote any
 *
 * The result is authored exactly like the procedural props next to it -- origin
 * at the ground-level centre, front toward +z, metres -- so the two are
 * interchangeable at every call site.
 */

import { useMemo } from 'react';
import { Box3, BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three';
import { useGLTF } from '@react-three/drei';

/** How a raw generated mesh is turned into a scene-space prop. */
export interface GlbTransform {
  /**
   * Yaw about +y, radians, applied before anything else. Use it to bring the
   * model's front round to +z; read the direction off the reference image and
   * confirm it in the browser.
   */
  yaw?: number;
  /** Target bounding-box width (world x) after the yaw, metres. */
  width?: number;
  /** Target bounding-box height, metres. */
  height?: number;
  /**
   * Target bounding-box depth (world z), metres. Left out, depth follows
   * whichever scale `width` (or failing that `height`) asked for, which is the
   * usual case: only a building that has to fill a fixed footprint *and* reach
   * a fixed roof height needs all three.
   */
  depth?: number;
  /** Where the lowest vertex ends up. Default 0, i.e. standing on the ground. */
  baseY?: number;
  /** Nudge in x / z after centring, metres. */
  offset?: readonly [number, number];
}

/** A baked geometry and the box it ended up occupying. */
export interface BakedGlb {
  geometry: BufferGeometry;
  /** Final bounding-box size in metres, after the whole transform. */
  size: Vector3;
  /** Final bounding-box centre, in the parent group's space. */
  center: Vector3;
}

/* Keyed by the loaded mesh *and* the transform, because two call sites may want
 * the same file at two sizes (the same pedestal on a court and on a drive).
 * The outer WeakMap lets a dropped GLTF take its bakes with it. */
const CACHE = new WeakMap<Mesh, Map<string, BakedGlb>>();

function keyOf(t: GlbTransform): string {
  return [t.yaw ?? 0, t.width ?? 0, t.height ?? 0, t.depth ?? 0, t.baseY ?? 0, t.offset?.[0] ?? 0, t.offset?.[1] ?? 0].join('|');
}

const BOX = new Box3();

function boundsOf(geometry: BufferGeometry): Box3 {
  geometry.computeBoundingBox();
  return BOX.copy(geometry.boundingBox ?? new Box3());
}

function bake(mesh: Mesh, transform: GlbTransform): BakedGlb {
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

  if (transform.yaw) geometry.rotateY(transform.yaw);
  geometry.center();

  const raw = boundsOf(geometry);
  const span = new Vector3(
    Math.max(raw.max.x - raw.min.x, 1e-6),
    Math.max(raw.max.y - raw.min.y, 1e-6),
    Math.max(raw.max.z - raw.min.z, 1e-6),
  );
  // Width wins when both are given, so a building keeps its footprint and only
  // stretches to reach `roofY`; a prop that only names a height scales
  // uniformly off that instead.
  const sx = transform.width ? transform.width / span.x : undefined;
  const sy = transform.height ? transform.height / span.y : undefined;
  const sz = transform.depth ? transform.depth / span.z : undefined;
  const uniform = sx ?? sy ?? sz ?? 1;
  geometry.scale(sx ?? uniform, sy ?? uniform, sz ?? uniform);

  const seated = boundsOf(geometry);
  geometry.translate(
    transform.offset?.[0] ?? 0,
    (transform.baseY ?? 0) - seated.min.y,
    transform.offset?.[1] ?? 0,
  );

  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const final = boundsOf(geometry);
  return {
    geometry,
    size: new Vector3().subVectors(final.max, final.min),
    center: new Vector3().addVectors(final.min, final.max).multiplyScalar(0.5),
  };
}

/**
 * Suspends until `url` is in, then hands back one shared baked geometry.
 *
 * `useDraco` is false on purpose: nothing in this project is Draco, and leaving
 * it on would have drei reach for a decoder on a Google CDN. Meshopt's decoder
 * ships inside three.
 */
export function useBakedGlb(url: string, transform: GlbTransform): BakedGlb {
  const { scene } = useGLTF(url, false, true);
  const key = keyOf(transform);
  return useMemo(() => {
    const mesh = scene.getObjectByProperty('isMesh', true) as Mesh | undefined;
    if (!mesh) throw new Error(url + ' has no mesh');
    let bakes = CACHE.get(mesh);
    if (!bakes) {
      bakes = new Map();
      CACHE.set(mesh, bakes);
    }
    const hit = bakes.get(key);
    if (hit) return hit;
    const baked = bake(mesh, transform);
    bakes.set(key, baked);
    return baked;
    // `transform` is an object literal at most call sites; `key` is its value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, url, key]);
}

/**
 * Warms the cache before anything mounts, so a model is in hand on the first
 * paint rather than a frame of boxes. `EnergyScene` is a
 * `dynamic(..., { ssr: false })` import, but the guard keeps this honest for
 * anything that imports a folder directly.
 */
export function preloadGlb(url: string): void {
  if (typeof window !== 'undefined') useGLTF.preload(url, false, true);
}
