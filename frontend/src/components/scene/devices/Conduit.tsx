'use client';

/**
 * One armoured run between a device and the building's junction box.
 *
 * Thickness is a share of the busiest flow this hour, exactly like the 2D
 * diagram's stroke width -- but quantised into RADIUS_BUCKETS steps, because a
 * TubeGeometry cannot be resized in place and rebuilding one every frame would
 * churn buffers. The bucket only changes when the share moves ~12 points.
 *
 * The beads of light are NOT here: every run's particles live in the single
 * shared InstancedMesh in `FlowParticles`, which is why a five-conduit site
 * spends five draw calls on tubes and exactly one on light.
 *
 * Commercial runs are 80-220 mm; a domestic run is 30-80 mm. Either way the
 * tube is a slightly glossy sheath (roughness 0.35) with only enough emissive
 * to keep its colour legible in shadow -- well under the composer's 1.05 cut,
 * so the conduit itself never blooms and the beads stand out against it.
 *
 * ## Colour
 *
 * `color` is a target, not a setting. The material walks to it inside the frame
 * loop over SETTLE_MS rather than being re-applied on render, so the grid's
 * red -> green on an approved plan is a settle and not a cut -- and, because it
 * happens on the material the mesh already owns, nothing is rebuilt or
 * remounted to do it. Under reduced motion the walk collapses to a snap.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  type CatmullRomCurve3,
  Color,
  type MeshStandardMaterial,
  TubeGeometry,
} from 'three';
import { settle, usePrefersReducedMotion } from './ApprovePulse';
import { DORMANT_KW, MAX_PARTICLES, RADIUS_BUCKETS, clamp } from './common';

/** Everything both the tube and its particle stream need to agree about. */
export interface ConduitScale {
  radius: number;
  dormant: boolean;
  /** Beads to show. 0 when dormant. */
  count: number;
  /** Curve-lengths per second. */
  speed: number;
}

/**
 * Quantise first, derive the radius from the bucket -- so `radius` is a stable
 * dependency and the geometry memo only fires on a bucket change.
 */
export function conduitScale(
  kw: number,
  maxKw: number,
  minRadius: number,
  maxRadius: number,
): ConduitScale {
  const magnitude = Math.abs(kw);
  const share = clamp(magnitude / maxKw, 0, 1);
  const dormant = magnitude < DORMANT_KW;
  const bucket = Math.min(RADIUS_BUCKETS - 1, Math.floor(share * RADIUS_BUCKETS));
  return {
    radius: minRadius + (maxRadius - minRadius) * ((bucket + 0.5) / RADIUS_BUCKETS),
    dormant,
    count: dormant ? 0 : Math.min(MAX_PARTICLES, 8 + Math.round(24 * share)),
    speed: 0.08 + 0.52 * share,
  };
}

export interface ConduitProps {
  /** Authored device -> junction. */
  curve: CatmullRomCurve3;
  scale: ConduitScale;
  color: string;
}

export function Conduit({ curve, scale, color }: ConduitProps) {
  const geometry = useMemo(
    () => new TubeGeometry(curve, 96, scale.radius, 6, false),
    [curve, scale.radius],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useRef<MeshStandardMaterial>(null);
  const target = useMemo(() => new Color(color), [color]);
  const reduced = usePrefersReducedMotion();

  /* First paint is not a transition: the run starts at its own colour. */
  const seeded = useRef(false);
  useLayoutEffect(() => {
    const mat = material.current;
    if (!mat || seeded.current) return;
    seeded.current = true;
    mat.color.copy(target);
    mat.emissive.copy(target);
  }, [target]);

  useFrame((_, delta) => {
    const mat = material.current;
    if (!mat) return;
    if (reduced) {
      mat.color.copy(target);
      mat.emissive.copy(target);
      return;
    }
    const alpha = settle(delta);
    if (alpha <= 0) return;
    mat.color.lerp(target, alpha);
    mat.emissive.lerp(target, alpha);
  });

  return (
    /* Not a pick target: only devices and the building answer the pointer, so
       the tube is excluded from the raycast outright. */
    <mesh geometry={geometry} castShadow receiveShadow raycast={() => null}>
      {/* No `color` / `emissive` props: they are driven from the frame loop
          above, and re-applying them on every store tick would undo the lerp. */}
      <meshStandardMaterial
        ref={material}
        emissiveIntensity={0.22}
        roughness={0.35}
        metalness={0.25}
        transparent
        opacity={scale.dormant ? 0.18 : 0.92}
      />
    </mesh>
  );
}

export default Conduit;
