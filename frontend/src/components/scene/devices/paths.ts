/**
 * Conduit routing.
 *
 * Every device is wired to the junction box on the building's front (+z) face.
 * On a commercial lot two shapes of run exist:
 *
 *   ground  device -> (around the building if it is behind/beside it)
 *           -> the front lane -> junction, held 0.3 m above grade
 *   roof    device -> roof front edge -> straight down the front face,
 *           0.4 m proud of it -> junction
 *
 * The control points are deliberately sparse; the curve is centripetal
 * Catmull-Rom, which (unlike uniform) cannot cusp or overshoot into the
 * building at the corners.
 *
 * The residence is a different animal -- everything is within 20 m of the meter
 * and the runs are domestic conduit, not buried feeders -- so it gets hand-laid
 * curves instead, below. They share one rule: the five runs converge on the
 * junction at five different heights down the -x gable corner, which is what
 * keeps them from knitting together into a single grey rope.
 */

import { Vector3 } from 'three';
import type { BuildingType } from '@/types/api';
import { BUILDING_SPECS, RESIDENCE_WALL_BATTERY, junction, ridgeY, roofY } from '../layout';

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

/* -------------------------------------------------------------------------- */
/* Commercial                                                                  */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Residence                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fixed points on the single-family lot that more than one prop needs to agree
 * about. These are the coordinates the House model has to respect: anything
 * here that the house does not actually have a wall at will float.
 *
 *   pole        utility pole, = anchorsFor('residence').grid
 *   eave        where the service drop lands, on the -x gable wall
 *   meter       wall meter box, just up-wall of the junction
 *   gableX      the -x gable wall plane; wall-mounted kit hangs off this
 *   frontZ      the front (+z) wall plane, where the junction lives
 *   charger     wall EV charger, on the front-left post
 *   heatPump    ground-pad heat pump, +x side
 *   bay         the drive bay, = anchorsFor('residence').ev
 */
export const RESIDENCE = {
  pole: [-12, 0, 6] as const,
  eave: [-7, 6, 4] as const,
  /** On the -x gable, not the front wall: the front-left is taken by the EV charger. */
  meter: [-7.09, 1.5, 4.6] as const,
  /** BUILDING_SPECS.residence is 14 x 10, so the gable wall is at -7; runs sit 80 mm proud. */
  gableX: -7.08,
  /** ...and the front wall at +5. Note `junction('residence')` stands 0.3 m proud of it. */
  frontZ: 5,
  charger: [-6.4, 1.4, 5.07] as const,
  heatPump: [7.6, 0, 2.5] as const,
  bay: [9, 0, 6] as const,
} as const;

/** Rooftop PV on the house is modelled by the House itself; we only tap its -x rake. */
export function residenceSolarOrigin(): [number, number, number] {
  return [-6.6, ridgeY('residence') - 0.25, 0];
}

export type ResidenceRun = 'grid' | 'solar' | 'battery' | 'ev' | 'hvac';

/**
 * The five domestic runs.
 *
 * `grid` doubles as the overhead service drop -- the pole prop deliberately
 * stops at its insulator so the span you see is the live conduit, beads and
 * all, rather than a dead line drawn twice.
 */
export function residenceConduit(run: ResidenceRun): Vector3[] {
  const end = junction('residence');
  const j = new Vector3(end[0], end[1], end[2]);
  const gx = RESIDENCE.gableX;

  switch (run) {
    case 'grid':
      return dedupe([
        // Pole insulator -> catenary sag -> eave -> down the gable -> meter.
        new Vector3(RESIDENCE.pole[0], 7.9, RESIDENCE.pole[2] - 0.62),
        new Vector3(-9.5, 6.55, 4.9),
        new Vector3(RESIDENCE.eave[0] - 0.06, RESIDENCE.eave[1], RESIDENCE.eave[2]),
        new Vector3(gx, 3.8, 4.3),
        new Vector3(RESIDENCE.meter[0] - 0.02, RESIDENCE.meter[1] + 0.3, RESIDENCE.meter[2]),
        new Vector3(gx, 0.85, 5),
        j,
      ]);

    case 'solar': {
      // Down the gable rake, passing above the wall battery (its top is 1.78).
      const from = residenceSolarOrigin();
      return dedupe([
        new Vector3(from[0], from[1], from[2]),
        new Vector3(gx, 5.6, 1),
        new Vector3(gx, 2.55, 3.2),
        new Vector3(gx, 2.35, 4.85),
        new Vector3(-6.75, 1.05, 5.3),
        j,
      ]);
    }

    case 'battery':
      // Out of the bottom of the wall units and along the wall below them.
      return dedupe([
        new Vector3(gx - 0.14, RESIDENCE_WALL_BATTERY[1] - 0.6, RESIDENCE_WALL_BATTERY[2]),
        new Vector3(gx, 0.45, 2.8),
        new Vector3(gx, 0.42, 4.6),
        new Vector3(-6.8, 0.42, 5.28),
        j,
      ]);

    case 'ev':
      // Along the front lawn edge, outboard of the HVAC run.
      return dedupe([
        new Vector3(RESIDENCE.bay[0], 0.14, RESIDENCE.bay[2]),
        new Vector3(4.5, 0.14, 6.4),
        new Vector3(-1.5, 0.14, 6.3),
        new Vector3(-5.5, 0.22, 5.9),
        j,
      ]);

    case 'hvac':
    default:
      // Hugs the wall, inboard of the EV run.
      return dedupe([
        new Vector3(RESIDENCE.heatPump[0], 0.45, RESIDENCE.heatPump[2]),
        new Vector3(7.9, 0.2, 4.4),
        new Vector3(4, 0.2, 5.6),
        new Vector3(-2, 0.2, 5.58),
        new Vector3(-5.7, 0.3, 5.42),
        j,
      ]);
  }
}
