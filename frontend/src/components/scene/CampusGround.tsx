'use client';

/**
 * The ground the campus stands on -- and almost none of it.
 *
 * The stage is still a true-black page with no floor. All this adds is two
 * whispers, because four buildings scattered on nothing read as four separate
 * scenes rather than as one site:
 *
 *   lot pads       one barely-lighter rectangle per site, at --stage-ground.
 *                  It sits just BELOW grade so each building's own concrete
 *                  plinth still reads on top of it.
 *   service roads  a 6 m ribbon from the substation to each lot, following the
 *                  exact route its feed conduit takes, and stopping at the lot
 *                  boundary the way a real service road stops at the gate.
 *
 * Two draw calls for the whole campus: every pad is an instance of one box, and
 * the four ribbons are merged into a single buffer. Neither casts a shadow --
 * a 2 cm slab has nothing to cast, and keeping them out of the sun's pass is
 * worth more than the geometry costs.
 */

import { useEffect, useMemo } from 'react';
import { BufferAttribute, BufferGeometry, CatmullRomCurve3, Vector3 } from 'three';
import type { BuildingType } from '@/types/api';
import { Boxes, type Piece } from './devices/Instanced';
import { type Box, feedRoute, worldLotBox } from './world';

/** --stage-ground. The lot reads as a surface without becoming a colour. */
const PAD = '#0d0f13';
/** One step down from the pad: tarmac against hardstanding. */
const ROAD = '#0a0b0e';

/** Pads sit under grade so a building's plinth (top at y = 0) stays on top. */
const PAD_TOP = -0.006;
const PAD_THICKNESS = 0.08;
/** The road crosses the pad, so it has to be the higher of the two. */
const ROAD_Y = 0.004;

export const ROAD_WIDTH = 6;
/** Samples along each route. The ribbon is flat, so this is only smoothness. */
const ROAD_SAMPLES = 48;

/* -------------------------------------------------------------------------- */
/* Ribbon                                                                      */
/* -------------------------------------------------------------------------- */

function inside(box: Box, p: Vector3): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.z >= box.minZ && p.z <= box.maxZ;
}

/**
 * The route, sampled and then cut off at the lot gate.
 *
 * Without the cut the tarmac would run straight under the building, because a
 * site's grid anchor is inboard of its own lot boundary. One sample past the
 * boundary is kept so the ribbon ends flush with the pad edge rather than a
 * road-width short of it.
 */
function roadPoints(type: BuildingType): Vector3[] {
  const curve = new CatmullRomCurve3(feedRoute(type), false, 'centripetal', 0.5);
  const sampled = curve.getSpacedPoints(ROAD_SAMPLES);
  const lot = worldLotBox(type);

  const out: Vector3[] = [];
  for (const point of sampled) {
    out.push(point);
    if (inside(lot, point) && out.length > 1) break;
  }
  return out.length >= 2 ? out : sampled.slice(0, 2);
}

/** Appends one flat ribbon, two vertices per sample, to the shared buffers. */
function pushRibbon(points: Vector3[], half: number, positions: number[], indices: number[]) {
  const base = positions.length / 3;

  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const length = Math.hypot(tx, tz) || 1;
    tx /= length;
    tz /= length;
    /* Left-hand normal in the ground plane. */
    const nx = -tz;
    const nz = tx;
    positions.push(p.x + nx * half, ROAD_Y, p.z + nz * half);
    positions.push(p.x - nx * half, ROAD_Y, p.z - nz * half);
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = base + i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

function buildRoads(types: readonly BuildingType[]): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const type of types) pushRibbon(roadPoints(type), ROAD_WIDTH / 2, positions, indices);

  const geometry = new BufferGeometry();
  const array = new Float32Array(positions);
  geometry.setAttribute('position', new BufferAttribute(array, 3));

  /* Every face is horizontal, so the normals are known without computing them. */
  const normals = new Float32Array(array.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));

  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface CampusGroundProps {
  /** The site types actually on the campus, in registry order. */
  types: readonly BuildingType[];
}

export function CampusGround({ types }: CampusGroundProps) {
  const key = types.join(',');

  const pads = useMemo<Piece[]>(
    () =>
      types.map((type) => {
        const lot = worldLotBox(type);
        return {
          p: [
            (lot.minX + lot.maxX) / 2,
            PAD_TOP - PAD_THICKNESS / 2,
            (lot.minZ + lot.maxZ) / 2,
          ],
          s: [lot.maxX - lot.minX, PAD_THICKNESS, lot.maxZ - lot.minZ],
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const roads = useMemo(() => buildRoads(types), [key]);
  useEffect(() => () => roads.dispose(), [roads]);

  if (types.length === 0) return null;

  return (
    <group name="campus-ground">
      <Boxes pieces={pads} castShadow={false} receiveShadow>
        <meshStandardMaterial color={PAD} roughness={1} metalness={0} />
      </Boxes>

      <mesh geometry={roads} receiveShadow raycast={() => null}>
        <meshStandardMaterial color={ROAD} roughness={1} metalness={0} />
      </mesh>
    </group>
  );
}

export default CampusGround;
