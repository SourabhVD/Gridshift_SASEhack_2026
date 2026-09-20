/**
 * The campus. Where the four lots stand relative to each other, and to the
 * substation that feeds them.
 *
 * `layout.ts` describes ONE site in its own coordinates -- footprint centred on
 * the origin, transformer at x = -24, EV bays running out to x = +54. Nothing
 * in that file knows there is more than one building. This module is the layer
 * above it: every site keeps its local plan exactly as authored and is simply
 * translated by `SITE_OFFSETS[type]`, so a device anchor in world space is
 * always `anchorsFor(type).grid + siteWorld(type)` and never a second set of
 * numbers that can drift.
 *
 * The offsets are not free. Each lot's real extents -- grid anchor on one side,
 * the far end of the charging court on the other -- have to clear every other
 * lot and the substation yard by at least CLEARANCE metres, or the world reads
 * as four dioramas pushed together. `worldLotBox()` computes those extents from
 * the same constants the props are built from, and `checkCampus()` asserts the
 * clearance; the test is cheap enough to run once in dev.
 *
 * Layout, looking straight down with north (-z) up:
 *
 *        office                        hospital
 *                      SUBSTATION
 *        residence                     warehouse
 *
 * Orientation matters: the substation sits at the origin because every feed
 * line and every service road starts there, and a hub at the centre of the
 * frame is what makes the campus read as one system rather than as four.
 */

import { Vector3 } from 'three';
import type { BuildingType } from '@/types/api';
import { BUILDING_SPECS, type GroundAnchor, anchorsFor, evRun, ridgeY } from './layout';

/* -------------------------------------------------------------------------- */
/* Offsets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where each site's local origin sits on the campus, in metres.
 *
 * Keyed by type rather than by building id on purpose: the id is a fixture
 * detail, the type is the contract every other module in this folder already
 * switches on.
 */
export const SITE_OFFSETS: Record<BuildingType, readonly [number, number, number]> = {
  office: [-95, 0, -68],
  hospital: [72, 0, -72],
  warehouse: [78, 0, 72],
  residence: [-82, 0, 60],
};

/** The campus origin: the substation, and the hub every feed line leaves from. */
export const SUBSTATION_ORIGIN: readonly [number, number, number] = [0, 0, 0];

/** Fenced yard, in metres. Two transformer bays plus the bus gantry behind them. */
export const SUBSTATION_YARD: readonly [number, number] = [26, 18];

/**
 * Where a feed line leaves the substation: the busbar, on the yard's +z face
 * and a little above grade so the conduit does not graze the paving.
 */
export const SUBSTATION_BUS: readonly [number, number, number] = [0, 1.4, 0];

/** Minimum gap between any two lot boxes, and between a lot and the yard. */
export const CLEARANCE = 25;

/** This site's local origin in world space. Allocates; call it from a memo. */
export function siteWorld(type: BuildingType): Vector3 {
  const offset = SITE_OFFSETS[type];
  return new Vector3(offset[0], offset[1], offset[2]);
}

/** Translate a site-local point into world space, without allocating a Vector3. */
export function toWorld(
  type: BuildingType,
  local: readonly [number, number, number],
): [number, number, number] {
  const o = SITE_OFFSETS[type];
  return [local[0] + o[0], local[1] + o[1], local[2] + o[2]];
}

/* -------------------------------------------------------------------------- */
/* Extents                                                                     */
/* -------------------------------------------------------------------------- */

/** An axis-aligned ground footprint, in world metres. */
export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Slack around the props, so a lot pad is not flush with the last bollard. */
const LOT_MARGIN = 6;

/**
 * One site's ground footprint in its OWN coordinates.
 *
 * Same derivation as `Environment.lotOf`: the shell, plus every ground anchor,
 * plus the run the charging court occupies out along +x. Kept here rather than
 * reused from there because that function also folds in a shadow-frustum
 * height term this has no use for.
 */
export function localLotBox(type: BuildingType): Box {
  const [width, depth] = BUILDING_SPECS[type].footprint;
  const anchors = anchorsFor(type);
  const ground: GroundAnchor[] =
    anchors.battery === 'wall'
      ? [anchors.grid, anchors.ev]
      : [anchors.grid, anchors.battery, anchors.ev];

  const xs = ground.map((a) => a[0]);
  const zs = ground.map((a) => a[2]);

  return {
    minX: Math.min(-width / 2, ...xs) - LOT_MARGIN,
    maxX: Math.max(width / 2, anchors.ev[0] + evRun(type), ...xs) + LOT_MARGIN,
    minZ: Math.min(-depth / 2, ...zs) - LOT_MARGIN,
    maxZ: Math.max(depth / 2, ...zs) + LOT_MARGIN,
  };
}

/** The same box, translated onto the campus. */
export function worldLotBox(type: BuildingType): Box {
  const box = localLotBox(type);
  const o = SITE_OFFSETS[type];
  return {
    minX: box.minX + o[0],
    maxX: box.maxX + o[0],
    minZ: box.minZ + o[2],
    maxZ: box.maxZ + o[2],
  };
}

/** The substation yard's own box, with the same margin every lot gets. */
export function yardBox(): Box {
  const [w, d] = SUBSTATION_YARD;
  return {
    minX: -w / 2 - LOT_MARGIN,
    maxX: w / 2 + LOT_MARGIN,
    minZ: -d / 2 - LOT_MARGIN,
    maxZ: d / 2 + LOT_MARGIN,
  };
}

/** Centre of a box, on the ground plane. */
export function boxCentre(box: Box): [number, number] {
  return [(box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2];
}

/* -------------------------------------------------------------------------- */
/* Campus bounds                                                               */
/* -------------------------------------------------------------------------- */

export interface CampusBounds {
  min: Vector3;
  max: Vector3;
  /** Ground-plane centre; what the top-down camera looks at. */
  centre: Vector3;
  /** Half-extents in x and z, for the camera fit. */
  halfX: number;
  halfZ: number;
}

/**
 * Everything the top-down view has to hold: four lots, the yard, and enough
 * head-room above the tallest ridge that a label pill is not clipped.
 *
 * `types` lets a partially loaded campus frame only the sites it actually has;
 * with no argument it frames all four, which is what the world always is.
 */
export function campusBounds(types?: readonly BuildingType[]): CampusBounds {
  const list = types && types.length > 0 ? types : (Object.keys(SITE_OFFSETS) as BuildingType[]);

  const boxes = [yardBox(), ...list.map(worldLotBox)];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let top = 0;

  for (const box of boxes) {
    minX = Math.min(minX, box.minX);
    maxX = Math.max(maxX, box.maxX);
    minZ = Math.min(minZ, box.minZ);
    maxZ = Math.max(maxZ, box.maxZ);
  }
  for (const type of list) top = Math.max(top, ridgeY(type));

  return {
    min: new Vector3(minX, 0, minZ),
    max: new Vector3(maxX, top + 6, maxZ),
    centre: new Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2),
    halfX: (maxX - minX) / 2,
    halfZ: (maxZ - minZ) / 2,
  };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

/** Height of the feed conduits above grade. Matches `devices/paths.GROUND_Y`. */
export const FEED_Y = 0.3;

/**
 * The four control points a feed line and its service road share.
 *
 * Two waypoints rather than a straight line: the run leaves the substation
 * square to the yard, then sweeps to the site's grid anchor. A single segment
 * would read as a ruler drawn between two pins.
 */
export function feedRoute(type: BuildingType): Vector3[] {
  const anchors = anchorsFor(type);
  const end = toWorld(type, [anchors.grid[0], FEED_Y, anchors.grid[2]]);
  const start = new Vector3(SUBSTATION_BUS[0], FEED_Y, SUBSTATION_BUS[2]);
  const finish = new Vector3(end[0], FEED_Y, end[2]);

  const toward = finish.clone().sub(start);
  const lead = Math.sign(toward.z || 1) * Math.max(14, Math.abs(toward.z) * 0.18);

  return [
    start,
    new Vector3(start.x, FEED_Y, start.z + lead),
    new Vector3(start.x + toward.x * 0.55, FEED_Y, start.z + toward.z * 0.72),
    finish,
  ];
}

/* -------------------------------------------------------------------------- */
/* Dev-time self-check                                                         */
/* -------------------------------------------------------------------------- */

export interface CampusViolation {
  a: string;
  b: string;
  gap: number;
}

/** Shortest gap between two axis-aligned boxes. Negative means they overlap. */
function boxGap(a: Box, b: Box): number {
  const dx = Math.max(b.minX - a.maxX, a.minX - b.maxX);
  const dz = Math.max(b.minZ - a.maxZ, a.minZ - b.maxZ);
  /* Diagonal neighbours are clear as soon as EITHER axis separates them. */
  return Math.max(dx, dz);
}

/**
 * Every pair of lots, and every lot against the yard, at or beyond CLEARANCE.
 * Pure; `Campus.tsx` calls it once in dev and warns.
 */
export function checkCampus(): CampusViolation[] {
  const types = Object.keys(SITE_OFFSETS) as BuildingType[];
  const named: Array<[string, Box]> = [
    ['substation', yardBox()],
    ...types.map((type) => [type, worldLotBox(type)] as [string, Box]),
  ];

  const violations: CampusViolation[] = [];
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      const gap = boxGap(named[i][1], named[j][1]);
      if (gap < CLEARANCE) {
        violations.push({ a: named[i][0], b: named[j][0], gap: Math.round(gap) });
      }
    }
  }
  return violations;
}
