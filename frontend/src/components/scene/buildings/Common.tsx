'use client';

/**
 * Pieces every building shares: the ground pad, the highlight ring, the
 * junction box, the entrance plinth/canopy, roof slabs and parapets, plus a
 * generic InstancedBoxes helper that keeps the draw-call budget down.
 */
import * as THREE from 'three';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { BuildingType } from '@/types/api';
import { BUILDING_SPECS, junction } from '../layout';
import { PALETTE } from './materials';

/* -------------------------------------------------------------------------- */
/* Instanced boxes                                                             */
/* -------------------------------------------------------------------------- */

/** One box instance in building-local space. */
export interface BoxInstance {
  p: [number, number, number];
  /** Size along local x, y, z (before rotation). */
  s: [number, number, number];
  /** Rotation about X (used for the sawtooth roof panels). */
  rx?: number;
  /** Rotation about Y. */
  ry?: number;
  /** Rotation about Z. */
  rz?: number;
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v3 = new THREE.Vector3();
const s3 = new THREE.Vector3();

export interface InstancedBoxesProps {
  items: BoxInstance[];
  color: string;
  roughness?: number;
  metalness?: number;
  flatShading?: boolean;
  emissive?: string;
  emissiveIntensity?: number;
}

/**
 * Many identical-material boxes in one draw call. Used for mullions, spandrel
 * bands, parapets, corrugation strips, louvres, dock doors and bumpers.
 */
export function InstancedBoxes({
  items,
  color,
  roughness = 0.8,
  metalness = 0.05,
  flatShading = false,
  emissive,
  emissiveIntensity,
}: InstancedBoxesProps) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = items.length;

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    for (let i = 0; i < count; i++) {
      const item = items[i];
      v3.set(item.p[0], item.p[1], item.p[2]);
      e.set(item.rx ?? 0, item.ry ?? 0, item.rz ?? 0);
      q.setFromEuler(e);
      s3.set(item.s[0], item.s[1], item.s[2]);
      m4.compose(v3, q, s3);
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [items, count]);

  if (count === 0) return null;

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, count]}
      castShadow
      receiveShadow
      frustumCulled={false}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color={color}
        roughness={roughness}
        metalness={metalness}
        flatShading={flatShading}
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
      />
    </instancedMesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Ground pad                                                                  */
/* -------------------------------------------------------------------------- */

/** How far the pad oversails the footprint on every side. */
export const PAD_MARGIN = 4;
export const PAD_THICKNESS = 0.15;

export function GroundPad({ type }: { type: BuildingType }) {
  const [w, d] = BUILDING_SPECS[type].footprint;
  return (
    <mesh position={[0, -PAD_THICKNESS / 2, 0]} receiveShadow castShadow>
      <boxGeometry args={[w + PAD_MARGIN * 2, PAD_THICKNESS, d + PAD_MARGIN * 2]} />
      <meshStandardMaterial color={PALETTE.pad} roughness={0.95} metalness={0} />
    </mesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Highlight ring                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Emissive ring at ground level around the pad. Only rendered when the building
 * is highlighted -- nothing else about the model changes.
 */
export function HighlightRing({ type }: { type: BuildingType }) {
  const [w, d] = BUILDING_SPECS[type].footprint;
  const outer = Math.max(w, d) / 2 + PAD_MARGIN + 1.2;
  const material = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    const mat = material.current;
    if (!mat) return;
    const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 2.2);
    mat.emissiveIntensity = 1.1 + 1.9 * pulse;
    mat.opacity = 0.45 + 0.45 * pulse;
  });

  return (
    <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[outer - 0.9, outer, 72]} />
      <meshStandardMaterial
        ref={material}
        color={PALETTE.highlight}
        emissive={PALETTE.highlight}
        emissiveIntensity={2}
        roughness={1}
        metalness={0}
        transparent
        opacity={0.8}
        depthWrite={false}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Junction box                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The 0.6 m cube the conduits arrive at, placed exactly at `junction(type)` on
 * the +z face. The devices module draws the conduits into it.
 */
export function JunctionBox({ type }: { type: BuildingType }) {
  const p = junction(type);
  return (
    <mesh position={p} castShadow receiveShadow>
      <boxGeometry args={[0.6, 0.6, 0.6]} />
      <meshStandardMaterial color={PALETTE.junction} roughness={0.6} metalness={0.4} flatShading />
    </mesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Entrance                                                                    */
/* -------------------------------------------------------------------------- */

export interface EntranceProps {
  /** Width of the canopy along x. */
  width: number;
  /** Front face of the mass the canopy attaches to (z of the wall plane). */
  z: number;
  /** Height of the canopy soffit. */
  height?: number;
  /** How far the canopy projects past the facade. */
  depth?: number;
  color?: string;
  /** Optional coloured band along the canopy edge (hospital ambulance canopy). */
  bandColor?: string;
  /** Shifts the canopy along x. */
  x?: number;
}

/**
 * Lighter plinth + entrance canopy on the +z face. Two boxes plus a pair of
 * instanced columns -- keeps the front of every building readable.
 */
export function EntranceCanopy({
  width,
  z,
  height = 4.4,
  depth = 3.2,
  color = PALETTE.plinthLight,
  bandColor,
  x = 0,
}: EntranceProps) {
  const columnX = width / 2 - 0.5;
  return (
    <group>
      {/* canopy slab */}
      <mesh position={[x, height, z + depth / 2]} castShadow receiveShadow>
        <boxGeometry args={[width, 0.35, depth]} />
        <meshStandardMaterial color={color} roughness={0.8} metalness={0.1} flatShading />
      </mesh>
      {bandColor ? (
        <mesh position={[x, height - 0.3, z + depth - 0.05]} castShadow receiveShadow>
          <boxGeometry args={[width, 0.5, 0.2]} />
          <meshStandardMaterial
            color={bandColor}
            roughness={0.6}
            emissive={bandColor}
            emissiveIntensity={0.25}
          />
        </mesh>
      ) : null}
      <InstancedBoxes
        items={[
          { p: [x - columnX, height / 2, z + depth - 0.4], s: [0.35, height, 0.35] },
          { p: [x + columnX, height / 2, z + depth - 0.4], s: [0.35, height, 0.35] },
        ]}
        color={color}
        roughness={0.8}
      />
    </group>
  );
}

/**
 * Low lighter apron around the base of a mass, in one draw call. The front
 * (+z) run is split so there is a `gap` metre opening on the centreline: that
 * keeps both the entrance and the junction box clear of it.
 */
export function Plinth({
  width,
  depth,
  height = 0.9,
  x = 0,
  z = 0,
  color = PALETTE.plinth,
  overhang = 0.5,
  gap = 6,
}: {
  width: number;
  depth: number;
  height?: number;
  x?: number;
  z?: number;
  color?: string;
  overhang?: number;
  gap?: number;
}) {
  const items = useMemo<BoxInstance[]>(() => {
    const cy = height / 2;
    const t = overhang + 0.4; // apron depth, overlapping into the facade
    const outerW = width + overhang * 2;
    const frontZ = z + depth / 2 + overhang - t / 2;
    const backZ = z - depth / 2 - overhang + t / 2;
    const sideX = width / 2 + overhang - t / 2;
    const runW = Math.max(0.01, (outerW - gap) / 2);
    return [
      { p: [x - (gap / 2 + runW / 2), cy, frontZ], s: [runW, height, t] },
      { p: [x + (gap / 2 + runW / 2), cy, frontZ], s: [runW, height, t] },
      { p: [x, cy, backZ], s: [outerW, height, t] },
      { p: [x + sideX, cy, z], s: [t, height, depth + overhang * 2] },
      { p: [x - sideX, cy, z], s: [t, height, depth + overhang * 2] },
    ];
  }, [width, depth, height, x, z, overhang, gap]);

  return <InstancedBoxes items={items} color={color} roughness={0.85} flatShading />;
}

/* -------------------------------------------------------------------------- */
/* Roof                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Flat roof slab + cornice. Its top sits 6 cm above the nominal roof height so
 * rooftop devices placed at `roofY(type)` rest on it rather than float.
 */
export function RoofSlab({
  width,
  depth,
  y,
  x = 0,
  z = 0,
  color = PALETTE.roof,
  overhang = 0.3,
}: {
  width: number;
  depth: number;
  y: number;
  x?: number;
  z?: number;
  color?: string;
  overhang?: number;
}) {
  return (
    <mesh position={[x, y - 0.09, z]} castShadow receiveShadow>
      <boxGeometry args={[width + overhang * 2, 0.3, depth + overhang * 2]} />
      <meshStandardMaterial color={color} roughness={0.95} metalness={0} flatShading />
    </mesh>
  );
}

/**
 * Four low parapet walls around a roof, in one draw call. The roof centre is
 * left completely clear for the devices module (solar + HVAC).
 */
export function parapetBoxes(
  width: number,
  depth: number,
  y: number,
  x = 0,
  z = 0,
  height = 0.7,
  thickness = 0.4,
): BoxInstance[] {
  const cy = y + height / 2;
  return [
    { p: [x, cy, z + depth / 2 - thickness / 2], s: [width, height, thickness] },
    { p: [x, cy, z - depth / 2 + thickness / 2], s: [width, height, thickness] },
    { p: [x + width / 2 - thickness / 2, cy, z], s: [thickness, height, depth] },
    { p: [x - width / 2 + thickness / 2, cy, z], s: [thickness, height, depth] },
  ];
}
