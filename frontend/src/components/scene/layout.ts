import type { BuildingType } from '@/types/api';
/** World units are metres. Ground is y = 0. Building footprint is centred on the origin. */
export interface BuildingSpec { footprint: [width: number, depth: number]; floorHeight: number; floors: number; }
export const BUILDING_SPECS: Record<BuildingType, BuildingSpec> = {
  office:    { footprint: [16, 16], floorHeight: 3.2, floors: 12 },
  hospital:  { footprint: [26, 18], floorHeight: 3.6, floors: 6 },
  warehouse: { footprint: [40, 24], floorHeight: 9,   floors: 1 },
  residence: { footprint: [14, 10], floorHeight: 3.0, floors: 2 },
};
export function roofY(type: BuildingType): number { const s = BUILDING_SPECS[type]; return s.floors * s.floorHeight; }
/** How far the residence ridge stands above its eaves. */
export const RESIDENCE_RIDGE_RISE = 3.2;
/**
 * Top of the building's silhouette. Flat-roofed types answer `roofY`; the
 * residence has a gable, so its ridge sits `RESIDENCE_RIDGE_RISE` above the
 * eaves. Use this, not `roofY`, for anything that has to clear the roof.
 */
export function ridgeY(type: BuildingType): number {
  return type === 'residence' ? roofY(type) + RESIDENCE_RIDGE_RISE : roofY(type);
}
/** Ground-level device anchors [x, y, z]. Rooftop devices (solar, hvac) sit on the roof, positioned by the devices module. */
export const ANCHORS = {
  grid:    [-24, 0, 12] as const,   // transformer + pylon, front-left
  battery: [-16, 0, -14] as const,  // battery cabinet, back-left
  ev:      [22, 0, 12] as const,    // charging bays, front-right; cars line up along +x from here
} as const;
/** A ground anchor, [x, y, z] in metres. */
export type GroundAnchor = readonly [number, number, number];
/**
 * Per-site device anchors. `battery: 'wall'` means the units are not a ground
 * cabinet at all: they hang on the house's -x gable end at
 * `RESIDENCE_WALL_BATTERY`, facing -x.
 */
export interface SiteAnchors { grid: GroundAnchor; battery: GroundAnchor | 'wall'; ev: GroundAnchor; }
/** Centre of the two wall-mounted battery units on the residence's -x gable end. */
export const RESIDENCE_WALL_BATTERY = [-7.2, 1.2, 1.5] as const;
const RESIDENCE_ANCHORS: SiteAnchors = { grid: [-12, 0, 6], battery: 'wall', ev: [9, 0, 6] };
/**
 * Device anchors for one site. The three commercial types share the original
 * `ANCHORS`; the residence lot is 14 x 10 m, so the commercial spacing would
 * put its transformer two gardens away.
 */
export function anchorsFor(type: BuildingType): SiteAnchors {
  return type === 'residence' ? RESIDENCE_ANCHORS : ANCHORS;
}
/** Where conduits meet the building: a junction box on the front face at ground level. */
export function junction(type: BuildingType): [number, number, number] {
  // The house wears its meter on the front-left corner, not on the centreline:
  // the centre of its +z face is taken by the glazed slider.
  if (type === 'residence') return [-6.5, 0.4, 5.3];
  return [0, 0.6, BUILDING_SPECS[type].footprint[1] / 2 + 0.3];
}
/** Camera look-at height per building so tall towers do not crop. */
export function focusHeight(type: BuildingType): number {
  // A two-storey house is short enough that 45% of the eaves aims at the
  // plinth; 3.5 m puts the look-at on the first floor instead.
  if (type === 'residence') return 3.5;
  return Math.min(roofY(type) * 0.45, 14);
}
export type SceneNode = 'building' | 'grid' | 'solar' | 'battery' | 'ev' | 'hvac';
export const TOOL_NODES: Record<string, SceneNode[]> = {
  get_energy_forecast: ['building'], get_electricity_prices: ['grid'], get_battery_state: ['battery'],
  get_ev_requirements: ['ev'], get_hvac_constraints: ['hvac'], run_schedule_optimizer: ['battery','ev','hvac'],
  validate_schedule: ['battery','ev','hvac'], save_action_plan: ['building'], request_human_approval: ['building'],
};
