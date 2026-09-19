/**
 * Conduit routing.
 *
 * Every device is wired to the junction box on the building's front (+z) face.
 * Two shapes of run exist:
 *
 *   ground  device -> (around the building if it is behind/beside it)
 *           -> the front lane -> junction, held 0.3 m above grade
 *   roof    device -> roof front edge -> straight down the front face,
 *           0.4 m proud of it -> junction
 *
 * The control points are deliberately sparse; the curve is centripetal
 * Catmull-Rom, which (unlike uniform) cannot cusp or overshoot into the
 * building at the corners.
 */

import { Vector3 } from 'three';
import type { BuildingType } from '@/types/api';
import { BUILDING_SPECS, junction, roofY } from '../layout';

/** Ground runs float this far above grade so they read against the pad. */
const GROUND_Y = 0.3;
/** Clearance between the building footprint and any routing lane. */
const CLEARANCE = 3.5;
/** How far a vertical face run stands off the wall. */
const FACE_OFFSET = 0.4;

/** Catmull-Rom divides by segment length; coincident points would produce NaN. */
function dedupe(points: Vector3[]): Vector3[] {
  const out: Vector3[] = [];
  for (const p of points) {
    if (out.length === 0 || out[out.length - 1].distanceTo(p) > 0.05) out.push(p);
  }
  return out;
}

/**
 * A ground device's run. Devices already in front of the building get a gentle
 * S-curve down the front lane; devices behind or beside it are taken out to a
 * side lane clear of the footprint first, so no conduit ever tunnels through
 * the building.
 */
export function groundConduit(type: BuildingType, from: readonly [number, number, number]): Vector3[] {
  const [width, depth] = BUILDING_SPECS[type].footprint;
  const halfW = width / 2;
  const halfD = depth / 2;
  const laneZ = halfD + CLEARANCE;
  const end = junction(type);
  const x0 = from[0];
  const z0 = from[2];

  const points = [new Vector3(x0, GROUND_Y, z0)];
  if (z0 >= laneZ) {
    // Already clear of the footprint in z: sweep in along the front.
    points.push(new Vector3(x0 * 0.62, GROUND_Y, z0 * 0.55 + laneZ * 0.45));
    points.push(new Vector3(x0 * 0.22, GROUND_Y, laneZ));
  } else {
    const side = x0 < 0 ? -1 : 1;
    const sideX = side * Math.max(Math.abs(x0), halfW + CLEARANCE);
    points.push(new Vector3(sideX, GROUND_Y, z0));
    points.push(new Vector3(sideX, GROUND_Y, laneZ));
    points.push(new Vector3(sideX * 0.35, GROUND_Y, laneZ));
  }
  points.push(new Vector3(end[0], end[1], end[2]));
  return dedupe(points);
}

/**
 * A rooftop device's run: across the roof to the front edge, over it, then
 * straight down the facade to the junction. `dropX` separates the solar and
 * HVAC descents so they do not overlap on the way down.
 */
export function roofConduit(
  type: BuildingType,
  from: readonly [number, number, number],
  dropX: number,
): Vector3[] {
  const [, depth] = BUILDING_SPECS[type].footprint;
  const halfD = depth / 2;
  const top = roofY(type);
  const faceZ = halfD + FACE_OFFSET;
  const end = junction(type);
  return dedupe([
    new Vector3(from[0], from[1], from[2]),
    // Reach the front edge in the device's own lane, then cross to the drop
    // line -- a diagonal across the roof would run over the panel array.
    new Vector3(from[0], top + 0.35, halfD - 0.8),
    new Vector3(dropX, top - Math.min(1.4, top * 0.2), faceZ),
    new Vector3(dropX, Math.min(1.8, top * 0.25), faceZ),
    new Vector3(end[0], end[1], end[2]),
  ]);
}

/**
 * Where the solar conduit leaves the array: the clear margin strip down the -x
 * side of the roof, never on top of a panel.
 */
export function solarOrigin(type: BuildingType): [number, number, number] {
  const [width, depth] = BUILDING_SPECS[type].footprint;
  return [-(width / 2 - 1.2), roofY(type) + 0.45, -depth * 0.05];
}

/** Where the HVAC conduit leaves the rooftop units. */
export function hvacOrigin(type: BuildingType): [number, number, number] {
  const [, depth] = BUILDING_SPECS[type].footprint;
  return [1.6, roofY(type) + 0.55, depth / 2 - 3.2];
}

export const SOLAR_DROP_X = -1.5;
export const HVAC_DROP_X = 1.5;
