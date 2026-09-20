'use client';

/**
 * Warehouse -- 40 x 24 m footprint, one 9 m storey.
 *
 * A long low shed: corrugated facade built from alternating thin strips in two
 * greys, five loading dock doors with bumpers on the -x side, a two-storey
 * office pod at the +z front corner, and a three-tooth sawtooth clerestory
 * along the back edge. The front two thirds of the roof are left completely
 * clear for the solar field.
 */

import { BUILDING_SPECS, junction, roofY } from '../layout';
import type { BuildingModelProps } from '../contracts';
import {
  EntranceCanopy,
  GroundPad,
  HighlightRing,
  InstancedBoxes,
  JunctionBox,
  Plinth,
  RoofSlab,
  type BoxInstance,
} from './Common';
import { PALETTE } from './materials';
import { NameSign } from './Signage';
import { PANE_DEPTH, wallGrid, Windows, type Pane } from './Windows';

const SPEC = BUILDING_SPECS.warehouse;
const [W, D] = SPEC.footprint; // 40, 24
const TOP = roofY('warehouse'); // 9

/* office pod */
const POD_W = 10;
const POD_D = 5;
const POD_H = 7;
const POD_X = -14;
const POD_Z = D / 2 + POD_D / 2 - 3; // 11.5 -- protrudes 2 m past the shed face

/* loading docks on the -x face */
const DOCK_COUNT = 5;
const DOCK_PITCH = 4.4;
const DOCK_W = 3.0;
const DOCK_H = 4.0;
const DOCK_X = -W / 2;

/* sawtooth clerestory along the back */
const TEETH = 3;
const TOOTH_D = 3;
const TOOTH_RISE = 2.1;
const TOOTH_Z0 = -D / 2; // -12
const TOOTH_SLOPE = Math.atan(TOOTH_RISE / TOOTH_D);

/** Alternating vertical strips, split by parity into two grey passes. */
function buildCorrugation(parity: 0 | 1): BoxInstance[] {
  const out: BoxInstance[] = [];
  const h = 8.4;
  const cy = 4.4;
  let k = 0;
  for (let i = 0; i < W; i++, k++) {
    const x = -W / 2 + 0.5 + i;
    if (k % 2 !== parity) continue;
    out.push({ p: [x, cy, D / 2 + 0.09], s: [0.55, h, 0.18] });
    out.push({ p: [x, cy, -D / 2 - 0.09], s: [0.55, h, 0.18] });
  }
  for (let i = 0; i < D; i++, k++) {
    const z = -D / 2 + 0.5 + i;
    if (k % 2 !== parity) continue;
    out.push({ p: [W / 2 + 0.09, cy, z], s: [0.18, h, 0.55] });
    out.push({ p: [-W / 2 - 0.09, cy, z], s: [0.18, h, 0.55] });
  }
  return out;
}

function dockZ(i: number): number {
  return (i - (DOCK_COUNT - 1) / 2) * DOCK_PITCH;
}

function buildDoors(): BoxInstance[] {
  const out: BoxInstance[] = [];
  for (let i = 0; i < DOCK_COUNT; i++) {
    out.push({ p: [DOCK_X - 0.2, DOCK_H / 2 + 0.9, dockZ(i)], s: [0.4, DOCK_H, DOCK_W] });
  }
  return out;
}

function buildDockCanopies(): BoxInstance[] {
  const out: BoxInstance[] = [];
  for (let i = 0; i < DOCK_COUNT; i++) {
    out.push({ p: [DOCK_X - 0.8, DOCK_H + 1.3, dockZ(i)], s: [1.8, 0.28, DOCK_W + 0.8] });
  }
  return out;
}

/** Rubber dock bumpers plus the corner downspouts -- one instanced pass. */
function buildTrim(): BoxInstance[] {
  const out: BoxInstance[] = [];
  for (let i = 0; i < DOCK_COUNT; i++) {
    for (const s of [-1, 1]) {
      out.push({
        p: [DOCK_X - 0.45, 1.5, dockZ(i) + s * (DOCK_W / 2 + 0.25)],
        s: [0.5, 1.2, 0.34],
      });
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      out.push({ p: [sx * (W / 2 + 0.2), 4.5, sz * (D / 2 - 0.4)], s: [0.34, 9, 0.34] });
    }
    out.push({ p: [sx * (W / 2 + 0.2), 4.5, 0], s: [0.34, 9, 0.34] });
  }
  return out;
}

function buildSawtooth(): { panels: BoxInstance[]; risers: BoxInstance[] } {
  const panels: BoxInstance[] = [];
  const risers: BoxInstance[] = [];
  const len = Math.hypot(TOOTH_D, TOOTH_RISE);
  for (let i = 0; i < TEETH; i++) {
    const zBack = TOOTH_Z0 + i * TOOTH_D;
    panels.push({
      p: [0, TOP + 0.1 + TOOTH_RISE / 2, zBack + TOOTH_D / 2],
      s: [W, 0.3, len],
      rx: TOOTH_SLOPE,
    });
    risers.push({
      p: [0, TOP + 0.1 + TOOTH_RISE / 2, zBack + 0.12],
      s: [W, TOOTH_RISE, 0.24],
    });
  }
  return { panels, risers };
}

/** Clerestory strips on the shed, the sawtooth glazing, and the office pod. */
function buildPanes(): Pane[] {
  const panes: Pane[] = [];
  const clerestory = { rows: 1, y0: 7.1, rowPitch: 1, h: 1.5 };

  panes.push(
    ...wallGrid({
      ...clerestory,
      facing: 'z+',
      dist: D / 2 + 0.18 + PANE_DEPTH / 2,
      cols: 12,
      colPitch: 3,
      w: 2.4,
    }),
    ...wallGrid({
      ...clerestory,
      facing: 'z-',
      dist: D / 2 + 0.18 + PANE_DEPTH / 2,
      cols: 12,
      colPitch: 3,
      w: 2.4,
    }),
    ...wallGrid({
      ...clerestory,
      facing: 'x+',
      dist: W / 2 + 0.18 + PANE_DEPTH / 2,
      cols: 7,
      colPitch: 3,
      w: 2.4,
    }),
    ...wallGrid({
      ...clerestory,
      facing: 'x-',
      dist: W / 2 + 0.18 + PANE_DEPTH / 2,
      cols: 7,
      colPitch: 3,
      w: 2.4,
    }),
  );

  // sawtooth glazing -- flat against the +z side of each riser
  for (let i = 0; i < TEETH; i++) {
    const zBack = TOOTH_Z0 + i * TOOTH_D;
    panes.push(
      ...wallGrid({
        facing: 'z+',
        cz: zBack + 0.12,
        dist: 0.16,
        cols: 11,
        colPitch: 3.2,
        w: 2.7,
        rows: 1,
        y0: TOP + 0.1 + TOOTH_RISE / 2,
        rowPitch: 1,
        h: 1.5,
      }),
    );
  }

  // office pod: two storeys
  const pod = { rows: 2, y0: 2.0, rowPitch: 3.2, h: 1.7, w: 1.8, colPitch: 2.4 };
  panes.push(
    ...wallGrid({
      ...pod,
      facing: 'z+',
      cx: POD_X,
      cz: POD_Z,
      dist: POD_D / 2 + PANE_DEPTH / 2 + 0.01,
      cols: 4,
    }),
    // side windows only on the part of the pod that clears the shed face
    ...wallGrid({
      ...pod,
      facing: 'x-',
      cx: POD_X,
      cz: POD_Z,
      dist: POD_W / 2 + PANE_DEPTH / 2 + 0.01,
      cols: 2,
      colPitch: 1.6,
      uOffset: 1.5,
    }),
    ...wallGrid({
      ...pod,
      facing: 'x+',
      cx: POD_X,
      cz: POD_Z,
      dist: POD_W / 2 + PANE_DEPTH / 2 + 0.01,
      cols: 2,
      colPitch: 1.6,
      uOffset: -1.5,
    }),
  );
  return panes;
}

/** Parapet on three sides only -- the back edge is taken by the sawtooth. */
function buildParapets(): BoxInstance[] {
  const clearBack = TOOTH_Z0 + TEETH * TOOTH_D; // -3
  const runZ = (D / 2 - clearBack) / 2 + clearBack;
  const runLen = D / 2 - clearBack;
  return [
    { p: [0, TOP + 0.3, D / 2 - 0.2], s: [W, 0.6, 0.4] },
    { p: [W / 2 - 0.2, TOP + 0.3, runZ], s: [0.4, 0.6, runLen] },
    { p: [-W / 2 + 0.2, TOP + 0.3, runZ], s: [0.4, 0.6, runLen] },
  ];
}

/* Shape data is constant, so it is built once at module load rather than per
 * component instance. */
const STRIPS_A = buildCorrugation(0);
const STRIPS_B = buildCorrugation(1);
const DOORS = buildDoors();
const DOCK_CANOPIES = buildDockCanopies();
const TRIM = buildTrim();
const SAWTOOTH = buildSawtooth();
const PANES = buildPanes();
const PARAPETS = buildParapets();
const JZ = junction('warehouse')[2];

export function Warehouse({ building, loadRatio, hour, highlighted }: BuildingModelProps) {
  return (
    <group>
      <GroundPad type="warehouse" />
      {highlighted ? <HighlightRing type="warehouse" /> : null}

      {/* shed */}
      <mesh position={[0, TOP / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[W, TOP, D]} />
        <meshStandardMaterial color={PALETTE.metalDark} roughness={0.85} metalness={0.15} flatShading />
      </mesh>
      <InstancedBoxes items={STRIPS_A} color={PALETTE.metalDark} roughness={0.8} metalness={0.2} flatShading />
      <InstancedBoxes items={STRIPS_B} color={PALETTE.metalLight} roughness={0.8} metalness={0.2} flatShading />

      {/* wide clear roof */}
      <RoofSlab width={W} depth={D} y={TOP} overhang={0.35} />
      <InstancedBoxes items={PARAPETS} color={PALETTE.parapet} roughness={0.9} />

      {/* sawtooth clerestory along the back edge */}
      <InstancedBoxes items={SAWTOOTH.panels} color={PALETTE.metalTrim} roughness={0.8} metalness={0.25} flatShading />
      <InstancedBoxes items={SAWTOOTH.risers} color={PALETTE.metalTrim} roughness={0.8} metalness={0.25} flatShading />

      {/* loading docks */}
      <mesh position={[DOCK_X - 1.6, 0.45, 0]} castShadow receiveShadow>
        <boxGeometry args={[3.2, 0.9, D - 2]} />
        <meshStandardMaterial color={PALETTE.plinth} roughness={0.95} flatShading />
      </mesh>
      <InstancedBoxes items={DOORS} color={PALETTE.metalLight} roughness={0.6} metalness={0.35} flatShading />
      <InstancedBoxes items={DOCK_CANOPIES} color={PALETTE.metalTrim} roughness={0.7} metalness={0.3} flatShading />
      <InstancedBoxes items={TRIM} color={PALETTE.dockRubber} roughness={0.95} />

      {/* two-storey office pod at the +z front corner */}
      <mesh position={[POD_X, POD_H / 2, POD_Z]} castShadow receiveShadow>
        <boxGeometry args={[POD_W, POD_H, POD_D]} />
        <meshStandardMaterial color={PALETTE.metalLight} roughness={0.85} metalness={0.1} flatShading />
      </mesh>
      <RoofSlab width={POD_W} depth={POD_D} y={POD_H} x={POD_X} z={POD_Z} overhang={0.35} />

      <Windows panes={PANES} hour={hour} loadRatio={loadRatio} />

      <Plinth width={W} depth={D} height={0.7} overhang={0.45} gap={8} />
      <EntranceCanopy
        width={5}
        z={POD_Z + POD_D / 2}
        x={POD_X}
        height={3.6}
        depth={1.8}
        color={PALETTE.metalTrim}
      />
      <JunctionBox type="warehouse" />
      <NameSign name={building.name} position={[8, 0, JZ + 2.4]} width={9} />
    </group>
  );
}

export default Warehouse;
