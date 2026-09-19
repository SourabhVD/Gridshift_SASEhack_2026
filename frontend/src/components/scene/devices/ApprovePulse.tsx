'use client';

/**
 * The approve moment, in the scene.
 *
 * Two things live here. The first is `settle()`, the frame-rate independent
 * lerp factor every material in this folder uses to walk to a new colour over
 * SETTLE_MS -- a fixed per-frame constant would settle at a different speed on a
 * 60 Hz laptop and a 144 Hz monitor, which is exactly the bug the 800 ms is
 * meant to hide.
 *
 * The second is the pulse itself: one bright bead that runs the grid conduit
 * from the transformer to the building's junction box ONCE when the plan is
 * approved, and is then parked for good. It rides the same cached arc-length
 * lookup the flow particles use, so it costs one extra draw call and no extra
 * curve maths.
 *
 * Reduced motion: no pulse at all, and `settle()` collapses to a snap. The
 * recolour survives because it carries information -- "the grid is being held
 * under the threshold" -- but nothing travels.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  type CatmullRomCurve3,
  type Mesh,
  Vector3,
} from 'three';
import { glow } from './common';
import { lookupFor, sample } from './FlowParticles';

/** How long a material takes to walk to a new colour. The one 800 ms on the page. */
export const SETTLE_MS = 800;

/** How long the bead takes to cross the site. */
export const PULSE_MS = 1100;

/** Fraction of the trip spent fading in at one end and out at the other. */
const PULSE_FADE = 0.12;

/** The bead is this many conduit radii across at its brightest. */
const PULSE_GIRTH = 2.4;

const POINT = new Vector3();

/**
 * Lerp factor for one frame of a SETTLE_MS settle: after that long, 99.9 % of
 * the distance is gone, whatever the frame rate.
 */
export function settle(deltaSeconds: number, durationMs: number = SETTLE_MS): number {
  if (!(deltaSeconds > 0)) return 0;
  return 1 - Math.pow(0.001, deltaSeconds / (durationMs / 1000));
}

/* -------------------------------------------------------------------------- */
/* prefers-reduced-motion                                                      */
/* -------------------------------------------------------------------------- */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onStoreChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** The scene never renders on the server, but the hook still needs the third arg. */
function getReducedMotionServerSnapshot(): boolean {
  return false;
}

/** Shared by every material in this folder that animates a colour. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
}

/* -------------------------------------------------------------------------- */
/* The pulse                                                                   */
/* -------------------------------------------------------------------------- */

/** ease-out cubic, the same curve `useCountUp` eases the KPI numbers on. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export interface ApprovePulseProps {
  /** The grid run, authored transformer -> junction. */
  curve: CatmullRomCurve3;
  /** True once the plan is approved. The rising edge is what fires the bead. */
  active: boolean;
  /** Conduit radius, so the bead is in scale with the run it travels inside. */
  radius: number;
  /** Palette hex; it is put through `glow()` so the composer blooms it. */
  color: string;
}

export function ApprovePulse({ curve, active, radius, color }: ApprovePulseProps) {
  const ref = useRef<Mesh>(null);
  /** Trip progress. 1 means finished -- which is also the mounted state. */
  const progress = useRef(1);
  const wasActive = useRef(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    // Rising edge only: an approved plan that is still approved next render
    // must not re-fire, and a reset back to idle re-arms it for the next run.
    if (active && !wasActive.current && !reduced) progress.current = 0;
    wasActive.current = active;
  }, [active, reduced]);

  useFrame((_, delta) => {
    const mesh = ref.current;
    if (!mesh) return;

    if (progress.current >= 1) {
      if (mesh.visible) mesh.visible = false;
      return;
    }

    progress.current = Math.min(1, progress.current + (delta * 1000) / PULSE_MS);
    sample(lookupFor(curve), easeOut(progress.current), POINT);
    mesh.position.copy(POINT);

    // Fade in off the transformer and out at the junction, so the bead arrives
    // and leaves rather than popping into and out of existence.
    const edge = Math.min(progress.current, 1 - progress.current);
    const fade = Math.min(1, edge / PULSE_FADE);
    mesh.scale.setScalar(Math.max(0.001, radius * PULSE_GIRTH * fade));
    mesh.visible = true;
  });

  return (
    <mesh ref={ref} visible={false} frustumCulled={false} raycast={() => null}>
      <icosahedronGeometry args={[1, 1]} />
      {/* Same recipe as the flow beads, one stop brighter: unlit, untonemapped
          and additive, so it reads as light travelling rather than a ball. */}
      <meshBasicMaterial
        color={glow(color, 3.2)}
        toneMapped={false}
        transparent
        opacity={0.95}
        blending={AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  );
}

export default ApprovePulse;
