/**
 * One composed close-up per node, per site.
 *
 * A shot is four numbers -- where to look, from which bearing, from how high
 * up, and how far back -- and the camera rig turns those into a position the
 * same way it builds the home view, so a selection is a *move* along the same
 * spherical rig rather than a cut to a second camera.
 *
 *   target        world point the camera looks at; derived from the real
 *                 anchors (`anchorsFor`, `RESIDENCE_WALL_BATTERY`, `roofY`,
 *                 and the residence constants in devices/paths) so a shot
 *                 cannot drift away from the geometry it is framing
 *   azimuthDeg    bearing of the camera FROM the target, measured off +z
 *                 toward +x -- the same convention as the rig's home azimuth
 *   elevationDeg  height angle above the horizon
 *   distance      metres along that bearing
 *
 * Two rules decide the azimuths. The sun runs from -102 deg (front-left, in the
 * morning) through 0 to +102 deg over the day, so a camera placed on the
 * opposite side of the subject gets the key light across the object rather than
 * flat down the lens; and the building has to sit behind or beside the subject,
 * never between it and the camera -- which is why the battery, parked behind a
 * 40 m warehouse, is shot from outside the lot corner rather than head-on.
 *
 * Elevations stay in the 18-32 deg band that keeps a prop looking like a thing
 * standing on the ground. The two exceptions are the arrays, which are only
 * legible from above and get 50 deg.
 *
 * The distances are not free choices either. The rig shoots at a 28 deg
 * vertical field of view -- a long lens, chosen for the home view so the site
 * reads as an architectural render rather than a game camera -- and at that
 * angle a subject `d` metres away is framed inside about `0.50 d` metres of
 * height and `0.89 d` of width at 16:9. Every distance below was solved from
 * the thing being framed: a 9 m utility pole needs 16 m, a 1.15 m wall battery
 * needs 5.5, and the rooftop plant needs a distance that grows with the number
 * of units on the roof.
 */

import { Vector3 } from 'three';
import type { BuildingType } from '@/types/api';
import { ANCHORS, BUILDING_SPECS, roofY } from '../layout';
import { RESIDENCE } from '../devices/paths';

export interface Shot {
  target: Vector3;
  azimuthDeg: number;
  elevationDeg: number;
  /** Metres from the target. Ignored when `homeScale` is set. */
  distance: number;
  /**
   * The building shot is the home view pulled in: it inherits the rig's own
   * fitted radius, which is the only distance that frames a 12-storey tower and
   * a single-storey shed alike.
   */
  homeScale?: number;
}

/** Bay pitch, mirrored from devices/EvBays. */
const BAY_W = 2.6;
/** Bays actually modelled, mirrored from devices/common. */
const MAX_RENDERED_BAYS = 12;
/** Setback of the rooftop plant from the front edge, mirrored from RoofHvac. */
const HVAC_SETBACK = 3.2;
/** Centre-to-centre spacing of the rooftop units, mirrored from RoofHvac. */
const HVAC_SPACING = 3.4;
const HVAC_MAX_UNITS = 4;
/** Width of the frame, in metres, per metre of distance at FOV 28 and 16:9. */
const FRAME_WIDTH_PER_M = 0.886;

/** The home bearing, so 'building' pulls straight in along the resting view. */
export const HOME_AZIMUTH_DEG = 40;
export const HOME_ELEVATION_DEG = 30;
/** How far the building shot closes in on the home framing. */
export const BUILDING_SHOT_SCALE = 0.8;

export type SceneNodeName = 'building' | 'grid' | 'solar' | 'battery' | 'ev' | 'hvac';

function renderedBays(evBays: number): number {
  return Math.max(1, Math.min(evBays, MAX_RENDERED_BAYS));
}

/** Units on the roof, mirrored from `devices/RoofHvac.unitCount`. */
function hvacUnits(hvacZones: number): number {
  return Math.max(1, Math.min(HVAC_MAX_UNITS, Math.round(hvacZones / 3)));
}

/** Everything about the site a shot has to size itself against. */
export interface SiteSize {
  evBays: number;
  hvacZones: number;
}

/* -------------------------------------------------------------------------- */
/* Residence                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The house is 14 x 10 m and everything on the lot is within 20 m of the meter,
 * so these are hand-placed rather than derived from a footprint: at four metres
 * a formula is never as good as looking at it.
 */
function residenceShot(node: SceneNodeName): Shot {
  switch (node) {
    case 'grid':
      // The whole pole -- can transformer, crossarm, service head -- with the
      // gable and its meter box behind it. Nine metres of pole needs a frame
      // about eight metres tall, hence the distance.
      return {
        target: new Vector3(RESIDENCE.pole[0], 4.2, RESIDENCE.pole[2]),
        azimuthDeg: -44,
        elevationDeg: 20,
        distance: 21,
      };
    case 'battery':
      // Square onto the -x gable the two wall units hang on, from the sunny
      // (+z, front) quarter so the powder-coated faces are not in wall shadow.
      return {
        target: new Vector3(-7.5, 1.25, 1.5),
        azimuthDeg: -78,
        elevationDeg: 16,
        distance: 4.8,
      };
    case 'ev':
      // From the street, square onto the drive: looking back along the lot
      // would put the house directly behind the car, so the camera stays in
      // front and lets the gable sit off to one side.
      return {
        target: new Vector3(9.4, 1.1, 6.2),
        azimuthDeg: 20,
        elevationDeg: 20,
        distance: 10,
      };
    case 'solar':
      // Down onto the front slope. The array centre is the House's own slope
      // group origin, (0, 7.41, 2.8).
      return {
        target: new Vector3(0, 7.4, 2.8),
        azimuthDeg: 16,
        elevationDeg: 50,
        distance: 22,
      };
    case 'hvac':
      // The heat pump's fan is on its +z face, so the camera stands off the
      // front-right corner of the pad.
      return {
        target: new Vector3(RESIDENCE.heatPump[0], 0.7, RESIDENCE.heatPump[2]),
        azimuthDeg: 42,
        elevationDeg: 20,
        distance: 4.5,
      };
    case 'building':
    default:
      return {
        target: new Vector3(),
        azimuthDeg: HOME_AZIMUTH_DEG,
        elevationDeg: HOME_ELEVATION_DEG,
        distance: 0,
        homeScale: BUILDING_SHOT_SCALE,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Commercial                                                                  */
/* -------------------------------------------------------------------------- */

function commercialShot(node: SceneNodeName, type: BuildingType, site: SiteSize): Shot {
  /* The three commercial sites share one lot plan, so the anchors are read
     straight off the constant rather than through `anchorsFor` -- which also
     has to answer 'wall' for the residence's battery. */
  const [, depth] = BUILDING_SPECS[type].footprint;
  const top = roofY(type);


  switch (node) {
    case 'grid': {
      // From outside the front-left corner of the lot, looking back in: the
      // transformer's door face reads and the pylon rakes off to the left.
      const [x, , z] = ANCHORS.grid;
      return {
        target: new Vector3(x - 1.2, 2.1, z),
        azimuthDeg: -26,
        elevationDeg: 22,
        distance: 12,
      };
    }
    case 'battery': {
      /* The cabinet stands behind the building, facing +z -- i.e. facing the
       * back wall. On the office and the hospital it is well clear of the
       * footprint in x, so a three-quarter view from the back-left sees its
       * face and its flank with nothing in the way.
       *
       * The warehouse is 40 m wide, which puts the same cabinet *under* the
       * building's own span with two metres of clearance behind the wall. Any
       * camera inboard of the back-left corner is then looking through that
       * wall, so the shot swings out past the grazing line through the corner
       * and backs off to keep the cabinet a reasonable size.
       */
      const [x, , z] = ANCHORS.battery;
      const [width] = BUILDING_SPECS[type].footprint;
      const toCornerX = -width / 2 - x;
      const toCornerZ = -depth / 2 - z;
      const blocked = toCornerX < 0;
      const grazingDeg = (Math.atan2(toCornerX, toCornerZ) * 180) / Math.PI;
      return {
        target: new Vector3(x, 1.5, z),
        azimuthDeg: blocked ? grazingDeg - 9 : -58,
        elevationDeg: blocked ? 26 : 24,
        distance: blocked ? 11 : 7,
      };
    }
    case 'ev': {
      // Stand off the far (+x) end and look back down the row: the nearest car
      // fills the foreground, the bays recede to the vanishing point, and the
      // building closes the composition at the end of the run.
      const [x, , z] = ANCHORS.ev;
      const rowW = renderedBays(site.evBays) * BAY_W;
      return {
        target: new Vector3(x + rowW * 0.46, 1.3, z),
        azimuthDeg: 60,
        elevationDeg: 19,
        distance: 14,
      };
    }
    case 'solar':
      // Arrays only read from above. Front-right and steep, so the tilted
      // laminates catch the sky rather than presenting their dark edge.
      return {
        target: new Vector3(0, top + 0.2, -depth * 0.05),
        azimuthDeg: 24,
        elevationDeg: 50,
        distance: 18,
      };
    case 'hvac': {
      // The plant sits on the front edge of the roof; the camera hangs just
      // outside the facade so the units stand against the sky. A warehouse
      // runs two units and an office four, so the distance is solved from the
      // run they actually occupy rather than fixed.
      const run = (hvacUnits(site.hvacZones) - 1) * HVAC_SPACING + 2.6;
      return {
        target: new Vector3(0, top + 1.1, depth / 2 - HVAC_SETBACK),
        azimuthDeg: 32,
        elevationDeg: 24,
        distance: Math.max(10, (run + 4) / FRAME_WIDTH_PER_M),
      };
    }
    case 'building':
    default:
      return {
        target: new Vector3(),
        azimuthDeg: HOME_AZIMUTH_DEG,
        elevationDeg: HOME_ELEVATION_DEG,
        distance: 0,
        homeScale: BUILDING_SHOT_SCALE,
      };
  }
}

/**
 * The close-up for one node on one site.
 *
 * Allocates, so call it from a memo rather than from `useFrame`. A shot with
 * `homeScale` carries no target of its own: the caller substitutes the rig's
 * resting look-at and fitted radius.
 */
export function shotFor(node: SceneNodeName, type: BuildingType, site: SiteSize): Shot {
  return type === 'residence' ? residenceShot(node) : commercialShot(node, type, site);
}

const ONE_OF_EACH: SiteSize = { evBays: 1, hvacZones: 3 };

/** The elevation a shot settles at, which is what the drag limits are measured from. */
export function shotElevation(node: SceneNodeName, type: BuildingType): number {
  return shotFor(node, type, ONE_OF_EACH).elevationDeg;
}
