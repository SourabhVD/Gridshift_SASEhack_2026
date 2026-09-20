/**
 * sea-hospital-002 -- Harborview Medical Annex.
 *
 * The hard case. A hospital never really turns off: the overnight floor sits
 * around 600 kW and the midday plateau runs 838-884 kW, six hours of it over
 * the 800 kW threshold. HVAC is the dominant load (~40%), the battery carries
 * a 30% critical-care reserve floor instead of the usual 20%, and the four
 * ambulance chargers have 220 kWh to place somewhere in the day.
 *
 * The solver does not trim the six bad hours on their own. It levels the whole
 * day onto a single ceiling: it fills the pack overnight, drawing 169.8 kW at
 * 03:00 while the building is quiet, meters 393.4 kWh back out between 12:00
 * and 19:00 at a rate that changes every hour, pushes ambulance charging past
 * the 18:00 shift change, and pre-cools the non-clinical zones at 02:00 and
 * 06:00 to pay for +2°F of drift at 13:00 and 16:00. The reserve floor never
 * binds: the state-of-charge walk bottoms out at 50.8%, and the pack is back
 * at its starting 76% by midnight.
 */

import type { Action, Building } from '@/types/api';
import {
  NOW_HOUR,
  TZ_OFFSET,
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
  round1,
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
/** Ambulance chargers. Four bays, all four deferrable against a 06:00 target. */
const EV_CHARGER_KW = 11;

/** End of the demo day, for an action that runs up to midnight. */
const MIDNIGHT = '2025-09-19T00:00:00' + TZ_OFFSET;

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
 * negative charges from the grid. The solver no longer holds one flat rate, so
 * a flat helper cannot express it -- every hour is set by what it takes to sit
 * on the day's ceiling. 393.4 kWh in overnight, the same 393.4 kWh back out
 * across the afternoon, and the balance is closed again before midnight.
 */
const BATTERY_KW: Record<number, number> = {
  2: -20.4,
  3: -169.8,
  9: -1.8,
  12: +63.5,
  13: +46.2,
  14: +95.7,
  15: +66.2,
  16: +37.2,
  17: +50.2,
  18: +34.4,
  21: -32.8,
  22: -66.8,
  23: -101.8,
};
const OPTIMIZED_BATTERY = zeros().map((_, h) => BATTERY_KW[h] ?? 0);

/**
 * Ambulance charging, as a delta on the baseline sessions. The midday bays are
 * thinned out and the energy reappears after the 18:00 shift change; the day's
 * total is unchanged, so no vehicle loses range.
 */
const EV_DELTA_KW: Record<number, number> = {
  10: -6.2,
  11: -14.2,
  12: -16.7,
  13: -22,
  14: -30.5,
  15: -44,
  16: -22,
  17: -22,
  19: +3.8,
  20: +41.8,
  21: +44,
  22: +44,
  23: +44,
};
const OPTIMIZED_EV = BASELINE_EV.map((kw, h) => kw + (EV_DELTA_KW[h] ?? 0));

/**
 * Pre-cool the non-clinical wings while the building is far below its ceiling,
 * then let those zones drift +2°F through two of the afternoon hours. Clinical
 * zones never move, and the day's HVAC energy is unchanged.
 */
const HVAC_SHIFT_KW = 35;
const HVAC_DELTA_KW: Record<number, number> = {
  2: +HVAC_SHIFT_KW,
  6: +HVAC_SHIFT_KW,
  13: -HVAC_SHIFT_KW,
  16: -HVAC_SHIFT_KW,
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
  '800 kW threshold for six straight hours, 12:00 through 18:00. The solver did',
  'not trim those six hours on their own. It levelled the whole day instead and',
  `held the meter within a kilowatt of a single ${OPTIMIZED_PEAK_KW} kW ceiling for`,
  `${CEILING_HOURS} of the 24`,
  'intervals. The quiet hours pay for that: the pack charges at 02:00 and again',
  `at 03:00, drawing ${MAX_CHARGE_KW} kW while the building is hundreds of kW below`,
  'the plateau, and the energy comes back out between 12:00 and 19:00 at a rate',
  `that changes every hour and tops out at ${PEAK_DISCHARGE_KW} kW at 14:00.`,
  `${BATTERY_DISCHARGE_KWH} kWh moves each way, so the pack ends the day back where`,
  `it started at ${START_SOC_PCT}% SOC. The critical-care reserve is never close: the`,
  `walk bottoms out at ${MIN_SOC_PCT}% at 18:00, ${SOC_HEADROOM_PCT} points above the`,
  `${RESERVE_FLOOR_PCT}% floor. Non-clinical air handlers pre-cool at 02:00 and 06:00`,
  'and then drift +2°F at 13:00 and again at 16:00, worth',
  `${HVAC_SHIFT_KW} kW in each of those two hours; patient rooms, theatres and`,
  'imaging are excluded outright. Ambulance charging moves out of the afternoon',
  `and into the evening, with the same ${EV_ENERGY_KWH} kWh delivered either way.`,
  `Together the peak falls from ${BASELINE_PEAK_KW} kW to ${OPTIMIZED_PEAK_KW} kW,`,
  `a ${PEAK_REDUCTION_KW} kW cut worth about $${DEMAND_CHARGE_AVOIDED_USD.toFixed(2)}`,
  `on the demand charge, with $${SAVINGS_USD.toFixed(2)} of day-ahead energy saved`,
  'on top, and the building no longer crosses the 800 kW threshold at any hour.',
  'The part worth a second look is the overnight charge: 03:00 goes from',
  `${BASELINE_GRID_KW[3]} kW to the same ceiling as the afternoon, which is a large`,
  'change to make to a hospital while nobody is watching.',
].join(' ');

function buildActions(runId: string): Action[] {
  return [
    {
      id: 'act-battery-01',
      run_id: runId,
      type: 'battery_discharge',
      title: `Discharge battery up to ${PEAK_DISCHARGE_KW} kW, 12:00-19:00`,
      description: `Fill the pack overnight at the $0.09/kWh rate, ${chargeKwAt(2)} kW at 02:00, ${chargeKwAt(3)} kW at 03:00 and a ${chargeKwAt(9)} kW trickle at 09:00, then meter ${BATTERY_DISCHARGE_KWH} kWh back out across the seven hours from 12:00 to 19:00. The rate is not flat: it runs from ${kwAt(OPTIMIZED_BATTERY, 18)} kW at 18:00 up to ${PEAK_DISCHARGE_KW} kW at 14:00, set each hour by whatever it takes to hold the ${OPTIMIZED_PEAK_KW} kW ceiling. SOC goes from ${START_SOC_PCT}% to 100% by 09:00, down to ${MIN_SOC_PCT}% at 18:00, and back to ${END_SOC_PCT}% by midnight. That low point is ${SOC_HEADROOM_PCT} points clear of the ${RESERVE_FLOOR_PCT}% critical-care reserve floor, and both the ${MAX_CHARGE_KW} kW charge and the ${PEAK_DISCHARGE_KW} kW discharge sit well inside the 400 kW inverter.`,
      start_time: isoHour(12),
      end_time: isoHour(19),
      magnitude: PEAK_DISCHARGE_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: PEAK_DISCHARGE_KW,
      estimated_savings_usd: 25.2,
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
      title: 'Pre-cool non-clinical zones, then drift +2°F at 13:00 and 16:00',
      description: `Pre-cool the 26 non-clinical zones (admin, lobby, cafeteria, plant rooms) with an extra ${HVAC_SHIFT_KW} kW at 02:00 and again at 06:00, when the building is hundreds of kW below its ceiling, then let them rise 2°F at 13:00 and again at 16:00, taking ${HVAC_SHIFT_KW} kW out of each of those hours. Day-total HVAC energy is unchanged at ${HVAC_ENERGY_KWH} kWh; only the timing moves. The 16 clinical zones -- patient rooms, operating theatres, imaging, pharmacy and the isolation suite -- are excluded and hold their setpoints and pressure relationships unchanged.`,
      start_time: isoHour(13),
      end_time: isoHour(17),
      magnitude: 2,
      unit: '°F',
      estimated_peak_reduction_kw: HVAC_SHIFT_KW,
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
      title: 'Shift ambulance charging to 19:00-00:00',
      description: `Thin the midday sessions and put the energy back after the 18:00 shift change. Charging drops to ${kwAt(OPTIMIZED_EV, 10)} kW at 10:00 and ${kwAt(OPTIMIZED_EV, 11)} kW at 11:00, runs down to nothing across the afternoon, then restarts at ${kwAt(OPTIMIZED_EV, 19)} kW at 19:00, ${kwAt(OPTIMIZED_EV, 20)} kW at 20:00 and all four bays at ${kwAt(OPTIMIZED_EV, 21)} kW from 21:00 to midnight. That takes the full ${2 * EV_CHARGER_KW} kW off 16:00 and 17:00 and ${EV_CUT_AT_PEAK_KW} kW off the 14:00 interval that sets the baseline peak. The same ${EV_ENERGY_KWH} kWh is delivered either way, so no vehicle loses range and every one is back above 80% before the 06:00 handover.`,
      start_time: isoHour(19),
      end_time: MIDNIGHT,
      magnitude: 2 * EV_CHARGER_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: 2 * EV_CHARGER_KW,
      estimated_savings_usd: 0,
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
      no_charging_after: MIDNIGHT,
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
      solver: 'CP-SAT',
    },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'run_schedule_optimizer',
    message: `Solver returned an optimal schedule in 3.1 s. Peak drops from ${BASELINE_PEAK_KW} kW to ${OPTIMIZED_PEAK_KW} kW, a ${PEAK_REDUCTION_KW} kW cut, and the building clears the 800 kW threshold in every hour. It found one ceiling and held the meter within a kilowatt of it for ${CEILING_HOURS} of the 24 intervals, so there is no single binding hour left to attack -- shedding harder anywhere just moves the ceiling somewhere else.`,
    payload: {
      status: 'OPTIMAL',
      solve_time_ms: 3104,
      baseline_peak_kw: BASELINE_PEAK_KW,
      optimized_peak_kw: OPTIMIZED_PEAK_KW,
      peak_reduction_kw: PEAK_REDUCTION_KW,
      ceiling_kw: OPTIMIZED_PEAK_KW,
      hours_at_ceiling: CEILING_HOURS,
      hours_over_threshold_after: 0,
      battery_throughput_kwh: BATTERY_DISCHARGE_KWH,
    },
    duration_ms: 3104,
  },
  {
    type: 'tool_result',
    tool_name: 'validate_schedule',
    message: `All 17 constraints pass. The state-of-charge walk bottoms out at ${MIN_SOC_PCT}% at 18:00, ${SOC_HEADROOM_PCT} points above the ${RESERVE_FLOOR_PCT}% critical-care floor, and the pack is back at ${END_SOC_PCT}% by midnight. Charge and discharge both stay inside the 400 kW inverter. All 16 clinical zones are untouched and the theatre pressure cascade holds, and every ambulance still gets its share of the ${EV_ENERGY_KWH} kWh.`,
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
      hvac_drift_hours: 2,
    },
    duration_ms: 240,
  },
  {
    type: 'decision',
    tool_name: 'save_action_plan',
    message: `Committing a three-action plan: charge the pack overnight and meter ${BATTERY_DISCHARGE_KWH} kWh back out between 12:00 and 19:00, drift the 26 non-clinical HVAC zones +2°F at 13:00 and 16:00, and move ambulance charging into the evening.`,
    payload: { action_count: 3, plan_savings_usd: SAVINGS_USD },
    duration_ms: 160,
  },
  {
    type: 'tool_call',
    tool_name: 'request_human_approval',
    message: `This one is not close to automatic. The plan lifts 03:00 from ${BASELINE_GRID_KW[3]} kW to the same ${OPTIMIZED_PEAK_KW} kW ceiling as the afternoon, which is a large overnight draw on a quiet building, and the HVAC action touches occupied space. It goes to the facilities director and the on-call clinical engineer together.`,
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
