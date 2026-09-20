'use client';

/**
 * Alder Street Residence -- 14 x 10 m footprint, two storeys at 3.0 m, eaves at
 * 6.0 m, gable ridge along x at 9.2 m.
 *
 * The only pitched-roof building in the portfolio, and the only one small
 * enough that a bitmap texture is worth having: vertical cedar cladding carries
 * the grain, thin proud strips every 0.14 m carry the board joints, and the
 * roof is dark standing-seam metal with the array laid flush into the front
 * slope rather than racked above a parapet.
 *
 * Geometry notes:
 *  - The ridge is `ridgeY('residence')`, not `roofY`. `roofY` is the eaves, and
 *    it is what the devices module should use for anything wall-mounted; the
 *    roof itself needs the ridge.
 *  - The pitch falls out of the two numbers the layout contract fixes: a 3.2 m
 *    rise over a 5 m half-depth is 32.6 degrees, a little shallower than the
 *    40 degrees of the reference photo, but the contract wins over the photo.
 *  - Everything on the front slope (standing seams, array) lives inside one
 *    rotated <group>, so the array can be authored in flat local coordinates.
 *  - `junction('residence')` is the front-left corner, not the centreline: the
 *    middle of the +z facade is the glazed slider. The canopy above it is high
 *    enough that the conduit run stays clear.
 *
 * Budget: ~6k triangles, 18 draw calls (19 highlighted).
 */

import { Suspense } from 'react';
import { BUILDING_SPECS, junction, ridgeY, roofY } from '../layout';
import type { BuildingModelProps } from '../contracts';
import {
  GroundPad,
  HighlightRing,
  InstancedBoxes,
  JunctionBox,
  type BoxInstance,
} from './Common';
import { boardSeams, buildWallShell, CedarWalls, PlainWalls, type WallShellSpec } from './Cladding';
import { litPanelHex, windowEmissiveIntensity } from './materials';
import { NameSign } from './Signage';
import { PANE_DEPTH, wallGrid, Windows, type Pane } from './Windows';

const SPEC = BUILDING_SPECS.residence;
const [W, D] = SPEC.footprint; // 14, 10
const EAVES = roofY('residence'); // 6.0
const RIDGE = ridgeY('residence'); // 9.2

/** Concrete plinth the whole house sits on. */
const PLINTH_H = 0.15;
/** Roof overhang past the walls, measured horizontally. */
const OVERHANG = 0.6;
/** Cedar board width. */
const BOARD_PITCH = 0.14;
/** How far the cladding surface stands off the structural mass. */
const CLAD_PROUD = 0.02;
/** How far the board-joint strips stand off the cladding. */
const SEAM_PROUD = 0.05;

const PITCH = Math.atan((RIDGE - EAVES) / (D / 2)); // 0.5695 rad, 32.6 deg
const ROOF_W = W + OVERHANG * 2; // 15.2
const Z_TIP = D / 2 + OVERHANG; // 5.6
const Y_TIP = RIDGE - Z_TIP * Math.tan(PITCH); // 5.616
const SLOPE_LEN = Math.hypot(Z_TIP, RIDGE - Y_TIP); // 6.649
const SLOPE_CY = (RIDGE + Y_TIP) / 2;
const SLOPE_CZ = Z_TIP / 2;
const ROOF_T = 0.22;

const SHELL: WallShellSpec = {
  hx: W / 2 + CLAD_PROUD,
  hz: D / 2 + CLAD_PROUD,
  y0: PLINTH_H,
  y1: EAVES,
  ridge: RIDGE,
};

/** Distance from the building centre out to a pane's centre, per axis. */
const PANE_X = SHELL.hx + SEAM_PROUD + PANE_DEPTH / 2;
const PANE_Z = SHELL.hz + SEAM_PROUD + PANE_DEPTH / 2;

const HOUSE = {
  larch: '#b98a5c',
  seam: '#8a6640',
  /** Core mass behind the cladding. Never seen, but never black either. */
  carcass: '#2a2019',
  render: '#3a3d42',
  roof: '#1c1f24',
  roofTrim: '#262b32',
  solar: '#0f1e3d',
  glass: '#0b1220',
  steel: '#14171c',
  plinth: '#3b424c',
  terrace: '#6b7280',
  lawn: '#2f4434',
} as const;

/* -------------------------------------------------------------------------- */
/* Roof                                                                        */
/* -------------------------------------------------------------------------- */

/** Both slopes, the ridge cap, the eaves fascias and the four barge boards. */
function buildRoof(): BoxInstance[] {
  const bargeX = ROOF_W / 2 - 0.07;
  const items: BoxInstance[] = [
    { p: [0, SLOPE_CY, SLOPE_CZ], s: [ROOF_W, ROOF_T, SLOPE_LEN], rx: -PITCH },
    { p: [0, SLOPE_CY, -SLOPE_CZ], s: [ROOF_W, ROOF_T, SLOPE_LEN], rx: PITCH },
    { p: [0, RIDGE + 0.19, 0], s: [ROOF_W + 0.1, 0.18, 0.62] },
    { p: [0, Y_TIP - 0.22, Z_TIP + 0.07], s: [ROOF_W, 0.32, 0.14] },
    { p: [0, Y_TIP - 0.22, -Z_TIP - 0.07], s: [ROOF_W, 0.32, 0.14] },
  ];
  for (const sx of [-1, 1]) {
    items.push({ p: [sx * bargeX, SLOPE_CY, SLOPE_CZ], s: [0.14, 0.34, SLOPE_LEN], rx: -PITCH });
    items.push({ p: [sx * bargeX, SLOPE_CY, -SLOPE_CZ], s: [0.14, 0.34, SLOPE_LEN], rx: PITCH });
  }
  return items;
}

/* Front-slope local frame: x runs along the building, z runs down the slope
   from the ridge (-) to the eaves tip (+), y is perpendicular to the roof. */
const ROOF_SURFACE_Y = ROOF_T / 2;
/** Array inset from every edge of the slope. */
const ARRAY_INSET = 0.6;
const ARRAY_W = ROOF_W - ARRAY_INSET * 2; // 14.0
const ARRAY_L = SLOPE_LEN - ARRAY_INSET * 2; // 5.449
const PANEL_COLS = 12;
const PANEL_ROWS = 6;
const COL_PITCH = ARRAY_W / PANEL_COLS;
const ROW_PITCH = ARRAY_L / PANEL_ROWS;

/** Standing seams every 0.45 m, plus the dark plate the array frames sit on. */
function buildSlopeTrim(): BoxInstance[] {
  const items: BoxInstance[] = [];
  const count = Math.floor(ROOF_W / 0.45);
  const span = (count - 1) * 0.45;
  for (let i = 0; i < count; i += 1) {
    const x = -span / 2 + i * 0.45;
    items.push({ p: [x, ROOF_SURFACE_Y + 0.035, 0], s: [0.05, 0.07, SLOPE_LEN - 0.1] });
  }
  // Frame plate: the 6 cm it shows between panels is the array's dark framing.
  items.push({
    p: [0, ROOF_SURFACE_Y + 0.015, 0],
    s: [ARRAY_W + 0.06, 0.03, ARRAY_L + 0.06],
  });
  return items;
}

/** 6 rows x 12 panels, flush to the slope and 4 cm proud of the seams. */
function buildPanels(): BoxInstance[] {
  const items: BoxInstance[] = [];
  for (let r = 0; r < PANEL_ROWS; r += 1) {
    const z = -ARRAY_L / 2 + ROW_PITCH * (r + 0.5);
    for (let c = 0; c < PANEL_COLS; c += 1) {
      const x = -ARRAY_W / 2 + COL_PITCH * (c + 0.5);
      items.push({
        p: [x, ROOF_SURFACE_Y + 0.055, z],
        s: [COL_PITCH - 0.07, 0.03, ROW_PITCH - 0.05],
      });
    }
  }
  return items;
}

/* -------------------------------------------------------------------------- */
/* Openings, ground and street furniture                                       */
/* -------------------------------------------------------------------------- */

/* The glazed slider dominates the +z facade; it sits right of centre so the
   front-left corner stays clear for the junction box and the canopy. */
const SLIDER_W = 3.2;
const SLIDER_H = 2.4;
const SLIDER_X = 2.6;
const SLIDER_CY = 0.2 + SLIDER_H / 2;
const SLIDER_Z = SHELL.hz + 0.07;

/** Black steel: slider frame, the corner post pair and the canopy. */
function buildSteel(): BoxInstance[] {
  const fz = SLIDER_Z + 0.02;
  const hw = SLIDER_W / 2;
  const hh = SLIDER_H / 2;
  return [
    { p: [SLIDER_X, SLIDER_CY + hh, fz], s: [SLIDER_W + 0.2, 0.1, 0.14] },
    { p: [SLIDER_X, SLIDER_CY - hh, fz], s: [SLIDER_W + 0.2, 0.1, 0.14] },
    { p: [SLIDER_X - hw, SLIDER_CY, fz], s: [0.1, SLIDER_H + 0.2, 0.14] },
    { p: [SLIDER_X + hw, SLIDER_CY, fz], s: [0.1, SLIDER_H + 0.2, 0.14] },
    { p: [SLIDER_X, SLIDER_CY, fz], s: [0.08, SLIDER_H, 0.14] },
    // canopy over the front-left corner, on two slim posts
    { p: [-5.0, 3.3, 6.0], s: [3.6, 0.14, 2.2] },
    { p: [-5.0, 3.21, 7.05], s: [3.6, 0.2, 0.08] },
    { p: [-3.4, 1.65, 6.9], s: [0.11, 3.3, 0.11] },
    { p: [-6.6, 1.65, 6.9], s: [0.11, 3.3, 0.11] },
  ];
}

/** Narrow windows on the three facades the slider does not take. */
function buildPanes(): Pane[] {
  return [
    ...wallGrid({
      facing: 'x+',
      dist: PANE_X,
      cols: 2,
      colPitch: 2.6,
      w: 0.85,
      rows: 2,
      y0: 1.7,
      rowPitch: 3.0,
      h: 1.7,
    }),
    // -x ground floor is the render panel the batteries mount on, so upper only
    ...wallGrid({
      facing: 'x-',
      dist: PANE_X,
      cols: 2,
      colPitch: 2.6,
      w: 0.85,
      rows: 1,
      y0: 4.7,
      rowPitch: 3.0,
      h: 1.7,
    }),
    ...wallGrid({
      facing: 'z-',
      dist: PANE_Z,
      cols: 3,
      colPitch: 3.4,
      w: 0.9,
      rows: 2,
      y0: 1.7,
      rowPitch: 3.0,
      h: 1.7,
    }),
    ...wallGrid({
      facing: 'z+',
      dist: PANE_Z,
      cols: 2,
      colPitch: 3.0,
      uOffset: -3.6,
      w: 0.9,
      rows: 1,
      y0: 4.7,
      rowPitch: 3.0,
      h: 1.7,
    }),
  ];
}

/* Shape data is constant, so it is built once at module load rather than per
 * component instance. */
const WALL_GEOMETRY = buildWallShell(SHELL);
const SEAMS = boardSeams(SHELL, BOARD_PITCH, SEAM_PROUD);
const ROOF = buildRoof();
const SLOPE_TRIM = buildSlopeTrim();
const PANELS = buildPanels();
const STEEL = buildSteel();
const PANES = buildPanes();
const JN = junction('residence');

export function House({ building, loadRatio, hour, highlighted }: BuildingModelProps) {
  const glass = litPanelHex(hour, loadRatio, 0.22);
  const glassGlow = windowEmissiveIntensity(hour) * 0.18;

  return (
    <group>
      <GroundPad type="residence" />
      {highlighted ? <HighlightRing type="residence" /> : null}

      {/* paved terrace along the front, then a strip of lawn beyond it */}
      <mesh position={[0, 0.04, D / 2 + 1.0]} receiveShadow>
        <boxGeometry args={[W + 4, 0.08, 2.0]} />
        <meshStandardMaterial color={HOUSE.terrace} roughness={0.92} metalness={0} />
      </mesh>
      <mesh position={[0, 0.03, D / 2 + 3.0]} receiveShadow>
        <boxGeometry args={[W + 8, 0.06, 2.0]} />
        <meshStandardMaterial color={HOUSE.lawn} roughness={1} metalness={0} />
      </mesh>

      {/* concrete plinth */}
      <mesh position={[0, PLINTH_H / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[W + 0.5, PLINTH_H, D + 0.5]} />
        <meshStandardMaterial color={HOUSE.plinth} roughness={0.95} metalness={0} flatShading />
      </mesh>

      {/* structural mass, then the cedar shell 2 cm proud of it */}
      <mesh position={[0, (PLINTH_H + EAVES) / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[W, EAVES - PLINTH_H, D]} />
        <meshStandardMaterial color={HOUSE.carcass} roughness={0.9} metalness={0} />
      </mesh>
      <Suspense fallback={<PlainWalls geometry={WALL_GEOMETRY} color={HOUSE.larch} />}>
        <CedarWalls geometry={WALL_GEOMETRY} />
      </Suspense>
      <InstancedBoxes items={SEAMS} color={HOUSE.seam} roughness={0.85} metalness={0} />

      {/* dark render panel on the -x gable end, where the wall batteries mount */}
      <mesh position={[-SHELL.hx - 0.04, 1.8, 1.5]} castShadow receiveShadow>
        <boxGeometry args={[0.12, 3.0, 4.0]} />
        <meshStandardMaterial color={HOUSE.render} roughness={0.75} metalness={0.05} flatShading />
      </mesh>

      {/* standing-seam gable roof */}
      <InstancedBoxes items={ROOF} color={HOUSE.roof} roughness={0.55} metalness={0.35} flatShading />

      {/* front slope: seams, array frame plate and the panels themselves */}
      <group position={[0, SLOPE_CY, SLOPE_CZ]} rotation={[-PITCH, 0, 0]}>
        <InstancedBoxes items={SLOPE_TRIM} color={HOUSE.roofTrim} roughness={0.5} metalness={0.4} />
        <InstancedBoxes items={PANELS} color={HOUSE.solar} roughness={0.25} metalness={0.5} />
      </group>

      {/* glazed slider on the +z face */}
      <mesh position={[SLIDER_X, SLIDER_CY, SLIDER_Z]} castShadow receiveShadow>
        <boxGeometry args={[SLIDER_W, SLIDER_H, 0.08]} />
        <meshStandardMaterial
          color={glass}
          emissive="#ffffff"
          emissiveIntensity={glassGlow}
          roughness={0.05}
          metalness={0.9}
        />
      </mesh>

      <InstancedBoxes items={STEEL} color={HOUSE.steel} roughness={0.45} metalness={0.6} flatShading />
      <Windows panes={PANES} hour={hour} loadRatio={loadRatio} />

      <JunctionBox type="residence" />
      <NameSign name={building.name} position={[4.6, 0, JN[2] + 2.4]} width={4.6} height={0.85} />
    </group>
  );
}

export default House;
