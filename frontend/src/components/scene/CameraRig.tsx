'use client';

/**
 * The only camera in the scene, and it still does not orbit.
 *
 * It now has two homes rather than one, and they are the same rig:
 *
 *   portfolio  straight down over the campus. Azimuth 0, elevation 90, a
 *              distance solved to fit `campusBounds()`. With the up vector
 *              below that puts north (-z) at the top of the frame and +x to
 *              the right -- a site plan, not a game camera.
 *   site       the original three-quarter view from the front-right corner of
 *              ONE lot, translated by that site's campus offset. Every device
 *              close-up from `interaction/shots` gets the same translation, so
 *              the shot table stays authored in site-local metres.
 *
 * Because both are just (target, azimuth, elevation, radius), the flight
 * between them is the rig's own damping and not a second code path: leaving the
 * campus walks the elevation 90 -> 30 and the azimuth 0 -> 40 while the target
 * travels to the lot, which reads exactly as "top-down, tilt, arrive". Coming
 * back runs the same numbers the other way. LEVEL_LAMBDA is tuned so the whole
 * move settles in about 900 ms.
 *
 * The up vector is the reason the top-down view works at all. A camera looking
 * straight down cannot use world up -- `lookAt` degenerates -- so every framing
 * here takes the *tangent* up: the direction the camera would move if you
 * raised its elevation. At elevation 0 that is world up, at 90 it is -z rotated
 * by the azimuth, and it is continuous and non-degenerate in between, which is
 * what makes the tilt a single smooth move.
 *
 * The distance is not a magic number either. `fitRadius` projects the eight
 * corners of the box onto the camera basis and solves for the smallest distance
 * that keeps all of them inside the frustum, so a 12-storey tower, a 40 m shed
 * and a 250 m campus are each framed correctly and a resize re-solves rather
 * than crops.
 *
 * The two concessions from before are unchanged and both are site-level only:
 * the agent's lean toward whatever tool is in flight, and the viewer's drag
 * offset on top of a selected close-up. At portfolio level neither applies --
 * nothing is selected, so there is nothing to look around.
 *
 * Under `prefers-reduced-motion` every one of these transitions is a cut.
 */

import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import type { BuildingType } from '@/types/api';
import type { ViewLevel } from '@/lib/store';
import {
  BUILDING_SPECS,
  type GroundAnchor,
  anchorsFor,
  evRun,
  focusHeight,
  ridgeY,
  roofY,
  type SceneNode,
} from './layout';
import { SITE_OFFSETS, campusBounds } from './world';
import { useSelected, useSelectionStore } from './interaction/selection';
import { shotFor } from './interaction/shots';

const FOV = 28;
/** Off the front-right corner, so the +z entrance and the +x EV bays both read. */
const AZIMUTH_DEG = 40;
/** Above the horizon. Shallow enough to keep facades, steep enough to read the plan. */
const ELEVATION_DEG = 30;
/** Straight down, due north. The campus is a plan drawing. */
const TOP_AZIMUTH_DEG = 0;
const TOP_ELEVATION_DEG = 90;
/** Breathing room once the exact fit has been solved. */
const FIT_MARGIN = 1.08;
/**
 * ...and a little less at portfolio. `campusBounds` already reserves head-room
 * above the tallest ridge for the label pills, and at 250 m across every extra
 * percent of margin comes straight off the size of the buildings.
 */
const CAMPUS_FIT_MARGIN = 1.06;

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
/** Campus <-> site. ~900 ms: far enough to travel, short enough not to wait. */
const LEVEL_LAMBDA = 3;
/** The drag offset rides on top and has to feel attached to the hand. */
const DRAG_LAMBDA = 14;

const DEG = Math.PI / 180;

interface Frame {
  min: THREE.Vector3;
  max: THREE.Vector3;
  /** Resting look-at. */
  target: THREE.Vector3;
}

/** Everything that has to be in frame for one lot, in SITE-LOCAL metres. */
function lotBounds(type: BuildingType): Frame {
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
 * scene -- campus, home, agent lean and every close-up -- is one of these.
 */
function viewDirection(out: THREE.Vector3, azimuthDeg: number, elevationDeg: number) {
  const el = elevationDeg * DEG;
  const az = azimuthDeg * DEG;
  return out
    .set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    .normalize();
}

/**
 * Screen-up for that same framing: the derivative of `viewDirection` with
 * respect to elevation, which is by construction perpendicular to it at every
 * angle including 90. At elevation 0 it is (0, 1, 0); at 90 with azimuth 0 it
 * is (0, 0, -1), i.e. north at the top of the frame.
 */
function tangentUp(out: THREE.Vector3, azimuthDeg: number, elevationDeg: number) {
  const el = elevationDeg * DEG;
  const az = azimuthDeg * DEG;
  return out
    .set(-Math.sin(az) * Math.sin(el), Math.cos(el), -Math.cos(az) * Math.sin(el))
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
 * Smallest distance along the view direction that keeps every corner of the box
 * inside the frustum. For a corner at camera-space (x, y, z), staying in frame
 * needs `|x| <= (distance - z) * tan(halfFov)`, which rearranges to a lower
 * bound on the distance; the answer is the largest bound over all eight
 * corners.
 *
 * The basis is built from the tangent up rather than from world up, so this
 * works at elevation 90 where world up is parallel to the view direction.
 */
function fitRadius(
  frame: Frame,
  aspect: number,
  azimuthDeg: number,
  elevationDeg: number,
  margin: number,
): number {
  const dir = viewDirection(new THREE.Vector3(), azimuthDeg, elevationDeg);
  const up = tangentUp(new THREE.Vector3(), azimuthDeg, elevationDeg);
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();

  const halfV = Math.tan((FOV / 2) * DEG);
  const halfH = halfV * aspect;

  const corner = new THREE.Vector3();
  let radius = 0;

  for (const x of [frame.min.x, frame.max.x]) {
    for (const y of [frame.min.y, frame.max.y]) {
      for (const z of [frame.min.z, frame.max.z]) {
        corner.set(x, y, z).sub(frame.target);
        const depth = corner.dot(dir);
        radius = Math.max(
          radius,
          Math.abs(corner.dot(right)) / halfH + depth,
          Math.abs(corner.dot(up)) / halfV + depth,
        );
      }
    }
  }

  return radius * margin;
}

/** World point the camera should lean toward, per lit node, in SITE-LOCAL metres. */
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
  /** Which of the two homes the rig is heading for. */
  level: ViewLevel;
  /** The site types actually on the campus, so a partial world still frames. */
  campusTypes: readonly BuildingType[];
}

export function CameraRig({
  type,
  activeNodes,
  evBays,
  hvacZones,
  level,
  campusTypes,
}: CameraRigProps) {
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const store = useSelectionStore();
  const selected = useSelected();
  const reduced = useReducedMotion();

  const lot = useMemo(() => lotBounds(type), [type]);
  /** This site's origin on the campus; every site-level target is offset by it. */
  const offset = useMemo(() => {
    const o = SITE_OFFSETS[type];
    return new THREE.Vector3(o[0], o[1], o[2]);
  }, [type]);

  const campusKey = campusTypes.join(',');
  const campus = useMemo(
    () => {
      const bounds = campusBounds(campusTypes);
      return {
        min: bounds.min,
        max: bounds.max,
        target: bounds.centre.clone(),
      } satisfies Frame;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [campusKey],
  );

  /* Allocating a Vector3 per frame is the one thing a rig must not do, so the
     shot is resolved once per selection and then only read. */
  const shot = useMemo(
    () => (selected ? shotFor(selected, type, { evBays, hvacZones }) : null),
    [selected, type, evBays, hvacZones],
  );

  /* Current (damped) state. Seeded on the campus, which is where the page
     always opens; the first frame snaps whatever level is actually asked for. */
  const target = useRef(campus.target.clone());
  const radius = useRef(0);
  const azimuth = useRef(TOP_AZIMUTH_DEG);
  const elevation = useRef(TOP_ELEVATION_DEG);
  /* The drag offset, damped separately and much harder. */
  const lookAz = useRef(0);
  const lookEl = useRef(0);
  const fitted = useRef({ lot, campus, aspect: 0, site: 0, world: 0 });

  /* Scratch, so useFrame allocates nothing. */
  const scratch = useMemo(
    () => ({
      dir: new THREE.Vector3(),
      up: new THREE.Vector3(),
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

    /* Re-solve both framings only when a subject or the panel size changes. */
    const cache = fitted.current;
    if (cache.lot !== lot || cache.campus !== campus || cache.aspect !== camera.aspect) {
      cache.lot = lot;
      cache.campus = campus;
      cache.aspect = camera.aspect;
      const aspect = camera.aspect || 16 / 9;
      cache.site = fitRadius(lot, aspect, AZIMUTH_DEG, ELEVATION_DEG, FIT_MARGIN);
      cache.world = fitRadius(
        campus,
        aspect,
        TOP_AZIMUTH_DEG,
        TOP_ELEVATION_DEG,
        CAMPUS_FIT_MARGIN,
      );
    }

    const portfolio = level === 'portfolio';

    /* Rest, per level. */
    const desired = scratch.desired;
    let desiredRadius: number;
    let desiredAzimuth: number;
    let desiredElevation: number;
    /* The level flight outranks the agent's lean and matches the shot move. */
    let lambda = portfolio ? LEVEL_LAMBDA : LAMBDA;

    if (portfolio) {
      desired.copy(campus.target);
      desiredRadius = cache.world;
      desiredAzimuth = TOP_AZIMUTH_DEG;
      desiredElevation = TOP_ELEVATION_DEG;
    } else {
      desired.copy(lot.target).add(offset);
      desiredRadius = cache.site;
      desiredAzimuth = AZIMUTH_DEG;
      desiredElevation = ELEVATION_DEG;

      if (shot) {
        lambda = SHOT_LAMBDA;
        desiredAzimuth = shot.azimuthDeg;
        desiredElevation = shot.elevationDeg;
        if (shot.homeScale) {
          desiredRadius = cache.site * shot.homeScale;
        } else {
          desired.copy(shot.target).add(offset);
          desiredRadius = shot.distance;
        }
      } else if (activeNodes.size > 0) {
        const lean = scratch.offset.set(0, 0, 0);
        for (const node of activeNodes) {
          lean.add(nodePosition(node, type, scratch.node));
        }
        lean.divideScalar(activeNodes.size).add(offset).sub(desired);
        lean.clampLength(0, MAX_FOCUS_SHIFT);
        desired.add(lean);
        desiredRadius *= FOCUS_ZOOM;
      }
    }

    /* Crossing between levels is the long move; damp it at LEVEL_LAMBDA even
       when the destination is a close-up, so the flight has one rhythm. */
    if (Math.abs(elevation.current - desiredElevation) > 25) lambda = LEVEL_LAMBDA;

    /* The first frame is not a transition: the page opens ON the campus. */
    const seed = radius.current === 0;

    if (reduced || seed) {
      target.current.copy(desired);
      radius.current = desiredRadius;
      azimuth.current = desiredAzimuth;
      elevation.current = desiredElevation;
      lookAz.current = portfolio ? 0 : store.look.az;
      lookEl.current = portfolio ? 0 : store.look.el;
    } else {
      const k = 1 - Math.exp(-lambda * dt);
      target.current.lerp(desired, k);
      radius.current = THREE.MathUtils.damp(radius.current, desiredRadius, lambda, dt);
      azimuth.current = THREE.MathUtils.damp(azimuth.current, desiredAzimuth, lambda, dt);
      elevation.current = THREE.MathUtils.damp(elevation.current, desiredElevation, lambda, dt);
      /* No drag-look on the campus: nothing is selected, so there is nothing
         to look around. */
      const wantAz = portfolio ? 0 : store.look.az;
      const wantEl = portfolio ? 0 : store.look.el;
      lookAz.current = THREE.MathUtils.damp(lookAz.current, wantAz, DRAG_LAMBDA, dt);
      lookEl.current = THREE.MathUtils.damp(lookEl.current, wantEl, DRAG_LAMBDA, dt);
    }

    const az = azimuth.current + lookAz.current;
    const el = elevation.current + lookEl.current;

    const dir = viewDirection(scratch.dir, az, el).multiplyScalar(radius.current);
    camera.up.copy(tangentUp(scratch.up, az, el));
    camera.position.copy(target.current).add(dir);
    camera.lookAt(target.current);
  });

  /* `far` has to clear the whole campus from 400 m up, which is a very
     different number from the one a single lot needed. */
  return <PerspectiveCamera ref={cameraRef} makeDefault fov={FOV} near={1} far={1600} />;
}

export default CameraRig;
