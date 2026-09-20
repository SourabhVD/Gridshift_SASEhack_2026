/**
 * sea-office-001 -- Cascade Commerce Center (the default building).
 *
 * The baseline is the original published forecast, untouched. The optimized
 * side is the schedule Minh's engine returns. It prices round-trip battery
 * losses, which the CP-SAT model did not: every kWh the pack gives back has
 * to be bought at 95% each way, so the day-ahead saving is smaller than it
 * was and the pack ends where it started rather than lower.
 *
 * Nothing here is authored as a curve. The optimized grid is derived from the
 * dispatch components, so an action's kW really is what moves the line:
 *
 *   hour   battery                EV                    net vs baseline
 *   03     -94.7 kW (charging)    -                     +94.7  fill the pack
 *   10-12   0                     69 -> 58.3/50.3/36.3  -10.7/-18.7/-32.7
 *   13-15  +3.7/+56.5/+67.7       69 -> 0/14.8/0        into the peak
 *   16     +194.7                 0 -> 69               pack carries the bays
 *   17-18  +50.7/+6.7             0                     taper off
 *   19-21   0                     0 -> 47.3/69/69       charging restarts
 *   22-23  -175.3/-151            0                     refill, off-peak
 *
 * HVAC does not move at all: the solver was offered the two-hour setpoint
 * drift and did not need it. base_kw is identical between the two curves,
 * which is the point -- no action changes what the building needs, only when
 * and from where it is served.
 *
 * Every number below is transcribed from a real run of that engine, and
 * `scripts/verify-fixtures.ts` fails if it drifts from one.
 */

import type { Action, Building } from '@/types/api';
import {
  actionWindow,
  DEMAND_CHARGE_USD_PER_KW,
  NOW_HOUR,
  PRICE_PER_KWH,
  type FlowComponents,
  baseFromGrid,
  energyCost,
  flat,
  gridFromComponents,
  hvacProfile,
  isoHour,
  makeFixture,
  range,
  round1,
  round2,
  scheduleScript,
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
/* Published curves (baseline, unchanged)                                      */
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

/**
 * kWh the pack has to buy back outside the modelled day. The solver keeps the
 * whole cycle inside the 24 hours -- a charge at 07:00 and a taper from 20:00
 * to midnight, both on the off-peak rate -- so there is nothing left to bill
 * separately and the optimized cost is just the optimized curve.
 */
export const BATTERY_RECHARGE_KWH = 0;

/* -------------------------------------------------------------------------- */
/* Baseline flow breakdown                                                     */
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

const START_SOC_PCT = 82;

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
  soc: flat(START_SOC_PCT),
};

/* -------------------------------------------------------------------------- */
/* Optimized dispatch                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The solver's battery schedule, hour to hour. Signed the way the flow
 * identity expects: positive discharges into the building, negative charges
 * from the grid. A flat helper cannot express this any more -- the rate moves
 * every hour of the discharge.
 */
const BATTERY_KW_BY_HOUR: Record<number, number> = {
  3: -94.7,
  13: +3.7,
  14: +56.5,
  15: +67.7,
  16: +194.7,
  17: +50.7,
  18: +6.7,
  22: -175.3,
  23: -151,
};
const OPTIMIZED_BATTERY = zeros().map((kw, h) => kw + (BATTERY_KW_BY_HOUR[h] ?? 0));

/**
 * EV charging is trimmed rather than stopped: the bays give back whatever the
 * plateau cannot carry, hour by hour, and take it again in the evening. 16:00
 * looks wrong at a glance -- the bays run flat out in an on-peak hour -- but
 * the battery is holding that hour at the ceiling anyway, so the charging is
 * free of the peak and only the energy price is paid.
 */
const EV_DELTA_KW: Record<number, number> = {
  10: -10.7,
  11: -18.7,
  12: -32.7,
  13: -69,
  14: -54.2,
  15: -69,
  16: +69,
  19: +47.3,
  20: +69,
  21: +69,
};
const OPTIMIZED_EV = BASELINE_EV.map((kw, h) => round1(kw + (EV_DELTA_KW[h] ?? 0)));

/** Empty on purpose: the solver left every setpoint where it found it. */
const HVAC_DELTA_KW: Record<number, number> = {};
/** Empty, so this collapses to a zero-length window and the row is dropped. */
const [HVAC_START_HOUR, HVAC_END_HOUR] = actionWindow(HVAC_DELTA_KW);
const OPTIMIZED_HVAC = BASELINE_HVAC.map((kw, h) => kw + (HVAC_DELTA_KW[h] ?? 0));

/**
 * The engine's own state of charge, not a walk of the dispatch above.
 *
 * `socWalk` integrates metered kW at the inverter, which is not what reaches
 * the cells: at 95% each way a charge stores less than it draws and a
 * discharge takes out more than it delivers. Walking this schedule losslessly
 * reads 100.9% at midday and 25% at midnight, on a plan the engine built to
 * peak at exactly 100% and end where it started. So the series is transcribed
 * rather than recomputed, and the backend publishes the same one.
 */
const OPTIMIZED_SOC = [
  82, 82, 82, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 99.2, 87.3,
  73.1, 32.1, 21.4, 20, 20, 20, 20, 53.3, 82,
];

const OPTIMIZED_PARTS: FlowComponents = {
  // No action changes what the building needs, so base_kw is the baseline's.
  base: BASELINE_PARTS.base,
  ev: OPTIMIZED_EV,
  hvac: OPTIMIZED_HVAC,
  solar: SOLAR_KW,
  battery: OPTIMIZED_BATTERY,
  soc: OPTIMIZED_SOC,
};

/** Optimizer output, derived from the dispatch above rather than authored. */
export const OPTIMIZED_LOAD_KW: number[] = gridFromComponents(OPTIMIZED_PARTS);

/* -------------------------------------------------------------------------- */
/* Headline numbers -- computed once, reused by the prose and the actions      */
/* -------------------------------------------------------------------------- */

const BASELINE_PEAK_KW = Math.max(...BASELINE_LOAD_KW);
const BASELINE_PEAK_HOUR = BASELINE_LOAD_KW.indexOf(BASELINE_PEAK_KW);
const OPTIMIZED_PEAK_KW = Math.max(...OPTIMIZED_LOAD_KW);
const PEAK_REDUCTION_KW = round1(BASELINE_PEAK_KW - OPTIMIZED_PEAK_KW);
const OVER_THRESHOLD_KW = round1(
  BASELINE_PEAK_KW - OFFICE_BUILDING.peak_threshold_kw,
);
const HOURS_OVER_THRESHOLD = BASELINE_LOAD_KW.filter(
  (kw) => kw > OFFICE_BUILDING.peak_threshold_kw,
).length;

const BASELINE_COST_USD = round2(energyCost(BASELINE_LOAD_KW));
const OPTIMIZED_COST_USD = round2(
  energyCost(OPTIMIZED_LOAD_KW) + BATTERY_RECHARGE_KWH * PRICE_PER_KWH[0],
);
const SAVINGS_USD = round2(BASELINE_COST_USD - OPTIMIZED_COST_USD);
const DEMAND_CHARGE_AVOIDED_USD = round2(
  PEAK_REDUCTION_KW * DEMAND_CHARGE_USD_PER_KW,
);

/** "13:00". Hour 24 reads as midnight, which is where an evening block closes. */
const clock = (h: number): string => `${String(h % 24).padStart(2, '0')}:00`;

/** Hours the pack is pushing out, in order. 13:00 through 18:00. */
const DISCHARGE_HOURS = OPTIMIZED_BATTERY.map((kw, h) => (kw > 0 ? h : -1)).filter(
  (h) => h >= 0,
);
const DISCHARGE_START_HOUR = DISCHARGE_HOURS[0];
const DISCHARGE_END_HOUR = DISCHARGE_HOURS[DISCHARGE_HOURS.length - 1] + 1;
const DISCHARGE_FIRST_KW = OPTIMIZED_BATTERY[DISCHARGE_START_HOUR];
const BATTERY_PEAK_KW = Math.max(...OPTIMIZED_BATTERY);
const BATTERY_PEAK_HOUR = OPTIMIZED_BATTERY.indexOf(BATTERY_PEAK_KW);
/**
 * Where the pack buys its energy. Both blocks are off-peak, one before the
 * discharge and one after; the hour is derived because the solver moves it --
 * it sat at 07:00 under CP-SAT and the engine puts it at 03:00.
 */
const CHARGE_HOURS = OPTIMIZED_BATTERY.map((kw, h) => (kw < 0 ? h : -1)).filter(
  (h) => h >= 0,
);
const PRECHARGE_HOURS = CHARGE_HOURS.filter((h) => h < DISCHARGE_START_HOUR);
const REFILL_HOURS = CHARGE_HOURS.filter((h) => h >= DISCHARGE_END_HOUR);
const PRECHARGE_HOUR = PRECHARGE_HOURS[0];
const BATTERY_PRECHARGE_KW = round1(-OPTIMIZED_BATTERY[PRECHARGE_HOUR]);
const REFILL_RANGE = `${clock(REFILL_HOURS[0])}-${clock(REFILL_HOURS[REFILL_HOURS.length - 1] + 1)}`;
const BATTERY_KWH = round1(
  OPTIMIZED_BATTERY.reduce((sum, kw) => sum + Math.max(kw, 0), 0),
);
/**
 * Where EV charging leaves and where it lands. Derived, because the solver
 * decides both and a typed clock range goes stale the moment a constraint
 * changes -- which is exactly what happened when the fleet deadline started
 * being enforced and the evening block moved off midnight.
 */
const EV_OUT_HOURS = Object.keys(EV_DELTA_KW)
  .map(Number)
  .filter((h) => EV_DELTA_KW[h] < 0)
  .sort((a, b) => a - b);
const EV_IN_HOURS = Object.keys(EV_DELTA_KW)
  .map(Number)
  .filter((h) => EV_DELTA_KW[h] > 0)
  .sort((a, b) => a - b);
const EV_OUT_RANGE = `${clock(EV_OUT_HOURS[0])}-${clock(EV_OUT_HOURS[EV_OUT_HOURS.length - 1] + 1)}`;
const EV_IN_RANGE = `${clock(EV_IN_HOURS[0])}-${clock(EV_IN_HOURS[EV_IN_HOURS.length - 1] + 1)}`;
const DISCHARGE_RANGE = `${clock(DISCHARGE_START_HOUR)}-${clock(DISCHARGE_END_HOUR)}`;

/**
 * What the scripted agent says it ran, and how long it took. Both are
 * transcribed from a real engine solve: the payload used to claim "CP-SAT"
 * and a 2312 ms solve, neither of which has been true since the MIP engine
 * became the default.
 */
const SOLVER_NAME = 'MIP (OR-Tools/SCIP)';
const SOLVE_TIME_MS = 63;

/** Hours pinned to the ceiling -- the shape of the answer, not the spike. */
const PLATEAU_HOURS = OPTIMIZED_LOAD_KW.map((kw, h) =>
  Math.abs(kw - Math.max(...OPTIMIZED_LOAD_KW)) < 0.05 ? h : -1,
).filter((h) => h >= 0);

const MIN_SOC_PCT = Math.min(...OPTIMIZED_SOC);
const END_SOC_PCT = OPTIMIZED_SOC[OPTIMIZED_SOC.length - 1];
const RESERVE_FLOOR_PCT = 20;

/** Same rule the backend applies: the hours the lever actually moves. */
const [EV_START_HOUR, EV_END_HOUR] = actionWindow(EV_DELTA_KW);

const EV_SHIFTED_KWH = round1(
  OPTIMIZED_EV.reduce((sum, kw, h) => sum + Math.max(kw - BASELINE_EV[h], 0), 0),
);

/**
 * What each lever takes out of the BASELINE peak interval, which is what
 * Action.estimated_peak_reduction_kw means. Here the three add up to
 * PEAK_REDUCTION_KW exactly, because the optimized curve sits on its own peak
 * at 15:00 as well.
 */
const BATTERY_PEAK_CUT_KW = round1(OPTIMIZED_BATTERY[BASELINE_PEAK_HOUR]);
const EV_PEAK_CUT_KW = round1(
  BASELINE_EV[BASELINE_PEAK_HOUR] - OPTIMIZED_EV[BASELINE_PEAK_HOUR],
);
const HVAC_PEAK_CUT_KW = round1(
  BASELINE_HVAC[BASELINE_PEAK_HOUR] - OPTIMIZED_HVAC[BASELINE_PEAK_HOUR],
);

/**
 * How many rows the plan actually has. A lever the optimizer left alone is
 * dropped by makeFixture, so the narration must not say "three" when the
 * reader can count two.
 */
const ACTION_COUNT = [BATTERY_PEAK_CUT_KW, EV_PEAK_CUT_KW, HVAC_PEAK_CUT_KW].filter(
  (kw) => kw > 0,
).length;
const ACTION_COUNT_WORD = ['zero', 'one', 'two', 'three'][ACTION_COUNT] ?? String(ACTION_COUNT);

/**
 * Where the day-ahead energy saving comes from. Each lever is priced against
 * the baseline at the tariff, so the three add up to SAVINGS_USD exactly.
 */
const BATTERY_SAVINGS_USD = round2(
  OPTIMIZED_BATTERY.reduce((sum, kw, h) => sum + kw * PRICE_PER_KWH[h], 0),
);
const EV_SAVINGS_USD = round2(
  BASELINE_EV.reduce(
    (sum, kw, h) => sum + (kw - OPTIMIZED_EV[h]) * PRICE_PER_KWH[h],
    0,
  ),
);
const HVAC_SAVINGS_USD = round2(
  BASELINE_HVAC.reduce(
    (sum, kw, h) => sum + (kw - OPTIMIZED_HVAC[h]) * PRICE_PER_KWH[h],
    0,
  ),
);

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

export const PLAN_SUMMARY = [
  `Today's forecast peaks at ${BASELINE_PEAK_KW} kW at 15:00, ${OVER_THRESHOLD_KW} kW`,
  `above the ${OFFICE_BUILDING.peak_threshold_kw} kW threshold, and stays over it for`,
  `${HOURS_OVER_THRESHOLD} hours. The optimizer does not shave that spike so much as`,
  `flatten the day: from 10:00 to 19:00 the meter holds ${OPTIMIZED_PEAK_KW} kW every`,
  `hour, and the evening never gets back above it. ${ACTION_COUNT_WORD} levers do the`,
  `work. The battery takes a ${BATTERY_PRECHARGE_KW} kW charge at`,
  `${clock(PRECHARGE_HOUR)} to reach 100%, then carries the afternoon, ramping from`,
  `${DISCHARGE_FIRST_KW} kW at ${clock(DISCHARGE_START_HOUR)} to ${BATTERY_PEAK_KW} kW`,
  `at ${clock(BATTERY_PEAK_HOUR)} and tapering out after 18:00, for ${BATTERY_KWH} kWh`,
  `out of the ${OFFICE_BUILDING.battery_capacity_kwh} kWh pack. The six EV bays are`,
  'trimmed rather than stopped: they give back whatever the plateau cannot carry',
  `from ${clock(EV_OUT_HOURS[0])} on, and take ${EV_SHIFTED_KWH} kWh of it again at`,
  `${clock(16)} and across ${clock(19)}-${clock(22)}, all of it before the 22:00 fleet`,
  'despatch. HVAC never moves; the solver was offered the setpoint float and did',
  `not need it. The billing peak falls from ${BASELINE_PEAK_KW} kW to`,
  `${OPTIMIZED_PEAK_KW} kW, a ${PEAK_REDUCTION_KW} kW cut worth about`,
  `$${DEMAND_CHARGE_AVOIDED_USD.toFixed(2)} on this month's demand charge at`,
  `$${DEMAND_CHARGE_USD_PER_KW.toFixed(2)}/kW, with $${SAVINGS_USD.toFixed(2)} of`,
  `day-ahead energy saved on top. The pack refills over ${REFILL_RANGE} and ends the`,
  `day back at ${END_SOC_PCT}%, exactly where it started -- the engine charges for the`,
  'round trip, so nothing here is paid for with energy that never gets bought.',
  'This still goes to a human because it takes the pack all the way down to its',
  `${MIN_SOC_PCT}% reserve floor, leaving no margin if the afternoon runs hotter than`,
  'the forecast.',
].join(' ');

function buildActions(runId: string): Action[] {
  return [
    {
      id: 'act-battery-01',
      run_id: runId,
      type: 'battery_discharge',
      title: `Discharge battery up to ${BATTERY_PEAK_KW} kW, ${DISCHARGE_RANGE}`,
      description: `Dispatch ${BATTERY_KWH} kWh from the ${OFFICE_BUILDING.battery_capacity_kwh} kWh pack across ${DISCHARGE_HOURS.length} hours, starting at ${DISCHARGE_FIRST_KW} kW at ${clock(DISCHARGE_START_HOUR)}, deepening to ${BATTERY_PEAK_KW} kW at ${clock(BATTERY_PEAK_HOUR)} and tapering to ${OPTIMIZED_BATTERY[18]} kW by 18:00. That is inside the ${OFFICE_BUILDING.battery_max_kw} kW inverter, though not by much at the deepest hour. To pay for it the pack takes a ${BATTERY_PRECHARGE_KW} kW charge at ${clock(PRECHARGE_HOUR)} and refills over ${REFILL_RANGE}, both at the $0.09/kWh off-peak rate. The charge is sized for a 95% round trip, so SOC runs ${START_SOC_PCT}% up to 100%, down to ${MIN_SOC_PCT}% and back to ${END_SOC_PCT}% -- the pack is handed back exactly as it was found, but it does sit on the ${RESERVE_FLOOR_PCT}% reserve floor to get there.`,
      start_time: isoHour(DISCHARGE_START_HOUR),
      end_time: isoHour(DISCHARGE_END_HOUR),
      magnitude: BATTERY_PEAK_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: BATTERY_PEAK_CUT_KW,
      estimated_savings_usd: BATTERY_SAVINGS_USD,
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
      title: `Move ${EV_SHIFTED_KWH} kWh of EV charging out of ${EV_OUT_RANGE} into ${EV_IN_RANGE}`,
      description: `Meter the six bays against the ceiling rather than switching them off: they come down from the ${6 * EV_CHARGER_KW} kW site allocation through the late morning, go to zero only at ${clock(13)} and ${clock(15)}, and take the energy back at ${clock(16)} -- under cover of the battery -- and across ${clock(19)}-${clock(22)}. Total energy delivered is unchanged and all six sessions are served before the 22:00 fleet despatch. This takes ${EV_PEAK_CUT_KW} kW straight out of the peak-setting hour. The energy saving is only $${EV_SAVINGS_USD.toFixed(2)}, because the ${clock(16)} block buys back at $0.16/kWh what the evening saves at $0.09 -- this lever is here for the demand charge, not the bill.`,
      start_time: isoHour(EV_START_HOUR),
      end_time: isoHour(EV_END_HOUR),
      magnitude: 6 * EV_CHARGER_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: EV_PEAK_CUT_KW,
      estimated_savings_usd: EV_SAVINGS_USD,
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
      title: 'Hold the HVAC setpoint at 72°F, no drift today',
      description: `The optimizer had the usual two-hour float to 75°F available and did not use it. With the battery and the EV shift already holding the day at or under ${OPTIMIZED_PEAK_KW} kW, spending occupant comfort buys nothing, so nothing is sent to the air handlers and the occupied band is never approached. The row is dropped from the plan a human sees -- an action of zero magnitude over zero hours is not something to approve -- but the lever stays modelled and is the first thing called for if the afternoon runs hot.`,
      start_time: isoHour(HVAC_START_HOUR),
      end_time: isoHour(HVAC_END_HOUR),
      magnitude: 0,
      unit: '°F',
      estimated_peak_reduction_kw: HVAC_PEAK_CUT_KW,
      estimated_savings_usd: HVAC_SAVINGS_USD,
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
/* Agent script                                                               */
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
    message: `Peak confirmed: ${BASELINE_PEAK_KW} kW at 15:00, ${OVER_THRESHOLD_KW} kW over the ${OFFICE_BUILDING.peak_threshold_kw} kW threshold. The building stays above threshold for ${HOURS_OVER_THRESHOLD} consecutive hours, 13:00 through 17:00.`,
    payload: {
      peak_kw: BASELINE_PEAK_KW,
      peak_time: isoHour(15),
      threshold_kw: OFFICE_BUILDING.peak_threshold_kw,
      hours_over_threshold: HOURS_OVER_THRESHOLD,
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
      demand_charge_usd_per_kw: DEMAND_CHARGE_USD_PER_KW,
    },
    duration_ms: 310,
  },
  {
    type: 'tool_result',
    tool_name: 'get_battery_state',
    message: `Battery is at ${START_SOC_PCT}% SOC, 410 kWh available against a ${OFFICE_BUILDING.battery_capacity_kwh} kWh pack and a ${OFFICE_BUILDING.battery_max_kw} kW inverter. A ${RESERVE_FLOOR_PCT}% reserve floor is contractual, so 310 kWh is dispatchable as things stand, and more than that if the pack is topped up first.`,
    payload: {
      soc_pct: START_SOC_PCT,
      capacity_kwh: OFFICE_BUILDING.battery_capacity_kwh,
      available_kwh: 410,
      max_discharge_kw: OFFICE_BUILDING.battery_max_kw,
      reserve_floor_pct: RESERVE_FLOOR_PCT,
      dispatchable_kwh: 310,
    },
    duration_ms: 260,
  },
  {
    type: 'tool_result',
    tool_name: 'get_ev_requirements',
    message:
      'Six EVs are plugged in. Two are staff vehicles departing at 18:00 and must reach 80% by then; the other four are fleet vans prepped for a 22:00 despatch. Those four are movable, but only up to 22:00 -- not overnight.',
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
    message: `I have three levers: a 500 kWh pack I can top up before the peak, six EV sessions with deadline slack, and a two-hour HVAC drift. None of them alone covers ${OVER_THRESHOLD_KW} kW for ${HOURS_OVER_THRESHOLD} hours, so I will hand all three to the optimizer together rather than guess at a split.`,
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
      solver: SOLVER_NAME,
    },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'run_schedule_optimizer',
    message: `Solver returned an optimal schedule in ${SOLVE_TIME_MS} ms. Peak drops from ${BASELINE_PEAK_KW} kW to ${OPTIMIZED_PEAK_KW} kW, a ${PEAK_REDUCTION_KW} kW cut. It did not shave 15:00, it levelled the day: ${PLATEAU_HOURS.length} hours sit on the same ${OPTIMIZED_PEAK_KW} kW ceiling and the rest of the evening comes in under it, so there is no single interval left to attack.`,
    payload: {
      status: 'OPTIMAL',
      solver: SOLVER_NAME,
      solve_time_ms: SOLVE_TIME_MS,
      baseline_peak_kw: BASELINE_PEAK_KW,
      optimized_peak_kw: OPTIMIZED_PEAK_KW,
      peak_reduction_kw: PEAK_REDUCTION_KW,
      binding_interval: isoHour(OPTIMIZED_LOAD_KW.indexOf(OPTIMIZED_PEAK_KW)),
    },
    duration_ms: SOLVE_TIME_MS,
  },
  {
    type: 'tool_result',
    tool_name: 'validate_schedule',
    message: `All 12 constraints pass. The battery bottoms out at ${MIN_SOC_PCT}% SOC -- on the ${RESERVE_FLOOR_PCT}% floor exactly, not above it -- and is back to ${END_SOC_PCT}% by midnight, which is where it started. Every EV reaches 80% before the 22:00 fleet despatch. HVAC never leaves 72°F, so there is no drift to check.`,
    payload: {
      constraints_checked: 12,
      violations: 0,
      battery_min_soc_pct: MIN_SOC_PCT,
      battery_end_soc_pct: END_SOC_PCT,
      ev_deadlines_met: 6,
      hvac_max_temp_f: 72,
      hvac_drift_hours: 0,
    },
    duration_ms: 180,
  },
  {
    type: 'decision',
    tool_name: 'save_action_plan',
    message: `Committing a ${ACTION_COUNT_WORD}-action plan: run the battery across ${DISCHARGE_RANGE}, peaking at ${BATTERY_PEAK_KW} kW, move ${EV_SHIFTED_KWH} kWh of EV charging into ${EV_IN_RANGE}, and leave the HVAC setpoint alone. The third lever is modelled but unused, so it is not put to a human as something to approve.`,
    payload: { action_count: ACTION_COUNT, plan_savings_usd: SAVINGS_USD },
    duration_ms: 150,
  },
  {
    type: 'tool_call',
    tool_name: 'request_human_approval',
    message: `This takes the pack to its ${MIN_SOC_PCT}% floor with nothing in reserve, and throttles all six EV bays through the working afternoon, so it needs a human. Sending ${ACTION_COUNT_WORD === 'two' ? 'both' : 'all ' + ACTION_COUNT_WORD} actions to the facility manager for approval.`,
    payload: { requires_approval: true, action_count: ACTION_COUNT },
    duration_ms: null,
  },
  {
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
]);

/* -------------------------------------------------------------------------- */

export const officeFixture = makeFixture({
  building: OFFICE_BUILDING,
  baselineGrid: BASELINE_LOAD_KW,
  baselineParts: BASELINE_PARTS,
  optimizedParts: OPTIMIZED_PARTS,
  actualLoadKw: ACTUAL_LOAD_KW,
  batteryRechargeKwh: BATTERY_RECHARGE_KWH,
  summary: {
    current_load_kw: BASELINE_LOAD_KW[NOW_HOUR],
    battery_soc_pct: START_SOC_PCT,
    solar_generation_kw: SOLAR_KW[NOW_HOUR],
    ev_connected: 6,
    hvac_setpoint_f: 72,
    outdoor_temp_f: 71,
  },
  planSummary: PLAN_SUMMARY,
  buildActions,
  script: OFFICE_SCRIPT,
});
