'use client';

/**
 * The beads of light running along the conduits -- all five runs, in one
 * InstancedMesh.
 *
 * Each stream owns a fixed slice of MAX_PARTICLES instances, so a quiet flow is
 * throttled by leaving its slots parked at zero scale rather than by resizing
 * anything. Colour is per instance, which is what lets one unlit material carry
 * five different channels: the sky blue of the grid, the amber of the array,
 * the teal of the chargers.
 *
 * Every colour goes through `glow()`, i.e. it is multiplied clear of 1.0 in
 * linear space, and the material opts out of tone mapping. Those two together
 * are what make the beads the brightest thing in the frame and the only thing
 * (with the status LEDs and a live charger screen) that the composer blooms.
 *
 * Positions come from a 65-point lookup taken off each curve once
 * (`getSpacedPoints`) and lerped -- `curve.getPointAt` per particle per frame
 * would re-walk the arc-length table 200 times a frame. The lookups are cached
 * against the curve itself, so a colour or flow change costs nothing. The lookup
 * and its sampler are exported, because the approve pulse rides the same table.
 *
 * A stream's colour is a target rather than a setting: the instance colours walk
 * to it over SETTLE_MS, so the grid's red -> green on an approved plan settles
 * on the beads at the same rate as on the tube they run inside. The write is
 * skipped entirely on the frames where nothing is converging, which is almost
 * all of them.
 *
 * Every temporary is hoisted; the frame loop allocates nothing.
 */

import { useLayoutEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  type CatmullRomCurve3,
  Color,
  type InstancedMesh,
  Object3D,
  Vector3,
} from 'three';
import { settle, usePrefersReducedMotion } from './ApprovePulse';
import { MAX_PARTICLES, glow } from './common';

const SCRATCH = new Object3D();
const POINT = new Vector3();
const TINT = new Color();
const PARKED = new Vector3(0, -1000, 0);

/** Below this the walk is over and the colour is snapped to its target. */
const COLOR_EPSILON = 0.002;

/** Arc-length lookups, cached against the curve so re-renders are free. */
const LOOKUPS = new WeakMap<CatmullRomCurve3, Vector3[]>();

export function lookupFor(curve: CatmullRomCurve3): Vector3[] {
  let points = LOOKUPS.get(curve);
  if (!points) {
    points = curve.getSpacedPoints(64);
    LOOKUPS.set(curve, points);
  }
  return points;
}

/** Sample the precomputed polyline at u in [0,1]. */
export function sample(points: readonly Vector3[], u: number, out: Vector3): void {
  const f = u * (points.length - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(points.length - 1, i0 + 1);
  out.copy(points[i0]).lerp(points[i1], f - i0);
}

export interface ParticleStream {
  curve: CatmullRomCurve3;
  /** How many beads to show, already capped by the caller. */
  count: number;
  /** Curve-lengths per second. */
  speed: number;
  /** The curve runs device -> junction; reverse it for power leaving the building. */
  reverse: boolean;
  color: string;
  /** Bead radius, scaled off the conduit it runs inside. */
  radius: number;
}

export interface FlowParticlesProps {
  streams: readonly ParticleStream[];
}

export function FlowParticles({ streams }: FlowParticlesProps) {
  const ref = useRef<InstancedMesh>(null);
  const capacity = Math.max(1, streams.length * MAX_PARTICLES);
  const reduced = usePrefersReducedMotion();

  /** What each stream is showing right now, as opposed to what it is heading for. */
  const shown = useRef<Color[]>([]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    for (let s = 0; s < streams.length; s++) {
      // A stream seen for the first time starts at its own colour; one that has
      // been on screen keeps whatever it had, and the frame loop walks it over.
      if (!shown.current[s]) shown.current[s] = new Color().copy(glow(streams[s].color));
      TINT.copy(shown.current[s]);
      for (let i = 0; i < MAX_PARTICLES; i++) {
        mesh.setColorAt(s * MAX_PARTICLES + i, TINT);
      }
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [streams]);

  /* r3f re-registers this callback on every render, so closing over `streams`
   * directly always sees the current set. */
  useFrame((state, delta) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = state.clock.elapsedTime;

    for (let s = 0; s < streams.length; s++) {
      const stream = streams[s];
      const base = s * MAX_PARTICLES;
      const points = lookupFor(stream.curve);
      const travel = t * stream.speed;
      const size = stream.radius * 1.15;

      for (let i = 0; i < MAX_PARTICLES; i++) {
        if (i < stream.count) {
          let u = (i / stream.count + travel) % 1;
          if (stream.reverse) u = 1 - u;
          sample(points, u, POINT);
          SCRATCH.position.copy(POINT);
          SCRATCH.scale.setScalar(size * (0.85 + 0.25 * Math.sin(t * 4.2 + i * 1.7)));
        } else {
          // Parked far below the stage rather than resized to nothing, which
          // would leave a degenerate matrix in the buffer.
          SCRATCH.position.copy(PARKED);
          SCRATCH.scale.setScalar(0.001);
        }
        SCRATCH.updateMatrix();
        mesh.setMatrixAt(base + i, SCRATCH.matrix);
      }
    }
    mesh.count = streams.length * MAX_PARTICLES;
    mesh.instanceMatrix.needsUpdate = true;

    /* Colour walk. Only the streams still converging are written, so an idle
       site pays one distance check per conduit per frame and nothing else. */
    const alpha = reduced ? 1 : settle(delta);
    if (alpha <= 0) return;

    let repaint = false;
    for (let s = 0; s < streams.length; s++) {
      const current = shown.current[s];
      if (!current) continue;
      const want = glow(streams[s].color);
      const distance =
        Math.abs(current.r - want.r) +
        Math.abs(current.g - want.g) +
        Math.abs(current.b - want.b);
      if (distance < COLOR_EPSILON) continue;

      if (alpha >= 1 || distance < COLOR_EPSILON * 4) current.copy(want);
      else current.lerp(want, alpha);

      TINT.copy(current);
      const base = s * MAX_PARTICLES;
      for (let i = 0; i < MAX_PARTICLES; i++) mesh.setColorAt(base + i, TINT);
      repaint = true;
    }
    if (repaint && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, capacity]}
      frustumCulled={false}
      /* Beads of light are never a pick target. */
      raycast={() => null}
    >
      <icosahedronGeometry args={[1, 0]} />
      {/* Unlit, untonemapped and additive: the beads read as light, not as
          painted spheres, and the per-instance colours carry them above the
          bloom threshold on their own. */}
      <meshBasicMaterial
        color="#ffffff"
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
