'use client';

/**
 * Hospital -- 26 x 18 m footprint, 6 floors at 3.6 m (21.6 m to the roof).
 *
 * H-plan: two ward wings running front-to-back, joined by a shallower core.
 * Light render facade, horizontal ribbon windows, a helipad on the east wing
 * roof, an ambulance canopy with a red band on the +z face, and a red cross on
 * the core. All three masses top out at the same height so the roof plane at
 * `roofY('hospital')` is continuous for the devices module.
 */
import { useEffect, useMemo } from 'react';
import type * as THREE from 'three';
import { BUILDING_SPECS, junction, roofY } from '../layout';
import type { BuildingModelProps } from '../contracts';
import {
  EntranceCanopy,
  GroundPad,
  HighlightRing,
  InstancedBoxes,
  JunctionBox,
  parapetBoxes,
  Plinth,
  type BoxInstance,
} from './Common';
import { litPanelHex, makeHelipadTexture, PALETTE, windowEmissiveIntensity } from './materials';
import { NameSign } from './Signage';
import { wallGrid, Windows, type Pane } from './Windows';

const SPEC = BUILDING_SPECS.hospital;
const [W, D] = SPEC.footprint; // 26, 18
const FLOOR = SPEC.floorHeight; // 3.6
const TOP = roofY('hospital'); // 21.6

/** Wing and core masses. */
const WING_W = 8;
const WING_X = W / 2 - WING_W / 2; // 9
const CORE_W = 10;
const CORE_D = 9;

/** A window band per floor: centre height and pane size. */
const BAND_Y0 = 1.95;
const BAND_H = 1.7;
/** Panes stand proud of the ribbon trim they sit in, not just of the wall. */
const RIBBON_PROUD = 0.16;

/**
 * Ribbon windows, split into 2 m bays so individual rooms light up rather than
 * whole floors. Every exposed face of every mass gets a run.
 */
function buildPanes(): Pane[] {
  const panes: Pane[] = [];
  const rows = SPEC.floors;
  const common = { rows, y0: BAND_Y0, rowPitch: FLOOR, h: BAND_H, colPitch: 2, w: 1.72 };

  for (const sign of [-1, 1]) {
    const cx = sign * WING_X;
    // long outer face of the wing
    panes.push(
      ...wallGrid({
        ...common,
        facing: sign > 0 ? 'x+' : 'x-',
        cx,
        dist: WING_W / 2 + RIBBON_PROUD,
        cols: 8,
      }),
      // wing front and back
      ...wallGrid({
        ...common,
        facing: 'z+',
        cx,
        dist: D / 2 + RIBBON_PROUD,
        cols: 3,
      }),
      ...wallGrid({
        ...common,
        facing: 'z-',
        cx,
        dist: D / 2 + RIBBON_PROUD,
        cols: 3,
      }),
    );
  }

  // core: front starts at level 1 (level 0 is the entrance glazing)
  panes.push(
    ...wallGrid({
      ...common,
      facing: 'z+',
      dist: CORE_D / 2 + RIBBON_PROUD,
      cols: 4,
      rows: rows - 1,
      y0: BAND_Y0 + FLOOR,
    }),
    ...wallGrid({
      ...common,
      facing: 'z-',
      dist: CORE_D / 2 + RIBBON_PROUD,
      cols: 4,
    }),
  );
  return panes;
}

/** The dark recess each ribbon of panes sits in, tying the bays together. */
function buildRibbons(): BoxInstance[] {
  const out: BoxInstance[] = [];
  const t = 0.22;
  for (let f = 0; f < SPEC.floors; f++) {
    const y = BAND_Y0 + f * FLOOR;
    for (const sign of [-1, 1]) {
      const cx = sign * WING_X;
      out.push({ p: [cx + sign * (WING_W / 2), y, 0], s: [t, BAND_H + 0.5, D - 1.2] });
      out.push({ p: [cx, y, D / 2], s: [WING_W - 1.2, BAND_H + 0.5, t] });
      out.push({ p: [cx, y, -D / 2], s: [WING_W - 1.2, BAND_H + 0.5, t] });
    }
    if (f > 0) out.push({ p: [0, y, CORE_D / 2], s: [CORE_W - 1.4, BAND_H + 0.5, t] });
    out.push({ p: [0, y, -CORE_D / 2], s: [CORE_W - 1.4, BAND_H + 0.5, t] });
  }
  return out;
}

/* Shape data is constant, so it is built once at module load rather than per
 * component instance. */
const PANES = buildPanes();
const RIBBONS = buildRibbons();
const ROOF_CAPS: BoxInstance[] = [
  { p: [-WING_X, TOP - 0.09, 0], s: [WING_W + 0.6, 0.3, D + 0.6] },
  { p: [WING_X, TOP - 0.09, 0], s: [WING_W + 0.6, 0.3, D + 0.6] },
  { p: [0, TOP - 0.09, 0], s: [CORE_W, 0.3, CORE_D + 0.6] },
];
const PARAPETS: BoxInstance[] = [
  ...parapetBoxes(WING_W + 0.4, D + 0.4, TOP, -WING_X, 0, 0.75, 0.35),
  ...parapetBoxes(WING_W + 0.4, D + 0.4, TOP, WING_X, 0, 0.75, 0.35),
];
const JZ = junction('hospital')[2];

export function Hospital({ building, loadRatio, hour, highlighted }: BuildingModelProps) {
  const helipad = useMemo(() => makeHelipadTexture(), []);
  useEffect(() => {
    const tex: THREE.CanvasTexture | null = helipad;
    return () => {
      tex?.dispose();
    };
  }, [helipad]);

  const glass = litPanelHex(hour, loadRatio, 0.5);
  const glow = windowEmissiveIntensity(hour);

  return (
    <group>
      <GroundPad type="hospital" />
      {highlighted ? <HighlightRing type="hospital" /> : null}

      {/* wings */}
      {[-1, 1].map((sign) => (
        <mesh
          key={sign}
          position={[sign * WING_X, TOP / 2, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[WING_W, TOP, D]} />
          <meshStandardMaterial color={PALETTE.hospitalFacade} roughness={0.9} metalness={0} flatShading />
        </mesh>
      ))}

      {/* core */}
      <mesh position={[0, TOP / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[CORE_W, TOP, CORE_D]} />
        <meshStandardMaterial color={PALETTE.hospitalCore} roughness={0.9} metalness={0} flatShading />
      </mesh>

      <InstancedBoxes items={RIBBONS} color={PALETTE.officeSpandrel} roughness={0.85} />
      <Windows panes={PANES} hour={hour} loadRatio={loadRatio} />

      {/* roofs -- centre left clear for the devices module */}
      <InstancedBoxes items={ROOF_CAPS} color={PALETTE.roof} roughness={0.95} flatShading />
      <InstancedBoxes items={PARAPETS} color={PALETTE.parapet} roughness={0.9} />

      {/* helipad on the east wing */}
      <mesh position={[WING_X, TOP + 0.14, -4]} castShadow receiveShadow>
        <cylinderGeometry args={[3.2, 3.2, 0.22, 28]} />
        <meshStandardMaterial
          map={helipad}
          color={helipad ? '#ffffff' : '#334155'}
          roughness={0.95}
          metalness={0}
        />
      </mesh>

      {/* entrance glazing + emergency light band on the core front */}
      <mesh position={[0, 1.9, CORE_D / 2 + 0.08]} castShadow receiveShadow>
        <boxGeometry args={[CORE_W - 1.6, 3.2, 0.2]} />
        <meshStandardMaterial
          color={glass}
          emissive="#ffffff"
          emissiveIntensity={glow * 0.6}
          roughness={0.25}
          metalness={0.25}
        />
      </mesh>
      <mesh position={[0, 3.75, CORE_D / 2 + 0.12]} castShadow receiveShadow>
        <boxGeometry args={[CORE_W - 1.6, 0.3, 0.24]} />
        <meshStandardMaterial
          color={PALETTE.redBright}
          emissive={PALETTE.redBright}
          emissiveIntensity={1.6}
          roughness={0.5}
          toneMapped={false}
        />
      </mesh>

      {/* red cross on the core */}
      <mesh position={[0, 13.5, CORE_D / 2 + 0.16]} castShadow receiveShadow>
        <boxGeometry args={[3.0, 1.0, 0.28]} />
        <meshStandardMaterial
          color={PALETTE.red}
          emissive={PALETTE.red}
          emissiveIntensity={0.8}
          roughness={0.6}
        />
      </mesh>
      <mesh position={[0, 13.5, CORE_D / 2 + 0.16]} castShadow receiveShadow>
        <boxGeometry args={[1.0, 3.0, 0.28]} />
        <meshStandardMaterial
          color={PALETTE.red}
          emissive={PALETTE.red}
          emissiveIntensity={0.8}
          roughness={0.6}
        />
      </mesh>

      {/* ambulance canopy, tucked between the wings */}
      <EntranceCanopy
        width={CORE_W - 0.5}
        z={CORE_D / 2}
        height={5.0}
        depth={3.6}
        color={PALETTE.hospitalTrim}
        bandColor={PALETTE.red}
      />

      <Plinth width={W} depth={D} height={0.8} overhang={0.5} gap={11} color={PALETTE.plinthLight} />
      <JunctionBox type="hospital" />
      <NameSign name={building.name} position={[-11.5, 0, JZ + 3.2]} width={7.5} />
    </group>
  );
}

export default Hospital;
