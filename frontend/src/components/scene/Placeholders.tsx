'use client';

/**
 * Stand-in geometry for the two modules that are built separately: the building
 * shell and the device props. They implement the same contracts, so swapping
 * the real ones in is a two-line import change in EnergyScene.
 *
 * These are meant to be presentable rather than detailed — flat-shaded blocks
 * at the right scale, in the right places, with the right colours. If a module
 * is late, the scene still reads.
 */

import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import type { BuildingModelProps, DevicesProps } from './contracts';
import { ANCHORS, BUILDING_SPECS, junction, roofY, type SceneNode } from './layout';

/* Palette, mirroring the theme tokens. -------------------------------------- */
const C_GRID = '#38bdf8';
const C_SOLAR = '#f59e0b';
const C_BATTERY = '#a78bfa';
const C_HVAC = '#9ca3af';
const C_ALERT = '#ef4444';
const C_GOOD = '#10b981';
const C_SHELL = '#2a3748';
const C_SHELL_DARK = '#1d2735';
const C_PROP = '#374151';
const C_PROP_LIGHT = '#4b5563';
const C_PAD = '#2b3540';
const C_WINDOW = '#fbbf24';

/** 1 deep in the night, 0 in full daylight. Matches the Environment's arc. */
function nightFactor(hour: number): number {
  return 1 - THREE.MathUtils.smoothstep(Math.sin((Math.PI * (hour - 6.75)) / 12.5), -0.05, 0.25);
}

/* -------------------------------------------------------------------------- */
/* Building                                                                    */
/* -------------------------------------------------------------------------- */

export function PlaceholderBuilding({
  building,
  loadRatio,
  hour,
  highlighted,
}: BuildingModelProps) {
  const spec = BUILDING_SPECS[building.type];
  const [w, d] = spec.footprint;
  const h = roofY(building.type);

  /* Glazing bands sit between floors; a single-storey shed gets one belt line. */
  const bands = useMemo(() => {
    if (spec.floors <= 1) return [h * 0.62];
    return Array.from({ length: spec.floors - 1 }, (_, i) => (i + 1) * spec.floorHeight);
  }, [spec.floors, spec.floorHeight, h]);

  const night = nightFactor(hour);
  const load = THREE.MathUtils.clamp(loadRatio, 0, 1.4);
  const glow = (0.18 + 1.25 * load) * (0.25 + 0.75 * night);
  const windowColor = loadRatio > 1 ? C_ALERT : C_WINDOW;
  const padRadius = Math.max(w, d) * 0.82;

  return (
    <group>
      {/* Ground pad the building stands on. */}
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <boxGeometry args={[w + 8, 0.12, d + 8]} />
        <meshStandardMaterial color={C_PAD} roughness={0.92} flatShading />
      </mesh>

      {/* Shell. */}
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={C_SHELL} roughness={0.78} metalness={0.05} flatShading />
      </mesh>

      {/* Glazing bands, lit by hour and by how hard the building is pulling. */}
      {bands.map((y) => (
        <mesh key={y} position={[0, y, 0]}>
          <boxGeometry args={[w + 0.08, 0.5, d + 0.08]} />
          <meshStandardMaterial
            color="#0f1722"
            emissive={windowColor}
            emissiveIntensity={glow}
            roughness={0.35}
          />
        </mesh>
      ))}

      {/* Roof slab, a shade darker so the silhouette reads from above. */}
      <mesh position={[0, h + 0.25, 0]} castShadow receiveShadow>
        <boxGeometry args={[w + 0.8, 0.5, d + 0.8]} />
        <meshStandardMaterial color={C_SHELL_DARK} roughness={0.9} flatShading />
      </mesh>

      {/* Signage band above the entrance. */}
      <mesh position={[0, 2.4, d / 2 + 0.06]}>
        <planeGeometry args={[Math.min(w * 0.7, 10), 1.1]} />
        <meshStandardMaterial
          color="#0f1722"
          emissive={C_GRID}
          emissiveIntensity={0.35 + 0.35 * night}
          roughness={0.5}
        />
      </mesh>

      {highlighted && (
        <mesh position={[0, 0.14, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[padRadius, padRadius + 0.5, 72]} />
          <meshBasicMaterial color={C_GRID} transparent opacity={0.65} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Devices                                                                     */
/* -------------------------------------------------------------------------- */

/** Line weight from a flow's share of the busiest flow this hour. */
function weight(kw: number, maxKw: number): number {
  return 1 + 2.2 * THREE.MathUtils.clamp(Math.abs(kw) / Math.max(maxKw, 1), 0, 1);
}

export function PlaceholderDevices({
  building,
  flows,
  mode,
  overThreshold,
  activeNodes,
  running,
}: DevicesProps) {
  const spec = BUILDING_SPECS[building.type];
  const [w, d] = spec.footprint;
  const roof = roofY(building.type);
  const jn = junction(building.type);

  const maxKw = Math.max(
    Math.abs(flows.grid_kw),
    flows.solar_kw,
    Math.abs(flows.battery_kw),
    flows.ev_kw,
    flows.hvac_kw,
    1,
  );

  const lit = (node: SceneNode) => running && activeNodes.has(node);
  const emissive = (node: SceneNode) => (lit(node) ? 0.9 : 0.12);

  const gridColor = overThreshold ? C_ALERT : C_GRID;
  const batteryColor = mode === 'optimized' && flows.battery_kw > 0 ? C_GOOD : C_BATTERY;
  const hvacColor = flows.hvac_kw >= flows.ev_kw && flows.hvac_kw > 0 ? C_SOLAR : C_HVAC;

  const solarPos: [number, number, number] = [-w * 0.16, roof + 0.7, 0];
  const hvacPos: [number, number, number] = [w * 0.28, roof + 1.4, -d * 0.24];

  /* Roof runs come down the front face rather than through the slab. */
  const facadeZ = d / 2 + 0.3;
  const solarRun: [number, number, number][] = [
    solarPos,
    [solarPos[0], roof + 0.7, facadeZ],
    [solarPos[0], 0.6, facadeZ],
    jn,
  ];
  const hvacRun: [number, number, number][] = [
    hvacPos,
    [hvacPos[0], roof + 0.7, facadeZ],
    [hvacPos[0], 0.6, facadeZ],
    jn,
  ];

  return (
    <group>
      {/* ---- conduits ---- */}
      <Line
        points={[[ANCHORS.grid[0], 0.6, ANCHORS.grid[2]], jn]}
        color={gridColor}
        lineWidth={weight(flows.grid_kw, maxKw)}
        transparent
        opacity={0.7}
      />
      <Line
        points={[[ANCHORS.battery[0], 0.6, ANCHORS.battery[2]], jn]}
        color={batteryColor}
        lineWidth={weight(flows.battery_kw, maxKw)}
        transparent
        opacity={0.7}
      />
      <Line
        points={[[ANCHORS.ev[0], 0.6, ANCHORS.ev[2]], jn]}
        color={C_GRID}
        lineWidth={weight(flows.ev_kw, maxKw)}
        transparent
        opacity={0.7}
      />
      <Line
        points={solarRun}
        color={C_SOLAR}
        lineWidth={weight(flows.solar_kw, maxKw)}
        transparent
        opacity={0.5}
      />
      <Line
        points={hvacRun}
        color={hvacColor}
        lineWidth={weight(flows.hvac_kw, maxKw)}
        transparent
        opacity={0.5}
      />

      {/* ---- junction box ---- */}
      <mesh position={jn} castShadow>
        <boxGeometry args={[1.2, 1.2, 0.5]} />
        <meshStandardMaterial color={C_PROP_LIGHT} roughness={0.7} flatShading />
      </mesh>

      {/* ---- transformer + pylon ---- */}
      <group position={[ANCHORS.grid[0], 0, ANCHORS.grid[2]]}>
        <mesh position={[0, 1.6, 0]} castShadow receiveShadow>
          <boxGeometry args={[3.4, 3.2, 3.4]} />
          <meshStandardMaterial
            color={C_PROP}
            emissive={gridColor}
            emissiveIntensity={emissive('grid')}
            roughness={0.75}
            flatShading
          />
        </mesh>
        <mesh position={[0, 6.5, -2.2]} castShadow>
          <cylinderGeometry args={[0.22, 0.3, 13, 6]} />
          <meshStandardMaterial color={C_PROP_LIGHT} roughness={0.85} flatShading />
        </mesh>
        <mesh position={[0, 12, -2.2]} castShadow>
          <boxGeometry args={[5, 0.3, 0.3]} />
          <meshStandardMaterial color={C_PROP_LIGHT} roughness={0.85} flatShading />
        </mesh>
      </group>

      {/* ---- battery cabinet ---- */}
      <group position={[ANCHORS.battery[0], 0, ANCHORS.battery[2]]}>
        <mesh position={[0, 1.3, 0]} castShadow receiveShadow>
          <boxGeometry args={[5.5, 2.6, 2.4]} />
          <meshStandardMaterial
            color={C_PROP}
            emissive={batteryColor}
            emissiveIntensity={emissive('battery')}
            roughness={0.7}
            flatShading
          />
        </mesh>
        <mesh position={[0, 2.75, 0]}>
          <boxGeometry args={[5.5 * THREE.MathUtils.clamp(flows.battery_soc_pct / 100, 0, 1), 0.2, 2.4]} />
          <meshStandardMaterial color={batteryColor} emissive={batteryColor} emissiveIntensity={0.6} />
        </mesh>
      </group>

      {/* ---- EV bays ---- */}
      <group position={[ANCHORS.ev[0], 0, ANCHORS.ev[2]]}>
        {Array.from({ length: Math.min(building.ev_bays, 6) }, (_, i) => (
          <mesh key={i} position={[i * 3.2, 0.9, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.7, 1.8, 0.5]} />
            <meshStandardMaterial
              color={C_PROP}
              emissive={C_GRID}
              emissiveIntensity={emissive('ev')}
              roughness={0.7}
              flatShading
            />
          </mesh>
        ))}
      </group>

      {/* ---- rooftop solar ---- */}
      <mesh position={solarPos} rotation={[-0.22, 0, 0]} castShadow>
        <boxGeometry args={[w * 0.58, 0.16, d * 0.5]} />
        <meshStandardMaterial
          color="#16233a"
          emissive={C_SOLAR}
          emissiveIntensity={lit('solar') ? 0.7 : (flows.solar_kw / maxKw) * 0.12}
          roughness={0.28}
          metalness={0.35}
          flatShading
        />
      </mesh>

      {/* ---- rooftop HVAC ---- */}
      <mesh position={hvacPos} castShadow receiveShadow>
        <boxGeometry args={[3.6, 2, 3]} />
        <meshStandardMaterial
          color={C_PROP_LIGHT}
          emissive={hvacColor}
          emissiveIntensity={emissive('hvac')}
          roughness={0.7}
          flatShading
        />
      </mesh>
    </group>
  );
}
