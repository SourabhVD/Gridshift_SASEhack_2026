/**
 * Shared vocabulary for the 3D device props: palette, materials, thresholds and
 * the small deterministic helpers the whole subtree leans on.
 *
 * Nothing here reads `Date`, `Math.random` or `window` -- the scene has to be
 * byte-identical between the server tree and the client tree, and identical
 * between two runs so screenshots are comparable.
 *
 * ## Lighting contract
 *
 * The stage is ACES tone mapped at ~1.05 exposure with a procedural environment
 * map, and bloom picks up anything brighter than 1.05 in linear space. That
 * splits every surface in this folder into two families:
 *
 *   paint / plastic / concrete / metal   albedo in [#141414, #f2f2f2], tone
 *                                        mapped, never above the threshold
 *   light                                `toneMapped={false}` plus a colour run
 *                                        through `glow()`, i.e. multiplied
 *                                        above 1.0 so the composer blooms it
 *
 * `glow()` is the only sanctioned way to cross the threshold. Reach for it for
 * LEDs, screens and flow particles; never for a painted panel.
 */

import { Color } from 'three';
import type { Building, BuildingType, EnergyFlows } from '@/types/api';

/** Below this a flow is "dormant": faded conduit, no particles. Same number the 2D diagram uses. */
export const DORMANT_KW = 0.5;
/** Nameplate of one DC bay. `building.ev_bays * PER_BAY_KW` is the site's EV ceiling. */
export const PER_BAY_KW = 11;
/** Never model more than this many bays; larger sites get a multiplier in the label instead. */
export const MAX_RENDERED_BAYS = 12;
/** Hard cap on flow particles per conduit (also the per-stream slice of the shared InstancedMesh). */
export const MAX_PARTICLES = 40;
/** Conduit tube radius is quantised into this many buckets so geometry is rebuilt rarely. */
export const RADIUS_BUCKETS = 8;

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Channel colours are the literal hexes of the 2D diagram's CSS custom
 * properties -- a WebGL material cannot read a CSS variable, so they are
 * duplicated here on purpose. Keep in step with `globals.css`.
 *
 * Surface colours are albedo, not paint-chip colour: what the surface reflects
 * under a neutral sky. They all sit inside the [#141414, #f2f2f2] band the tone
 * mapper is happy with. The one deliberate exception is `glass`, which is
 * nearly black diffuse because its look comes from the environment reflection
 * rather than from its albedo.
 */
export const PALETTE = {
  /* --- channels: the STAGE RAMP -------------------------------------------
   * These are NOT the UI hexes. Bloom clips saturation before it adds light,
   * so the stage runs each channel ~20 % toward white (same hue, ~8 L* up).
   * `glow()` multiplies on top of that, which is why BLOOM_GAIN can stay at
   * 2.2 -- the lift happens in the colour, not in the gain.
   * ---------------------------------------------------------------------- */
  /** --stage-grid. Grid / utility. The only channel that takes a state. */
  grid: '#6EA0FF',
  /** --stage-alert. ONLY the grid channel is ever allowed to take this. */
  alert: '#FF7B75',
  /** --stage-solar. Solar generation. Never borrowed by HVAC any more. */
  solar: '#FFBE5C',
  /** --stage-battery. */
  battery: '#D5B8FF',
  /** --stage-ev. EV charging. Deliberately NOT the grid blue. */
  ev: '#4CD9C3',
  /** --stage-hvac. HVAC, at every load: it never warms up, it only thickens. */
  hvac: '#9FA6B3',
  /** --stage-good. Grid under threshold in an optimized plan. Grid only. */
  good: '#7BEAAB',

  /* --- surfaces ---------------------------------------------------------- */
  /** Painted steel: enclosures, lattice, rails. Tinted per instance. */
  steel: '#59606b',
  /** Pad-mount transformer green-grey. */
  transformer: '#3b4a3f',
  /** Powder-coated white: cabinets, pedestals, wall units, heat pump. */
  powder: '#e9e9e6',
  /** Cast concrete: pads, plinths, kerbs, drives. */
  concrete: '#9a9791',
  /** Rubber / EPDM: tyres, gaskets, dark trim. */
  rubber: '#1b1b1b',
  /** Dark reflective glazing. Its look is the reflection, not the albedo. */
  glass: '#0b1220',
  /** Silver car paint, under a clearcoat. */
  carPaint: '#c9ccd1',
  /** PV laminate under glass. */
  panel: '#16233a',
  /** PV frame + mounting rails. */
  frame: '#1f2937',
  /** Bituminous apron under the charging court. */
  asphalt: '#2f3136',
  /** Bay markings and kerb paint. */
  markings: '#d8d8d2',
  /** Weathered timber utility pole. */
  wood: '#6b5b4a',
  /** Warning placard. Paint, not a light: stays well under the bloom threshold. */
  placard: '#c9a227',
  /** Dim red tail lamp lens. Under the threshold on purpose -- parked cars do not bloom. */
  tailLamp: '#8f2b2b',
  /** Head lamp lens, unlit. */
  headLamp: '#dfe6ef',
  /** Generic dark trim: screen bezels, seams, louvre shadow. */
  dark: '#23262b',
} as const;

/** Historical alias. The whole folder still spells the palette `C`. */
export const C = PALETTE;

/* -------------------------------------------------------------------------- */
/* Material presets                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Roughness/metalness pairs, one per real-world material. Spread these into a
 * `<meshStandardMaterial>` so two props that claim to be the same material
 * actually are.
 */
export const MAT = {
  paintedSteel: { roughness: 0.45, metalness: 0.6 },
  powder: { roughness: 0.35, metalness: 0.1 },
  concrete: { roughness: 0.95, metalness: 0 },
  rubber: { roughness: 0.9, metalness: 0 },
  glass: { roughness: 0.05, metalness: 0.9 },
  /** Base coat. Pair it with `clearcoat 1 / clearcoatRoughness 0.08` on a physical material. */
  carPaint: { roughness: 0.3, metalness: 0.85 },
  /** PV glass: a sheen, not a mirror. */
  pvGlass: { roughness: 0.2, metalness: 0.6 },
  timber: { roughness: 0.85, metalness: 0 },
} as const;

/* -------------------------------------------------------------------------- */
/* Bloom                                                                       */
/* -------------------------------------------------------------------------- */

/** Multiplier that carries a palette colour clear of the composer's 1.05 cut. */
export const BLOOM_GAIN = 2.2;

/* `Color.set(Color)` copies the raw linear components, so a cached instance can
 * be handed to any number of materials without being re-converted or mutated.
 * Building them once also keeps `glow()` free to call during render. */
const GLOW_CACHE = new Map<string, Color>();

/**
 * A palette colour lifted above the bloom threshold.
 *
 * `new Color(hex)` converts sRGB -> linear working space; multiplying after
 * that is what actually makes the pixel bright, and the material must opt out
 * of tone mapping (`toneMapped={false}`) or ACES pulls it straight back under
 * 1.0.
 */
export function glow(hex: string, gain: number = BLOOM_GAIN): Color {
  const key = hex + '|' + gain;
  let color = GLOW_CACHE.get(key);
  if (!color) {
    color = new Color(hex).multiplyScalar(gain);
    GLOW_CACHE.set(key, color);
  }
  return color;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Narrows the single-family lot, which swaps almost every prop for a domestic one. */
export function isResidence(type: BuildingType): boolean {
  return type === 'residence';
}

/**
 * Copies any length-3 reading into a fresh mutable tuple.
 *
 * `layout.ts` hands out `readonly` tuples, plain arrays and (for the wall
 * battery) a sentinel string depending on the anchor; this keeps every call
 * site from growing its own cast.
 */
export function v3(a: readonly number[]): [number, number, number] {
  return [a[0], a[1], a[2]];
}

/**
 * Deterministic pseudo-random in [0, 1). Used for bay occupancy and paint
 * jitter -- `Math.random` would desync the server and client trees and make
 * every screenshot different.
 */
export function hash01(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Muted metallic car paints, cycled by bay index. All take the same clearcoat. */
export const CAR_PAINTS = ['#c9ccd1', '#8b929c', '#5f6670', '#a8a29b'] as const;

/** Busiest flow this hour; every conduit width, particle count and speed is a share of it. */
export function maxFlowKw(flows: EnergyFlows): number {
  return Math.max(
    1,
    Math.abs(flows.grid_kw),
    Math.abs(flows.solar_kw),
    Math.abs(flows.battery_kw),
    Math.abs(flows.ev_kw),
    Math.abs(flows.hvac_kw),
  );
}

export interface EvPlan {
  /** Bays actually modelled (<= MAX_RENDERED_BAYS). */
  rendered: number;
  /** Of the modelled bays, how many are drawing power. */
  activeRendered: number;
  /** Of the real site, how many bays are drawing power -- what the label says. */
  activeTotal: number;
  /** ev_kw as a share of the site ceiling, 0..1. */
  ratio: number;
  /** `rendered * multiplier ~= building.ev_bays`; 1 when nothing was folded away. */
  multiplier: number;
}

/**
 * How many bays are busy, and how many of them we bother to model.
 *
 * The site ceiling is `ev_bays * PER_BAY_KW`. The fixtures never exceed it
 * (a 24-bay warehouse peaks at exactly 264 kW), so the ratio is simply clamped,
 * which keeps the bay count monotonic in `ev_kw`.
 */
export function evPlan(building: Building, evKw: number): EvPlan {
  const rendered = Math.min(building.ev_bays, MAX_RENDERED_BAYS);
  const ceiling = Math.max(building.ev_bays * PER_BAY_KW, 1);
  const ratio = clamp(evKw / ceiling, 0, 1);
  const busy = (bays: number) =>
    evKw > 0 ? Math.max(1, Math.min(bays, Math.round(ratio * bays))) : 0;
  return {
    rendered,
    activeRendered: busy(rendered),
    activeTotal: busy(building.ev_bays),
    ratio,
    multiplier: rendered > 0 ? Math.max(1, Math.round(building.ev_bays / rendered)) : 1,
  };
}

/** "-> 90 kW discharging" / "<- 40 kW charging" / "idle", matching the 2D readout. */
export function batteryPhrase(batteryKw: number): string {
  if (Math.abs(batteryKw) < DORMANT_KW) return 'idle';
  return batteryKw > 0
    ? '→ ' + Math.round(batteryKw) + ' kW discharging'
    : '← ' + Math.round(Math.abs(batteryKw)) + ' kW charging';
}
