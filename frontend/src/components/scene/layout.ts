import type { BuildingType } from '@/types/api';
/** World units are metres. Ground is y = 0. Building footprint is centred on the origin. */
export interface BuildingSpec { footprint: [width: number, depth: number]; floorHeight: number; floors: number; }
export const BUILDING_SPECS: Record<BuildingType, BuildingSpec> = {
  office:    { footprint: [16, 16], floorHeight: 3.2, floors: 12 },
  hospital:  { footprint: [26, 18], floorHeight: 3.6, floors: 6 },
  warehouse: { footprint: [40, 24], floorHeight: 9,   floors: 1 },
};
export function roofY(type: BuildingType): number { const s = BUILDING_SPECS[type]; return s.floors * s.floorHeight; }
/** Ground-level device anchors [x, y, z]. Rooftop devices (solar, hvac) sit on the roof, positioned by the devices module. */
export const ANCHORS = {
  grid:    [-24, 0, 12] as const,   // transformer + pylon, front-left
  battery: [-16, 0, -14] as const,  // battery cabinet, back-left
  ev:      [22, 0, 12] as const,    // charging bays, front-right; cars line up along +x from here
} as const;
/** Where conduits meet the building: a junction box on the front face at ground level. */
export function junction(type: BuildingType): [number, number, number] { return [0, 0.6, BUILDING_SPECS[type].footprint[1] / 2 + 0.3]; }
/** Camera look-at height per building so tall towers do not crop. */
export function focusHeight(type: BuildingType): number { return Math.min(roofY(type) * 0.45, 14); }
export type SceneNode = 'building' | 'grid' | 'solar' | 'battery' | 'ev' | 'hvac';
export const TOOL_NODES: Record<string, SceneNode[]> = {
  get_energy_forecast: ['building'], get_electricity_prices: ['grid'], get_battery_state: ['battery'],
  get_ev_requirements: ['ev'], get_hvac_constraints: ['hvac'], run_schedule_optimizer: ['battery','ev','hvac'],
  validate_schedule: ['battery','ev','hvac'], save_action_plan: ['building'], request_human_approval: ['building'],
};
