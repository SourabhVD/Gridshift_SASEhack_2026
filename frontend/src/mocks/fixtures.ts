/**
 * GridShift demo fixtures -- entry point.
 *
 * The data itself now lives one directory down, one file per building:
 *
 *   buildings/shared.ts      deterministic generator + the flow identity
 *   buildings/office.ts      sea-office-001    Cascade Commerce Center
 *   buildings/hospital.ts    sea-hospital-002  Harborview Medical Annex
 *   buildings/warehouse.ts   sea-warehouse-003 Duwamish Logistics Hub
 *   buildings/index.ts       registry + validateFixtures()
 *
 * Nothing here is random. Every curve is generated from a handful of control
 * points, so the charts, the KPI tiles, the flow diagram and the action plan
 * are all reading the same arithmetic and cannot disagree.
 *
 * Only src/mocks/mockServer.ts should import this module.
 */

export {
  BUILDINGS,
  DEFAULT_BUILDING_ID,
  FIXTURES,
  HOSPITAL_ID,
  OFFICE_ID,
  WAREHOUSE_ID,
  checkFixtures,
  getFixture,
  isKnownBuilding,
  validateFixtures,
  type BuildingFixture,
  type FixtureReport,
  type FixtureViolation,
} from './buildings';

export {
  DEMAND_CHARGE_USD_PER_KW,
  DEMO_DATE,
  NOW_HOUR,
  NOW_ISO,
  PRICE_PER_KWH,
  TZ_OFFSET,
  isoHour,
  type ScriptedEvent,
} from './buildings/shared';

/* -------------------------------------------------------------------------- */
/* Default-building shorthands                                                 */
/* -------------------------------------------------------------------------- */

import { officeFixture } from './buildings/office';

export {
  ACTUAL_LOAD_KW,
  BASELINE_LOAD_KW,
  BATTERY_RECHARGE_KWH,
  OPTIMIZED_LOAD_KW,
  PLAN_SUMMARY,
  SOLAR_KW,
  OFFICE_BUILDING as BUILDING,
} from './buildings/office';

/** The default building's name/id, kept for callers that predate the registry. */
export const BUILDING_NAME = officeFixture.building.name;
export const BUILDING_ID = officeFixture.building.id;
export const PEAK_THRESHOLD_KW = officeFixture.building.peak_threshold_kw;

export const BASELINE_PEAK_KW = officeFixture.baselinePeakKw;
export const BASELINE_PEAK_HOUR = officeFixture.baselinePeakHour;
export const OPTIMIZED_PEAK_KW = officeFixture.optimizedPeakKw;
export const PEAK_REDUCTION_KW = officeFixture.peakReductionKw;
export const BASELINE_COST_USD = officeFixture.baselineCostUsd;
export const OPTIMIZED_COST_USD = officeFixture.optimizedCostUsd;
export const SAVINGS_USD = officeFixture.savingsUsd;
export const DEMAND_CHARGE_AVOIDED_USD = officeFixture.demandChargeAvoidedUsd;

/** The default building's scripted run. */
export const AGENT_SCRIPT = officeFixture.script;

/** Total scripted run length, used by the mock server. */
export const SCRIPT_DURATION_MS =
  AGENT_SCRIPT[AGENT_SCRIPT.length - 1].offset_ms;
