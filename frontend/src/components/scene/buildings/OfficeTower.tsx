'use client';

/**
 * Office tower -- 16 x 16 m footprint, 12 floors at 3.2 m (38.4 m to the roof).
 *
 * A glass-blue shaft with the top two floors set back, vertical mullion strips
 * every 2 m, a spandrel band at every floor line, a double-height glazed lobby
 * at the base, and a louvred mechanical screen along the back edge of the
 * setback terrace. The top roof is left clear for the devices module.
 */
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
  RoofSlab,
  type BoxInstance,
} from './Common';
import { litPanelHex, PALETTE, windowEmissiveIntensity } from './materials';
import { NameSign } from './Signage';
import { PANE_DEPTH, wallGrid, Windows, type Facing, type Pane } from './Windows';

const SPEC = BUILDING_SPECS.office;
const [W, D] = SPEC.footprint; // 16, 16
const FLOOR = SPEC.floorHeight; // 3.2
const TOP = roofY('office'); // 38.4

/** Floors 0-1 are the glazed lobby. */
const LOBBY_FLOORS = 2;
const LOBBY_TOP = LOBBY_FLOORS * FLOOR; // 6.4
/** The shaft runs to floor 10; floors 10-11 are set back. */
const SHAFT_FLOORS = 10;
const SHAFT_TOP = SHAFT_FLOORS * FLOOR; // 32
const SETBACK = 3.6; // total width lost at the setback
const TOP_W = W - SETBACK; // 12.4

const ALL_FACES: Facing[] = ['z+', 'x+', 'z-', 'x-'];

/** Vertical mullion strips every 2 m, on both the shaft and the setback. */
function buildMullions(): BoxInstance[] {
  const out: BoxInstance[] = [];
  const add = (
    faceW: number,
    half: number,
    height: number,
    cy: number,
    withCorners: boolean,
    proud: number,
  ) => {
    const steps = Math.round(faceW / 2);
    for (const facing of ALL_FACES) {
      // Corner strips only once, from the z faces, so they do not double up.
      const onZ = facing === 'z+' || facing === 'z-';
      const from = withCorners && onZ ? 0 : 1;
      const to = withCorners && onZ ? steps : steps - 1;
      for (let k = from; k <= to; k++) {
        const u = -faceW / 2 + k * 2;
        const dist = half + proud;
        const p: [number, number, number] =
          facing === 'z+'
            ? [u, cy, dist]
            : facing === 'z-'
              ? [-u, cy, -dist]
              : facing === 'x+'
                ? [dist, cy, -u]
                : [-dist, cy, u];
        const s: [number, number, number] =
          facing === 'z+' || facing === 'z-'
            ? [0.18, height, 0.3]
            : [0.3, height, 0.18];
        out.push({ p, s });
      }
    }
  };
  // shaft: runs unbroken from the plinth past the lobby up to the setback, so
  // the double-height lobby glass gets the same vertical rhythm as the tower
  add(W, W / 2, SHAFT_TOP - 1.0, (SHAFT_TOP + 1.0) / 2, true, 0.2);
  // setback block
  add(TOP_W, TOP_W / 2, TOP - SHAFT_TOP, (TOP + SHAFT_TOP) / 2, true, 0.12);
  return out;
}

/** A dark spandrel band at every floor line. */
function buildSpandrels(): BoxInstance[] {
  const out: BoxInstance[] = [];
  for (let f = 1; f <= SPEC.floors; f++) {
    const y = f * FLOOR - 0.35;
    const setback = y > SHAFT_TOP;
    const width = setback ? TOP_W : W;
    const half = width / 2 + 0.09;
    out.push({ p: [0, y, half], s: [width + 0.18, 0.9, 0.22] });
    out.push({ p: [0, y, -half], s: [width + 0.18, 0.9, 0.22] });
    out.push({ p: [half, y, 0], s: [0.22, 0.9, width + 0.18] });
    out.push({ p: [-half, y, 0], s: [0.22, 0.9, width + 0.18] });
  }
  return out;
}

/** Window panes: 8 bays per face on the shaft, 6 on the setback. */
function buildPanes(): Pane[] {
  const shaftDist = W / 2 + PANE_DEPTH / 2 + 0.01;
  const topDist = TOP_W / 2 + PANE_DEPTH / 2 + 0.01;
  const panes: Pane[] = [];
  for (const facing of ALL_FACES) {
    panes.push(
      ...wallGrid({
        facing,
        dist: shaftDist,
        cols: 8,
        colPitch: 2,
        w: 1.5,
        rows: SHAFT_FLOORS - LOBBY_FLOORS,
        y0: LOBBY_TOP + FLOOR / 2 + 0.15,
        rowPitch: FLOOR,
        h: 1.7,
      }),
      ...wallGrid({
        facing,
        dist: topDist,
        cols: 6,
        colPitch: 2,
        w: 1.5,
        rows: SPEC.floors - SHAFT_FLOORS,
        y0: SHAFT_TOP + FLOOR / 2 + 0.15,
        rowPitch: FLOOR,
        h: 1.7,
      }),
    );
  }
  return panes;
}

/** Horizontal louvres on the rooftop mechanical screen. */
function buildLouvres(): BoxInstance[] {
  const out: BoxInstance[] = [];
  for (let i = 0; i < 4; i++) {
    out.push({ p: [0, SHAFT_TOP + 0.75 + i * 0.6, -W / 2 + 0.9], s: [W - 1.2, 0.3, 0.72] });
  }
  return out;
}

/* Shape data is constant, so it is built once at module load rather than per
 * component instance. */
const MULLIONS = buildMullions();
const SPANDRELS = buildSpandrels();
const PANES = buildPanes();
const LOUVRES = buildLouvres();
const PARAPETS = [
  ...parapetBoxes(W, D, SHAFT_TOP, 0, 0, 0.8, 0.35),
  ...parapetBoxes(TOP_W, TOP_W, TOP, 0, 0, 0.8, 0.35),
];
const JZ = junction('office')[2];
/** Two door leaves either side of the junction box, which sits on x = 0. */
const DOORS: BoxInstance[] = [
  { p: [-2.1, 1.8, D / 2 + 0.15], s: [3.2, 3.0, 0.3] },
  { p: [2.1, 1.8, D / 2 + 0.15], s: [3.2, 3.0, 0.3] },
];

export function OfficeTower({ building, loadRatio, hour, highlighted }: BuildingModelProps) {
  const lobbyGlass = litPanelHex(hour, loadRatio, 0.35);
  const lobbyGlow = windowEmissiveIntensity(hour) * 0.2;

  return (
    <group>
      <GroundPad type="office" />
      {highlighted ? <HighlightRing type="office" /> : null}

      {/* shaft */}
      <mesh position={[0, SHAFT_TOP / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[W, SHAFT_TOP, D]} />
        <meshStandardMaterial
          color={PALETTE.officeGlass}
          metalness={0.2}
          roughness={0.35}
          flatShading
        />
      </mesh>

      {/* double-height glazed lobby wrapping the base */}
      <mesh position={[0, (LOBBY_TOP + 1.0) / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[W + 0.22, LOBBY_TOP - 1.0, D + 0.22]} />
        <meshStandardMaterial
          color={lobbyGlass}
          emissive="#ffffff"
          emissiveIntensity={lobbyGlow * 0.5}
          metalness={0.3}
          roughness={0.2}
        />
      </mesh>

      {/* set-back top two floors */}
      <mesh position={[0, (TOP + SHAFT_TOP) / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[TOP_W, TOP - SHAFT_TOP, TOP_W]} />
        <meshStandardMaterial
          color={PALETTE.officeGlass}
          metalness={0.2}
          roughness={0.35}
          flatShading
        />
      </mesh>

      <InstancedBoxes items={MULLIONS} color={PALETTE.officeMullion} roughness={0.5} metalness={0.4} />
      <InstancedBoxes items={SPANDRELS} color={PALETTE.officeSpandrel} roughness={0.7} />
      <Windows panes={PANES} hour={hour} loadRatio={loadRatio} />

      {/* setback terrace + top roof, both left clear in the middle */}
      <RoofSlab width={W} depth={D} y={SHAFT_TOP} />
      <RoofSlab width={TOP_W} depth={TOP_W} y={TOP} />
      <InstancedBoxes items={PARAPETS} color={PALETTE.parapet} roughness={0.9} />

      {/* rooftop mechanical screen along the back edge of the terrace */}
      <mesh position={[0, SHAFT_TOP + 1.5, -D / 2 + 0.9]} castShadow receiveShadow>
        <boxGeometry args={[W - 0.6, 3.0, 0.3]} />
        <meshStandardMaterial color={PALETTE.officeScreen} roughness={0.75} metalness={0.3} flatShading />
      </mesh>
      <InstancedBoxes items={LOUVRES} color={PALETTE.metalTrim} roughness={0.6} metalness={0.4} flatShading />

      {/* stair bulkhead, back corner of the top roof */}
      <mesh position={[-3.6, TOP + 1.5, -3.6]} castShadow receiveShadow>
        <boxGeometry args={[2.6, 2.8, 2.6]} />
        <meshStandardMaterial color={PALETTE.roof} roughness={0.9} flatShading />
      </mesh>

      {/* entrance doors, split so the junction box on the centreline stays clear */}
      <InstancedBoxes items={DOORS} color={PALETTE.officeSpandrel} roughness={0.4} metalness={0.3} />

      <Plinth width={W} depth={D} height={1.0} overhang={0.6} />
      <EntranceCanopy width={9} z={D / 2} height={4.4} depth={2.2} color={PALETTE.plinthLight} />
      <JunctionBox type="office" />
      <NameSign name={building.name} position={[-7.5, 0, JZ + 2.6]} width={7} />
    </group>
  );
}

export default OfficeTower;
