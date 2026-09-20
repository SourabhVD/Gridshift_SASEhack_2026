/**
 * sea-warehouse-003 -- Duwamish Logistics Hub.
 *
 * The easy case, structurally: a single-storey shed whose own load barely
 * moves (90 kW overnight, ~160 kW while the sortation lines run) and whose
 * entire peak problem is a delivery fleet. Twenty-four vans plug in as they
 * come off route between 13:00 and 17:00, 11 kW each, and that block alone
 * pushes the site from 111 kW at noon to 426 kW against a 350 kW threshold.
 *
 * Because the vans are the peak, re-queueing them is the whole plan. The
 * engine does not stop at moving a block of vans into the evening: it returns
 * a charging rate for every hour that meters the fleet out from 13:00 all the
 * way to 22:00, and the battery covers the one hour that would otherwise
 * stick up through the line. What comes back is not a lower spike, it is a
 * flat 234.1 kW ceiling held from 13:00 to the end of the day.
 *
 * The hour to understand is 20:00. The engine puts 263.6 kW of charging there
 * -- all but a whisker of full fleet concurrency -- and hides it behind a
 * 208.9 kW discharge, so the meter reads 233.7 kW. Read the battery row on its
 * own and it looks pointless: it cuts nothing from the 15:00 interval that set
 * the old peak, and it loses $2.16 on energy, because it both buys and sells
 * off-peak and pays the round trip for the privilege. Take it away and 20:00
 * bills at 442.6 kW, which is worse than doing nothing at all. That is the
 * whole argument for pricing peaks and energy separately, in one hour.
 *
 * HVAC gets no action at all -- an unconditioned high-bay with dock-door
 * infiltration has no thermal mass to pre-cool and no occupant comfort band to
 * borrow against, so the agent says so and ships a two-action plan instead of
 * inventing a third.
 */

import type { Action, Building } from '@/types/api';
import {
  HOURS,
  NOW_HOUR,
  PRICE_PER_KWH,
  type FlowComponents,
  actionWindow,
  baseFromGrid,
  energyCost,
  flat,
  gridFromComponents,
  hvacProfile,
  isoHour,
  makeFixture,
  meteredActuals,
  round1,
  round2,
  scheduleScript,
  solarBell,
  zeros,
} from './shared';

export const WAREHOUSE_ID = 'sea-warehouse-003';

export const WAREHOUSE_BUILDING: Building = {
  id: WAREHOUSE_ID,
  name: 'Duwamish Logistics Hub',
  type: 'warehouse',
  address: '4600 E Marginal Way S, Seattle, WA 98134',
  floors: 1,
  area_sqft: 320_000,
  peak_threshold_kw: 350,
  battery_capacity_kwh: 1000,
  battery_max_kw: 500,
  ev_bays: 24,
  solar_capacity_kw: 90,
  hvac_zones: 6,
};

const RESERVE_FLOOR_PCT = 10;
const START_SOC_PCT = 90;
const VAN_CHARGER_KW = 11;

/* -------------------------------------------------------------------------- */
/* Baseline                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Vans returning from route. They do not all arrive at once -- 22 are on
 * charge by 13:00, the last two by 14:00, and the first eight are finished by
 * 16:00. Peak concurrency is 24, the full bay count.
 */
const VANS_ON_CHARGE: Record<number, number> = { 13: 22, 14: 24, 15: 24, 16: 18 };
const BASELINE_VANS: number[] = Array.from(
  { length: 24 },
  (_, h) => VANS_ON_CHARGE[h] ?? 0,
);

const BASELINE_EV = BASELINE_VANS.map((n) => n * VAN_CHARGER_KW);

const SOLAR_KW = solarBell(75, 13, 5.5);

/** 90 kW overnight, 160 kW once the building opens at 06:00. */
const BASE_LOAD_KW = Array.from({ length: 24 }, (_, h) =>
  h >= 6 && h < 22 ? 160 : 90,
);

/**
 * Grid-pinned like the other two, so the published curve is an integer series.
 * HVAC is taken as a share of that curve and base_kw falls out as the residual
 * -- it lands within a couple of kW of BASE_LOAD_KW at every hour, which is
 * the check that the shape is self-consistent.
 */
const PROVISIONAL_HVAC = hvacProfile(
  BASE_LOAD_KW.map((kw, h) => kw + BASELINE_EV[h]),
  { night: 0.06, dayMin: 0.1, dayMax: 0.13, dayStart: 6, dayEnd: 22 },
);

export const BASELINE_GRID_KW: number[] = BASE_LOAD_KW.map((kw, h) =>
  Math.round(kw + BASELINE_EV[h] + PROVISIONAL_HVAC[h] - SOLAR_KW[h]),
);

const BASELINE_HVAC = hvacProfile(BASELINE_GRID_KW, {
  night: 0.06,
  dayMin: 0.1,
  dayMax: 0.13,
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

/**
 * What the engine returns is finer than whole vans: a charging rate for every
 * hour, written here as the change from the baseline. It lifts 648.6 kWh out
 * of 13:00-17:00 and lands the same 648.6 kWh between 17:00 and 23:00, so the
 * fleet still takes its full 968 kWh before the 05:00 departure -- only the
 * hour it arrives in changes.
 *
 * Nobody asked for a cohort split and the engine did not produce one, which is
 * why the van-by-van framing this file used to carry is gone: the answer is a
 * rate schedule, and describing it as "twelve vans move" was a story about the
 * answer rather than the answer.
 */
const EV_DELTA_KW: Record<number, number> = {
  13: -143.9,
  14: -174.9,
  15: -191.9,
  16: -137.9,
  17: +67.1,
  18: +56.1,
  19: +55.1,
  20: +263.6,
  21: +67.6,
  22: +139.1,
};
const OPTIMIZED_EV = BASELINE_EV.map((kw, h) => round1(kw + (EV_DELTA_KW[h] ?? 0)));

/**
 * The pack's day, signed: positive discharges into the building, negative
 * charges off the grid. It fills at midnight on the $0.09 rate, empties
 * 208.9 kW into the 20:00 van block -- the hour that would otherwise bill
 * higher than the baseline peak -- trickles the last 11.5 kW out at 21:00, and
 * buys the energy back at 23:00.
 *
 * 244.4 kWh in for 220.4 kWh out. The 24 kWh gap is the 95% round trip, and it
 * is the reason this row is worth -$2.16 on energy: everything it does happens
 * at $0.09 either way, so there is no arbitrage in it at all. It is here
 * purely to hold the ceiling.
 */
const BATTERY_DISPATCH_KW: Record<number, number> = {
  0: -105.3,
  20: +208.9,
  21: +11.5,
  23: -139.1,
};
const OPTIMIZED_BATTERY = zeros().map((kw, h) => kw + (BATTERY_DISPATCH_KW[h] ?? 0));

/** State of charge as the engine solved it. See the note on OPTIMIZED_PARTS. */
const OPTIMIZED_SOC = [
  100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
  100, 100, 100, 100, 100, 78, 76.8, 76.8, 90,
];

/** kWh taken out of the pack over the day, and kWh put back inside the day. */
const BATTERY_DISPATCHED_KWH = round1(
  OPTIMIZED_BATTERY.reduce((sum, kw) => sum + Math.max(kw, 0), 0),
);
const BATTERY_REFILLED_KWH = round1(
  OPTIMIZED_BATTERY.reduce((sum, kw) => sum + Math.max(-kw, 0), 0),
);

/**
 * Only the shortfall gets bought back outside the modelled window and billed
 * at the overnight rate. This schedule ends where it started, so there is none.
 */
export const BATTERY_RECHARGE_KWH = round1(
  Math.max(BATTERY_DISPATCHED_KWH - BATTERY_REFILLED_KWH, 0),
);

const OPTIMIZED_PARTS: FlowComponents = {
  base: BASELINE_PARTS.base,
  ev: OPTIMIZED_EV,
  // No HVAC action: the high-bay has nothing useful to give.
  hvac: BASELINE_HVAC,
  solar: SOLAR_KW,
  battery: OPTIMIZED_BATTERY,
  // The engine's own series, not a walk of the dispatch above: at 95% each
  // way the cells take in less than the inverter draws, so walking the metered
  // kW reads 100.5% at midday on a plan the engine capped at 100%.
  soc: OPTIMIZED_SOC,
};

export const OPTIMIZED_GRID_KW = gridFromComponents(OPTIMIZED_PARTS);

/* -------------------------------------------------------------------------- */
/* Headline numbers                                                            */
/* -------------------------------------------------------------------------- */

const BASELINE_PEAK_KW = Math.max(...BASELINE_GRID_KW);
const OPTIMIZED_PEAK_KW = Math.max(...OPTIMIZED_GRID_KW);
/** First hour that touches the flat ceiling; nothing after it goes higher. */
const OPTIMIZED_PEAK_HOUR = OPTIMIZED_GRID_KW.indexOf(OPTIMIZED_PEAK_KW);
const PEAK_REDUCTION_KW = round2(BASELINE_PEAK_KW - OPTIMIZED_PEAK_KW);
const THRESHOLD_HEADROOM_KW = round1(
  WAREHOUSE_BUILDING.peak_threshold_kw - OPTIMIZED_PEAK_KW,
);
const BASELINE_COST_USD = round2(energyCost(BASELINE_GRID_KW));
const OPTIMIZED_COST_USD = round2(
  energyCost(OPTIMIZED_GRID_KW) + BATTERY_RECHARGE_KWH * 0.09,
);
const SAVINGS_USD = round2(BASELINE_COST_USD - OPTIMIZED_COST_USD);
const DEMAND_CHARGE_AVOIDED_USD = round2(PEAK_REDUCTION_KW * 8.5);
/** "13:00". Hour 24 reads as midnight, which is where an evening block closes. */
const clock = (h: number): string => `${String(h % 24).padStart(2, '0')}:00`;

const BASELINE_PEAK_HOUR = BASELINE_GRID_KW.indexOf(BASELINE_PEAK_KW);

/** The rate the battery action is quoted at: its deepest discharge hour. */
const DISCHARGE_KW = Math.max(...OPTIMIZED_BATTERY);
const DISCHARGE_HOURS = OPTIMIZED_BATTERY.map((kw, h) => (kw > 0 ? h : -1)).filter(
  (h) => h >= 0,
);
const DISCHARGE_START_HOUR = DISCHARGE_HOURS[0];
const DISCHARGE_END_HOUR = DISCHARGE_HOURS[DISCHARGE_HOURS.length - 1] + 1;
const END_SOC_PCT = OPTIMIZED_PARTS.soc[HOURS - 1];

/** Hours the fleet is held under its baseline rate, and where it lands. */
const EV_OUT_HOURS = Object.keys(EV_DELTA_KW)
  .map(Number)
  .filter((h) => EV_DELTA_KW[h] < 0)
  .sort((a, b) => a - b);
const EV_IN_HOURS = Object.keys(EV_DELTA_KW)
  .map(Number)
  .filter((h) => EV_DELTA_KW[h] > 0)
  .sort((a, b) => a - b);
const EV_SHIFTED_KWH = round1(
  EV_IN_HOURS.reduce((sum, h) => sum + EV_DELTA_KW[h], 0),
);
/** Deepest single-hour cut, which is what the action's magnitude quotes. */
const EV_DEEPEST_CUT_KW = round1(
  Math.max(...EV_OUT_HOURS.map((h) => -EV_DELTA_KW[h])),
);
/** What each lever takes out of the interval that set the BASELINE peak. */
const EV_CUT_AT_PEAK_KW = round1(
  BASELINE_EV[BASELINE_PEAK_HOUR] - OPTIMIZED_EV[BASELINE_PEAK_HOUR],
);
const BATTERY_CUT_AT_PEAK_KW = round1(OPTIMIZED_BATTERY[BASELINE_PEAK_HOUR]);

/**
 * What 20:00 would bill without the pack. Higher than the day it replaces,
 * which is the only honest way to describe a row whose own peak-cut reads 0.
 */
const UNCOVERED_EVENING_KW = round1(
  OPTIMIZED_GRID_KW[DISCHARGE_START_HOUR] + DISCHARGE_KW,
);

/** Same rule the backend applies: the hours each lever actually moves. */
const [EV_START_HOUR, EV_END_HOUR] = actionWindow(EV_DELTA_KW);

/**
 * Where the day-ahead saving comes from, priced against the baseline at the
 * tariff, so the two levers add up to SAVINGS_USD exactly rather than being
 * typed in by hand and drifting away from it. The battery's share is
 * negative, and that is not a bug: see the note on BATTERY_DISPATCH_KW.
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

/**
 * What the scripted agent says it ran, and how long it took. Both transcribed
 * from a real solve: the payload used to claim "CP-SAT" and 1418 ms, neither
 * of which has been true since the MIP engine became the default.
 */
const SOLVER_NAME = 'MIP (OR-Tools/SCIP)';
const SOLVE_TIME_MS = 44;

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

export const PLAN_SUMMARY = [
  `Today's forecast peaks at ${BASELINE_PEAK_KW} kW at ${clock(BASELINE_PEAK_HOUR)},`,
  `${BASELINE_PEAK_KW - 350} kW above the 350 kW threshold, and the cause is`,
  'unambiguous: the building itself never draws more than about 180 kW, and the',
  `other ${24 * VAN_CHARGER_KW} kW is 24 delivery vans charging at once between 13:00 and 17:00.`,
  'So the plan does not shed anything, it re-queues. The optimizer meters the',
  `fleet out hour by hour from ${clock(EV_OUT_HOURS[0])} to ${clock(22)}, moving`,
  `${EV_SHIFTED_KWH} kWh later in the day so no single hour carries more than it has`,
  'to; because the vans are not back on route until 05:00, nobody waits on a',
  `charge. The awkward hour is ${clock(DISCHARGE_START_HOUR)}, where the engine parks`,
  `${round1(OPTIMIZED_EV[DISCHARGE_START_HOUR])} kW of charging -- almost full fleet`,
  `concurrency -- and covers it with a ${DISCHARGE_KW} kW discharge, so the meter reads`,
  `${OPTIMIZED_GRID_KW[DISCHARGE_START_HOUR]} kW instead of ${UNCOVERED_EVENING_KW} kW. That`,
  `battery row cuts nothing from ${clock(BASELINE_PEAK_HOUR)} and loses`,
  `$${Math.abs(BATTERY_SAVINGS_USD).toFixed(2)} on energy, because it buys and sells on`,
  'the same $0.09 rate and pays the round trip; without it the evening bills higher',
  `than the day it replaced. The pack fills at midnight, empties into`,
  `${clock(DISCHARGE_START_HOUR)}, and buys the energy back at ${clock(23)}, ending at`,
  `the ${END_SOC_PCT}% it started at. Peak falls from ${BASELINE_PEAK_KW} kW to`,
  `${OPTIMIZED_PEAK_KW} kW, a ${PEAK_REDUCTION_KW} kW cut worth about`,
  `$${DEMAND_CHARGE_AVOIDED_USD.toFixed(2)} on the demand charge, plus`,
  `$${SAVINGS_USD.toFixed(2)} of day-ahead energy. There is deliberately no HVAC`,
  'action: an unconditioned high bay with dock doors cycling has no thermal mass',
  'to pre-cool and no comfort band to borrow against, so offering one would be',
  'theatre. There is no single binding hour left either: from 13:00 to midnight the',
  `site rides a flat ${OPTIMIZED_PEAK_KW} kW ceiling, ${THRESHOLD_HEADROOM_KW} kW under threshold.`,
].join(' ');

function buildActions(runId: string): Action[] {
  return [
    {
      id: 'act-ev-01',
      run_id: runId,
      type: 'ev_charging_shift',
      title: `Meter the fleet out across ${clock(EV_START_HOUR)}-${clock(EV_END_HOUR)}`,
      description: `Hold the yard chargers to a rate the site can carry rather than letting 24 vans draw at once: ${round1(OPTIMIZED_EV[13])} kW at 13:00 tapering to ${round1(OPTIMIZED_EV[16])} kW at 16:00, then the remaining ${EV_SHIFTED_KWH} kWh across the evening, ending with ${round1(OPTIMIZED_EV[20])} kW at ${clock(20)} and ${round1(OPTIMIZED_EV[22])} kW at ${clock(22)}. Van-hours are identical either way, so every vehicle reaches the same state of charge -- the fleet does not leave the yard until 05:00, which is six hours of slack. This single action takes ${EV_CUT_AT_PEAK_KW} kW out of the peak-setting interval, and it is the whole of the demand-charge saving.`,
      start_time: isoHour(EV_START_HOUR),
      end_time: isoHour(EV_END_HOUR),
      magnitude: EV_DEEPEST_CUT_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: EV_CUT_AT_PEAK_KW,
      estimated_savings_usd: EV_SAVINGS_USD,
      status: 'pending',
      constraints_checked: [
        'all_vans_full_by_0500_departure',
        'site_charger_limit_264kw',
        'per_bay_limit_11kw',
        'no_van_session_split_across_gaps',
      ],
    },
    {
      id: 'act-battery-02',
      run_id: runId,
      type: 'battery_discharge',
      title: `Discharge battery at ${DISCHARGE_KW} kW, ${clock(DISCHARGE_START_HOUR)}-${clock(DISCHARGE_END_HOUR)}`,
      description: `Dispatch ${BATTERY_DISPATCHED_KWH} kWh from the 1000 kWh pack into the evening charging block, taking SOC from 100% down to ${OPTIMIZED_PARTS.soc[DISCHARGE_END_HOUR]}% -- nowhere near the ${RESERVE_FLOOR_PCT}% floor, and well inside the 500 kW inverter. Read on its own this row looks like it earns nothing: it takes ${BATTERY_CUT_AT_PEAK_KW} kW out of the ${clock(BASELINE_PEAK_HOUR)} interval that set the old peak, and its energy line is -$${Math.abs(BATTERY_SAVINGS_USD).toFixed(2)}, because it charges and discharges on the same $0.09 rate and pays the 95% round trip both ways. It is not arbitrage and it is not padding. It is what makes the ${clock(DISCHARGE_START_HOUR)} charging block possible: without the pack that hour bills at ${UNCOVERED_EVENING_KW} kW, higher than the ${BASELINE_PEAK_KW} kW day it is replacing, and the entire ${PEAK_REDUCTION_KW} kW cut goes with it.`,
      start_time: isoHour(DISCHARGE_START_HOUR),
      end_time: isoHour(DISCHARGE_END_HOUR),
      magnitude: DISCHARGE_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: BATTERY_CUT_AT_PEAK_KW,
      estimated_savings_usd: BATTERY_SAVINGS_USD,
      status: 'pending',
      constraints_checked: [
        'soc_reserve_floor_10pct',
        'max_discharge_500kw',
        'single_cycle_per_day',
        'recharge_window_available_overnight',
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Agent script                                                                */
/* -------------------------------------------------------------------------- */

export const WAREHOUSE_SCRIPT = scheduleScript([
  {
    type: 'thinking',
    tool_name: null,
    message:
      'Run started. A distribution shed usually has one dominant flexible load rather than several small ones, so rather than surveying everything evenly I want to find out first how much of this peak is the building and how much is the fleet.',
    payload: null,
    duration_ms: 850,
  },
  {
    type: 'tool_call',
    tool_name: 'get_energy_forecast',
    message: 'get_energy_forecast(building_id="' + WAREHOUSE_ID + '", horizon_hours=24)',
    payload: { building_id: WAREHOUSE_ID, horizon_hours: 24 },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'get_energy_forecast',
    message: `Peak confirmed: ${BASELINE_PEAK_KW} kW at 15:00, ${BASELINE_PEAK_KW - 350} kW over the 350 kW threshold, above it for four hours from 13:00. Note the shape -- the site is at ${BASELINE_GRID_KW[12]} kW at noon and ${BASELINE_GRID_KW[13]} kW an hour later. That is not a building warming up, that is something plugging in.`,
    payload: {
      peak_kw: BASELINE_PEAK_KW,
      peak_time: isoHour(15),
      threshold_kw: 350,
      hours_over_threshold: 4,
      first_exceedance: isoHour(13),
      noon_kw: BASELINE_GRID_KW[12],
    },
    duration_ms: 780,
  },
  {
    type: 'tool_result',
    tool_name: 'get_electricity_prices',
    message:
      'Tariff loaded. $0.09/kWh off-peak, $0.16/kWh from 14:00 to 20:00, $8.50/kW monthly demand charge. Worth noting that 18:00-20:00 is still on-peak, so anything I move into the early evening saves demand charge but not energy.',
    payload: {
      off_peak_usd_per_kwh: 0.09,
      on_peak_usd_per_kwh: 0.16,
      on_peak_window: '14:00-20:00',
      demand_charge_usd_per_kw: 8.5,
    },
    duration_ms: 290,
  },
  {
    type: 'tool_result',
    tool_name: 'get_battery_state',
    message: `Battery is at ${START_SOC_PCT}% SOC, 900 kWh on a 1000 kWh pack behind a 500 kW inverter, with only a ${RESERVE_FLOOR_PCT}% floor. This is the least constrained resource in the portfolio -- 800 kWh dispatchable, far more than this peak needs.`,
    payload: {
      soc_pct: START_SOC_PCT,
      capacity_kwh: 1000,
      available_kwh: 900,
      max_discharge_kw: 500,
      reserve_floor_pct: RESERVE_FLOOR_PCT,
      dispatchable_kwh: 800,
    },
    duration_ms: 250,
  },
  {
    type: 'tool_result',
    tool_name: 'get_ev_requirements',
    message: `There it is. Twenty-four delivery vans at 11 kW, all plugging in as they come off route between 13:00 and 17:00 -- 264 kW at full concurrency, which is ${Math.round((264 / BASELINE_PEAK_KW) * 100)}% of the peak. They do not depart until 05:00, so every one of them has six hours of slack.`,
    payload: {
      sessions_connected: 24,
      flexible_sessions: 24,
      locked_sessions: 0,
      charger_power_kw_each: VAN_CHARGER_KW,
      arrival_window: '13:00-17:00',
      departure_time: '05:00',
      slack_hours: 6,
    },
    duration_ms: 330,
  },
  {
    type: 'tool_result',
    tool_name: 'get_hvac_constraints',
    message:
      'HVAC has nothing to offer here. Six zones, all unconditioned high bay on destratification fans and dock-door make-up air; no cooling setpoint to float, no thermal mass to pre-charge, and the office mezzanine is 4% of the load. I am dropping HVAC from the resource list rather than pretending it is a lever.',
    payload: {
      zones_total: 6,
      conditioned_zones: 1,
      flexible_kw: 0,
      reason: 'unconditioned_high_bay_no_thermal_mass',
      mezzanine_share_pct: 4,
    },
    duration_ms: 260,
  },
  {
    type: 'thinking',
    tool_name: null,
    message: `So this is a queueing problem, not a shedding problem. If the vans create the peak and every van has six hours of slack, re-queueing them is worth more than anything the battery can do -- and it costs nobody anything. I will let the optimizer set the rate hour by hour rather than guessing at a split, and keep the battery in the resource list in case moving the load creates a new peak somewhere else.`,
    payload: null,
    duration_ms: 1050,
  },
  {
    type: 'tool_call',
    tool_name: 'run_schedule_optimizer',
    message:
      'run_schedule_optimizer(objective="minimize_peak_then_cost", horizon_hours=24, resources=["battery","ev"])',
    payload: {
      objective: 'minimize_peak_then_cost',
      horizon_hours: 24,
      resources: ['battery', 'ev'],
      excluded_resources: ['hvac'],
      solver: SOLVER_NAME,
    },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'run_schedule_optimizer',
    message: `Solver returned an optimal schedule in ${SOLVE_TIME_MS} ms. Peak drops from ${BASELINE_PEAK_KW} kW to ${OPTIMIZED_PEAK_KW} kW, a ${PEAK_REDUCTION_KW} kW cut. It went further than the two-window split I had in mind: it meters the charging rate hour by hour out to ${clock(22)} and holds the site on a flat ${OPTIMIZED_PEAK_KW} kW line from 13:00 onward, so there is no binding hour left to attack -- every hour from 13:00 sets the peak together now, and taking load off one only lifts another. It also did something I would not have: it parks ${round1(OPTIMIZED_EV[20])} kW of charging at ${clock(20)} and covers it with the battery. That costs energy and earns no peak on its own, but it is what makes the rest of the schedule fit.`,
    payload: {
      status: 'OPTIMAL',
      solver: SOLVER_NAME,
      solve_time_ms: SOLVE_TIME_MS,
      baseline_peak_kw: BASELINE_PEAK_KW,
      optimized_peak_kw: OPTIMIZED_PEAK_KW,
      peak_reduction_kw: PEAK_REDUCTION_KW,
      evening_block_kw: round1(OPTIMIZED_EV[20]),
      uncovered_evening_kw: UNCOVERED_EVENING_KW,
      binding_interval: isoHour(OPTIMIZED_PEAK_HOUR),
    },
    duration_ms: SOLVE_TIME_MS,
  },
  {
    type: 'tool_result',
    tool_name: 'validate_schedule',
    message: `All 9 constraints pass. Every van reaches full charge before the 05:00 departure with hours to spare, no bay exceeds 11 kW, and the site never crosses the 264 kW charger limit -- ${clock(20)} comes closest at ${round1(OPTIMIZED_EV[20])} kW. Battery ends at ${END_SOC_PCT}%, back where it started and well clear of the ${RESERVE_FLOOR_PCT}% floor.`,
    payload: {
      constraints_checked: 9,
      violations: 0,
      vans_charged_by_departure: 24,
      min_van_slack_hours: 6,
      battery_end_soc_pct: END_SOC_PCT,
    },
    duration_ms: 170,
  },
  {
    type: 'decision',
    tool_name: 'save_action_plan',
    message: `Committing a two-action plan: meter the fleet out across ${clock(EV_START_HOUR)}-${clock(EV_END_HOUR)}, and discharge the battery at ${DISCHARGE_KW} kW from ${clock(DISCHARGE_START_HOUR)} to ${clock(DISCHARGE_END_HOUR)} to cover the evening block. No HVAC action -- there is no flexibility there to recommend.`,
    payload: { action_count: 2, plan_savings_usd: SAVINGS_USD },
    duration_ms: 140,
  },
  {
    type: 'tool_call',
    tool_name: 'request_human_approval',
    message:
      'Neither action affects a person, so this is the cleanest plan in the portfolio -- but re-queueing the fleet changes the yard schedule, so the dispatch supervisor should see it before it runs.',
    payload: {
      requires_approval: true,
      action_count: 2,
      approvers: ['dispatch_supervisor'],
    },
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

export const warehouseFixture = makeFixture({
  building: WAREHOUSE_BUILDING,
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
    ev_connected: 0,
    hvac_setpoint_f: 68,
    outdoor_temp_f: 71,
  },
  planSummary: PLAN_SUMMARY,
  buildActions,
  script: WAREHOUSE_SCRIPT,
});
