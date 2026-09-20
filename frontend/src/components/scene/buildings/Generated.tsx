'use client';

/**
 * Generated building shells, and the table that fits them to the layout.
 *
 * Each of these is one vertex-coloured mesh out of the model pipeline (see
 * `glb/useBakedGlb`), standing in for the whole procedural shell -- walls,
 * roof, cladding, windows and all. What it does *not* stand in for is the
 * scene contract around it: the ground pad, the highlight ring, the junction
 * box at `junction(type)` and the name sign are still the pieces from
 * `Common`, drawn either side of the model, so anchors, picking and the
 * agent's highlight keep working exactly as they did.
 *
 * ## Fitting a generated building to `BUILDING_SPECS`
 *
 * The generator's output is normalised to about a metre on its longest axis and
 * has whatever proportions the reference image had. The layout contract wants a
 * specific footprint *and* a specific `roofY` -- the devices module lays its
 * solar array across `footprint - 4 m` at exactly `roofY(type)`, so a shell
 * that is short leaves the array hanging in the air.
 *
 * So each entry's `fit` holds a per-type box, not a scale: width comes from the
 * footprint, height from `roofY`, and the depth follows the width's scale
 * because no generated model happens to share the contract's plan ratio. Where
 * that asks for more than about 1.4x of vertical stretch the model is not used
 * at all -- see `GENERATED`.
 *
 * The numbers are bounding-box sizes for the *whole* model, and they are not
 * round: each was solved backwards from a feature that has to land on a
 * contract plane, from a measurement of the optimised file rather than from the
 * reference image.
 */

import type { ReactNode } from 'react';
import type { BuildingType } from '@/types/api';
import type { BuildingModelProps } from '../contracts';
import { GlbOrFallback } from '../glb/GlbOrFallback';
import { NightWindows } from '../glb/NightWindows';
import { preloadGlb, useBakedGlb, type GlbTransform } from '../glb/useBakedGlb';
import { GroundPad, HighlightRing, JunctionBox } from './Common';
import { NameSign } from './Signage';

/* -------------------------------------------------------------------------- */
/* Per-type fit                                                                */
/* -------------------------------------------------------------------------- */

interface WindowBand {
  /** Sill heights, metres. */
  rows: number[];
  cols: number;
  spread: number;
  size: [number, number];
}

interface GeneratedSpec {
  src: string;
  fit: GlbTransform;
  /**
   * Multiplied onto the baked vertex colours. A slight lift only -- the
   * generator's albedo is already inside the [#141414, #f2f2f2] band the tone
   * mapper wants, so anything stronger than a few percent takes it out again.
   */
  tint: string;
  roughness: number;
  /** Where the name sign stands, so it clears the model's own base. */
  sign: [number, number];
  signWidth: number;
  windows: WindowBand;
}

/**
 * The generated shells that survived the quality gate, one entry per type.
 *
 * Three of the four generated buildings are deliberately absent, and their
 * models are not shipped. What each of them failed on is worth writing down,
 * because two of the three failures are properties of the pipeline rather than
 * of one bad file:
 *
 *   office     the reference is a 2.8:1 slab tower. Held to a 16 m footprint
 *              width it is 6.6 m deep and 25 m tall, so reaching `roofY` 38.4
 *              costs a 1.57x vertical stretch -- and the roof is then 9 m deep
 *              under a solar array that is 12 m deep. Half the array hangs in
 *              mid-air over the back of the tower.
 *   hospital   a 2.5:1 low H-block. Width 26 m puts its roof at 10.2 m against
 *              a `roofY` of 21.6, a 2.1x stretch, and the render is a smear:
 *              every window band is twice its height and the facade reads as
 *              melted wax next to the procedural one.
 *   residence  the one whose proportions *did* fit -- 14 x 10 m on the nose,
 *              eaves on 6 m, gable wall on x = -7 -- and it still lost, on
 *              surface. The generator returned a uniformly pale house: its
 *              roof band averages 0.26 luminance where the reference is a
 *              black solar roof, so at the tour's roof close-up the residence
 *              has no visible array at all. The procedural house carries 72
 *              panels, cedar board seams and a pane-by-pane night, and the
 *              site's whole solar chapter is about that roof.
 *
 * The rule those three establish: a generated building is usable when its own
 * height-to-width ratio is within about 1.4x of what `BUILDING_SPECS` asks for,
 * its plan depth is no less than `footprint depth - 4 m` so the rooftop array
 * lands on something, *and* its vertex colours actually carry the feature the
 * site is about. Below any of those the procedural shell -- which fits the
 * contract exactly, because it was authored from it -- wins.
 */
export const GENERATED: Partial<Record<BuildingType, GeneratedSpec>> = {
  warehouse: {
    src: '/models/warehouse.glb',
    // 40.22 puts the shed walls on +-20, and 9.0 puts the sawtooth ridge on
    // `roofY('warehouse')` so the solar array lands on the teeth rather than
    // above them. That is a 1.37x vertical stretch, which a corrugated shed
    // carries: the ribs get taller, and nothing about them says how tall they
    // were meant to be.
    fit: { width: 40.22, height: 9.0 },
    tint: '#d7dce2',
    roughness: 0.85,
    sign: [8, 14.7],
    signWidth: 9,
    windows: {
      rows: [3.2, 6.6],
      cols: 4,
      spread: 12.0,
      size: [1.6, 1.4],
    },
  },
};

/** Every generated shell, warmed before the first paint. */
for (const spec of Object.values(GENERATED)) preloadGlb(spec.src);

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

function GeneratedShell({
  building,
  loadRatio,
  hour,
  highlighted,
  spec,
}: BuildingModelProps & { spec: GeneratedSpec }) {
  const { geometry, size } = useBakedGlb(spec.src, spec.fit);
  const type = building.type;

  return (
    <group>
      <GroundPad type={type} />
      {highlighted ? <HighlightRing type={type} /> : null}

      {/* The shell itself: one mesh, one draw call, colour in COLOR_0. */}
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial
          color={spec.tint}
          vertexColors
          roughness={spec.roughness}
          metalness={0}
        />
      </mesh>

      {/* Windows are painted into the shell, so they cannot switch on. These
          can: a few warm quads on the front face, after dark only. */}
      <NightWindows
        hour={hour}
        loadRatio={loadRatio}
        z={size.z / 2}
        rows={spec.windows.rows}
        cols={spec.windows.cols}
        spread={spec.windows.spread}
        size={spec.windows.size}
      />

      <JunctionBox type={type} />
      <NameSign
        name={building.name}
        position={[spec.sign[0], 0, spec.sign[1]]}
        width={spec.signWidth}
        height={0.85}
      />
    </group>
  );
}

/**
 * A generated shell, or the procedural building it stands in for.
 *
 * `fallback` is the whole procedural component, pad and sign included, so the
 * two branches never double up on anything.
 */
export function GeneratedBuilding({
  spec,
  fallback,
  ...props
}: BuildingModelProps & { spec: GeneratedSpec; fallback: ReactNode }) {
  return (
    <GlbOrFallback src={spec.src} fallback={fallback}>
      <GeneratedShell {...props} spec={spec} />
    </GlbOrFallback>
  );
}

export default GeneratedBuilding;
