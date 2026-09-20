/**
 * sea-hospital-002 -- Harborview Medical Annex.
 *
 * The hard case. A hospital never really turns off: the overnight floor sits
 * around 600 kW and the midday plateau runs 830-884 kW, six hours of it over
 * the 800 kW threshold. HVAC is the dominant load (~40%), the battery carries
 * a 30% critical-care reserve floor instead of the usual 20%, and only two of
 * the four ambulance chargers may be moved at all.
 *
 * The reserve floor is what shapes the plan: the inverter is rated 400 kW and
 * the optimizer wanted 110 kW, but 76% SOC minus a 30% floor is 368 kWh, and
 * the over-threshold block is six hours long. 60 kW is the largest flat
 * discharge that covers all six hours without touching the floor, so that is
 * what gets dispatched.
 */

import type { Action, Building } from '@/types/api';
import {
  NOW_HOUR,
  type FlowComponents,
  baseFromGrid,
  energyCost,
  flat,
  gridFromComponents,
  hvacProfile,
  isoHour,
  makeFixture,
  meteredActuals,
  piecewise,
  range,
  round2,
  scheduleScript,
  socWalk,
  solarBell,
  withHours,
  zeros,
} from './shared';

export const HOSPITAL_ID = 'sea-hospital-002';

export const HOSPITAL_BUILDING: Building = {
  id: HOSPITAL_ID,
  name: 'Harborview Medical Annex',
  type: 'hospital',
  address: '325 9th Avenue, Seattle, WA 98104',
  floors: 6,
  area_sqft: 210_000,
  peak_threshold_kw: 800,
  battery_capacity_kwh: 800,
  battery_max_kw: 400,
  ev_bays: 4,
  solar_capacity_kw: 90,
  hvac_zones: 42,
};

const RESERVE_FLOOR_PCT = 30;
const START_SOC_PCT = 76;
/** Ambulance chargers. Four bays, two of them clinically movable. */
const EV_CHARGER_KW = 11;

/* -------------------------------------------------------------------------- */
/* Baseline                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Flat overnight floor, a long morning ramp as theatres and imaging come up,
 * then a 12:00-18:00 plateau. Peak 884 kW at 14:00; over 800 kW for six
 * consecutive hours, 12:00 through 18:00.
 */
export const BASELINE_GRID_KW: number[] = piecewise([
  [0, 604],
  [3, 588],
  [5, 600],
  [8, 748],
  [11, 772],
  [12, 838],
  [14, 884],
  [16, 852],
  [17, 830],
  [20, 716],
  [23, 612],
]).map(Math.round);

const SOLAR_KW = solarBell(72, 13, 5.5);

/** Two ambulances on charge from 10:00; the movable pair joins 14:00-16:00. */
const BASELINE_EV = withHours(
  withHours(zeros(), range(10, 18), 2 * EV_CHARGER_KW),
  range(14, 16),
  4 * EV_CHARGER_KW,
);

const BASELINE_HVAC = hvacProfile(BASELINE_GRID_KW, {
  night: 0.34,
  dayMin: 0.36,
  dayMax: 0.42,
  dayStart: 6,
  dayEnd: 22,
});

const BASELINE_PARTS: FlowComponents = {
  base: baseFromGrid(BASELINE_GRID_KW, {
    ev: BASELINE_EV,
    hvac: BASELINE_HVAC,
    solar: SOLAR_KW,
    battery: zeros(),
  }),
  ev: BASELINE_EV,
  hvac: BASELINE_HVAC,
  solar: SOLAR_KW,
  battery: zeros(),
  soc: flat(START_SOC_PCT),
};

/* -------------------------------------------------------------------------- */
/* Optimized                                                                   */
/* -------------------------------------------------------------------------- */

const DISCHARGE_KW = 60;
const DISCHARGE_HOURS = range(12, 18);
const OPTIMIZED_BATTERY = withHours(zeros(), DISCHARGE_HOURS, DISCHARGE_KW);
export const BATTERY_RECHARGE_KWH = DISCHARGE_KW * DISCHARGE_HOURS.length;

/** The two movable ambulances re-charge after the evening shift change. */
const OPTIMIZED_EV = withHours(
  withHours(BASELINE_EV, range(14, 16), 2 * EV_CHARGER_KW),
  range(19, 21),
  2 * EV_CHARGER_KW,
);

/**
 * Pre-cool the non-clinical wings while it is still cheap, then let those
 * zones drift +2°F through the two hottest hours. Clinical zones never move.
 */
const HVAC_DELTA_KW: Record<number, number> = {
  10: +15,
  11: +15,
  13: -35,
  14: -35,
};
const OPTIMIZED_HVAC = BASELINE_HVAC.map((kw, h) => kw + (HVAC_DELTA_KW[h] ?? 0));

const OPTIMIZED_PARTS: FlowComponents = {
  base: BASELINE_PARTS.base,
  ev: OPTIMIZED_EV,
  hvac: OPTIMIZED_HVAC,
  solar: SOLAR_KW,
  battery: OPTIMIZED_BATTERY,
  soc: socWalk(
    OPTIMIZED_BATTERY,
    START_SOC_PCT,
    HOSPITAL_BUILDING.battery_capacity_kwh,
  ),
};

export const OPTIMIZED_GRID_KW = gridFromComponents(OPTIMIZED_PARTS);

/* -------------------------------------------------------------------------- */
/* Headline numbers -- computed once, reused by the prose and the actions      */
/* -------------------------------------------------------------------------- */

const BASELINE_PEAK_KW = Math.max(...BASELINE_GRID_KW);
const OPTIMIZED_PEAK_KW = Math.max(...OPTIMIZED_GRID_KW);
const PEAK_REDUCTION_KW = BASELINE_PEAK_KW - OPTIMIZED_PEAK_KW;
const BASELINE_COST_USD = round2(energyCost(BASELINE_GRID_KW));
const OPTIMIZED_COST_USD = round2(
  energyCost(OPTIMIZED_GRID_KW) + BATTERY_RECHARGE_KWH * 0.09,
);
const SAVINGS_USD = round2(BASELINE_COST_USD - OPTIMIZED_COST_USD);
const DEMAND_CHARGE_AVOIDED_USD = round2(PEAK_REDUCTION_KW * 8.5);
const END_SOC_PCT = OPTIMIZED_PARTS.soc[17];

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

export const PLAN_SUMMARY = [
  `Today's forecast peaks at ${BASELINE_PEAK_KW} kW at 14:00 and stays above the`,
  '800 kW threshold for six straight hours, 12:00 through 18:00. That length is',
  'the binding constraint, not the height: the pack holds 608 kWh at 76% SOC but',
  'the critical-care policy reserves 30% of it, leaving 368 kWh. Spread across',
  `six hours that is ${DISCHARGE_KW} kW, well under the 400 kW inverter -- so the`,
  'battery alone cannot carry this and the plan adds two narrow, reversible',
  'levers on top. Non-clinical air handlers pre-cool at 10:00-12:00 and then',
  'drift +2°F for the two hottest hours, worth 35 kW; patient rooms, theatres',
  'and imaging are excluded outright. Two of the four ambulance chargers move to',
  '19:00, after the shift change, while the two on standby keep charging through.',
  `Together the peak falls from ${BASELINE_PEAK_KW} kW to ${OPTIMIZED_PEAK_KW} kW,`,
  `a ${PEAK_REDUCTION_KW} kW cut worth about $${DEMAND_CHARGE_AVOIDED_USD.toFixed(2)}`,
  `on the demand charge, with $${SAVINGS_USD.toFixed(2)} of day-ahead energy saved`,
  `on top. The battery ends the window at ${END_SOC_PCT}% SOC, one point above the`,
  'floor, which is exactly where a hospital should not be without a human',
  'agreeing to it first.',
].join(' ');

function buildActions(runId: string): Action[] {
  return [
    {
      id: 'act-battery-01',
      run_id: runId,
      type: 'battery_discharge',
      title: `Discharge battery at ${DISCHARGE_KW} kW, 12:00-18:00`,
      description: `Dispatch ${BATTERY_RECHARGE_KWH} kWh from the 800 kWh pack flat across all six over-threshold hours, taking SOC from ${START_SOC_PCT}% to ${END_SOC_PCT}%. The 30% critical-care reserve floor, not the 400 kW inverter, is what caps this at ${DISCHARGE_KW} kW -- a deeper, shorter discharge would clear 14:00 but leave 17:00 and 18:00 exposed. Recharges overnight at the $0.09/kWh off-peak rate.`,
      start_time: isoHour(12),
      end_time: isoHour(18),
      magnitude: DISCHARGE_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: DISCHARGE_KW,
      estimated_savings_usd: 25.2,
      status: 'pending',
      constraints_checked: [
        'soc_reserve_floor_30pct_critical_care',
        'max_discharge_400kw',
        'islanding_capability_preserved',
        'single_cycle_per_day',
      ],
    },
    {
      id: 'act-hvac-02',
      run_id: runId,
      type: 'hvac_setpoint',
      title: 'Pre-cool non-clinical zones, then drift +2°F 13:00-15:00',
      description:
        'Pre-cool the 26 non-clinical zones (admin, lobby, cafeteria, plant rooms) from 10:00 to 12:00, then let them rise 2°F for the 13:00-15:00 block, worth 35 kW. The 16 clinical zones -- patient rooms, operating theatres, imaging, pharmacy and the isolation suite -- are excluded and hold their setpoints and pressure relationships unchanged.',
      start_time: isoHour(13),
      end_time: isoHour(15),
      magnitude: 2,
      unit: '°F',
      estimated_peak_reduction_kw: 35,
      estimated_savings_usd: 11.2,
      status: 'pending',
      constraints_checked: [
        'clinical_zones_excluded',
        'operating_theatre_pressure_cascade_held',
        'non_clinical_max_temp_76f',
        'max_drift_duration_2h',
      ],
    },
    {
      id: 'act-ev-03',
      run_id: runId,
      type: 'ev_charging_shift',
      title: 'Shift 2 of 4 ambulance chargers to 19:00-21:00',
      description:
        'Move the two reserve ambulances off charge during 14:00-16:00 and re-start them at 19:00, after the shift change, at 11 kW each. The two front-line ambulances on standby are locked -- they must hold above 80% at all times and are never interrupted. Energy is unchanged; this action exists only to take 22 kW out of the peak-setting block.',
      start_time: isoHour(19),
      end_time: isoHour(21),
      magnitude: 2 * EV_CHARGER_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: 2 * EV_CHARGER_KW,
      estimated_savings_usd: 0,
      status: 'pending',
      constraints_checked: [
        'frontline_pair_never_interrupted',
        'reserve_pair_min_soc_80pct_by_2200',
        'dispatch_readiness_2_vehicles_minimum',
        'site_charger_limit_44kw',
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Agent script                                                                */
/* -------------------------------------------------------------------------- */

export const HOSPITAL_SCRIPT = scheduleScript([
  {
    type: 'thinking',
    tool_name: null,
    message:
      'Run started on a hospital, so the bar is different: nothing that touches patient care is on the table. Before I look for savings I need to know how long the building is over threshold, because duration usually decides what the battery can do here.',
    payload: null,
    duration_ms: 900,
  },
  {
    type: 'tool_call',
    tool_name: 'get_energy_forecast',
    message: 'get_energy_forecast(building_id="' + HOSPITAL_ID + '", horizon_hours=24)',
    payload: { building_id: HOSPITAL_ID, horizon_hours: 24 },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'get_energy_forecast',
    message: `Peak confirmed: ${BASELINE_PEAK_KW} kW at 14:00, 84 kW over the 800 kW threshold. The worrying number is the width -- six consecutive hours over threshold, 12:00 through 18:00, against four at a typical office.`,
    payload: {
      peak_kw: BASELINE_PEAK_KW,
      peak_time: isoHour(14),
      threshold_kw: 800,
      hours_over_threshold: 6,
      first_exceedance: isoHour(12),
      overnight_floor_kw: 588,
    },
    duration_ms: 910,
  },
  {
    type: 'tool_result',
    tool_name: 'get_electricity_prices',
    message:
      'Tariff loaded. Same Seattle City Light schedule as the rest of the portfolio: $0.09/kWh off-peak, $0.16/kWh from 14:00 to 20:00, $8.50/kW monthly demand charge set by the single highest interval.',
    payload: {
      off_peak_usd_per_kwh: 0.09,
      on_peak_usd_per_kwh: 0.16,
      on_peak_window: '14:00-20:00',
      demand_charge_usd_per_kw: 8.5,
    },
    duration_ms: 300,
  },
  {
    type: 'tool_result',
    tool_name: 'get_battery_state',
    message: `Battery is at ${START_SOC_PCT}% SOC, 608 kWh on an 800 kWh pack behind a 400 kW inverter. The reserve floor here is ${RESERVE_FLOOR_PCT}%, not the usual 20% -- the pack is part of the critical-care ride-through -- so only 368 kWh is dispatchable.`,
    payload: {
      soc_pct: START_SOC_PCT,
      capacity_kwh: 800,
      available_kwh: 608,
      max_discharge_kw: 400,
      reserve_floor_pct: RESERVE_FLOOR_PCT,
      reserve_reason: 'critical_care_ride_through',
      dispatchable_kwh: 368,
    },
    duration_ms: 270,
  },
  {
    type: 'tool_result',
    tool_name: 'get_ev_requirements',
    message:
      'Four ambulance chargers at 11 kW. Two are front-line vehicles on standby and must stay above 80% at all times -- they are not movable at any hour. The two reserve vehicles can be deferred, but not before 18:00, when the shift changes.',
    payload: {
      sessions_connected: 4,
      flexible_sessions: 2,
      locked_sessions: 2,
      lock_reason: 'frontline_dispatch_readiness',
      earliest_shift_time: isoHour(18),
      target_soc_pct: 80,
      charger_power_kw_each: EV_CHARGER_KW,
    },
    duration_ms: 320,
  },
  {
    type: 'tool_result',
    tool_name: 'get_hvac_constraints',
    message:
      'HVAC is 42 zones, and 16 of them are clinical: patient rooms, theatres, imaging, pharmacy, isolation. Those are locked on both setpoint and pressure cascade. The remaining 26 non-clinical zones may drift 2°F for up to two hours, worth about 35 kW.',
    payload: {
      zones_total: 42,
      clinical_zones_locked: 16,
      non_clinical_zones_flexible: 26,
      max_drift_f: 2,
      max_drift_hours: 2,
      non_clinical_max_temp_f: 76,
      estimated_shed_kw: 35,
    },
    duration_ms: 280,
  },
  {
    type: 'thinking',
    tool_name: null,
    message: `368 kWh over a six-hour block is ${DISCHARGE_KW} kW flat -- far below what the inverter could do, but a deeper discharge would clear 14:00 and leave 17:00 and 18:00 uncovered, and the demand charge only cares about the highest interval that survives. So: battery flat across all six hours, HVAC and EV on top for the two worst ones. Handing that shape to the optimizer.`,
    payload: null,
    duration_ms: 1200,
  },
  {
    type: 'tool_call',
    tool_name: 'run_schedule_optimizer',
    message:
      'run_schedule_optimizer(objective="minimize_peak_then_cost", horizon_hours=24, resources=["battery","ev","hvac"], locked_zones=16)',
    payload: {
      objective: 'minimize_peak_then_cost',
      horizon_hours: 24,
      resources: ['battery', 'ev', 'hvac'],
      locked_zones: 16,
      solver: 'CP-SAT',
    },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'run_schedule_optimizer',
    message: `Solver returned an optimal schedule in 3.1 s. Peak drops from ${BASELINE_PEAK_KW} kW to ${OPTIMIZED_PEAK_KW} kW, a ${PEAK_REDUCTION_KW} kW cut. It wanted 110 kW on the battery and the reserve floor refused, so the binding intervals are now 16:00 and 18:00, tied -- shedding harder at 14:00 buys nothing.`,
    payload: {
      status: 'OPTIMAL',
      solve_time_ms: 3104,
      baseline_peak_kw: BASELINE_PEAK_KW,
      optimized_peak_kw: OPTIMIZED_PEAK_KW,
      peak_reduction_kw: PEAK_REDUCTION_KW,
      unconstrained_battery_kw: 110,
      binding_intervals: [isoHour(16), isoHour(18)],
    },
    duration_ms: 3104,
  },
  {
    type: 'tool_result',
    tool_name: 'validate_schedule',
    message: `All 17 constraints pass. Battery ends the window at ${END_SOC_PCT}% SOC, one point above the ${RESERVE_FLOOR_PCT}% critical-care floor. Both front-line ambulances stay above 80% throughout. All 16 clinical zones are untouched and the theatre pressure cascade holds.`,
    payload: {
      constraints_checked: 17,
      violations: 0,
      battery_end_soc_pct: END_SOC_PCT,
      reserve_floor_pct: RESERVE_FLOOR_PCT,
      clinical_zones_untouched: 16,
      frontline_min_soc_pct: 84,
      hvac_drift_hours: 2,
    },
    duration_ms: 240,
  },
  {
    type: 'decision',
    tool_name: 'save_action_plan',
    message: `Committing a three-action plan: hold ${DISCHARGE_KW} kW on the battery from 12:00 to 18:00, drift the 26 non-clinical HVAC zones +2°F for two hours, and move the two reserve ambulance chargers to 19:00.`,
    payload: { action_count: 3, plan_savings_usd: SAVINGS_USD },
    duration_ms: 160,
  },
  {
    type: 'tool_call',
    tool_name: 'request_human_approval',
    message:
      'This one is not close to automatic. The battery finishes one point off a critical-care reserve floor and the HVAC action touches occupied space, so it goes to the facilities director and the on-call clinical engineer together.',
    payload: {
      requires_approval: true,
      action_count: 3,
      approvers: ['facilities_director', 'clinical_engineering_on_call'],
    },
    duration_ms: null,
  },
  {
    type: 'complete',
    tool_name: null,
    message: `Investigation complete in 16.8 s. Plan is ready for review; nothing will be dispatched until both approvers sign off.`,
    payload: {
      peak_reduction_kw: PEAK_REDUCTION_KW,
      savings_usd: SAVINGS_USD,
      demand_charge_avoided_usd: DEMAND_CHARGE_AVOIDED_USD,
    },
    duration_ms: null,
  },
]);

/* -------------------------------------------------------------------------- */

export const hospitalFixture = makeFixture({
  building: HOSPITAL_BUILDING,
  baselineGrid: BASELINE_GRID_KW,
  baselineParts: BASELINE_PARTS,
  optimizedParts: OPTIMIZED_PARTS,
  pinnedOptimizedGrid: OPTIMIZED_GRID_KW,
  actualLoadKw: meteredActuals(BASELINE_GRID_KW, NOW_HOUR),
  batteryRechargeKwh: BATTERY_RECHARGE_KWH,
  summary: {
    current_load_kw: BASELINE_GRID_KW[NOW_HOUR],
    battery_soc_pct: START_SOC_PCT,
    solar_generation_kw: SOLAR_KW[NOW_HOUR],
    ev_connected: 2,
    hvac_setpoint_f: 70,
    outdoor_temp_f: 71,
  },
  planSummary: PLAN_SUMMARY,
  buildActions,
  script: HOSPITAL_SCRIPT,
});
