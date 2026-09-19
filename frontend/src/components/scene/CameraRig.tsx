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
 *
 * The one concession to the viewer: picking a device hands the rig a composed
 * close-up from `interaction/shots`, and the four spherical parameters — target,
 * azimuth, elevation, radius — are damped toward it instead of toward home.
 * Selection outranks the agent lean, which is suppressed while a shot is held.
 * On top of that sits the drag offset, damped much faster so a look-around
 * tracks the hand rather than trailing it; clearing the selection zeroes the
 * offset, so the camera snaps back to the shot and then eases home. Under
 * `prefers-reduced-motion` every one of those transitions is a cut.
 */

import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import type { BuildingType } from '@/types/api';
import {
  BUILDING_SPECS,
  type GroundAnchor,
  anchorsFor,
  focusHeight,
  ridgeY,
  roofY,
  type SceneNode,
} from './layout';
import { evRun } from './Environment';
import { useSelected, useSelectionStore } from './interaction/selection';
import { shotFor } from './interaction/shots';

const FOV = 28;
/** Off the front-right corner, so the +z entrance and the +x EV bays both read. */
const AZIMUTH_DEG = 40;
/** Above the horizon. Shallow enough to keep facades, steep enough to read the plan. */
const ELEVATION_DEG = 30;
/** Breathing room once the exact fit has been solved. */
const FIT_MARGIN = 1.08;

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
/** Home <-> close-up. About 700 ms to settle, which reads as a move, not a cut. */
const SHOT_LAMBDA = 3.5;
/** The drag offset rides on top and has to feel attached to the hand. */
const DRAG_LAMBDA = 14;

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
  const anchors = anchorsFor(type);
  /* The residence hangs its batteries on a gable wall rather than standing a
     cabinet in the garden, so it has one ground anchor fewer to frame. */
  const ground: GroundAnchor[] =
    anchors.battery === 'wall'
      ? [anchors.grid, anchors.ev]
      : [anchors.grid, anchors.battery, anchors.ev];
  const xs = ground.map((a) => a[0]);
  const zs = ground.map((a) => a[2]);

  const minX = Math.min(-w / 2, ...xs) - LOT_PADDING;
  const maxX = Math.max(w / 2, anchors.ev[0] + evRun(type), ...xs) + LOT_PADDING;
  const minZ = Math.min(-d / 2, ...zs) - LOT_PADDING;
  const maxZ = Math.max(d / 2, ...zs) + LOT_PADDING;

  return {
    min: new THREE.Vector3(minX, 0, minZ),
    /* `ridgeY`, not `roofY`: a gable would be cropped by its own rise. */
    max: new THREE.Vector3(maxX, ridgeY(type) + 3, maxZ),
    target: new THREE.Vector3(
      ((minX + maxX) / 2) * LOT_BIAS,
      focusHeight(type),
      ((minZ + maxZ) / 2) * LOT_BIAS,
    ),
  };
}

/**
 * Unit vector from the look-at toward the camera, for a bearing measured off
 * +z toward +x and a height angle above the horizon. Every framing in the
 * scene — home, agent lean and every close-up — is one of these.
 */
function viewDirection(out: THREE.Vector3, azimuthDeg: number, elevationDeg: number) {
  const el = elevationDeg * DEG;
  const az = azimuthDeg * DEG;
  return out
    .set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    .normalize();
}

/* -------------------------------------------------------------------------- */
/* Media queries                                                               */
/* -------------------------------------------------------------------------- */

function mediaStore(query: string) {
  return {
    subscribe(onChange: () => void) {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    read: () => window.matchMedia(query).matches,
  };
}

const MOTION = mediaStore('(prefers-reduced-motion: reduce)');
const FALSE = () => false;

/** True when the viewer has asked for no animation; then every move is a cut. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(MOTION.subscribe, MOTION.read, FALSE);
}

/**
 * Smallest distance along `dir` that keeps every corner of the lot inside the
 * frustum. For a corner at camera-space (x, y, z), staying in frame needs
 * `|x| <= (distance - z) * tan(halfFov)`, which rearranges to a lower bound on
 * the distance; the answer is the largest bound over all eight corners.
 */
function fitRadius(lot: Lot, aspect: number): number {
  const dir = viewDirection(new THREE.Vector3(), AZIMUTH_DEG, ELEVATION_DEG);
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
    case 'grid': {
      const { grid } = anchorsFor(type);
      return out.set(grid[0], 2.5, grid[2]);
    }
    case 'battery': {
      const { battery } = anchorsFor(type);
      /* Wall-mounted units: lean toward the gable they hang on. */
      if (battery === 'wall') return out.set(-BUILDING_SPECS[type].footprint[0] / 2, 2.5, 0);
      return out.set(battery[0], 2.5, battery[2]);
    }
    case 'ev': {
      const { ev } = anchorsFor(type);
      return out.set(ev[0] + evRun(type) / 2, 2.5, ev[2]);
    }
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
  /** Bay count and zone count: the close-ups size themselves off the real site. */
  evBays: number;
  hvacZones: number;
}

export function CameraRig({ type, activeNodes, evBays, hvacZones }: CameraRigProps) {
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const store = useSelectionStore();
  const selected = useSelected();
  const reduced = useReducedMotion();

  const lot = useMemo(() => lotBounds(type), [type]);
  /* Allocating a Vector3 per frame is the one thing a rig must not do, so the
     shot is resolved once per selection and then only read. */
  const shot = useMemo(
    () => (selected ? shotFor(selected, type, { evBays, hvacZones }) : null),
    [selected, type, evBays, hvacZones],
  );

  /* Current (damped) state. Snapped on a building switch: a different subject
     is a cut, not a move. */
  const target = useRef(lot.target.clone());
  const radius = useRef(0);
  const azimuth = useRef(AZIMUTH_DEG);
  const elevation = useRef(ELEVATION_DEG);
  /* The drag offset, damped separately and much harder. */
  const lookAz = useRef(0);
  const lookEl = useRef(0);
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
    let desiredAzimuth = AZIMUTH_DEG;
    let desiredElevation = ELEVATION_DEG;
    /* The lean is the agent's; the shot is the viewer's, and the viewer wins. */
    let lambda = LAMBDA;

    if (shot) {
      lambda = SHOT_LAMBDA;
      desiredAzimuth = shot.azimuthDeg;
      desiredElevation = shot.elevationDeg;
      if (shot.homeScale) {
        desiredRadius = cache.radius * shot.homeScale;
      } else {
        desired.copy(shot.target);
        desiredRadius = shot.distance;
      }
    } else if (activeNodes.size > 0) {
      const offset = scratch.offset.set(0, 0, 0);
      for (const node of activeNodes) {
        offset.add(nodePosition(node, type, scratch.node));
      }
      offset.divideScalar(activeNodes.size).sub(lot.target);
      offset.clampLength(0, MAX_FOCUS_SHIFT);
      desired.add(offset);
      desiredRadius *= FOCUS_ZOOM;
    }

    if (reduced) {
      target.current.copy(desired);
      radius.current = desiredRadius;
      azimuth.current = desiredAzimuth;
      elevation.current = desiredElevation;
      lookAz.current = store.look.az;
      lookEl.current = store.look.el;
    } else {
      const k = 1 - Math.exp(-lambda * dt);
      target.current.lerp(desired, k);
      radius.current = THREE.MathUtils.damp(radius.current, desiredRadius, lambda, dt);
      azimuth.current = THREE.MathUtils.damp(azimuth.current, desiredAzimuth, lambda, dt);
      elevation.current = THREE.MathUtils.damp(elevation.current, desiredElevation, lambda, dt);
      lookAz.current = THREE.MathUtils.damp(lookAz.current, store.look.az, DRAG_LAMBDA, dt);
      lookEl.current = THREE.MathUtils.damp(lookEl.current, store.look.el, DRAG_LAMBDA, dt);
    }

    const dir = viewDirection(
      scratch.dir,
      azimuth.current + lookAz.current,
      elevation.current + lookEl.current,
    ).multiplyScalar(radius.current);
    camera.position.copy(target.current).add(dir);
    camera.lookAt(target.current);
  });

  return <PerspectiveCamera ref={cameraRef} makeDefault fov={FOV} near={1} far={600} />;
}

export default CameraRig;
