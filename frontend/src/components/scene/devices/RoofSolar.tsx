'use client';

/**
 * The rooftop PV array: one InstancedMesh of tilted panels, laid out row by row
 * inside the footprint minus a 2 m perimeter margin, with the front-centre left
 * clear for the HVAC units.
 *
 * Panel count follows the nameplate at roughly one panel per 0.4 kW, capped at
 * 160 instances and by whatever actually fits. Rows fill from the back of the
 * roof forward, so a small array never crowds the plant.
 *
 * 1 draw call.
 */

import { useMemo } from 'react';
import type { Building } from '@/types/api';
import { formatKw } from '@/lib/format';
import { BUILDING_SPECS, roofY } from '../layout';
import { C, clamp } from './common';
import { Boxes, type Piece } from './Instanced';
import { NodeLabel } from './NodeLabel';

const PANEL_W = 1.7;
const PANEL_D = 1.05;
const PANEL_T = 0.07;
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
/** The sheen a producing panel picks up. */
const GLINT = '#93c5fd';

function buildPanels(building: Building): Piece[] {
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
  // roofY + 0.05 is the deck; the extra 0.25 is the mounting rail, so a tilted
  // panel's low edge still clears the roof.
  const y = top + 0.05 + 0.25;

  const pieces: Piece[] = [];
  for (let r = 0; r < rows && pieces.length < wanted; r++) {
    const z = startZ + r * PITCH_Z;
    for (let c = 0; c < cols && pieces.length < wanted; c++) {
      const x = startX + c * pitchX;
      if (z > plantZ && Math.abs(x) < PLANT_HALF_W) continue;
      pieces.push({ p: [x, y, z], s: [PANEL_W, PANEL_T, PANEL_D], r: [TILT, 0, 0] });
    }
  }
  return pieces;
}

export interface RoofSolarProps {
  building: Building;
  solarKw: number;
}

export function RoofSolar({ building, solarKw }: RoofSolarProps) {
  const panels = useMemo(() => buildPanels(building), [building]);
  const [, depth] = BUILDING_SPECS[building.type].footprint;
  const top = roofY(building.type);

  const output = clamp(
    building.solar_capacity_kw > 0 ? solarKw / building.solar_capacity_kw : 0,
    0,
    1,
  );

  return (
    <group>
      <Boxes pieces={panels}>
        <meshStandardMaterial
          color={C.panel}
          metalness={0.6}
          roughness={0.3}
          // A pale daylight blue rather than the amber of the solar conduit:
          // metalness 0.6 leaves so little diffuse that a warm emissive swamps
          // the navy and the array reads as terracotta. This lifts the panels
          // toward "glass catching the sun" and stays in the blue family.
          emissive={GLINT}
          emissiveIntensity={0.02 + 0.3 * output}
        />
      </Boxes>
      <NodeLabel position={[0, top + 3.6, -depth * 0.3]} name="Solar" value={formatKw(solarKw)} />
    </group>
  );
}

export default RoofSolar;
