'use client';

/**
 * The lit windows a generated shell cannot have.
 *
 * The procedural buildings carry a real pane per window and drive each one off
 * `hour` and `loadRatio`, which is most of what makes the portfolio read as
 * occupied after dark. A generated shell has its glazing baked into COLOR_0,
 * so there is nothing to switch on -- it goes flat and dead at 22:00 while the
 * building next to it glows.
 *
 * This is the cheap version of that effect and no more: a handful of small
 * unlit quads a few centimetres proud of the model's front face, at plausible
 * storey heights, above the bloom cut so they read as lights rather than as
 * pale paint. One InstancedMesh, one draw call, nothing at all before dusk.
 *
 * Which quads stay dark is `hash01` of the quad index, so the same building is
 * lit the same way on every render and two screenshots are comparable.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, InstancedMesh, Object3D } from 'three';
import { hash01, nightFactor } from '../buildings/materials';

/** Warm interior light. Multiplied past 1.0 so the composer blooms it. */
const WARM = '#ffd08a';
const GAIN = 1.6;
/** Fraction of quads that stay dark after sunset. Matches `Windows`. */
const DARK_FRACTION = 0.3;

export interface NightWindowsProps {
  hour: number;
  /** How hard the site is working. A busy building burns a little brighter. */
  loadRatio?: number;
  /** The front (+z) face plane. Quads sit `proud` in front of it. */
  z: number;
  /** Sill heights, one entry per storey band to light. */
  rows: readonly number[];
  /** Quads per row, spread symmetrically about x = 0. */
  cols: number;
  /** Horizontal distance from the centreline to the outermost column. */
  spread: number;
  /** Quad size, metres. */
  size: readonly [number, number];
  /** How far in front of `z` the quads sit. */
  proud?: number;
}

const SCRATCH = new Object3D();
const TINT = new Color();

/**
 * 6-10 warm quads on the front face, after dark only.
 *
 * Deliberately not on the other three faces: from the scene's camera arc the
 * front is the face you see, and a quad on a face you cannot see is a draw
 * call's worth of instances spent on nothing.
 */
export function NightWindows({
  hour,
  loadRatio = 0,
  z,
  rows,
  cols,
  spread,
  size,
  proud = 0.06,
}: NightWindowsProps) {
  const night = nightFactor(hour);
  const mesh = useRef<InstancedMesh>(null);

  const places = useMemo(() => {
    const out: [number, number][] = [];
    const step = cols > 1 ? (spread * 2) / (cols - 1) : 0;
    for (const y of rows) {
      for (let c = 0; c < cols; c++) out.push([-spread + c * step, y]);
    }
    return out;
  }, [rows, cols, spread]);

  const count = places.length;

  useLayoutEffect(() => {
    const target = mesh.current;
    if (!target || night <= 0) return;
    // A loaded building burns a little brighter, the same way `litPanelColor`
    // warms a pane -- but it can only ever climb, never dim below the cut.
    const gain = GAIN * night * (1 + 0.25 * Math.min(1, Math.max(0, loadRatio)));
    for (let i = 0; i < count; i++) {
      const [x, y] = places[i];
      SCRATCH.position.set(x, y, z + proud);
      SCRATCH.rotation.set(0, 0, 0);
      SCRATCH.scale.set(size[0], size[1], 1);
      SCRATCH.updateMatrix();
      target.setMatrixAt(i, SCRATCH.matrix);
      const lit = hash01(i * 5 + 11) >= DARK_FRACTION;
      target.setColorAt(i, TINT.set(WARM).multiplyScalar(lit ? gain : 0.02));
    }
    target.count = count;
    target.instanceMatrix.needsUpdate = true;
    if (target.instanceColor) target.instanceColor.needsUpdate = true;
    target.computeBoundingSphere();
  }, [places, count, night, loadRatio, z, proud, size]);

  if (night <= 0 || count === 0) return null;

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, count]}
      castShadow={false}
      receiveShadow={false}
    >
      <planeGeometry args={[1, 1]} />
      {/* Unlit and untonemapped: the per-instance colour is what carries the
          glow, and it is multiplied past 1.0 so bloom picks it up. */}
      <meshBasicMaterial color="#ffffff" toneMapped={false} />
    </instancedMesh>
  );
}

export default NightWindows;
