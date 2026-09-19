/**
 * GridShift demo fixtures.
 *
 * One medium office building (~150,000 sq ft) in Seattle, on a clear September
 * weekday. Every number below is internally consistent: the optimized curve is
 * the baseline curve plus the per-hour deltas of the three actions, and the
 * dollar figures are computed from the same hourly prices.
 *
 * Nothing here is random -- the numbers are pinned so the demo, the chart axes
 * and docs/API_CONTRACT.md all agree.
 */

import type {
  Action,
  ActionPlan,
  AgentEvent,
  DashboardSummary,
  ForecastPoint,
  ForecastResponse,
  ImpactPoint,
} from '@/types/api';

/* -------------------------------------------------------------------------- */
/* Time helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Thursday. Pinned so fixtures stay byte-stable across runs. */
export const DEMO_DATE = '2025-09-18';
/** Seattle, PDT. */
export const TZ_OFFSET = '-07:00';

/** ISO 8601 timestamp for the start of hour `h` on the demo day. */
export function isoHour(h: number): string {
  return DEMO_DATE + 'T' + String(h).padStart(2, '0') + ':00:00' + TZ_OFFSET;
}

/** The demo's "now". Hours before this have metered actuals. */
export const NOW_HOUR = 10;
export const NOW_ISO = isoHour(NOW_HOUR);

export const BUILDING_NAME = 'Cascade Commerce Center';
export const BUILDING_ID = 'sea-office-001';
export const PEAK_THRESHOLD_KW = 450;

/* -------------------------------------------------------------------------- */
/* Hourly series (index === hour of day)                                       */
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

/** Seattle City Light style TOU: $0.09/kWh off-peak, $0.16/kWh 14:00-20:00. */
export const PRICE_PER_KWH: number[] = Array.from({ length: 24 }, (_, h) =>
  h >= 14 && h < 20 ? 0.16 : 0.09,
);

/** Rooftop PV. Clear September day, ~60 kW at solar noon. */
export const SOLAR_KW: number[] = [
  0, 0, 0, 0, 0, 0, 3.2, 11.5, 24.8, 38.6, 49.2, 56.8, 60.4, 58.1, 51.3, 40.7,
  27.4, 14.2, 4.6, 0, 0, 0, 0, 0,
];

/**
 * Optimizer output = BASELINE_LOAD_KW + the deltas below.
 *   11,12  +24 / +18  HVAC pre-cool (adds load, banks thermal mass)
 *   13     -22        chillers coast on the banked mass
 *   14     -90 battery, -46 EV, -14 HVAC setpoint
 *   15     -90 battery, -46 EV, -18 HVAC setpoint
 *   16     -90 battery
 *   18,19  +46 / +46  the 4 shifted EV sessions land here
 * New peak is 438 kW at 18:00, set by the shifted EV load.
 */
export const OPTIMIZED_LOAD_KW: number[] = [
  182, 178, 174, 172, 176, 188, 221, 274, 328, 372, 396, 428, 436, 436, 346,
  368, 421, 436, 438, 384, 286, 243, 210, 191,
];

/** Monthly demand charge used for the avoided-demand-charge figure. */
export const DEMAND_CHARGE_USD_PER_KW = 8.5;
/** kWh used to recharge the battery overnight at the off-peak rate. */
export const BATTERY_RECHARGE_KWH = 270;

/* -------------------------------------------------------------------------- */
/* Derived aggregates                                                          */
/* -------------------------------------------------------------------------- */

function energyCost(loadKw: number[]): number {
  return loadKw.reduce((sum, kw, h) => sum + kw * PRICE_PER_KWH[h], 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const BASELINE_PEAK_KW = Math.max(...BASELINE_LOAD_KW); // 522
export const BASELINE_PEAK_HOUR = BASELINE_LOAD_KW.indexOf(BASELINE_PEAK_KW); // 15
export const OPTIMIZED_PEAK_KW = Math.max(...OPTIMIZED_LOAD_KW); // 438
export const PEAK_REDUCTION_KW = BASELINE_PEAK_KW - OPTIMIZED_PEAK_KW; // 84

export const BASELINE_COST_USD = round2(energyCost(BASELINE_LOAD_KW)); // 869.59
/** Optimized day cost, including recharging the battery overnight off-peak. */
export const OPTIMIZED_COST_USD = round2(
  energyCost(OPTIMIZED_LOAD_KW) + BATTERY_RECHARGE_KWH * 0.09,
); // 847.37
export const SAVINGS_USD = round2(BASELINE_COST_USD - OPTIMIZED_COST_USD); // 22.22
export const DEMAND_CHARGE_AVOIDED_USD = round2(
  PEAK_REDUCTION_KW * DEMAND_CHARGE_USD_PER_KW,
); // 714.00

/* -------------------------------------------------------------------------- */
/* GET /api/dashboard/summary                                                  */
/* -------------------------------------------------------------------------- */

export function buildSummary(): DashboardSummary {
  return {
    building_name: BUILDING_NAME,
    timestamp: NOW_ISO,
    current_load_kw: 396,
    predicted_peak_kw: BASELINE_PEAK_KW,
    predicted_peak_time: isoHour(BASELINE_PEAK_HOUR),
    peak_threshold_kw: PEAK_THRESHOLD_KW,
    battery_soc_pct: 82,
    battery_capacity_kwh: 500,
    battery_max_kw: 250,
    electricity_price_per_kwh: PRICE_PER_KWH[NOW_HOUR],
    solar_generation_kw: SOLAR_KW[NOW_HOUR],
    ev_connected: 6,
    hvac_setpoint_f: 72,
    outdoor_temp_f: 71,
  };
}

/* -------------------------------------------------------------------------- */
/* GET /api/forecast                                                           */
/* -------------------------------------------------------------------------- */

export function buildForecast(): ForecastResponse {
  const points: ForecastPoint[] = BASELINE_LOAD_KW.map((kw, h) => ({
    timestamp: isoHour(h),
    predicted_load_kw: kw,
    actual_load_kw: ACTUAL_LOAD_KW[h],
    price_per_kwh: PRICE_PER_KWH[h],
    is_peak: kw > PEAK_THRESHOLD_KW,
  }));

  return {
    building_name: BUILDING_NAME,
    generated_at: NOW_ISO,
    peak_threshold_kw: PEAK_THRESHOLD_KW,
    points,
  };
}

/* -------------------------------------------------------------------------- */
/* Agent event script                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The scripted agent run. `offset_ms` is how long after the run starts the
 * event becomes visible; mockServer.ts replays it in real time.
 */
export interface ScriptedEvent
  extends Omit<AgentEvent, 'id' | 'run_id' | 'timestamp'> {
  offset_ms: number;
}

export const AGENT_SCRIPT: ScriptedEvent[] = [
  {
    seq: 1,
    offset_ms: 0,
    type: 'thinking',
    tool_name: null,
    message:
      "Run started. Today's forecast tripped the peak-risk flag, so before recommending anything I need to confirm the peak is real and find out which loads are actually flexible.",
    payload: null,
    duration_ms: 900,
  },
  {
    seq: 2,
    offset_ms: 1200,
    type: 'tool_call',
    tool_name: 'get_energy_forecast',
    message: 'get_energy_forecast(building_id="' + BUILDING_ID + '", horizon_hours=24)',
    payload: { building_id: BUILDING_ID, horizon_hours: 24 },
    duration_ms: null,
  },
  {
    seq: 3,
    offset_ms: 2400,
    type: 'tool_result',
    tool_name: 'get_energy_forecast',
    message:
      'Peak confirmed: 522 kW at 15:00, 72 kW over the 450 kW threshold. The building stays above threshold for four consecutive hours, 13:00 through 17:00.',
    payload: {
      peak_kw: 522,
      peak_time: isoHour(15),
      threshold_kw: PEAK_THRESHOLD_KW,
      hours_over_threshold: 4,
      first_exceedance: isoHour(13),
    },
    duration_ms: 840,
  },
  {
    seq: 4,
    offset_ms: 3600,
    type: 'tool_result',
    tool_name: 'get_electricity_prices',
    message:
      'Tariff loaded. Energy is $0.09/kWh off-peak and $0.16/kWh from 14:00 to 20:00, but the real cost here is the $8.50/kW monthly demand charge set by the single highest interval.',
    payload: {
      off_peak_usd_per_kwh: 0.09,
      on_peak_usd_per_kwh: 0.16,
      on_peak_window: '14:00-20:00',
      demand_charge_usd_per_kw: DEMAND_CHARGE_USD_PER_KW,
    },
    duration_ms: 310,
  },
  {
    seq: 5,
    offset_ms: 4800,
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
    seq: 6,
    offset_ms: 6000,
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
      charger_power_kw_each: 11.5,
    },
    duration_ms: 290,
  },
  {
    seq: 7,
    offset_ms: 7200,
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
    seq: 8,
    offset_ms: 8400,
    type: 'thinking',
    tool_name: null,
    message:
      'I have three levers: 310 kWh of battery, four movable EV sessions, and a two-hour HVAC drift. None of them alone covers 72 kW for four hours, so I will hand all three to the optimizer together rather than guess at a split.',
    payload: null,
    duration_ms: 1100,
  },
  {
    seq: 9,
    offset_ms: 9600,
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
    seq: 10,
    offset_ms: 12000,
    type: 'tool_result',
    tool_name: 'run_schedule_optimizer',
    message:
      'Solver returned an optimal schedule in 2.3 s. Peak drops from 522 kW to 438 kW, an 84 kW cut. Note the new peak is set by 18:00, not 15:00 -- the shifted EV load becomes the binding interval, so shedding harder at 15:00 would not help.',
    payload: {
      status: 'OPTIMAL',
      solve_time_ms: 2312,
      baseline_peak_kw: BASELINE_PEAK_KW,
      optimized_peak_kw: OPTIMIZED_PEAK_KW,
      peak_reduction_kw: PEAK_REDUCTION_KW,
      binding_interval: isoHour(18),
    },
    duration_ms: 2312,
  },
  {
    seq: 11,
    offset_ms: 13200,
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
    seq: 12,
    offset_ms: 14400,
    type: 'decision',
    tool_name: 'save_action_plan',
    message:
      'Committing a three-action plan: discharge the battery at 90 kW from 14:00 to 17:00, move four EV sessions to the evening, and pre-cool then let the setpoint float 3°F during the peak.',
    payload: { action_count: 3, plan_savings_usd: SAVINGS_USD },
    duration_ms: 150,
  },
  {
    seq: 13,
    offset_ms: 15600,
    type: 'tool_call',
    tool_name: 'request_human_approval',
    message:
      'The HVAC action changes occupant comfort, so this plan needs a human. Sending all three actions to the facility manager for approval.',
    payload: { requires_approval: true, action_count: 3 },
    duration_ms: null,
  },
  {
    seq: 14,
    offset_ms: 16800,
    type: 'complete',
    tool_name: null,
    message:
      'Investigation complete in 16.8 s. Plan is ready for review; nothing will be dispatched until it is approved.',
    payload: {
      peak_reduction_kw: PEAK_REDUCTION_KW,
      savings_usd: SAVINGS_USD,
      demand_charge_avoided_usd: DEMAND_CHARGE_AVOIDED_USD,
    },
    duration_ms: null,
  },
];

/** Total scripted run length, used by the mock server. */
export const SCRIPT_DURATION_MS =
  AGENT_SCRIPT[AGENT_SCRIPT.length - 1].offset_ms;

/* -------------------------------------------------------------------------- */
/* Action plan                                                                 */
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

export function buildActions(runId: string): Action[] {
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

export function buildImpact(): ImpactPoint[] {
  return BASELINE_LOAD_KW.map((kw, h) => ({
    timestamp: isoHour(h),
    baseline_kw: kw,
    optimized_kw: OPTIMIZED_LOAD_KW[h],
  }));
}

export function buildPlan(runId: string): ActionPlan {
  return {
    run_id: runId,
    status: 'awaiting_approval',
    created_at: NOW_ISO,
    summary: PLAN_SUMMARY,
    baseline_peak_kw: BASELINE_PEAK_KW,
    optimized_peak_kw: OPTIMIZED_PEAK_KW,
    peak_reduction_kw: PEAK_REDUCTION_KW,
    baseline_cost_usd: BASELINE_COST_USD,
    optimized_cost_usd: OPTIMIZED_COST_USD,
    savings_usd: SAVINGS_USD,
    actions: buildActions(runId),
    impact: buildImpact(),
  };
}
