'use client';

/**
 * The only camera in the scene, and it does not move.
 *
 * This is an architectural render, not a viewer: one fixed three-quarter view
 * from the front-right corner, high enough to read the site plan and low enough
 * to keep the building a building. No orbit controls, no auto-orbit — a
 * dashboard panel that eats scroll gestures or drifts in the corner of your eye
 * is a bad neighbour.
 *
 * The distance is not a magic number. `fitRadius` projects the eight corners of
 * the lot onto the camera basis and solves for the smallest distance that keeps
 * all of them inside the frustum, so a 12-storey tower and a 40 m shed are each
 * framed correctly and a resize re-solves rather than crops.
 *
 * The one concession to the agent: while a tool is in flight, the look-at drifts
 * a few metres toward whatever that tool is about and the camera creeps 10 %
 * closer. It is a lean, not a move — small enough that nothing needs a
 * reduced-motion escape hatch.
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import type { BuildingType } from '@/types/api';
import { ANCHORS, BUILDING_SPECS, focusHeight, roofY, type SceneNode } from './layout';

const FOV = 28;
/** Off the front-right corner, so the +z entrance and the +x EV bays both read. */
const AZIMUTH_DEG = 40;
/** Above the horizon. Shallow enough to keep facades, steep enough to read the plan. */
const ELEVATION_DEG = 30;
/** Breathing room once the exact fit has been solved. */
const FIT_MARGIN = 1.08;

/** How far the bays run out along +x from their anchor, cars included. */
const EV_RUN = 28;
/** Slack around the props, so nothing is framed flush to the edge. */
const LOT_PADDING = 4;
/**
 * The lot is long to the right of the building. Framing its true centre would
 * push the building into the left third, so the look-at splits the difference.
 */
const LOT_BIAS = 0.5;

/** The look-at may drift this far toward a lit node, and no further. */
const MAX_FOCUS_SHIFT = 4;
/** The most the camera creeps in while a node is lit. */
const FOCUS_ZOOM = 0.9;

/** Time constant of roughly half a second for the focus lean. */
const LAMBDA = 2.2;

const DEG = Math.PI / 180;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

interface Lot {
  min: THREE.Vector3;
  max: THREE.Vector3;
  /** Resting look-at. */
  target: THREE.Vector3;
}

/** Everything that has to be in frame: the shell plus every device anchor. */
function lotBounds(type: BuildingType): Lot {
  const [w, d] = BUILDING_SPECS[type].footprint;

  const minX = Math.min(ANCHORS.grid[0], ANCHORS.battery[0], -w / 2) - LOT_PADDING;
  const maxX = Math.max(ANCHORS.ev[0] + EV_RUN, w / 2) + LOT_PADDING;
  const minZ = Math.min(ANCHORS.battery[2], -d / 2) - LOT_PADDING;
  const maxZ = Math.max(ANCHORS.grid[2], ANCHORS.ev[2], d / 2) + LOT_PADDING;

  return {
    min: new THREE.Vector3(minX, 0, minZ),
    max: new THREE.Vector3(maxX, roofY(type) + 3, maxZ),
    target: new THREE.Vector3(
      ((minX + maxX) / 2) * LOT_BIAS,
      focusHeight(type),
      ((minZ + maxZ) / 2) * LOT_BIAS,
    ),
  };
}

/** Unit vector from the look-at toward the camera. */
function viewDirection(out: THREE.Vector3): THREE.Vector3 {
  const el = ELEVATION_DEG * DEG;
  const az = AZIMUTH_DEG * DEG;
  return out
    .set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    .normalize();
}

/**
 * Smallest distance along `dir` that keeps every corner of the lot inside the
 * frustum. For a corner at camera-space (x, y, z), staying in frame needs
 * `|x| <= (distance - z) * tan(halfFov)`, which rearranges to a lower bound on
 * the distance; the answer is the largest bound over all eight corners.
 */
function fitRadius(lot: Lot, aspect: number): number {
  const dir = viewDirection(new THREE.Vector3());
  const forward = dir.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, WORLD_UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  const halfV = Math.tan((FOV / 2) * DEG);
  const halfH = halfV * aspect;

  const corner = new THREE.Vector3();
  let radius = 0;

  for (const x of [lot.min.x, lot.max.x]) {
    for (const y of [lot.min.y, lot.max.y]) {
      for (const z of [lot.min.z, lot.max.z]) {
        corner.set(x, y, z).sub(lot.target);
        const depth = corner.dot(dir);
        radius = Math.max(
          radius,
          Math.abs(corner.dot(right)) / halfH + depth,
          Math.abs(corner.dot(up)) / halfV + depth,
        );
      }
    }
  }

  return radius * FIT_MARGIN;
}

/** World point the camera should lean toward, per lit node. */
function nodePosition(node: SceneNode, type: BuildingType, out: THREE.Vector3): THREE.Vector3 {
  switch (node) {
    case 'grid':
      return out.set(ANCHORS.grid[0], 2.5, ANCHORS.grid[2]);
    case 'battery':
      return out.set(ANCHORS.battery[0], 2.5, ANCHORS.battery[2]);
    case 'ev':
      return out.set(ANCHORS.ev[0] + EV_RUN / 2, 2.5, ANCHORS.ev[2]);
    case 'solar':
    case 'hvac':
      return out.set(0, roofY(type) + 2, 0);
    case 'building':
    default:
      return out.set(0, focusHeight(type), 0);
  }
}

export interface CameraRigProps {
  type: BuildingType;
  /** Nodes the agent is currently touching. Empty means "rest". */
  activeNodes: ReadonlySet<SceneNode>;
}

export function CameraRig({ type, activeNodes }: CameraRigProps) {
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);

  const lot = useMemo(() => lotBounds(type), [type]);

  /* Current (damped) state. Snapped on a building switch: a different subject
     is a cut, not a move. */
  const target = useRef(lot.target.clone());
  const radius = useRef(0);
  const fitted = useRef({ aspect: 0, radius: 0, lot });

  /* Scratch, so useFrame allocates nothing. */
  const scratch = useMemo(
    () => ({
      dir: new THREE.Vector3(),
      node: new THREE.Vector3(),
      desired: new THREE.Vector3(),
      offset: new THREE.Vector3(),
    }),
    [],
  );

  useFrame((_, delta) => {
    const camera = cameraRef.current;
    if (!camera) return;
    const dt = Math.min(delta, 0.1);

    /* Re-solve the framing only when the subject or the panel size changes. */
    const cache = fitted.current;
    if (cache.lot !== lot || cache.aspect !== camera.aspect) {
      const snap = cache.lot !== lot;
      cache.lot = lot;
      cache.aspect = camera.aspect;
      cache.radius = fitRadius(lot, camera.aspect || 16 / 9);
      if (snap || radius.current === 0) {
        radius.current = cache.radius;
        target.current.copy(lot.target);
      }
    }

    /* Rest, plus a small lean toward whatever the agent is querying. */
    const desired = scratch.desired.copy(lot.target);
    let desiredRadius = cache.radius;

    if (activeNodes.size > 0) {
      const offset = scratch.offset.set(0, 0, 0);
      for (const node of activeNodes) {
        offset.add(nodePosition(node, type, scratch.node));
      }
      offset.divideScalar(activeNodes.size).sub(lot.target);
      offset.clampLength(0, MAX_FOCUS_SHIFT);
      desired.add(offset);
      desiredRadius *= FOCUS_ZOOM;
    }

    const k = 1 - Math.exp(-LAMBDA * dt);
    target.current.lerp(desired, k);
    radius.current = THREE.MathUtils.damp(radius.current, desiredRadius, LAMBDA, dt);

    const dir = viewDirection(scratch.dir).multiplyScalar(radius.current);
    camera.position.copy(target.current).add(dir);
    camera.lookAt(target.current);
  });

  return <PerspectiveCamera ref={cameraRef} makeDefault fov={FOV} near={1} far={600} />;
}

export default CameraRig;
