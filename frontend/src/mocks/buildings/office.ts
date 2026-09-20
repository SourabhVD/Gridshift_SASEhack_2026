/**
 * sea-office-001 -- Cascade Commerce Center (the default building).
 *
 * This is the original GridShift demo, unchanged: same 24-hour curves, same
 * 14-event script, same three actions, same dollar figures. The only thing
 * added here is the flow breakdown behind each hour, back-solved from the
 * published curves so `flows.grid_kw` is exactly `predicted_load_kw` and
 * `optimized_flows.grid_kw` is exactly `optimized_kw`.
 *
 * How the optimized flows reconcile with the pinned optimized curve:
 *
 *   hour   battery    EV                     HVAC          net vs baseline
 *   11,12       0     -                      +24 / +18     +24 / +18  pre-cool
 *   13          0     -                      -22           -22        coasting
 *   14      +90 kW    69 -> 23 kW (-46)      -14           -150
 *   15      +90 kW    69 -> 23 kW (-46)      -18           -154
 *   16      +90 kW    -                      -              -90
 *   18,19       0     0 -> 46 kW (+46)       -             +46 / +46  shifted
 *
 * base_kw comes out identical between the two curves, which is the point: no
 * action in this plan changes what the building actually needs, only when and
 * from where it is served.
 */

import type { Action, Building } from '@/types/api';
import {
  NOW_HOUR,
  type FlowComponents,
  baseFromGrid,
  flat,
  hvacProfile,
  isoHour,
  makeFixture,
  range,
  scheduleScript,
  socWalk,
  withHours,
  zeros,
} from './shared';

export const OFFICE_ID = 'sea-office-001';

export const OFFICE_BUILDING: Building = {
  id: OFFICE_ID,
  name: 'Cascade Commerce Center',
  type: 'office',
  address: '1200 4th Avenue, Seattle, WA 98101',
  floors: 12,
  area_sqft: 150_000,
  peak_threshold_kw: 450,
  battery_capacity_kwh: 500,
  battery_max_kw: 250,
  ev_bays: 6,
  solar_capacity_kw: 75,
  hvac_zones: 18,
};

/* -------------------------------------------------------------------------- */
/* Published curves (unchanged)                                                */
/* -------------------------------------------------------------------------- */

/** ML forecast. Peak 522 kW at 15:00; over 450 kW for 13:00-17:00 (4 hours). */
export const BASELINE_LOAD_KW: number[] = [
  182, 178, 174, 172, 176, 188, 221, 274, 328, 372, 396, 404, 418, 458, 496,
  522, 511, 436, 392, 338, 286, 243, 210, 191,
];

/** Metered load. Null from NOW_HOUR onward. */
export const ACTUAL_LOAD_KW: (number | null)[] = [
  179.4, 176.8, 173.2, 171.9, 175.5, 187.3, 219.6, 271.4, 326.8, 384.2,
  ...Array<number | null>(14).fill(null),
];

/** Rooftop PV. Clear September day, ~60 kW at solar noon on a 75 kW array. */
export const SOLAR_KW: number[] = [
  0, 0, 0, 0, 0, 0, 3.2, 11.5, 24.8, 38.6, 49.2, 56.8, 60.4, 58.1, 51.3, 40.7,
  27.4, 14.2, 4.6, 0, 0, 0, 0, 0,
];

/** Optimizer output. New peak is 438 kW at 18:00, set by the shifted EV load. */
export const OPTIMIZED_LOAD_KW: number[] = [
  182, 178, 174, 172, 176, 188, 221, 274, 328, 372, 396, 428, 436, 436, 346,
  368, 421, 436, 438, 384, 286, 243, 210, 191,
];

/** kWh used to recharge the battery overnight at the off-peak rate. */
export const BATTERY_RECHARGE_KWH = 270;

/* -------------------------------------------------------------------------- */
/* Flow breakdown                                                              */
/* -------------------------------------------------------------------------- */

/** Six bays at 11.5 kW share a 69 kW site allocation, 09:00-16:00. */
const EV_CHARGER_KW = 11.5;
const BASELINE_EV = withHours(zeros(), range(9, 16), 6 * EV_CHARGER_KW);

const BASELINE_HVAC = hvacProfile(BASELINE_LOAD_KW, {
  night: 0.15,
  dayMin: 0.25,
  dayMax: 0.35,
  dayStart: 6,
  dayEnd: 21,
});

const BASELINE_BATTERY = zeros();

const BASELINE_PARTS: FlowComponents = {
  base: baseFromGrid(BASELINE_LOAD_KW, {
    ev: BASELINE_EV,
    hvac: BASELINE_HVAC,
    solar: SOLAR_KW,
    battery: BASELINE_BATTERY,
  }),
  ev: BASELINE_EV,
  hvac: BASELINE_HVAC,
  solar: SOLAR_KW,
  battery: BASELINE_BATTERY,
  soc: flat(82),
};

/** 90 kW out of the pack for the three core peak hours; idle the rest of the day. */
const OPTIMIZED_BATTERY = withHours(zeros(), range(14, 17), 90);

/** Four fleet vans leave 14:00-16:00 and re-appear, on faster chargers, at 18:00. */
const OPTIMIZED_EV = withHours(
  withHours(BASELINE_EV, range(14, 16), 2 * EV_CHARGER_KW),
  range(18, 20),
  4 * EV_CHARGER_KW,
);

/** Pre-cool, coast, then let the setpoint float through the two worst hours. */
const HVAC_DELTA_KW: Record<number, number> = {
  11: +24,
  12: +18,
  13: -22,
  14: -14,
  15: -18,
};
const OPTIMIZED_HVAC = BASELINE_HVAC.map((kw, h) => kw + (HVAC_DELTA_KW[h] ?? 0));

const OPTIMIZED_PARTS: FlowComponents = {
  // Replaced by makeFixture: the pinned optimized curve re-solves base_kw.
  base: BASELINE_PARTS.base,
  ev: OPTIMIZED_EV,
  hvac: OPTIMIZED_HVAC,
  solar: SOLAR_KW,
  battery: OPTIMIZED_BATTERY,
  soc: socWalk(OPTIMIZED_BATTERY, 82, OFFICE_BUILDING.battery_capacity_kwh),
};

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

export const PLAN_SUMMARY = [
  "Today's forecast peaks at 522 kW at 15:00, 72 kW above the 450 kW threshold,",
  'and stays over it for four hours. No single resource covers that gap, so the',
  'plan stacks three: the battery carries 90 kW through the 14:00-17:00 core,',
  'four of the six EV sessions move to the evening where they have deadline',
  'slack, and an 11:00-13:00 pre-cool lets the HVAC setpoint float to 75°F',
  'during the worst two hours without leaving the comfort band. Together they',
  'cut the billing peak from 522 kW to 438 kW. Day-ahead energy cost falls only',
  '$22.22 once the overnight battery recharge is paid back -- the real prize is',
  'the demand charge, where an 84 kW lower peak avoids about $714.00 on this',
  "month's bill at $8.50/kW. The HVAC action is the only one occupants can",
  'feel, which is why this plan is routed for approval rather than dispatched.',
].join(' ');

function buildActions(runId: string): Action[] {
  return [
    {
      id: 'act-battery-01',
      run_id: runId,
      type: 'battery_discharge',
      title: 'Discharge battery at 90 kW, 14:00-17:00',
      description:
        'Dispatch 270 kWh from the 500 kWh pack across the three core peak hours, taking SOC from 82% to 28% and staying clear of the 20% reserve floor. Recharges overnight at the $0.09/kWh off-peak rate.',
      start_time: isoHour(14),
      end_time: isoHour(17),
      magnitude: 90,
      unit: 'kW',
      estimated_peak_reduction_kw: 90,
      estimated_savings_usd: 18.9,
      status: 'pending',
      constraints_checked: [
        'soc_reserve_floor_20pct',
        'max_discharge_250kw',
        'single_cycle_per_day',
        'recharge_window_available_overnight',
      ],
    },
    {
      id: 'act-ev-02',
      run_id: runId,
      type: 'ev_charging_shift',
      title: 'Shift 4 of 6 EV sessions to 18:00-20:00',
      description:
        'Move 92 kWh of fleet-van charging (4 sessions at 11.5 kW) out of the 14:00-16:00 window. Those vans only need 80% by 22:00, while the two staff vehicles departing at 18:00 keep their current schedule. Energy cost is unchanged because both windows are on-peak -- this action exists purely to take load out of the peak-setting interval.',
      start_time: isoHour(18),
      end_time: isoHour(20),
      magnitude: 46,
      unit: 'kW',
      estimated_peak_reduction_kw: 46,
      estimated_savings_usd: 0,
      status: 'pending',
      constraints_checked: [
        'ev_target_soc_80pct_met',
        'deadline_1800_respected_for_2_departing',
        'deadline_2200_respected_for_4_fleet',
        'site_charger_limit_69kw',
      ],
    },
    {
      id: 'act-hvac-03',
      run_id: runId,
      type: 'hvac_setpoint',
      title: 'Pre-cool 11:00-13:00, then float setpoint +3°F',
      description:
        'Drop to 70°F from 11:00 to 13:00 to bank thermal mass, then let the setpoint rise from 72°F to 75°F for the 14:00-16:00 peak. Drift is capped at the permitted two hours and stays inside the 68-75°F occupied comfort band.',
      start_time: isoHour(14),
      end_time: isoHour(16),
      magnitude: 3,
      unit: '°F',
      estimated_peak_reduction_kw: 18,
      estimated_savings_usd: 3.32,
      status: 'pending',
      constraints_checked: [
        'zone_temp_max_75f',
        'max_drift_duration_2h',
        'occupied_comfort_band_68_75f',
        'precool_min_setpoint_70f',
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Agent script                                                                */
/* -------------------------------------------------------------------------- */

export const OFFICE_SCRIPT = scheduleScript([
  {
    type: 'thinking',
    tool_name: null,
    message:
      "Run started. Today's forecast tripped the peak-risk flag, so before recommending anything I need to confirm the peak is real and find out which loads are actually flexible.",
    payload: null,
    duration_ms: 900,
  },
  {
    type: 'tool_call',
    tool_name: 'get_energy_forecast',
    message: 'get_energy_forecast(building_id="' + OFFICE_ID + '", horizon_hours=24)',
    payload: { building_id: OFFICE_ID, horizon_hours: 24 },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'get_energy_forecast',
    message:
      'Peak confirmed: 522 kW at 15:00, 72 kW over the 450 kW threshold. The building stays above threshold for four consecutive hours, 13:00 through 17:00.',
    payload: {
      peak_kw: 522,
      peak_time: isoHour(15),
      threshold_kw: 450,
      hours_over_threshold: 4,
      first_exceedance: isoHour(13),
    },
    duration_ms: 840,
  },
  {
    type: 'tool_result',
    tool_name: 'get_electricity_prices',
    message:
      'Tariff loaded. Energy is $0.09/kWh off-peak and $0.16/kWh from 14:00 to 20:00, but the real cost here is the $8.50/kW monthly demand charge set by the single highest interval.',
    payload: {
      off_peak_usd_per_kwh: 0.09,
      on_peak_usd_per_kwh: 0.16,
      on_peak_window: '14:00-20:00',
      demand_charge_usd_per_kw: 8.5,
    },
    duration_ms: 310,
  },
  {
    type: 'tool_result',
    tool_name: 'get_battery_state',
    message:
      'Battery is at 82% SOC, 410 kWh available against a 500 kWh pack and a 250 kW inverter. A 20% reserve floor is contractual, so 310 kWh is genuinely dispatchable today.',
    payload: {
      soc_pct: 82,
      capacity_kwh: 500,
      available_kwh: 410,
      max_discharge_kw: 250,
      reserve_floor_pct: 20,
      dispatchable_kwh: 310,
    },
    duration_ms: 260,
  },
  {
    type: 'tool_result',
    tool_name: 'get_ev_requirements',
    message:
      'Six EVs are plugged in. Two are staff vehicles departing at 18:00 and must reach 80% by then; the other four are fleet vans that only need 80% by 22:00. Those four are movable.',
    payload: {
      sessions_connected: 6,
      flexible_sessions: 4,
      locked_sessions: 2,
      target_soc_pct: 80,
      deadlines: { departing: isoHour(18), fleet: isoHour(22) },
      charger_power_kw_each: EV_CHARGER_KW,
    },
    duration_ms: 290,
  },
  {
    type: 'tool_result',
    tool_name: 'get_hvac_constraints',
    message:
      'HVAC is at a 72°F setpoint and may drift to 75°F for at most two hours while occupied. Pre-cooling to 70°F beforehand is permitted, which buys back most of the comfort cost.',
    payload: {
      current_setpoint_f: 72,
      max_setpoint_f: 75,
      min_precool_setpoint_f: 70,
      max_drift_hours: 2,
      occupied_band_f: [68, 75],
    },
    duration_ms: 240,
  },
  {
    type: 'thinking',
    tool_name: null,
    message:
      'I have three levers: 310 kWh of battery, four movable EV sessions, and a two-hour HVAC drift. None of them alone covers 72 kW for four hours, so I will hand all three to the optimizer together rather than guess at a split.',
    payload: null,
    duration_ms: 1100,
  },
  {
    type: 'tool_call',
    tool_name: 'run_schedule_optimizer',
    message:
      'run_schedule_optimizer(objective="minimize_peak_then_cost", horizon_hours=24, resources=["battery","ev","hvac"])',
    payload: {
      objective: 'minimize_peak_then_cost',
      horizon_hours: 24,
      resources: ['battery', 'ev', 'hvac'],
      solver: 'CP-SAT',
    },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'run_schedule_optimizer',
    message:
      'Solver returned an optimal schedule in 2.3 s. Peak drops from 522 kW to 438 kW, an 84 kW cut. Note the new peak is set by 18:00, not 15:00 -- the shifted EV load becomes the binding interval, so shedding harder at 15:00 would not help.',
    payload: {
      status: 'OPTIMAL',
      solve_time_ms: 2312,
      baseline_peak_kw: 522,
      optimized_peak_kw: 438,
      peak_reduction_kw: 84,
      binding_interval: isoHour(18),
    },
    duration_ms: 2312,
  },
  {
    type: 'tool_result',
    tool_name: 'validate_schedule',
    message:
      'All 12 constraints pass. Battery ends the window at 28% SOC, above the 20% floor. Every EV still reaches 80% before its own deadline. HVAC drift is exactly two hours and tops out at 75°F.',
    payload: {
      constraints_checked: 12,
      violations: 0,
      battery_end_soc_pct: 28,
      ev_deadlines_met: 6,
      hvac_max_temp_f: 75,
      hvac_drift_hours: 2,
    },
    duration_ms: 180,
  },
  {
    type: 'decision',
    tool_name: 'save_action_plan',
    message:
      'Committing a three-action plan: discharge the battery at 90 kW from 14:00 to 17:00, move four EV sessions to the evening, and pre-cool then let the setpoint float 3°F during the peak.',
    payload: { action_count: 3, plan_savings_usd: 22.22 },
    duration_ms: 150,
  },
  {
    type: 'tool_call',
    tool_name: 'request_human_approval',
    message:
      'The HVAC action changes occupant comfort, so this plan needs a human. Sending all three actions to the facility manager for approval.',
    payload: { requires_approval: true, action_count: 3 },
    duration_ms: null,
  },
  {
    type: 'complete',
    tool_name: null,
    message:
      'Investigation complete in 16.8 s. Plan is ready for review; nothing will be dispatched until it is approved.',
    payload: {
      peak_reduction_kw: 84,
      savings_usd: 22.22,
      demand_charge_avoided_usd: 714,
    },
    duration_ms: null,
  },
]);

/* -------------------------------------------------------------------------- */

export const officeFixture = makeFixture({
  building: OFFICE_BUILDING,
  baselineGrid: BASELINE_LOAD_KW,
  baselineParts: BASELINE_PARTS,
  optimizedParts: OPTIMIZED_PARTS,
  pinnedOptimizedGrid: OPTIMIZED_LOAD_KW,
  actualLoadKw: ACTUAL_LOAD_KW,
  batteryRechargeKwh: BATTERY_RECHARGE_KWH,
  summary: {
    current_load_kw: BASELINE_LOAD_KW[NOW_HOUR],
    battery_soc_pct: 82,
    solar_generation_kw: SOLAR_KW[NOW_HOUR],
    ev_connected: 6,
    hvac_setpoint_f: 72,
    outdoor_temp_f: 71,
  },
  planSummary: PLAN_SUMMARY,
  buildActions,
  script: OFFICE_SCRIPT,
});
