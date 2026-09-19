'use client';

/**
 * The rooftop PV array: tilted laminates laid row by row inside the footprint
 * minus a 2 m perimeter margin, with the front-centre left clear for the HVAC
 * units. Each panel gets a dark frame a few millimetres proud of the glass and
 * sits on a pair of mounting rails, which is what stops a big array reading as
 * a sheet of navy paint.
 *
 * Panel count follows the nameplate at roughly one panel per 0.4 kW, capped at
 * 160 instances and by whatever actually fits. Rows fill from the back of the
 * roof forward, so a small array never crowds the plant.
 *
 * The glass takes a faint pale-blue emissive scaled by generation. It is
 * deliberately held well under the composer's 1.05 cut: a working array should
 * look like glass catching the sun, not like a light source.
 *
 * The residence has flush roof solar modelled by the House itself, so this
 * renders nothing there but the label -- the run down the gable still exists,
 * it just starts at the roof edge (see `paths.residenceSolarOrigin`).
 *
 * Draw calls: 2 commercial, 0 residence.
 */

import { useMemo } from 'react';
import type { Building } from '@/types/api';
import { formatKw } from '@/lib/format';
import { BUILDING_SPECS, roofY } from '../layout';
import { C, DORMANT_KW, MAT, clamp, isResidence } from './common';
import { Boxes, type Piece } from './Instanced';
import { NodeLabel } from './NodeLabel';
import { residenceSolarOrigin } from './paths';

const PANEL_W = 1.7;
const PANEL_D = 1.05;
const PANEL_T = 0.05;
const GAP_X = 0.22;
/** Tilt toward -z (south). The panel normal ends up at (0, cos20, -sin20). */
const TILT = -(20 * Math.PI) / 180;
const PITCH_Z = PANEL_D * Math.cos(TILT) + 0.5;
const MARGIN = 2;
const MAX_PANELS = 160;
const KW_PER_PANEL = 0.4;
/** Front-centre keep-out the HVAC units sit in. */
const PLANT_DEPTH = 5.5;
const PLANT_HALF_W = 6;
/** The sheen a producing panel picks up. Pale daylight blue, never amber: at
 *  metalness 0.6 there is so little diffuse left that a warm emissive swamps
 *  the navy and the whole array reads as terracotta. */
const GLINT = '#93c5fd';

/* -------------------------------------------------------------------------- */
/* Residence pick plate                                                        */
/* -------------------------------------------------------------------------- */

/* The House owns the domestic array, so these mirror its front-slope frame:
   a 32.6 deg pitch whose centre is (0, 7.408, 2.8), carrying a 14.0 x 5.449 m
   array. The plate is lifted 0.12 m along the slope normal so it wins the
   raycast against the panels underneath, which belong to the building. */
const RESIDENCE_PITCH = Math.atan(3.2 / 5);
const RESIDENCE_ARRAY_W = 14.0;
const RESIDENCE_ARRAY_L = 5.449;
const PLATE_LIFT = 0.12;
const RESIDENCE_SLOPE_Y = 7.408 + PLATE_LIFT * Math.cos(RESIDENCE_PITCH);
const RESIDENCE_SLOPE_Z = 2.8 + PLATE_LIFT * Math.sin(RESIDENCE_PITCH);

interface Array_ {
  glass: Piece[];
  /** Frames and rails -- one cluster, matte, no sheen. */
  metal: Piece[];
}

function buildArray(building: Building): Array_ {
  const [width, depth] = BUILDING_SPECS[building.type].footprint;
  const top = roofY(building.type);
  const usableW = Math.max(PANEL_W, width - MARGIN * 2);
  const usableD = Math.max(PANEL_D, depth - MARGIN * 2);
  const pitchX = PANEL_W + GAP_X;

  const cols = Math.max(1, Math.floor((usableW + GAP_X) / pitchX));
  const rows = Math.max(1, Math.floor((usableD + 0.5) / PITCH_Z));
  const startX = -((cols - 1) * pitchX) / 2;
  const startZ = -((rows - 1) * PITCH_Z) / 2;

  const wanted = Math.min(
    MAX_PANELS,
    Math.max(4, Math.round(building.solar_capacity_kw / KW_PER_PANEL)),
  );
  const plantZ = depth / 2 - PLANT_DEPTH;
  // roofY + 0.05 is the deck; the extra 0.3 is the rail, so a tilted panel's
  // low edge still clears the roof.
  const y = top + 0.35;

  const glass: Piece[] = [];
  const metal: Piece[] = [];
  const rowUsed: number[] = [];

  for (let r = 0; r < rows && glass.length < wanted; r++) {
    const z = startZ + r * PITCH_Z;
    let placed = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let c = 0; c < cols && glass.length < wanted; c++) {
      const x = startX + c * pitchX;
      if (z > plantZ && Math.abs(x) < PLANT_HALF_W) continue;
      glass.push({ p: [x, y, z], s: [PANEL_W, PANEL_T, PANEL_D], r: [TILT, 0, 0] });
      // The frame: the same plate, a hair larger and a hair lower, so a dark
      // lip shows all the way round the glass.
      metal.push({
        p: [x, y - 0.018, z],
        s: [PANEL_W + 0.05, PANEL_T, PANEL_D + 0.05],
        r: [TILT, 0, 0],
        c: C.frame,
      });
      placed++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    if (placed > 0) rowUsed.push(r, minX, maxX);
  }

  // Mounting rails: two per populated row, running the width of it.
  for (let i = 0; i < rowUsed.length; i += 3) {
    const z = startZ + rowUsed[i] * PITCH_Z;
    const span = rowUsed[i + 2] - rowUsed[i + 1] + PANEL_W;
    const mid = (rowUsed[i + 1] + rowUsed[i + 2]) / 2;
    for (const dz of [-0.3, 0.3]) {
      metal.push({ p: [mid, top + 0.16, z + dz], s: [span, 0.06, 0.06], c: C.frame });
    }
  }

  return { glass, metal };
}

export interface RoofSolarProps {
  building: Building;
  solarKw: number;
}

export function RoofSolar({ building, solarKw }: RoofSolarProps) {
  const residence = isResidence(building.type);
  const array = useMemo(() => (residence ? null : buildArray(building)), [residence, building]);

  const output = clamp(
    building.solar_capacity_kw > 0 ? solarKw / building.solar_capacity_kw : 0,
    0,
    1,
  );
  const show = solarKw >= DORMANT_KW;

  if (residence || !array) {
    const from = residenceSolarOrigin();
    return (
      <group>
        {/* The house's own front slope carries the laminates, so there is no
            array mesh here to click. This invisible plate lies on that slope
            (the House's slope group is at y 7.408, z 2.8, pitched 32.6 deg)
            purely so the array answers the pointer like every other device.
            It writes no colour and takes no light. */}
        <mesh
          position={[0, RESIDENCE_SLOPE_Y, RESIDENCE_SLOPE_Z]}
          rotation={[-RESIDENCE_PITCH - Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[RESIDENCE_ARRAY_W, RESIDENCE_ARRAY_L]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
        <NodeLabel
          position={[from[0], from[1] + 1.6, from[2]]}
          name="Solar"
          value={formatKw(solarKw)}
          show={show}
        />
      </group>
    );
  }

  const [width, depth] = BUILDING_SPECS[building.type].footprint;
  const top = roofY(building.type);

  return (
    <group>
      <Boxes pieces={array.glass}>
        <meshStandardMaterial
          color={C.panel}
          {...MAT.pvGlass}
          emissive={GLINT}
          emissiveIntensity={0.02 + 0.28 * output}
        />
      </Boxes>
      <Boxes pieces={array.metal}>
        <meshStandardMaterial color="#ffffff" roughness={0.6} metalness={0.5} />
      </Boxes>
      <NodeLabel
        // Pushed to -x and lifted: at the centreline it landed on top of the
        // HVAC pill, which sits at the same height on the other side of the roof.
        position={[-width * 0.3, top + 4.6, -depth * 0.3]}
        name="Solar"
        value={formatKw(solarKw)}
        show={show}
      />
    </group>
  );
}

export default RoofSolar;
