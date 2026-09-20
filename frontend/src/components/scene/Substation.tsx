'use client';

/**
 * The substation at the centre of the campus -- the thing all four feeders
 * actually come from.
 *
 * Built from primitives, to the same material contract as every other prop
 * (see Environment.tsx): albedo inside [#141414, #f2f2f2], roughness doing the
 * storytelling, metalness binary, and nothing emissive. A substation at night
 * is a dark object with a few hard highlights on its bushings; making any of it
 * glow would put a fifth light source in a scene that has three.
 *
 * Five clusters, five draw calls plus the yard:
 *
 *   yard        one plane of dark crushed stone, the ground the kit stands on
 *   concrete    tank plinths, mast footing, fence sleepers
 *   steel       fence rails, gantry portals, radiator fins, the lattice mast
 *   tanks       two 4.4 m pad-mount transformer tanks
 *   porcelain   bushings, post insulators and the busbar tubes
 *
 * Everything is authored around the origin, because the origin IS the
 * substation: `world.ts` places every lot relative to it.
 */

import { useMemo } from 'react';
import { Html } from '@react-three/drei';
import { SUBSTATION_YARD } from './world';
import { Boxes, Cylinders, type Piece } from './devices/Instanced';
import { C, MAT } from './devices/common';

/** Crushed stone inside the fence. Darker than the lot pads, never black. */
const YARD = '#1a1c20';
/** Porcelain, weathered. Bright, but a long way under the bloom threshold. */
const PORCELAIN = '#cfcbc2';
/** Bare aluminium busbar. */
const BUSBAR = '#b8bcc2';

/** Yard half-extents, so the fence knows where the perimeter is. */
const HALF_W = SUBSTATION_YARD[0] / 2;
const HALF_D = SUBSTATION_YARD[1] / 2;

/** Fence height, and how far apart its posts stand. */
const FENCE_H = 2.4;
const POST_PITCH = 3.25;

/** The lattice mast: short, because it terminates four feeders and no line. */
const MAST = { x: -9.4, z: -5.8, height: 15, baseSpread: 1.3, topSpread: 0.42 };

/** Centres of the two transformer bays. */
const TANKS: readonly [number, number][] = [
  [-6.4, -2.6],
  [6.4, -2.6],
];
const TANK_D = 4.4;
const TANK_H = 3.6;

/** The two bus gantries, each `{ z, height, span }`. */
const GANTRIES: readonly { z: number; height: number; span: number }[] = [
  { z: 4.6, height: 6.6, span: 8.6 },
  { z: 1.2, height: 5.2, span: 7.4 },
];

/** Phase spacing on a gantry, in metres. */
const PHASE_PITCH = 1.15;

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/** Evenly spaced post centres around the yard perimeter. */
function fencePosts(): [number, number][] {
  const out: [number, number][] = [];
  const along = (from: number, to: number) =>
    Math.max(1, Math.round(Math.abs(to - from) / POST_PITCH));

  const nx = along(-HALF_W, HALF_W);
  const nz = along(-HALF_D, HALF_D);

  for (let i = 0; i <= nx; i += 1) {
    const x = -HALF_W + (i / nx) * (HALF_W * 2);
    out.push([x, -HALF_D], [x, HALF_D]);
  }
  /* Corners are already placed by the runs above. */
  for (let i = 1; i < nz; i += 1) {
    const z = -HALF_D + (i / nz) * (HALF_D * 2);
    out.push([-HALF_W, z], [HALF_W, z]);
  }
  return out;
}

/** The mast's four legs, each a thin box raked in toward the top. */
function mastLegs(): Piece[] {
  const { x, z, height, baseSpread, topSpread } = MAST;
  const rake = (baseSpread - topSpread) / height;
  const angle = Math.atan(rake);
  const length = height / Math.cos(angle);
  const mid = (baseSpread + topSpread) / 2;

  const legs: Piece[] = [];
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      legs.push({
        p: [x + sx * mid, height / 2, z + sz * mid],
        s: [0.17, length, 0.17],
        /* Rotating about z leans the leg in x, about x leans it in z. */
        r: [sz * angle, 0, -sx * angle],
      });
    }
  }
  return legs;
}

/** Horizontal lacing at four levels, plus one diagonal per face per bay. */
function mastLacing(): Piece[] {
  const { x, z, height, baseSpread, topSpread } = MAST;
  const levels = [0.22, 0.45, 0.68, 0.94];
  const out: Piece[] = [];

  for (const t of levels) {
    const y = height * t;
    const spread = baseSpread + (topSpread - baseSpread) * t;
    const width = spread * 2;
    out.push(
      { p: [x, y, z - spread], s: [width, 0.11, 0.11] },
      { p: [x, y, z + spread], s: [width, 0.11, 0.11] },
      { p: [x - spread, y, z], s: [0.11, 0.11, width] },
      { p: [x + spread, y, z], s: [0.11, 0.11, width] },
    );
  }

  /* One diagonal per bay on the two faces the camera actually sees. */
  for (let i = 0; i < levels.length - 1; i += 1) {
    const y0 = height * levels[i];
    const y1 = height * levels[i + 1];
    const spread = baseSpread + (topSpread - baseSpread) * ((levels[i] + levels[i + 1]) / 2);
    const rise = y1 - y0;
    const run = spread * 2;
    const length = Math.hypot(rise, run);
    const tilt = Math.atan2(run, rise);
    out.push(
      { p: [x, (y0 + y1) / 2, z + spread], s: [0.09, length, 0.09], r: [0, 0, tilt] },
      { p: [x + spread, (y0 + y1) / 2, z], s: [0.09, length, 0.09], r: [-tilt, 0, 0] },
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface SubstationProps {
  /** Show the name plate. Only at portfolio level; up close it is chrome. */
  labelled?: boolean;
}

export function Substation({ labelled = true }: SubstationProps) {
  const concrete = useMemo<Piece[]>(() => {
    const out: Piece[] = [];
    for (const [x, z] of TANKS) {
      out.push({ p: [x, 0.16, z], s: [TANK_D + 1.6, 0.32, TANK_D + 1.6] });
    }
    out.push({ p: [MAST.x, 0.2, MAST.z], s: [4, 0.4, 4] });
    for (const gantry of GANTRIES) {
      out.push(
        { p: [-gantry.span, 0.14, gantry.z], s: [1.3, 0.28, 1.3] },
        { p: [gantry.span, 0.14, gantry.z], s: [1.3, 0.28, 1.3] },
      );
    }
    return out;
  }, []);

  const steel = useMemo<Piece[]>(() => {
    const out: Piece[] = [];

    /* Fence rails: three horizontal runs per side. */
    for (const y of [0.35, FENCE_H * 0.62, FENCE_H]) {
      out.push(
        { p: [0, y, -HALF_D], s: [HALF_W * 2, 0.07, 0.07] },
        { p: [0, y, HALF_D], s: [HALF_W * 2, 0.07, 0.07] },
        { p: [-HALF_W, y, 0], s: [0.07, 0.07, HALF_D * 2] },
        { p: [HALF_W, y, 0], s: [0.07, 0.07, HALF_D * 2] },
      );
    }

    /* Gantry portals: two columns and a head beam each. */
    for (const gantry of GANTRIES) {
      out.push(
        { p: [-gantry.span, gantry.height / 2, gantry.z], s: [0.34, gantry.height, 0.34] },
        { p: [gantry.span, gantry.height / 2, gantry.z], s: [0.34, gantry.height, 0.34] },
        { p: [0, gantry.height, gantry.z], s: [gantry.span * 2 + 0.34, 0.3, 0.26] },
      );
    }

    /* Radiator banks down both flanks of each tank. */
    for (const [x, z] of TANKS) {
      for (let i = 0; i < 5; i += 1) {
        const dz = (i - 2) * 0.62;
        out.push(
          { p: [x - TANK_D / 2 - 0.42, TANK_H * 0.55, z + dz], s: [0.85, TANK_H * 0.72, 0.14] },
          { p: [x + TANK_D / 2 + 0.42, TANK_H * 0.55, z + dz], s: [0.85, TANK_H * 0.72, 0.14] },
        );
      }
      /* Conservator drum sits across the top, and the cable box on the -z face. */
      out.push({ p: [x, TANK_H + 0.55, z - 1.5], s: [3.1, 0.62, 0.62] });
      out.push({ p: [x, 1.2, z + TANK_D / 2 + 0.3], s: [1.5, 2.1, 0.5] });
    }

    return [...out, ...mastLegs(), ...mastLacing()];
  }, []);

  const posts = useMemo<Piece[]>(
    () => fencePosts().map(([x, z]) => ({ p: [x, FENCE_H / 2, z], s: [0.1, FENCE_H, 0.1] })),
    [],
  );

  const tanks = useMemo<Piece[]>(
    () => TANKS.map(([x, z]) => ({ p: [x, TANK_H / 2 + 0.32, z], s: [TANK_D, TANK_H, TANK_D] })),
    [],
  );

  /* Bushings on the tank lids, post insulators on the gantry heads, and the
     busbar tubes they carry -- one cluster, because porcelain and bare
     aluminium at this distance are the same material story. */
  const porcelain = useMemo<Piece[]>(() => {
    const out: Piece[] = [];

    for (const [x, z] of TANKS) {
      for (let phase = -1; phase <= 1; phase += 1) {
        out.push({
          p: [x + phase * 1.15, TANK_H + 1.15, z + 0.9],
          s: [0.42, 1.5, 0.42],
          c: PORCELAIN,
        });
      }
    }

    for (const gantry of GANTRIES) {
      for (let phase = -1; phase <= 1; phase += 1) {
        const z = gantry.z + phase * PHASE_PITCH * 0.42;
        /* Insulator stacks hanging under the head beam... */
        out.push(
          { p: [-gantry.span, gantry.height - 0.75, z], s: [0.3, 1.1, 0.3], c: PORCELAIN },
          { p: [gantry.span, gantry.height - 0.75, z], s: [0.3, 1.1, 0.3], c: PORCELAIN },
        );
        /* ...and the bar they hold, laid on its side along x. */
        out.push({
          p: [0, gantry.height - 1.25, z],
          s: [0.17, gantry.span * 2, 0.17],
          r: [0, 0, Math.PI / 2],
          c: BUSBAR,
        });
      }
    }

    return out;
  }, []);

  return (
    <group name="substation">
      {/* The yard. Receives the sun's shadow from the mast and the gantries,
          which is most of what says "this is standing on something". */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow>
        <planeGeometry args={[SUBSTATION_YARD[0], SUBSTATION_YARD[1]]} />
        <meshStandardMaterial color={YARD} roughness={1} metalness={0} />
      </mesh>

      <Boxes pieces={concrete}>
        <meshStandardMaterial color={C.concrete} {...MAT.concrete} />
      </Boxes>

      <Boxes pieces={steel}>
        <meshStandardMaterial color={C.steel} {...MAT.paintedSteel} />
      </Boxes>

      <Cylinders pieces={posts} radialSegments={6}>
        <meshStandardMaterial color={C.steel} {...MAT.paintedSteel} />
      </Cylinders>

      <Cylinders pieces={tanks} radialSegments={16}>
        <meshStandardMaterial color={C.transformer} roughness={0.55} metalness={0.5} />
      </Cylinders>

      <Cylinders pieces={porcelain} radialSegments={8}>
        {/* Per-instance tint, so the material stays white. */}
        <meshStandardMaterial color="#ffffff" roughness={0.3} metalness={0} />
      </Cylinders>

      {labelled && (
        <Html
          position={[0, MAST.height + 2.4, 0]}
          center
          occlude={false}
          zIndexRange={[20, 0]}
          wrapperClass="pointer-events-none"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          <span className="rounded-full border border-white/10 bg-black/55 px-2 py-0.5 text-[10px] tracking-[0.08em] whitespace-nowrap text-white/70 uppercase backdrop-blur-sm">
            Substation
          </span>
        </Html>
      )}
    </group>
  );
}

export default Substation;
