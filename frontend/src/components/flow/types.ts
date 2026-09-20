/**
 * Flow diagram data shapes.
 *
 * These are the canonical API types re-exported under the names the diagram
 * uses, so the diagram can never drift from the contract.
 *
 * Sign convention for EnergyFlows.battery_kw: > 0 = discharging INTO the
 * building; < 0 = charging FROM the grid.
 * Identity: grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw
 */

export type { Building, BuildingType, EnergyFlows } from '@/types/api';
export type { AgentToolName as FlowTool } from '@/types/api';
