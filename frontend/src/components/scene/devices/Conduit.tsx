'use client';

/**
 * One armoured run between a device and the building's junction box, plus the
 * beads of light travelling along it.
 *
 * Thickness is a share of the busiest flow this hour, exactly like the 2D
 * diagram's stroke width -- but quantised into RADIUS_BUCKETS steps, because a
 * TubeGeometry cannot be resized in place and rebuilding one every frame would
 * churn buffers. The bucket only changes when the share moves ~12 points.
 */

import { useEffect, useMemo } from 'react';
import { CatmullRomCurve3, TubeGeometry, type Vector3 } from 'three';
import { DORMANT_KW, MAX_PARTICLES, RADIUS_BUCKETS, clamp } from './common';
import { FlowParticles } from './FlowParticles';

export interface ConduitProps {
  /** Control points, ordered device -> junction. */
  points: Vector3[];
  /** Signed for the battery, a magnitude for everything else. */
  kw: number;
  /** Busiest flow this hour. */
  maxKw: number;
  color: string;
  /** True when power moves device -> building (curve forward). */
  towardBuilding: boolean;
}

export function Conduit({ points, kw, maxKw, color, towardBuilding }: ConduitProps) {
  const curve = useMemo(
    () => new CatmullRomCurve3(points, false, 'centripetal', 0.5),
    [points],
  );

  const magnitude = Math.abs(kw);
  const share = clamp(magnitude / maxKw, 0, 1);
  const dormant = magnitude < DORMANT_KW;

  // Quantise first, derive the radius from the bucket -- so `radius` is a
  // stable dependency and the geometry memo only fires on a bucket change.
  const bucket = Math.min(RADIUS_BUCKETS - 1, Math.floor(share * RADIUS_BUCKETS));
  const radius = 0.12 + 0.25 * ((bucket + 0.5) / RADIUS_BUCKETS);

  const geometry = useMemo(() => new TubeGeometry(curve, 96, radius, 6, false), [curve, radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const count = dormant ? 0 : Math.min(MAX_PARTICLES, 8 + Math.round(24 * share));
  const speed = 0.08 + 0.52 * share;

  return (
    <group>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.35}
          roughness={0.45}
          metalness={0.15}
          transparent
          opacity={dormant ? 0.25 : 0.9}
        />
      </mesh>
      {count > 0 ? (
        <FlowParticles
          curve={curve}
          count={count}
          speed={speed}
          reverse={!towardBuilding}
          color={color}
          radius={radius * 1.35}
        />
      ) : null}
    </group>
  );
}

export default Conduit;
