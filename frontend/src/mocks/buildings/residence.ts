/**
 * sea-residence-004 -- Alder Street Residence.
 *
 * The small case, and the only one where the threshold is not a demand charge
 * on a commercial bill but a residential demand-response cap: the utility pays
 * the household to stay under 9 kW and bills a penalty for every kW over it.
 * Everything here is one to two orders of magnitude below the other three
 * sites, which is the point -- the same contract, the same flow identity and
 * the same agent loop have to read correctly at 0.6 kW as well as at 884 kW.
 *
 * The day in one line: a 2,400 sqft house drifts along at 0.6-1.9 kW, banks
 * its 8.2 kW array into two wall batteries through the morning, exports the
 * midday surplus, and then puts an 11.5 kW car charger, an electric dinner and
 * a heat pump on the meter at the same time. 17:00-19:00 reads 12.4 / 13.4 /
 * 11.9 kW -- three consecutive hours over the 9 kW cap.
 *
 * Two modelling notes, because both are load-bearing:
 *
 *   1. PV-to-battery priority. The hybrid inverter is set to fill the pack
 *      before it serves the house, so from first light until the pack is full
 *      the whole array goes to storage and the house rides the meter. That is
 *      why the morning grid curve is exactly base + HVAC (1.5 kW at 06:00
 *      rising to 1.9 kW at 10:00) and why SOC reads 91% at 10:00.
 *   2. Net export. 27 kWh of storage cannot swallow a 50 kWh solar day. The
 *      pack is full at 11:00, and from then until 17:00 the surplus leaves the
 *      property: `grid_kw` goes negative, bottoming out at -4.0 kW at 12:00.
 *      That is a real house with a real array, not a broken fixture, and it is
 *      the first fixture that exercises the negative half of the contract. The
 *      flow diagram already reverses a wire whose flow runs the other way, and
 *      both charts ask for `domain={[0, 'auto']}` without `allowDataOverflow`,
 *      so recharts widens past the 0 floor rather than clipping. This site is
 *      the regression test for both of those.
 *
 * The plan is component-first on both sides: nothing is pinned, so every kW an
 * action claims is a kW that really moves in `optimized_flows`. The optimized
 * dispatch is the engine's own: the pack runs an hour-by-hour schedule rather
 * than one flat rate, and the answer is not to empty the 18:00 peak but to cut
 * the charger there, cover 17:00 and 22:00 out of storage, and hold the whole
 * evening flat at 4.7 kW.
 *
 * One more note, specific to this site: at 27 kWh the pack's 95% round trip is
 * not a rounding error. It gives back 16.3 kWh and takes 18.2 kWh to do it,
 * and that 1.9 kWh is a visible share of a $2.68 day. The engine prices it;
 * the state of charge published here is the engine's own series rather than a
 * walk of the dispatch, because a lossless walk of these numbers reads 102.8%.
 */

import type { Action, Building } from '@/types/api';
import {
  actionWindow,
  HOURS,
  NOW_HOUR,
  TZ_OFFSET,
  type FlowComponents,
  energyCost,
  gridFromComponents,
  isoHour,
  makeFixture,
  meteredActuals,
  round1,
  round2,
  scheduleScript,
  socWalk,
  zeros,
} from './shared';

export const RESIDENCE_ID = 'sea-residence-004';

export const RESIDENCE_BUILDING: Building = {
  id: RESIDENCE_ID,
  name: 'Alder Street Residence',
  type: 'residence',
  address: '1418 E Alder Street, Seattle, WA 98122',
  floors: 2,
  area_sqft: 2_400,
  peak_threshold_kw: 9,
  battery_capacity_kwh: 27,
  battery_max_kw: 10,
  ev_bays: 1,
  solar_capacity_kw: 8.2,
  hvac_zones: 2,
};

/** Contractual floor on the pack: the owner keeps it back for outages. */
const RESERVE_FLOOR_PCT = 20;
/** Where the pack sits at 00:00, after last night's evening draw. */
const START_SOC_PCT = 50.6;
/** The wall charger. One bay, one car. */
const EV_CHARGER_KW = 11.5;
/** Occupied comfort band the heat pump may float inside. */
const COMFORT_BAND_F: [number, number] = [70, 76];

/* -------------------------------------------------------------------------- */
/* Baseline components                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Everything that is not the car, the heat pump or the array: fridge, standby,
 * lighting, and from 17:00 the cooking-and-lights block that makes a household
 * evening. 0.4 kW overnight, 1.2 kW through the morning, 0.8 kW midday,
 * 2.6 kW 17:00-22:00.
 */
const BASE_KW: number[] = [
  0.4, 0.4, 0.4, 0.4, 0.4, 0.4, //  00-05 asleep
  1.2, 1.2, 1.2, 1.2, 1.2, //       06-10 breakfast, showers, laundry
  0.8, 0.8, 0.8, 0.8, 0.8, 0.8, //  11-16 empty house
  2.6, 2.6, 2.6, 2.6, 2.6, //       17-21 cooking, lights, everyone home
  0.4, 0.4, //                      22-23 back down
];

/**
 * Single heat pump, two zones. 0.2 kW ticking over overnight, climbing with
 * the outdoor temperature to a flat 1.8 kW through 14:00-19:00, then falling
 * away fast once the 80 F afternoon breaks -- by 19:00 it is 72 F outdoors
 * against a 72 F setpoint and the compressor barely runs.
 */
const HVAC_KW: number[] = [
  0.2, 0.2, 0.2, 0.2, 0.2, 0.2, //  00-05
  0.3, 0.4, 0.5, 0.6, 0.7, //       06-10
  0.9, 1.1, 1.4, //                 11-13 ramping with the afternoon
  1.8, 1.8, 1.8, 1.8, 1.8, //       14-18 flat out
  0.9, 0.6, 0.4, 0.2, 0.2, //       19-23 coasting down
];

/**
 * 8.2 kW array on the front gable slope, which faces south-west: first light
 * just before 07:00, 6.1 kW at 13:00, and a long warm shoulder that still
 * makes 3.5 kW at 17:00. Dark by 20:00.
 */
const SOLAR_KW: number[] = [
  0, 0, 0, 0, 0, 0, //              00-05
  0.1, 0.8, 2.2, 3.4, 4.4, //       06-10
  5.3, 5.9, 6.1, 5.8, 5.2, 4.4, //  11-16
  3.5, 2.5, 0.6, //                 17-19
  0, 0, 0, 0, //                    20-23
];

/**
 * The car plugs in at 17:30 and pulls the full 11.5 kW through 17:00-20:00,
 * tapering to 9 kW in the last hour as the pack approaches its 80% target.
 * 32 kWh in three hours, straight through the evening peak.
 */
const BASELINE_EV_KW: number[] = zeros();
BASELINE_EV_KW[17] = EV_CHARGER_KW;
BASELINE_EV_KW[18] = EV_CHARGER_KW;
BASELINE_EV_KW[19] = 9.0;

/** kWh the car takes in the baseline session. */
const EV_SESSION_KWH = round1(BASELINE_EV_KW.reduce((sum, kw) => sum + kw, 0));

/**
 * PV-to-battery priority (see the header): every watt the array makes is
 * stored until the pack is full, capped by the inverter. Returns the signed
 * battery series -- negative is charging, which is the only sign this house's
 * baseline battery ever takes.
 */
function pvPriorityCharge(solar: number[], startPct: number, capacityKwh: number): number[] {
  const out = zeros();
  let soc = startPct;
  for (let h = 0; h < HOURS; h += 1) {
    const headroomKwh = ((100 - soc) / 100) * capacityKwh;
    const charge = Math.min(solar[h], headroomKwh, RESIDENCE_BUILDING.battery_max_kw);
    // Below 0.05 kW the published value would round to zero anyway.
    out[h] = charge < 0.05 ? 0 : round1(-charge);
    soc = round1(soc - (out[h] / capacityKwh) * 100);
  }
  return out;
}

const BASELINE_BATTERY_KW = pvPriorityCharge(
  SOLAR_KW,
  START_SOC_PCT,
  RESIDENCE_BUILDING.battery_capacity_kwh,
);

const BASELINE_PARTS: FlowComponents = {
  base: BASE_KW,
  ev: BASELINE_EV_KW,
  hvac: HVAC_KW,
  solar: SOLAR_KW,
  battery: BASELINE_BATTERY_KW,
  soc: socWalk(BASELINE_BATTERY_KW, START_SOC_PCT, RESIDENCE_BUILDING.battery_capacity_kwh),
};

/** Component-first: the published curve is derived, never authored. */
export const BASELINE_GRID_KW: number[] = gridFromComponents(BASELINE_PARTS);

/* -------------------------------------------------------------------------- */
/* Optimized components                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Action 1. The engine does not park the whole session in one block. It leaves
 * 17:00 on the charger at full rate -- the pack covers that hour instead --
 * trims 18:00 and 19:00 hard, and puts the rest back from 20:00 on, finishing
 * with a full-rate hour at 22:00. Signed kW against the baseline session, so
 * the deltas cancel and the car still takes its whole charge.
 */
const EV_DELTA_KW: Record<number, number> = {
  18: -7.5,
  19: -7.2,
  20: +1.5,
  21: +1.7,
  22: +11.5,
};
const OPTIMIZED_EV_KW = BASELINE_EV_KW.map((kw, h) => round1(kw + (EV_DELTA_KW[h] ?? 0)));

/** kWh of the session still inside the 17:00-20:00 evening window. */
const EV_EVENING_KWH = round1(
  OPTIMIZED_EV_KW.slice(17, 20).reduce((sum, kw) => sum + kw, 0),
);
/** kWh the plan moves out of the evening and into the late-night hours. */
const EV_SHIFTED_KWH = round1(EV_SESSION_KWH - EV_EVENING_KWH);
/** The largest single hour the shift empties. It is 17:00, not the 18:00 peak. */
const EV_PEAK_CUT_KW = round1(
  Math.max(...BASELINE_EV_KW.map((kw, h) => kw - OPTIMIZED_EV_KW[h])),
);
/** Day-ahead energy the shift moves off the on-peak rate. */
const EV_SHIFT_SAVINGS_USD = round2(energyCost(BASELINE_EV_KW) - energyCost(OPTIMIZED_EV_KW));

/**
 * Action 2. The pack no longer holds one flat rate. The engine varies it hour
 * by hour: an overnight charge off the $0.09 rate, the part of the midday
 * surplus that fits, and then discharges into the two hours the charger runs
 * flat out -- 17:00 and 22:00. Signed, so negative is charging.
 *
 * 18.2 kWh in for 16.3 kWh out. On a 27 kWh pack the 95% round trip costs
 * nearly two kilowatt-hours, which on this site is not a rounding error: it is
 * most of the difference between the plan saving money and merely moving it.
 */
const BATTERY_DISPATCH_KW: Record<number, number> = {
  0: -4.1,
  1: -1.3,
  8: -3.0,
  9: -2.9,
  10: -2.8,
  17: +7.7,
  18: +1.2,
  22: +7.4,
  23: -4.1,
};
const OPTIMIZED_BATTERY_KW = zeros().map((kw, h) => round1(kw + (BATTERY_DISPATCH_KW[h] ?? 0)));

/** State of charge as the engine solved it. See the note on OPTIMIZED_PARTS. */
const OPTIMIZED_SOC = [
  65, 69.5, 69.5, 69.5, 69.5, 69.5, 69.5, 69.5, 80, 90.2, 100, 100, 100, 100,
  100, 100, 100, 69.9, 65.1, 65.1, 65.1, 65.1, 36.2, 50.6,
];

/**
 * Action 3. The solver returned no setpoint change. With the pack under the
 * 18:00 hour the heat pump cannot move the binding interval, so the optimized
 * HVAC curve is the baseline one and the float to 76 F is carried as a
 * permission the household may take rather than a load the plan leans on.
 */
const HVAC_DELTA_KW: Record<number, number> = {};
/** Empty under the solver, so this collapses to a zero-length window and
  * makeFixture drops the row. The heuristic does move the setpoint, and then
  * the window is real and the row appears with the text below. */
const [HVAC_START_HOUR, HVAC_END_HOUR] = actionWindow(HVAC_DELTA_KW);
const OPTIMIZED_HVAC_KW = HVAC_KW.map((kw, h) => round1(kw + (HVAC_DELTA_KW[h] ?? 0)));

const OPTIMIZED_PARTS: FlowComponents = {
  base: BASE_KW,
  ev: OPTIMIZED_EV_KW,
  hvac: OPTIMIZED_HVAC_KW,
  solar: SOLAR_KW,
  battery: OPTIMIZED_BATTERY_KW,
  // The engine's own series, not a walk of the dispatch above. On a 27 kWh
  // pack the 95%-each-way round trip is worth several points of SOC an hour,
  // so a lossless walk reads 102.8% at midday on a plan the engine capped at
  // 100%. Transcribed, and checked against the backend by verify-fixtures.
  soc: OPTIMIZED_SOC,
};

export const OPTIMIZED_GRID_KW: number[] = gridFromComponents(OPTIMIZED_PARTS);

/**
 * kWh that would have to be pushed back into the pack outside the modelled
 * window, billed at the $0.09 overnight rate. The solver's dispatch is
 * energy-neutral across the day -- every kWh it discharges it has already
 * bought inside the window -- so the pack ends where it started and there is
 * nothing left to buy back. Derived, not asserted: give the pack an unbalanced
 * schedule and this figure comes back on its own.
 */
export const BATTERY_RECHARGE_KWH = round1(
  Math.max(
    0,
    ((START_SOC_PCT - OPTIMIZED_PARTS.soc[HOURS - 1]) / 100) *
      RESIDENCE_BUILDING.battery_capacity_kwh,
  ),
);

/* -------------------------------------------------------------------------- */
/* Headline numbers                                                            */
/* -------------------------------------------------------------------------- */

const BASELINE_PEAK_KW = Math.max(...BASELINE_GRID_KW);
const BASELINE_PEAK_HOUR = BASELINE_GRID_KW.indexOf(BASELINE_PEAK_KW);
const OPTIMIZED_PEAK_KW = Math.max(...OPTIMIZED_GRID_KW);
const OPTIMIZED_PEAK_HOUR = OPTIMIZED_GRID_KW.indexOf(OPTIMIZED_PEAK_KW);
const PEAK_REDUCTION_KW = round1(BASELINE_PEAK_KW - OPTIMIZED_PEAK_KW);
const HOURS_OVER_CAP = BASELINE_GRID_KW.filter(
  (kw) => kw > RESIDENCE_BUILDING.peak_threshold_kw,
).length;
const CAP_HEADROOM_KW = round1(RESIDENCE_BUILDING.peak_threshold_kw - OPTIMIZED_PEAK_KW);
const BASELINE_COST_USD = round2(energyCost(BASELINE_GRID_KW));
const OPTIMIZED_COST_USD = round2(energyCost(OPTIMIZED_GRID_KW) + BATTERY_RECHARGE_KWH * 0.09);
const SAVINGS_USD = round2(BASELINE_COST_USD - OPTIMIZED_COST_USD);
/** The demand-response penalty the 9 kW cap carries, at $8.50/kW. */
const PENALTY_AVOIDED_USD = round2(PEAK_REDUCTION_KW * 8.5);
const MONTHLY_ENERGY_USD = round2(SAVINGS_USD * 30);
const DISPATCHABLE_KWH = round1(
  ((99.9 - RESERVE_FLOOR_PCT) / 100) * RESIDENCE_BUILDING.battery_capacity_kwh,
);
const END_SOC_PCT = OPTIMIZED_PARTS.soc[HOURS - 1];
const MIN_SOC_PCT = Math.min(...OPTIMIZED_PARTS.soc);
/** kWh the pack puts on the meter across the day. */
const BATTERY_DISPATCHED_KWH = round1(
  OPTIMIZED_BATTERY_KW.reduce((sum, kw) => sum + Math.max(0, kw), 0),
);
/** The hours the pack pushes out, in order. */
const DISCHARGE_HOURS = OPTIMIZED_BATTERY_KW.map((kw, h) => (kw > 0 ? h : -1)).filter(
  (h) => h >= 0,
);
const DISCHARGE_START_HOUR = DISCHARGE_HOURS[0];
const DISCHARGE_END_HOUR = DISCHARGE_HOURS[DISCHARGE_HOURS.length - 1] + 1;
/** The two hours that matter: the evening peak, and the late full-rate hour. */
const PEAK_DISCHARGE_KW = Math.max(...OPTIMIZED_BATTERY_KW);
const PEAK_DISCHARGE_HOUR = OPTIMIZED_BATTERY_KW.indexOf(PEAK_DISCHARGE_KW);
const LATE_DISCHARGE_HOUR = DISCHARGE_HOURS[DISCHARGE_HOURS.length - 1];
const LATE_DISCHARGE_KW = OPTIMIZED_BATTERY_KW[LATE_DISCHARGE_HOUR];
/** kWh the pack takes in, which is more than it gives back. */
const BATTERY_CHARGED_KWH = round1(
  OPTIMIZED_BATTERY_KW.reduce((sum, kw) => sum + Math.max(0, -kw), 0),
);
/** What each covered hour would read with the pack idle. */
const uncovered = (h: number): number => round1(OPTIMIZED_GRID_KW[h] + OPTIMIZED_BATTERY_KW[h]);
/** What the battery takes out of the interval that sets the baseline peak. */
const BATTERY_PEAK_CUT_KW = round1(OPTIMIZED_BATTERY_KW[BASELINE_PEAK_HOUR]);
/** Same rule the backend applies: the hours the lever actually moves. */
const [EV_START_HOUR, EV_END_HOUR] = actionWindow(EV_DELTA_KW);
/** kWh the pack takes from the midday surplus the house would otherwise export. */
const BATTERY_SOLAR_CHARGE_KWH = round1(
  OPTIMIZED_BATTERY_KW.reduce(
    (sum, kw, h) => sum + (SOLAR_KW[h] > 0 ? Math.max(0, -kw) : 0),
    0,
  ),
);
/** kWh the pack buys off the meter, all of it at the overnight rate. */
const BATTERY_GRID_CHARGE_KWH = round1(
  OPTIMIZED_BATTERY_KW.reduce(
    (sum, kw, h) => sum + (SOLAR_KW[h] > 0 ? 0 : Math.max(0, -kw)),
    0,
  ),
);
/** What the setpoint lever is worth at the interval that sets the peak. */
const HVAC_PEAK_CUT_KW = round1(
  HVAC_KW[BASELINE_PEAK_HOUR] - OPTIMIZED_HVAC_KW[BASELINE_PEAK_HOUR],
);
/**
 * What the scripted agent says it ran, and how long it took. Both transcribed
 * from a real solve: the payload used to claim "CP-SAT" and 912 ms, neither of
 * which has been true since the MIP engine became the default.
 */
const SOLVER_NAME = 'MIP (OR-Tools/SCIP)';
const SOLVE_TIME_MS = 41;

/** "04:00" -- clock label for an hour index. */
function hourLabel(h: number): string {
  return String(h).padStart(2, '0') + ':00';
}

/** 07:00 tomorrow: the hour the car has to be ready by. */
const EV_DEADLINE = '2025-09-19T07:00:00' + TZ_OFFSET;

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

export const PLAN_SUMMARY = [
  `This house sits under the utility's ${RESIDENCE_BUILDING.peak_threshold_kw} kW demand-response cap, and tonight it`,
  `breaks it: ${BASELINE_PEAK_KW} kW at 18:00 and ${HOURS_OVER_CAP} consecutive hours over the line, 17:00 to`,
  '20:00. The cause is not the house -- cooking, lights and the heat pump',
  `together come to about 4.4 kW -- it is that an ${EV_CHARGER_KW} kW car charger starts at`,
  '17:30 on top of all of it. Nothing has to be given up. The car is not driven',
  `until morning, so ${EV_SHIFTED_KWH} kWh of the ${EV_SESSION_KWH} kWh session moves past 19:00 and`,
  `the charger is cut to ${OPTIMIZED_EV_KW[18]} kW at 18:00 and ${OPTIMIZED_EV_KW[19]} kW at 19:00.`,
  `${hourLabel(PEAK_DISCHARGE_HOUR)} is the hour that cannot move -- the car has only just`,
  'plugged in and the house wants its full rate -- so the two wall batteries, full',
  `since 10:00 on today's own solar, carry it at ${PEAK_DISCHARGE_KW} kW, and they do the`,
  `same for ${hourLabel(LATE_DISCHARGE_HOUR)} at ${LATE_DISCHARGE_KW} kW when the session finishes at`,
  `full rate. The evening comes out perfectly flat: ${OPTIMIZED_PEAK_KW} kW every hour from`,
  `${hourLabel(PEAK_DISCHARGE_HOUR)} to midnight. Billing peak falls from ${BASELINE_PEAK_KW} kW to`,
  `${OPTIMIZED_PEAK_KW} kW, ${CAP_HEADROOM_KW} kW clear of the cap, avoiding about`,
  `$${PENALTY_AVOIDED_USD.toFixed(2)} of demand-response penalty on this month's bill; day-ahead`,
  `energy falls $${SAVINGS_USD.toFixed(2)}, roughly $${MONTHLY_ENERGY_USD.toFixed(2)} over a 30-day month. The pack`,
  `gives back ${BATTERY_DISPATCHED_KWH} kWh and takes ${BATTERY_CHARGED_KWH} kWh to do it -- the`,
  'gap is the round trip, and on a pack this small it is a real share of the',
  `saving rather than a rounding error. It still ends the night at ${END_SOC_PCT}% where`,
  `it started, well above the ${RESERVE_FLOOR_PCT}% the owner holds back for outages, so`,
  'nothing has to be bought back tomorrow. The car takes its full session and is',
  'finished by 23:00. The heat pump keeps its normal schedule: the only thing the',
  `plan asks of the household is permission to let the house float to`,
  `${COMFORT_BAND_F[1]} F between 17:00 and 19:00, which the optimizer priced and did not need.`,
].join(' ');

function buildActions(runId: string): Action[] {
  return [
    {
      id: 'act-ev-01',
      run_id: runId,
      type: 'ev_charging_shift',
      title: `Move ${EV_SHIFTED_KWH} kWh of the EV session past 22:00`,
      description: `Spread the ${EV_SESSION_KWH} kWh charge across the evening rather than slowing it down. The car plugs in at 17:30 but is not driven until the morning, so it has thirteen hours of slack against an 80%-by-07:00 target. ${EV_EVENING_KWH} kWh still lands between 17:00 and 20:00 -- the charger keeps its full ${EV_CHARGER_KW} kW at 17:00, where the pack covers it, and is cut to ${OPTIMIZED_EV_KW[18]} kW at 18:00 and ${OPTIMIZED_EV_KW[19]} kW at 19:00 so both those hours sit under the cap on their own. The remaining ${EV_SHIFTED_KWH} kWh runs from 20:00 to ${hourLabel(LATE_DISCHARGE_HOUR)}, on the $0.09 overnight rate instead of the $0.16 on-peak one. The ${EV_PEAK_CUT_KW} kW here is measured at ${hourLabel(BASELINE_PEAK_HOUR)}, the interval that sets the baseline peak. The session finishes an hour before midnight, eight hours before the deadline.`,
      start_time: isoHour(EV_START_HOUR),
      end_time: isoHour(EV_END_HOUR),
      magnitude: EV_PEAK_CUT_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: EV_PEAK_CUT_KW,
      estimated_savings_usd: EV_SHIFT_SAVINGS_USD,
      status: 'pending',
      constraints_checked: [
        'ev_target_soc_80pct_by_0700',
        'session_energy_conserved',
        'charger_limit_11_5kw',
        'demand_response_cap_9kw',
      ],
    },
    {
      id: 'act-battery-02',
      run_id: runId,
      type: 'battery_discharge',
      title: `Discharge the pack ${PEAK_DISCHARGE_KW} kW at ${hourLabel(PEAK_DISCHARGE_HOUR)} and ${LATE_DISCHARGE_KW} kW at ${hourLabel(LATE_DISCHARGE_HOUR)}`,
      description: `Put storage under the two hours the charger runs flat out. Action 1 does not empty ${hourLabel(PEAK_DISCHARGE_HOUR)}: the car has just plugged in and takes its full ${EV_CHARGER_KW} kW, and without this action that hour reads ${uncovered(PEAK_DISCHARGE_HOUR)} kW. ${hourLabel(LATE_DISCHARGE_HOUR)} is the same shape at the other end of the session -- ${uncovered(LATE_DISCHARGE_HOUR)} kW on an idle pack. Covering both brings each of them to ${OPTIMIZED_PEAK_KW} kW. Measured at the ${hourLabel(BASELINE_PEAK_HOUR)} baseline peak this action is worth ${BATTERY_PEAK_CUT_KW} kW, which understates it: the two hours it does carry are the ones that would otherwise set the new peak. ${BATTERY_DISPATCHED_KWH} kWh leaves a pack that is full by 10:00, the largest rate is inside the ${RESIDENCE_BUILDING.battery_max_kw} kW inverter rating, and state of charge never drops below ${MIN_SOC_PCT}%, well clear of the ${RESERVE_FLOOR_PCT}% outage reserve. Putting it back takes ${BATTERY_CHARGED_KWH} kWh, not ${BATTERY_DISPATCHED_KWH}: ${BATTERY_SOLAR_CHARGE_KWH} kWh from midday surplus the house would otherwise export and ${BATTERY_GRID_CHARGE_KWH} kWh off the meter at $0.09, with the difference lost to the 95% round trip each way. What this action is for is the cap, not the tariff.`,
      start_time: isoHour(DISCHARGE_START_HOUR),
      end_time: isoHour(DISCHARGE_END_HOUR),
      magnitude: PEAK_DISCHARGE_KW,
      unit: 'kW',
      estimated_peak_reduction_kw: BATTERY_PEAK_CUT_KW,
      estimated_savings_usd: 0,
      status: 'pending',
      constraints_checked: [
        'soc_reserve_floor_20pct',
        'max_discharge_10kw',
        'single_cycle_per_day',
        'charge_balanced_within_day',
      ],
    },
    {
      id: 'act-hvac-03',
      run_id: runId,
      type: 'hvac_setpoint',
      title: `Allow the house to float to ${COMFORT_BAND_F[1]}°F from 17:00 to 19:00`,
      description: `Let the house drift from 72°F to ${COMFORT_BAND_F[1]}°F across the two evening hours, capped at the permitted two hours and inside the ${COMFORT_BAND_F[0]}-${COMFORT_BAND_F[1]}°F occupied band. The optimizer priced this one and did not build the schedule around it: with the pack already under 18:00 the heat pump cannot move the interval that sets the peak, so it is worth ${HVAC_PEAK_CUT_KW} kW there and the plan's flows show the heat pump on its normal schedule all evening. It is carried because it costs the household nothing to accept and is worth about $0.10 of energy if they do, and because it is the only action anyone in the house would feel, which is why the plan is routed for approval rather than dispatched.`,
      start_time: isoHour(HVAC_START_HOUR),
      end_time: isoHour(HVAC_END_HOUR),
      magnitude: 4,
      unit: '°F',
      estimated_peak_reduction_kw: HVAC_PEAK_CUT_KW,
      estimated_savings_usd: 0.1,
      status: 'pending',
      constraints_checked: [
        'occupied_comfort_band_70_76f',
        'max_drift_duration_2h',
        'drift_starts_after_1700',
        'zone_temp_max_76f',
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Agent script                                                                */
/* -------------------------------------------------------------------------- */

export const RESIDENCE_SCRIPT = scheduleScript([
  {
    type: 'thinking',
    tool_name: null,
    message:
      'Run started. This site is a house, so the peak is almost certainly one appliance rather than a load shape -- at this scale a single wall charger is bigger than everything else in the building put together. I want to confirm that before I go looking for anything subtle.',
    payload: null,
    duration_ms: 820,
  },
  {
    type: 'tool_call',
    tool_name: 'get_energy_forecast',
    message: 'get_energy_forecast(building_id="' + RESIDENCE_ID + '", horizon_hours=24)',
    payload: { building_id: RESIDENCE_ID, horizon_hours: 24 },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'get_energy_forecast',
    message: `Peak confirmed: ${BASELINE_PEAK_KW} kW at 18:00, ${round1(BASELINE_PEAK_KW - RESIDENCE_BUILDING.peak_threshold_kw)} kW over the ${RESIDENCE_BUILDING.peak_threshold_kw} kW cap and over it for ${HOURS_OVER_CAP} consecutive hours from 17:00. The rest of the day never clears 2 kW, and between 11:00 and 17:00 the house is a net exporter -- it runs to ${Math.min(...BASELINE_GRID_KW)} kW at noon. This is one evening event, not a load problem.`,
    payload: {
      peak_kw: BASELINE_PEAK_KW,
      peak_time: isoHour(BASELINE_PEAK_HOUR),
      threshold_kw: RESIDENCE_BUILDING.peak_threshold_kw,
      hours_over_threshold: HOURS_OVER_CAP,
      first_exceedance: isoHour(17),
      midday_export_kw: Math.min(...BASELINE_GRID_KW),
    },
    duration_ms: 610,
  },
  {
    type: 'tool_result',
    tool_name: 'get_electricity_prices',
    message: `Tariff loaded, and the shape of this bill matters. Energy is $0.09/kWh off-peak and $0.16/kWh from 14:00 to 20:00, but the household is enrolled in demand response: every kW the meter goes over ${RESIDENCE_BUILDING.peak_threshold_kw} kW in a month carries an $8.50 penalty. At this scale the penalty is worth far more than the energy, so the objective is the cap, not the kWh.`,
    payload: {
      off_peak_usd_per_kwh: 0.09,
      on_peak_usd_per_kwh: 0.16,
      on_peak_window: '14:00-20:00',
      demand_response_cap_kw: RESIDENCE_BUILDING.peak_threshold_kw,
      penalty_usd_per_kw: 8.5,
    },
    duration_ms: 240,
  },
  {
    type: 'tool_result',
    tool_name: 'get_battery_state',
    message: `Two wall units, ${RESIDENCE_BUILDING.battery_capacity_kwh} kWh together behind a ${RESIDENCE_BUILDING.battery_max_kw} kW inverter, and they are at ${BASELINE_PARTS.soc[NOW_HOUR]}% at 10:00 -- the inverter fills the pack from PV before it serves the house, so today's own array has done this. It tops out at 11:00 and then sits idle all afternoon. The owner holds a ${RESERVE_FLOOR_PCT}% reserve for outages, which still leaves ${DISPATCHABLE_KWH} kWh I can genuinely move.`,
    payload: {
      soc_pct: BASELINE_PARTS.soc[NOW_HOUR],
      capacity_kwh: RESIDENCE_BUILDING.battery_capacity_kwh,
      units: 2,
      max_discharge_kw: RESIDENCE_BUILDING.battery_max_kw,
      reserve_floor_pct: RESERVE_FLOOR_PCT,
      dispatchable_kwh: DISPATCHABLE_KWH,
      full_at: isoHour(11),
    },
    duration_ms: 210,
  },
  {
    type: 'tool_result',
    tool_name: 'get_ev_requirements',
    message: `One bay, one car, and a great deal of slack. It plugs in at 17:30 wanting ${EV_SESSION_KWH} kWh to reach 80%, the charger does ${EV_CHARGER_KW} kW, and the owner's only stated requirement is 80% by 07:00. That is a three-hour job with thirteen hours to do it in -- the deadline is not the constraint here, the start time is.`,
    payload: {
      sessions_connected: 1,
      flexible_sessions: 1,
      locked_sessions: 0,
      charger_power_kw: EV_CHARGER_KW,
      energy_required_kwh: EV_SESSION_KWH,
      target_soc_pct: 80,
      deadline: EV_DEADLINE,
      plug_in_time: '2025-09-18T17:30:00' + TZ_OFFSET,
      slack_hours: 13,
    },
    duration_ms: 260,
  },
  {
    type: 'tool_result',
    tool_name: 'get_hvac_constraints',
    message: `One heat pump, ${RESIDENCE_BUILDING.hvac_zones} zones, 72°F setpoint, and a ${COMFORT_BAND_F[0]}-${COMFORT_BAND_F[1]}°F occupied band with two hours of permitted drift. It is flat out at 1.8 kW from 14:00 to 19:00 against an 80°F afternoon. Small next to the charger, but a house has real thermal mass and the 14:00-16:00 solar is being exported for nothing, so pre-cooling is genuinely free here rather than merely cheap.`,
    payload: {
      zones: RESIDENCE_BUILDING.hvac_zones,
      current_setpoint_f: 72,
      occupied_band_f: COMFORT_BAND_F,
      max_drift_hours: 2,
      min_precool_setpoint_f: COMFORT_BAND_F[0],
      peak_draw_kw: 1.8,
    },
    duration_ms: 230,
  },
  {
    type: 'thinking',
    tool_name: null,
    message: `One ${EV_CHARGER_KW} kW load with thirteen hours of slack, against a ${RESIDENCE_BUILDING.peak_threshold_kw} kW cap. Moving it is obvious -- but moving it in one block is not sufficient: park the whole session in any single late hour and the meter reads over ${uncovered(LATE_DISCHARGE_HOUR)} kW there, and I have relocated the violation rather than removed it. The pack is full and idle from 10:00, so the right shape is to spread the session across the hours that have room and put storage under the hours that do not. I will hand the optimizer all three resources and let it place them.`,
    payload: null,
    duration_ms: 1040,
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
      hard_constraint: 'peak_kw <= ' + RESIDENCE_BUILDING.peak_threshold_kw,
      solver: SOLVER_NAME,
    },
    duration_ms: null,
  },
  {
    type: 'tool_result',
    tool_name: 'run_schedule_optimizer',
    message: `Solver returned an optimal schedule in ${SOLVE_TIME_MS} ms. Peak drops from ${BASELINE_PEAK_KW} kW to ${OPTIMIZED_PEAK_KW} kW, a cut of ${PEAK_REDUCTION_KW} kW, and the binding interval moves out of the evening entirely: it is now ${hourLabel(OPTIMIZED_PEAK_HOUR)}, where the pack takes its overnight charge. It did not empty ${hourLabel(PEAK_DISCHARGE_HOUR)} -- the car draws its full ${EV_CHARGER_KW} kW there and the battery covers it at ${PEAK_DISCHARGE_KW} kW -- it cut the charger at ${hourLabel(BASELINE_PEAK_HOUR)} instead and flattened everything after: ${OPTIMIZED_PEAK_KW} kW every hour from ${hourLabel(PEAK_DISCHARGE_HOUR)} to midnight, with ${CAP_HEADROOM_KW} kW of headroom under the cap.`,
    payload: {
      status: 'OPTIMAL',
      solver: SOLVER_NAME,
      solve_time_ms: SOLVE_TIME_MS,
      baseline_peak_kw: BASELINE_PEAK_KW,
      optimized_peak_kw: OPTIMIZED_PEAK_KW,
      peak_reduction_kw: PEAK_REDUCTION_KW,
      binding_interval: isoHour(OPTIMIZED_PEAK_HOUR),
      headroom_under_cap_kw: CAP_HEADROOM_KW,
    },
    duration_ms: SOLVE_TIME_MS,
  },
  {
    type: 'tool_result',
    tool_name: 'validate_schedule',
    message: `All 11 constraints pass. The meter never exceeds ${OPTIMIZED_PEAK_KW} kW, so the cap holds with ${CAP_HEADROOM_KW} kW to spare. The pack bottoms out at ${MIN_SOC_PCT}% and ends the night back at ${END_SOC_PCT}%, where it started and comfortably above the ${RESERVE_FLOOR_PCT}% outage reserve; its largest rate is ${PEAK_DISCHARGE_KW} kW against a ${RESIDENCE_BUILDING.battery_max_kw} kW inverter. The car takes its full ${EV_SESSION_KWH} kWh and is finished by ${hourLabel(LATE_DISCHARGE_HOUR + 1)}, eight hours before the 07:00 deadline. The heat pump keeps its normal schedule, so the ${COMFORT_BAND_F[1]}°F float is not being asked for at all.`,
    payload: {
      constraints_checked: 11,
      violations: 0,
      max_meter_kw: OPTIMIZED_PEAK_KW,
      battery_end_soc_pct: END_SOC_PCT,
      battery_min_soc_pct: MIN_SOC_PCT,
      ev_target_met_at: isoHour(LATE_DISCHARGE_HOUR + 1),
      hvac_band_f: COMFORT_BAND_F,
      hvac_schedule_changed: false,
    },
    duration_ms: 160,
  },
  {
    type: 'decision',
    tool_name: 'save_action_plan',
    message: `Committing a two-action plan: move ${EV_SHIFTED_KWH} kWh of the charging session past 19:00, and discharge the pack ${PEAK_DISCHARGE_KW} kW at ${hourLabel(PEAK_DISCHARGE_HOUR)} and ${LATE_DISCHARGE_KW} kW at ${hourLabel(LATE_DISCHARGE_HOUR)} to cover the two hours the charger runs flat out. The ${COMFORT_BAND_F[1]}°F evening float was priced and not needed, so the household is not asked for it and the row is dropped. Worth about $${PENALTY_AVOIDED_USD.toFixed(2)} of avoided demand-response penalty this month.`,
    payload: {
      action_count: 2,
      plan_savings_usd: SAVINGS_USD,
      penalty_avoided_usd: PENALTY_AVOIDED_USD,
    },
    duration_ms: 130,
  },
  {
    type: 'tool_call',
    tool_name: 'request_human_approval',
    message:
      'Neither action touches comfort -- the 76°F float was priced and not needed, so the household is never asked for it -- but deciding when somebody else’s car charges is still not mine to decide. Sending both to the owner.',
    payload: { requires_approval: true, action_count: 2, approvers: ['homeowner'] },
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
      demand_charge_avoided_usd: PENALTY_AVOIDED_USD,
    },
    duration_ms: null,
  },
]);

/* -------------------------------------------------------------------------- */

export const residenceFixture = makeFixture({
  building: RESIDENCE_BUILDING,
  baselineGrid: BASELINE_GRID_KW,
  baselineParts: BASELINE_PARTS,
  optimizedParts: OPTIMIZED_PARTS,
  actualLoadKw: meteredActuals(BASELINE_GRID_KW, NOW_HOUR),
  batteryRechargeKwh: BATTERY_RECHARGE_KWH,
  summary: {
    current_load_kw: BASELINE_GRID_KW[NOW_HOUR],
    battery_soc_pct: BASELINE_PARTS.soc[NOW_HOUR],
    solar_generation_kw: SOLAR_KW[NOW_HOUR],
    ev_connected: 0,
    hvac_setpoint_f: 72,
    outdoor_temp_f: 68,
  },
  planSummary: PLAN_SUMMARY,
  buildActions,
  script: RESIDENCE_SCRIPT,
});
