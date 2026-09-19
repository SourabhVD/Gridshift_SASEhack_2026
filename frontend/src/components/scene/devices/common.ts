/**
 * Shared vocabulary for the 3D device props: palette, thresholds and the small
 * deterministic helpers the whole subtree leans on.
 *
 * Nothing here reads `Date`, `Math.random` or `window` -- the scene has to be
 * byte-identical between the server tree and the client tree, and identical
 * between two runs so screenshots are comparable.
 */

import type { Building, EnergyFlows } from '@/types/api';

/** Below this a flow is "dormant": faded conduit, no particles. Same number the 2D diagram uses. */
export const DORMANT_KW = 0.5;
/** Nameplate of one DC bay. `building.ev_bays * PER_BAY_KW` is the site's EV ceiling. */
export const PER_BAY_KW = 11;
/** Never model more than this many bays; larger sites get a multiplier in the label instead. */
export const MAX_RENDERED_BAYS = 12;
/** Hard cap on flow particles per conduit (also the allocated InstancedMesh size). */
export const MAX_PARTICLES = 40;
/** Conduit tube radius is quantised into this many buckets so geometry is rebuilt rarely. */
export const RADIUS_BUCKETS = 8;

/**
 * Scene palette. These are the literal hexes of the 2D diagram's CSS custom
 * properties -- a WebGL material cannot read a CSS variable, so they are
 * duplicated here on purpose. Keep in step with `globals.css`.
 */
export const C = {
  /** --color-forecast */
  grid: '#38bdf8',
  /** --color-alert */
  alert: '#ef4444',
  /** --color-peak */
  solar: '#f59e0b',
  /** --color-battery */
  battery: '#a78bfa',
  /** --color-muted */
  hvac: '#9ca3af',
  /** --color-good */
  good: '#10b981',

  steel: '#4b5563',
  cabinet: '#374151',
  concrete: '#6b7280',
  asphalt: '#374151',
  paint: '#e5e7eb',
  ceramic: '#d6d3d1',
  glass: '#0f172a',
  panel: '#1e3a8a',
  dark: '#1f2937',
} as const;

/** Muted car paints, cycled by bay index. */
export const CAR_PAINTS = ['#9ca3af', '#64748b', '#4b5563', '#78716c'] as const;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
 * (a 24-bay warehouse peaks at exactly 264 kW), so the 7 kW/bay fallback is
 * never reached -- the ratio is simply clamped instead, which keeps the bay
 * count monotonic in `ev_kw`.
 */
export function evPlan(building: Building, evKw: number): EvPlan {
  const rendered = Math.min(building.ev_bays, MAX_RENDERED_BAYS);
  const ceiling = Math.max(building.ev_bays * PER_BAY_KW, 1);
  const ratio = clamp(evKw / ceiling, 0, 1);
  const busy = (bays: number) => (evKw > 0 ? Math.max(1, Math.min(bays, Math.round(ratio * bays))) : 0);
  return {
    rendered,
    activeRendered: busy(rendered),
    activeTotal: busy(building.ev_bays),
    ratio,
    multiplier: rendered > 0 ? Math.max(1, Math.round(building.ev_bays / rendered)) : 1,
  };
}

/** "→ 90 kW discharging" / "← 40 kW charging" / "idle", matching the 2D readout. */
export function batteryPhrase(batteryKw: number): string {
  if (Math.abs(batteryKw) < DORMANT_KW) return 'idle';
  return batteryKw > 0
    ? `→ ${Math.round(batteryKw)} kW discharging`
    : `← ${Math.round(Math.abs(batteryKw))} kW charging`;
}
