'use client';

/**
 * The beads of light running along one conduit.
 *
 * One InstancedMesh per conduit, allocated once at MAX_PARTICLES and then
 * throttled with `mesh.count` so a quiet flow costs fewer instances without
 * rebuilding anything. Positions come from a 65-point lookup taken off the
 * curve once (`getSpacedPoints`) and lerped -- `curve.getPointAt` per particle
 * per frame would re-walk the arc-length table 40 times a frame.
 *
 * Every temporary is hoisted; the frame loop allocates nothing.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, type CatmullRomCurve3, type InstancedMesh, Object3D, Vector3 } from 'three';
import { MAX_PARTICLES } from './common';

const SCRATCH = new Object3D();
const POINT = new Vector3();

/** Sample the precomputed polyline at u in [0,1]. */
function sample(points: readonly Vector3[], u: number, out: Vector3): void {
  const f = u * (points.length - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(points.length - 1, i0 + 1);
  out.copy(points[i0]).lerp(points[i1], f - i0);
}

export interface FlowParticlesProps {
  curve: CatmullRomCurve3;
  /** How many beads to show, already capped by the caller. */
  count: number;
  /** Curve-lengths per second. */
  speed: number;
  /** The curve runs device -> junction; reverse it for power leaving the building. */
  reverse: boolean;
  color: string;
  radius: number;
}

export function FlowParticles({ curve, count, speed, reverse, color, radius }: FlowParticlesProps) {
  const ref = useRef<InstancedMesh>(null);
  const lookup = useMemo(() => curve.getSpacedPoints(64), [curve]);

  useEffect(() => {
    if (ref.current) ref.current.count = count;
  }, [count]);

  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh || count === 0) return;
    const t = state.clock.elapsedTime;
    const travel = t * speed;
    for (let i = 0; i < count; i++) {
      let u = (i / count + travel) % 1;
      if (reverse) u = 1 - u;
      sample(lookup, u, POINT);
      SCRATCH.position.copy(POINT);
      SCRATCH.scale.setScalar(0.85 + 0.25 * Math.sin(t * 4.2 + i * 1.7));
      SCRATCH.updateMatrix();
      mesh.setMatrixAt(i, SCRATCH.matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  });

  const geometryArgs = useMemo(() => [radius, 0] as [number, number], [radius]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, MAX_PARTICLES]} frustumCulled={false}>
      <icosahedronGeometry args={geometryArgs} />
      {/* Unlit + untonemapped so the beads read as light, not as painted spheres. */}
      <meshBasicMaterial
        color={color}
        toneMapped={false}
        transparent
        opacity={0.95}
        blending={AdditiveBlending}
        depthWrite={false}
      />
    </instancedMesh>
  );
}

export default FlowParticles;
