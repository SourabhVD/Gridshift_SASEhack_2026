/**
 * sea-hospital-002 -- Harborview Medical Annex.
 *
 * The hard case. A hospital never really turns off: the overnight floor sits
 * around 600 kW and the midday plateau runs 838-884 kW, six hours of it over
 * the 800 kW threshold. HVAC is the dominant load (~40%), the battery carries
 * a 30% critical-care reserve floor instead of the usual 20%, and the four
 * ambulance chargers have 220 kWh to place somewhere in the day.
 *
 * The engine does not trim the six bad hours on their own. It levels the whole
 * day onto a single ceiling: it fills the pack in one 166.4 kW pull at 01:00
 * while the building is quiet, meters 429.1 kWh back out between 12:00 and
 * 19:00 at a rate that changes every hour, and pushes ambulance charging past
 * the 18:00 shift change. The reserve floor never binds -- state of charge
 * bottoms out at 43.5%, thirteen points clear -- and the pack is back at its
 * starting 76% by midnight, which it has to be: the engine charges for a 95%
 * round trip, so energy it spends is energy it has to buy.
 *
 * Two things here are worth saying out loud rather than glossing.
 *
 * The HVAC lever is offered and declined. The site reports a 35 kW shed with
 * two hours of drift, and the engine takes none of it: with the battery and
 * the ambulance bays already holding the ceiling, shedding load that has to be
 * made up an hour later buys nothing, and it will not spend patient comfort
 * for nothing. The action is modelled, comes back at zero, and is dropped from
 * the plan rather than shown to a clinician as something to approve.
 *
 * And the new ceiling is set at 01:00 -- by the pack's own charge, not by the
 * afternoon. That is the honest shape of the answer on this building: the
 * limit is no longer the plateau, it is how fast the pack can be filled
 * without becoming the peak itself.
 */

import type { Action, Building } from '@/types/api';
import {
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
  piecewise,
  range,
  round1,
  round2,
  scheduleScript,
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
/** Ambulance chargers. Four bays, all four deferrable against a 06:00 target. */
const EV_CHARGER_KW = 11;

/** "13:00". Hour 24 reads as midnight, which is where an evening block closes. */
const clock = (h: number): string => `${String(h % 24).padStart(2, '0')}:00`;

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

/**
 * Signed battery dispatch, hour -> kW: positive discharges into the building,
 * negative charges from the grid. The rate is not flat -- every hour is set by
 * what it takes to sit on the day's ceiling. The energy does not balance
 * either, and that is the point: 471.7 kWh goes in and 429.1 kWh comes back
 * out, because the pack is charged 95% one way and discharged 95% the other
 * and somebody has to pay for the difference.
 */
const BATTERY_KW: Record<number, number> = {
  1: -166.4,
  7: -35.7,
  12: +88.5,
  13: +73.6,
  14: +74.6,
  15: +58.6,
  16: +64.6,
  17: +42.6,
  18: +26.6,
  20: -5.4,
  21: -40.4,
  22: -74.4,
  23: -153.4,
};
const OPTIMIZED_BATTERY = zeros().map((_, h) => BATTERY_KW[h] ?? 0);

/** State of charge as the engine solved it. See the note on OPTIMIZED_PARTS. */
const OPTIMIZED_SOC = [
  76, 95.8, 95.8, 95.8, 95.8, 95.8, 95.8, 100, 100, 100, 100, 100, 88.4, 78.7,
  68.9, 61.1, 52.6, 47, 43.5, 43.5, 44.2, 49, 57.8, 76,
];

/**
 * Ambulance charging, as a delta on the baseline sessions. The midday bays are
 * thinned out and the energy reappears after the 18:00 shift change; the day's
 * total is unchanged, so no vehicle loses range.
 */
const EV_DELTA_KW: Record<number, number> = {
  10: +1.4,
  11: -6.6,
  12: +15.9,
  13: -22,
  14: -44,
  15: -44,
  16: -22,
  17: -22,
  19: +11.4,
  20: +43.9,
  21: +44,
  22: +44,
};
const OPTIMIZED_EV = BASELINE_EV.map((kw, h) => kw + (EV_DELTA_KW[h] ?? 0));

/**
 * Offered and declined.
 *
 * The site reports a 35 kW shed across the non-clinical wings
 * with up to two hours of +2°F drift, and the engine models it. It takes none
 * of it: the drift has to be paid back within the hour either side, and with
 * the battery and the bays already pinning the ceiling there is no peak left
 * for it to buy. Empty, so the window collapses and the row never reaches a
 * clinician. Spending patient comfort for a saving of zero is the one trade
 * this building should never make.
 */
const HVAC_SHIFT_KW = 35;
const HVAC_DELTA_KW: Record<number, number> = {};
const OPTIMIZED_HVAC = BASELINE_HVAC.map((kw, h) => kw + (HVAC_DELTA_KW[h] ?? 0));

const OPTIMIZED_PARTS: FlowComponents = {
  base: BASELINE_PARTS.base,
  ev: OPTIMIZED_EV,
  hvac: OPTIMIZED_HVAC,
  solar: SOLAR_KW,
  battery: OPTIMIZED_BATTERY,
  // The engine's own series, not a walk of the dispatch above: at 95% each
  // way the cells take in less than the inverter draws and give up more than
  // it delivers, so walking the metered kW reads 101.3% at midday on a plan
  // the engine capped at 100%. Transcribed, and checked by verify-fixtures.
  soc: OPTIMIZED_SOC,
};

export const OPTIMIZED_GRID_KW = gridFromComponents(OPTIMIZED_PARTS);

/**
 * Nothing is billed outside the modelled day. Every kWh the pack gives up is
 * put back inside the same 24 hours, so the recharge is already priced into
 * the optimized grid curve and there is no off-window top-up to add.
 */
export const BATTERY_RECHARGE_KWH = 0;

/* -------------------------------------------------------------------------- */
/* Headline numbers -- computed once, reused by the prose and the actions      */
/* -------------------------------------------------------------------------- */

const BASELINE_PEAK_KW = Math.max(...BASELINE_GRID_KW);
const OPTIMIZED_PEAK_KW = Math.max(...OPTIMIZED_GRID_KW);
const PEAK_REDUCTION_KW = round1(BASELINE_PEAK_KW - OPTIMIZED_PEAK_KW);
const BASELINE_COST_USD = round2(energyCost(BASELINE_GRID_KW));
const OPTIMIZED_COST_USD = round2(
  energyCost(OPTIMIZED_GRID_KW) + BATTERY_RECHARGE_KWH * 0.09,
);
const SAVINGS_USD = round2(BASELINE_COST_USD - OPTIMIZED_COST_USD);
const DEMAND_CHARGE_AVOIDED_USD = round2(PEAK_REDUCTION_KW * 8.5);

/** Hours the optimized meter sits within a kilowatt of the day's ceiling. */
const CEILING_HOURS = OPTIMIZED_GRID_KW.filter(
  (kw) => OPTIMIZED_PEAK_KW - kw < 1,
).length;

const PEAK_DISCHARGE_KW = round1(Math.max(...OPTIMIZED_BATTERY));
const MAX_CHARGE_KW = round1(-Math.min(...OPTIMIZED_BATTERY));
const BATTERY_DISCHARGE_KWH = round1(
  OPTIMIZED_BATTERY.reduce((sum, kw) => (kw > 0 ? sum + kw : sum), 0),
);
/**
 * What the scripted agent says it ran, and how long it took. Both transcribed
 * from a real solve: the payload used to claim "CP-SAT" and 3104 ms, neither
 * of which has been true since the MIP engine became the default.
 */
const SOLVER_NAME = 'MIP (OR-Tools/SCIP)';
const SOLVE_TIME_MS = 50;

const BASELINE_PEAK_HOUR = BASELINE_GRID_KW.indexOf(BASELINE_PEAK_KW);
const CHARGE_HOUR = OPTIMIZED_BATTERY.indexOf(Math.min(...OPTIMIZED_BATTERY));
const DISCHARGE_HOURS = OPTIMIZED_BATTERY.map((kw, h) => (kw > 0 ? h : -1)).filter(
  (h) => h >= 0,
);
const DISCHARGE_START_HOUR = DISCHARGE_HOURS[0];
const DISCHARGE_END_HOUR = DISCHARGE_HOURS[DISCHARGE_HOURS.length - 1] + 1;
const PEAK_DISCHARGE_HOUR = OPTIMIZED_BATTERY.indexOf(
  Math.max(...OPTIMIZED_BATTERY),
);
/** What the pack takes out of the interval that sets the BASELINE peak. */
const BATTERY_CUT_AT_PEAK_KW = round1(OPTIMIZED_BATTERY[BASELINE_PEAK_HOUR]);
/** Charged in versus given back out. They differ, by the round-trip loss. */
const BATTERY_CHARGE_KWH = round1(
  OPTIMIZED_BATTERY.reduce((sum, kw) => (kw < 0 ? sum - kw : sum), 0),
);

/**
 * Where the day-ahead saving comes from, priced against the baseline at the
 * tariff, so the levers add up to SAVINGS_USD exactly rather than being typed
 * in by hand and drifting away from it.
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

/** Same rule the backend applies: the hours each lever actually moves. */
const [EV_START_HOUR, EV_END_HOUR] = actionWindow(EV_DELTA_KW);
const [HVAC_START_HOUR, HVAC_END_HOUR] = actionWindow(HVAC_DELTA_KW);

const MIN_SOC_PCT = Math.min(...OPTIMIZED_PARTS.soc);
const SOC_HEADROOM_PCT = round1(MIN_SOC_PCT - RESERVE_FLOOR_PCT);
const END_SOC_PCT = OPTIMIZED_PARTS.soc[23];
const EV_ENERGY_KWH = round1(OPTIMIZED_EV.reduce((sum, kw) => sum + kw, 0));
const HVAC_ENERGY_KWH = round1(OPTIMIZED_HVAC.reduce((sum, kw) => sum + kw, 0));
/** What the EV shift takes out of the interval that sets the baseline peak. */
const EV_CUT_AT_PEAK_KW = round1(BASELINE_EV[14] - OPTIMIZED_EV[14]);

/** One hour off a component curve, at the 0.1 kW precision the API publishes. */
const kwAt = (series: number[], hour: number): number => round1(series[hour]);
/** How hard the pack is charging in `hour`, as a positive number. */
const chargeKwAt = (hour: number): number => round1(-OPTIMIZED_BATTERY[hour]);

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

export const PLAN_SUMMARY = [
  `Today's forecast peaks at ${BASELINE_PEAK_KW} kW at 14:00 and stays above the`,
  '800 kW threshold for six straight hours, 12:00 through 18:00. The optimizer',
  'did not trim those six hours on their own. It levelled the whole day instead',
  `and held the meter within a kilowatt of a single ${OPTIMIZED_PEAK_KW} kW ceiling`,
  `for ${CEILING_HOURS} of the 24 intervals. The quiet hours pay for that: the pack`,
  `takes one ${MAX_CHARGE_KW} kW pull at ${clock(CHARGE_HOUR)} while the building is`,
  'hundreds of kW below the plateau, tops up again at 07:00, and the energy comes',
  `back out between ${clock(DISCHARGE_START_HOUR)} and ${clock(DISCHARGE_END_HOUR)} at`,
  `a rate that changes every hour, topping out at ${PEAK_DISCHARGE_KW} kW at`,
  `${clock(PEAK_DISCHARGE_HOUR)}. ${BATTERY_CHARGE_KWH} kWh goes in against`,
  `${BATTERY_DISCHARGE_KWH} kWh back out -- the gap is the 95% round trip, and it is`,
  `bought rather than wished away, which is why the pack still ends the day at the`,
  `${START_SOC_PCT}% it started on. The critical-care reserve is never close: state of`,
  `charge bottoms out at ${MIN_SOC_PCT}% at 18:00, ${SOC_HEADROOM_PCT} points above the`,
  `${RESERVE_FLOOR_PCT}% floor. The ${HVAC_SHIFT_KW} kW of non-clinical setpoint drift`,
  'was offered and came back unused: with the ceiling already held, shedding air',
  'handling that has to be made up an hour later buys nothing, and patient comfort',
  'is not spent for nothing. Ambulance charging thins across the afternoon and',
  `moves past the 18:00 shift change, with the same ${EV_ENERGY_KWH} kWh delivered`,
  `either way. The peak falls from ${BASELINE_PEAK_KW} kW to ${OPTIMIZED_PEAK_KW} kW,`,
  `a ${PEAK_REDUCTION_KW} kW cut worth about $${DEMAND_CHARGE_AVOIDED_USD.toFixed(2)}`,
  `on the demand charge, with $${SAVINGS_USD.toFixed(2)} of day-ahead energy saved on`,
  'top, and the building no longer crosses the 800 kW threshold at any hour. The',
  `part worth a second look is ${clock(CHARGE_HOUR)}: it now sits on the same ceiling`,
  'as the afternoon, because the charge that pays for the whole plan is itself one',
  'of the hours that sets the new peak. That is a large change to make to a',
  'hospital while nobody is watching.',
].join(' ');

function buildActions(runId: string): Action[] {
  return [
    {
      id: 'act-battery-01',
      run_id: runId,
      type: 'battery_discharge',
      title: `Discharge battery up to ${PEAK_DISCHARGE_KW} kW, ${clock(DISCHARGE_START_HOUR)}-${clock(DISCHARGE_END_HOUR)}`,
      description: `Fill the pack at the $0.09/kWh rate -- one ${chargeKwAt(CHARGE_HOUR)} kW pull at ${clock(CHARGE_HOUR)} and a ${chargeKwAt(7)} kW top-up at 07:00 -- then meter ${BATTERY_DISCHARGE_KWH} kWh back out across the ${DISCHARGE_HOURS.length} hours from ${clock(DISCHARGE_START_HOUR)} to ${clock(DISCHARGE_END_HOUR)}. The rate is not flat: it runs from ${kwAt(OPTIMIZED_BATTERY, 18)} kW at 18:00 up to ${PEAK_DISCHARGE_KW} kW at ${clock(PEAK_DISCHARGE_HOUR)}, set each hour by whatever it takes to hold the ${OPTIMIZED_PEAK_KW} kW ceiling. ${BATTERY_CHARGE_KWH} kWh goes in for ${BATTERY_DISCHARGE_KWH} kWh out; the difference is the 95% round trip and it is bought, not borrowed. SOC goes from ${START_SOC_PCT}% to 100% by 07:00, down to ${MIN_SOC_PCT}% at 18:00, and back to ${END_SOC_PCT}% by midnight. That low point is ${SOC_HEADROOM_PCT} points clear of the ${RESERVE_FLOOR_PCT}% critical-care reserve floor, and both the ${MAX_CHARGE_KW} kW charge and the ${PEAK_DISCHARGE_KW} kW discharge sit well inside the 400 kW inverter.`,
      start_time: isoHour(DISCHARGE_START_HOUR),
      end_time: isoHour(DISCHARGE_END_HOUR),
      magnitude: PEAK_DISCHARGE_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: BATTERY_CUT_AT_PEAK_KW,
      estimated_savings_usd: BATTERY_SAVINGS_USD,
      status: 'pending',
      constraints_checked: [
        'soc_reserve_floor_30pct_critical_care',
        'max_discharge_400kw',
        'islanding_capability_preserved',
        'single_discharge_window_per_day',
      ],
    },
    {
      id: 'act-hvac-02',
      run_id: runId,
      type: 'hvac_setpoint',
      title: 'Hold every setpoint, clinical and non-clinical alike',
      description: `The optimizer had ${HVAC_SHIFT_KW} kW of non-clinical shed available with up to two hours of +2°F drift, and took none of it. Drift here is a loan, not a saving -- the air handlers make it back within the hour either side -- and with the battery and the ambulance bays already holding the day at ${OPTIMIZED_PEAK_KW} kW there is no peak left for it to buy. Day-total HVAC energy is unchanged at ${HVAC_ENERGY_KWH} kWh because nothing moved at all. The 16 clinical zones were never on the table; today the other 26 are not either. This row is dropped before the plan reaches a clinician, since an action of zero magnitude over zero hours is not something to approve, but the lever stays modelled and is the first thing called for if the afternoon runs hot.`,
      start_time: isoHour(HVAC_START_HOUR),
      end_time: isoHour(HVAC_END_HOUR),
      magnitude: 0,
      unit: '°F',
      estimated_peak_reduction_kw: 0,
      estimated_savings_usd: HVAC_SAVINGS_USD,
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
      title: `Shift ambulance charging to ${clock(19)}-${clock(23)}`,
      description: `Thin the midday sessions and put the energy back after the 18:00 shift change. The bays are metered against the ceiling rather than switched off: ${kwAt(OPTIMIZED_EV, 10)} kW at 10:00, ${kwAt(OPTIMIZED_EV, 11)} kW at 11:00 and ${kwAt(OPTIMIZED_EV, 12)} kW at 12:00 where there is room, nothing at all from ${clock(13)} to ${clock(18)}, then ${kwAt(OPTIMIZED_EV, 19)} kW at 19:00 and all four bays at ${kwAt(OPTIMIZED_EV, 21)} kW through to 23:00. That takes the full ${2 * EV_CHARGER_KW} kW off 16:00 and 17:00 and ${EV_CUT_AT_PEAK_KW} kW off the 14:00 interval that sets the baseline peak -- the largest single bite any lever takes out of that hour. The same ${EV_ENERGY_KWH} kWh is delivered either way, so no vehicle loses range and every one is back above 80% before the 06:00 handover.`,
      start_time: isoHour(EV_START_HOUR),
      end_time: isoHour(EV_END_HOUR),
      magnitude: round1(Math.max(...OPTIMIZED_EV)),
      unit: 'kW',
      estimated_peak_reduction_kw: EV_CUT_AT_PEAK_KW,
      estimated_savings_usd: EV_SAVINGS_USD,
      status: 'pending',
      constraints_checked: [
        'ev_energy_delivered_220kwh',
        'all_vehicles_min_soc_80pct_by_0600',
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
    message: `Peak confirmed: ${BASELINE_PEAK_KW} kW at 14:00, 84 kW over the 800 kW threshold. The worrying number is the width -- six consecutive hours over threshold, 12:00 through 18:00, against four at a typical office. The overnight floor is ${BASELINE_GRID_KW[3]} kW, which is a lot of unused headroom.`,
    payload: {
      peak_kw: BASELINE_PEAK_KW,
      peak_time: isoHour(14),
      threshold_kw: 800,
      hours_over_threshold: 6,
      first_exceedance: isoHour(12),
      overnight_floor_kw: BASELINE_GRID_KW[3],
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
    message: `Battery is at ${START_SOC_PCT}% SOC, 608 kWh on an 800 kWh pack behind a 400 kW inverter. The reserve floor here is ${RESERVE_FLOOR_PCT}%, not the usual 20% -- the pack is part of the critical-care ride-through -- so 368 kWh is dispatchable from where it stands. There is also 192 kWh of empty headroom above it, and the overnight rate is $0.09, so filling the pack first is on the table.`,
    payload: {
      soc_pct: START_SOC_PCT,
      capacity_kwh: 800,
      available_kwh: 608,
      max_discharge_kw: 400,
      max_charge_kw: 400,
      reserve_floor_pct: RESERVE_FLOOR_PCT,
      reserve_reason: 'critical_care_ride_through',
      dispatchable_kwh: 368,
      headroom_kwh: 192,
    },
    duration_ms: 270,
  },
  {
    type: 'tool_result',
    tool_name: 'get_ev_requirements',
    message: `Four ambulance chargers at ${EV_CHARGER_KW} kW, ${EV_ENERGY_KWH} kWh to deliver over the day. Two front-line vehicles are on standby and two are reserve, but the requirement is energy, not hours: every vehicle has to be back above 80% before the 06:00 handover and nothing may still be drawing after midnight. The 18:00 shift change frees all four bays.`,
    payload: {
      sessions_connected: 4,
      energy_required_kwh: EV_ENERGY_KWH,
      earliest_shift_time: isoHour(18),
      target_soc_pct: 80,
      target_time: '06:00',
      charger_power_kw_each: EV_CHARGER_KW,
      site_limit_kw: 4 * EV_CHARGER_KW,
      no_charging_after: isoHour(23),
    },
    duration_ms: 320,
  },
  {
    type: 'tool_result',
    tool_name: 'get_hvac_constraints',
    message: `HVAC is 42 zones, and 16 of them are clinical: patient rooms, theatres, imaging, pharmacy, isolation. Those are locked on both setpoint and pressure cascade. The remaining 26 non-clinical zones may drift 2°F for up to two hours, worth about ${HVAC_SHIFT_KW} kW, and they can be pre-cooled ahead of it at the same ${HVAC_SHIFT_KW} kW in whichever hour I take it.`,
    payload: {
      zones_total: 42,
      clinical_zones_locked: 16,
      non_clinical_zones_flexible: 26,
      max_drift_f: 2,
      max_drift_hours: 2,
      non_clinical_max_temp_f: 76,
      estimated_shed_kw: HVAC_SHIFT_KW,
      precool_allowed: true,
    },
    duration_ms: 280,
  },
  {
    type: 'thinking',
    tool_name: null,
    message: `Working from where the pack sits, 368 kWh spread over the six over-threshold hours is only about 61 kW, and that still leaves the afternoon above 800. But the overnight hours are hundreds of kW below the plateau and cost $0.09, so I can fill the pack first and stop thinking of this as trimming six bad hours. The better shape is one ceiling for the whole day, with the quiet hours lifted to pay for the busy ones. Handing that to the optimizer.`,
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
      solver: SOLVER_NAME,
    },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'run_schedule_optimizer',
    message: `Solver returned an optimal schedule in ${SOLVE_TIME_MS} ms. Peak drops from ${BASELINE_PEAK_KW} kW to ${OPTIMIZED_PEAK_KW} kW, a ${PEAK_REDUCTION_KW} kW cut, and the building clears the 800 kW threshold in every hour. It found one ceiling and held the meter within a kilowatt of it for ${CEILING_HOURS} of the 24 intervals, so there is no single binding hour left to attack -- shedding harder anywhere just moves the ceiling somewhere else. It also left the HVAC lever alone, which I did not expect.`,
    payload: {
      status: 'OPTIMAL',
      solver: SOLVER_NAME,
      solve_time_ms: SOLVE_TIME_MS,
      baseline_peak_kw: BASELINE_PEAK_KW,
      optimized_peak_kw: OPTIMIZED_PEAK_KW,
      peak_reduction_kw: PEAK_REDUCTION_KW,
      ceiling_kw: OPTIMIZED_PEAK_KW,
      hours_at_ceiling: CEILING_HOURS,
      hours_over_threshold_after: 0,
      battery_throughput_kwh: BATTERY_DISCHARGE_KWH,
      hvac_curtail_kw: 0,
    },
    duration_ms: SOLVE_TIME_MS,
  },
  {
    type: 'tool_result',
    tool_name: 'validate_schedule',
    message: `All 17 constraints pass. State of charge bottoms out at ${MIN_SOC_PCT}% at 18:00, ${SOC_HEADROOM_PCT} points above the ${RESERVE_FLOOR_PCT}% critical-care floor, and the pack is back at ${END_SOC_PCT}% by midnight -- exactly where it started, with the round-trip loss paid for rather than borrowed. Charge and discharge both stay inside the 400 kW inverter. All 42 zones are untouched, clinical and non-clinical alike, so the theatre pressure cascade is not even engaged, and every ambulance still gets its share of the ${EV_ENERGY_KWH} kWh.`,
    payload: {
      constraints_checked: 17,
      violations: 0,
      battery_min_soc_pct: MIN_SOC_PCT,
      battery_end_soc_pct: END_SOC_PCT,
      reserve_floor_pct: RESERVE_FLOOR_PCT,
      max_charge_kw: MAX_CHARGE_KW,
      max_discharge_kw: PEAK_DISCHARGE_KW,
      clinical_zones_untouched: 16,
      ev_energy_delivered_kwh: EV_ENERGY_KWH,
      hvac_drift_hours: 0,
    },
    duration_ms: 240,
  },
  {
    type: 'decision',
    tool_name: 'save_action_plan',
    message: `Committing a two-action plan: charge the pack overnight and meter ${BATTERY_DISCHARGE_KWH} kWh back out between ${clock(DISCHARGE_START_HOUR)} and ${clock(DISCHARGE_END_HOUR)}, and move ambulance charging into the evening. The HVAC lever comes back at zero and is dropped rather than put to a clinician, which is the right way round: it was available and it was not worth using.`,
    payload: { action_count: 2, plan_savings_usd: SAVINGS_USD },
    duration_ms: 160,
  },
  {
    type: 'tool_call',
    tool_name: 'request_human_approval',
    message: `This one is not close to automatic. The plan lifts ${clock(CHARGE_HOUR)} from ${BASELINE_GRID_KW[CHARGE_HOUR]} kW to the same ${OPTIMIZED_PEAK_KW} kW ceiling as the afternoon -- the charge that pays for the whole day is itself one of the hours that sets the new peak -- and it runs the critical-care pack down to ${MIN_SOC_PCT}% in the middle of a weekday. It goes to the facilities director and the on-call clinical engineer together.`,
    payload: {
      requires_approval: true,
      action_count: 2,
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
