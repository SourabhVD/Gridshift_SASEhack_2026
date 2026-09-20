"""
sea-residence-004 -- Alder Street Residence. The scale test.

Ported from frontend/src/mocks/buildings/residence.ts.

The only site whose threshold is not a commercial demand charge but a
residential demand-response cap: the utility pays the household to stay under
9 kW and bills a penalty for every kW over it. Everything here is one to two
orders of magnitude below the other three sites, which is the point -- the same
contract, the same flow identity and the same agent loop have to read correctly
at 0.6 kW as well as at 884 kW.

Two modelling notes, because both are load-bearing:

  1. PV-to-battery priority. The hybrid inverter fills the pack before it
     serves the house, so from first light until the pack is full the whole
     array goes to storage and the house rides the meter.
  2. Net export. 27 kWh of storage cannot swallow a 50 kWh solar day. The pack
     is full at 11:00 and from then until 17:00 the surplus leaves the
     property: grid_kw goes negative, bottoming out around -4 kW. This is the
     only fixture that exercises the negative half of the contract.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .generator import (
    HOURS,
    NOW_HOUR,
    FlowComponents,
    iso_hour,
    iso_minute,
    metered_actuals,
    next_day_iso,
    pv_priority_charge,
    round1,
    round2,
    soc_walk,
    zeros,
)
from .spec import BuildingFixture, DispatchPolicy, Step

if TYPE_CHECKING:  # pragma: no cover
    from ..services.optimizer import OptimizationResult

RESIDENCE_ID = "sea-residence-004"

BUILDING: dict[str, Any] = {
    "id": RESIDENCE_ID,
    "name": "Alder Street Residence",
    "type": "residence",
    "address": "1418 E Alder Street, Seattle, WA 98122",
    "floors": 2,
    "area_sqft": 2_400,
    "peak_threshold_kw": 9,
    "battery_capacity_kwh": 27,
    "battery_max_kw": 10,
    "ev_bays": 1,
    "solar_capacity_kw": 8.2,
    "hvac_zones": 2,
}

#: Contractual floor on the pack: the owner keeps it back for outages.
RESERVE_FLOOR_PCT = 20
#: Where the pack sits at 00:00, after last night's evening draw.
START_SOC_PCT = 50.6
#: The wall charger. One bay, one car.
EV_CHARGER_KW = 11.5
#: Occupied comfort band the heat pump may float inside.
COMFORT_BAND_F = [70, 76]

# --------------------------------------------------------------------------- #
# Baseline components                                                          #
# --------------------------------------------------------------------------- #

#: Fridge, standby, lighting, and from 17:00 the cooking-and-lights block.
BASE_KW: list[float] = (
    [0.4] * 6          # 00-05 asleep
    + [1.2] * 5        # 06-10 breakfast, showers, laundry
    + [0.8] * 6        # 11-16 empty house
    + [2.6] * 5        # 17-21 cooking, lights, everyone home
    + [0.4] * 2        # 22-23 back down
)

#: Single heat pump, two zones, climbing with the outdoor temperature.
HVAC_KW: list[float] = [
    0.2, 0.2, 0.2, 0.2, 0.2, 0.2,     # 00-05
    0.3, 0.4, 0.5, 0.6, 0.7,          # 06-10
    0.9, 1.1, 1.4,                    # 11-13 ramping with the afternoon
    1.8, 1.8, 1.8, 1.8, 1.8,          # 14-18 flat out
    0.9, 0.6, 0.4, 0.2, 0.2,          # 19-23 coasting down
]

#: 8.2 kW array on a south-west gable: 6.1 kW at 13:00, dark by 20:00.
SOLAR_KW: list[float] = [
    0, 0, 0, 0, 0, 0,                 # 00-05
    0.1, 0.8, 2.2, 3.4, 4.4,          # 06-10
    5.3, 5.9, 6.1, 5.8, 5.2, 4.4,     # 11-16
    3.5, 2.5, 0.6,                    # 17-19
    0, 0, 0, 0,                       # 20-23
]

#: The car plugs in at 17:30 and pulls the full 11.5 kW through 17:00-20:00,
#: tapering to 9 kW in the last hour as the pack approaches its 80% target.
BASELINE_EV_KW: list[float] = zeros()
BASELINE_EV_KW[17] = EV_CHARGER_KW
BASELINE_EV_KW[18] = EV_CHARGER_KW
BASELINE_EV_KW[19] = 9.0

#: kWh the car takes in the baseline session.
EV_SESSION_KWH = round1(sum(BASELINE_EV_KW))

BASELINE_BATTERY_KW = pv_priority_charge(
    SOLAR_KW, START_SOC_PCT, BUILDING["battery_capacity_kwh"], BUILDING["battery_max_kw"]
)

BASELINE_PARTS = FlowComponents(
    base=BASE_KW,
    ev=BASELINE_EV_KW,
    hvac=HVAC_KW,
    solar=SOLAR_KW,
    battery=BASELINE_BATTERY_KW,
    soc=soc_walk(BASELINE_BATTERY_KW, START_SOC_PCT, BUILDING["battery_capacity_kwh"]),
)

#: Component-first: the published curve is derived, never authored.
BASELINE_GRID_KW: list[float] = [
    round1(
        BASE_KW[h] + BASELINE_EV_KW[h] + HVAC_KW[h] - SOLAR_KW[h] - BASELINE_BATTERY_KW[h]
    )
    for h in range(HOURS)
]

# --------------------------------------------------------------------------- #
# Dispatch policy                                                              #
# --------------------------------------------------------------------------- #

EVENING_DISCHARGE_KW = 8.0
#: kWh of the shifted session that lands after midnight, outside this window.
EV_KWH_AFTER_MIDNIGHT = round1(EV_SESSION_KWH - 2 * EV_CHARGER_KW)

POLICY = DispatchPolicy(
    #: The pack empties into the car for the two in-window hours, so the meter
    #: never sees the wall charger at full tilt.
    battery_discharge_kw={22: EVENING_DISCHARGE_KW, 23: EVENING_DISCHARGE_KW},
    #: The whole session moves to 22:00-02:00.
    ev_delta_kw={
        17: -EV_CHARGER_KW,
        18: -EV_CHARGER_KW,
        19: -9.0,
        22: EV_CHARGER_KW,
        23: EV_CHARGER_KW,
    },
    ev_kwh_after_window=EV_KWH_AFTER_MIDNIGHT,
    #: Pre-cool on the 14:00-16:00 surplus, then float to 76F for the evening.
    hvac_delta_kw={14: 0.6, 15: 0.6, 17: -0.9, 18: -0.9},
)

#: What 22:00 would read if the session moved but the pack stayed idle.
UNSHAVED_2200_KW = round1(BASE_KW[22] + EV_CHARGER_KW + HVAC_KW[22] - SOLAR_KW[22])
#: The pack is full on today's own array by 11:00.
FULL_SOC_PCT = round1(BASELINE_PARTS.soc[21])
DISPATCHABLE_KWH = round1(((FULL_SOC_PCT - RESERVE_FLOOR_PCT) / 100) * BUILDING["battery_capacity_kwh"])

#: 02:00 tomorrow: the shifted charging session runs past midnight.
NEXT_MORNING_0200 = next_day_iso(2)
#: Midnight tonight: the end of the in-window battery dispatch.
MIDNIGHT = next_day_iso(0)
EV_DEADLINE = next_day_iso(7)

# --------------------------------------------------------------------------- #
# Device facts                                                                 #
# --------------------------------------------------------------------------- #

TOOL_FACTS: dict[str, dict[str, Any]] = {
    "get_electricity_prices": {
        "off_peak_usd_per_kwh": 0.09,
        "on_peak_usd_per_kwh": 0.16,
        "on_peak_window": "14:00-20:00",
        "demand_response_cap_kw": BUILDING["peak_threshold_kw"],
        "penalty_usd_per_kw": 8.5,
    },
    "get_battery_state": {
        "soc_pct": BASELINE_PARTS.soc[NOW_HOUR],
        "capacity_kwh": BUILDING["battery_capacity_kwh"],
        "units": 2,
        "max_discharge_kw": BUILDING["battery_max_kw"],
        "reserve_floor_pct": RESERVE_FLOOR_PCT,
        "dispatchable_kwh": DISPATCHABLE_KWH,
        "full_at": iso_hour(11),
    },
    "get_ev_requirements": {
        "sessions_connected": 1,
        "flexible_sessions": 1,
        "locked_sessions": 0,
        "charger_power_kw": EV_CHARGER_KW,
        "energy_required_kwh": EV_SESSION_KWH,
        "target_soc_pct": 80,
        "deadline": EV_DEADLINE,
        "plug_in_time": iso_minute(17, 30),
        "earliest_shift_hour": 22,
        "slack_hours": 13,
    },
    "get_hvac_constraints": {
        "zones": BUILDING["hvac_zones"],
        "current_setpoint_f": 72,
        "occupied_band_f": COMFORT_BAND_F,
        "max_drift_hours": 2,
        "min_precool_setpoint_f": COMFORT_BAND_F[0],
        "peak_draw_kw": 1.8,
    },
    "run_schedule_optimizer": {
        "objective": "minimize_peak_then_cost",
        "resources": ["battery", "ev", "hvac"],
        "hard_constraint": f"peak_kw <= {BUILDING['peak_threshold_kw']}",
        "solver": "CP-SAT",
        "solve_time_ms": 912,
    },
    "validate_schedule": {
        "constraints_checked": 11,
        "ev_target_met_at": iso_minute(0, 47, "2025-09-19"),
        "hvac_max_temp_f": COMFORT_BAND_F[1],
        "hvac_drift_hours": 2,
    },
    "request_human_approval": {"approvers": ["homeowner"]},
}


# --------------------------------------------------------------------------- #
# Plan                                                                         #
# --------------------------------------------------------------------------- #


def _cap_headroom(r: "OptimizationResult") -> float:
    return round1(r.threshold_kw - r.optimized_peak_kw)


def plan_summary(r: "OptimizationResult") -> str:
    monthly_energy_usd = round2(r.savings_usd * 30)
    return " ".join(
        [
            f"This house sits under the utility's {r.threshold_kw:.0f} kW demand-response",
            f"cap, and tonight it breaks it: {r.baseline_peak_kw} kW at",
            f"{r.baseline_peak_hour}:00 and {r.hours_over_threshold} consecutive hours over",
            "the line, 17:00 to 20:00. The cause is not the house -- cooking, lights and",
            "the heat pump together come to about 4.4 kW -- it is that an",
            f"{EV_CHARGER_KW} kW car charger starts at 17:30 on top of all of it. Nothing",
            "has to be given up. The car is not driven until morning, so the whole",
            f"{EV_SESSION_KWH} kWh session moves to 22:00, and the two wall batteries --",
            f"full since 11:00 on today's own solar -- discharge at",
            f"{r.battery_flat_kw} kW into it, so the meter reads {r.optimized_peak_kw} kW",
            f"when the car starts rather than {UNSHAVED_2200_KW} kW. Moving the session",
            "without the pack behind it would simply relocate the violation to 22:00. The",
            f"heat pump then pre-cools to {COMFORT_BAND_F[0]} F at 14:00 on solar the house",
            f"is exporting anyway and floats to {COMFORT_BAND_F[1]} F from 17:00 to 19:00,",
            "which is the only part of this anyone in the house can feel. Billing peak",
            f"falls from {r.baseline_peak_kw} kW to {r.optimized_peak_kw} kW,",
            f"{_cap_headroom(r)} kW clear of the cap, avoiding about",
            f"${r.demand_charge_avoided_usd:.2f} of demand-response penalty on this",
            f"month's bill; day-ahead energy falls ${r.savings_usd:.2f}, roughly",
            f"${monthly_energy_usd:.2f} over a 30-day month, even after paying to put the",
            f"{r.battery_recharge_kwh} kWh back into the pack. The pack still ends the",
            f"night at {r.end_soc_pct}%, twice the {r.reserve_floor_pct:.0f}% the owner",
            "holds back for outages, and the car is at 80% long before 07:00.",
        ]
    )


def build_actions(r: "OptimizationResult") -> list[dict[str, Any]]:
    return [
        {
            "type": "ev_charging_shift",
            "title": "Move the EV session to 22:00-02:00",
            "description": (
                f"Delay the whole {EV_SESSION_KWH} kWh charge rather than slowing it down. "
                "The car plugs in at 17:30 but is not driven until the morning, so it has "
                "thirteen hours of slack against an 80%-by-07:00 target. Starting at "
                f"22:00 on the charger's full {EV_CHARGER_KW} kW, "
                f"{round1(2 * EV_CHARGER_KW)} kWh lands tonight and the last "
                f"{EV_KWH_AFTER_MIDNIGHT} kWh finishes by 00:47. This single action takes "
                f"{EV_CHARGER_KW} kW straight out of the {r.baseline_peak_hour}:00 "
                "interval that sets the peak, and moves it from the $0.16 on-peak window "
                "to the $0.09 overnight rate."
            ),
            "start_time": iso_hour(22),
            "end_time": NEXT_MORNING_0200,
            "magnitude": EV_CHARGER_KW,
            "unit": "kW",
            "estimated_peak_reduction_kw": EV_CHARGER_KW,
            "estimated_savings_usd": 2.24,
            "constraints_checked": [
                "ev_target_soc_80pct_by_0700",
                "single_session_not_split",
                "charger_limit_11_5kw",
                "demand_response_cap_9kw",
            ],
        },
        {
            "type": "battery_discharge",
            "title": f"Discharge the pack at {r.battery_flat_kw} kW, 22:00-00:00",
            "description": (
                "Cover the shifted charging session out of storage. The kW figure here is "
                f"measured against the {r.optimized_peak_hour}:00 interval this action "
                "actually governs, not the 18:00 baseline peak -- action 1 has already "
                "emptied that hour, and without this one 22:00 would come in at "
                f"{UNSHAVED_2200_KW} kW and break the cap all over again. "
                f"{round1(r.battery_flat_kw * 2)} kWh out of a pack that today's array "
                f"left at {FULL_SOC_PCT}% ends the night at {r.end_soc_pct}%, well above "
                f"the {r.reserve_floor_pct:.0f}% outage reserve and inside the "
                f"{r.inverter_kw:.0f} kW inverter rating. Energy cost is a wash -- both "
                "the dispatch and the recharge are at the $0.09 overnight rate -- so this "
                "action exists purely to keep the meter under the cap."
            ),
            "start_time": iso_hour(22),
            "end_time": MIDNIGHT,
            "magnitude": r.battery_flat_kw,
            "unit": "kW",
            "estimated_peak_reduction_kw": r.battery_flat_kw,
            "estimated_savings_usd": 0,
            "constraints_checked": [
                "soc_reserve_floor_20pct",
                "max_discharge_10kw",
                "single_cycle_per_day",
                "solar_recharge_available_tomorrow",
            ],
        },
        {
            "type": "hvac_setpoint",
            "title": (
                f"Pre-cool to {COMFORT_BAND_F[0]}°F at 14:00, float to "
                f"{COMFORT_BAND_F[1]}°F for the evening"
            ),
            "description": (
                "Run the heat pump 0.6 kW harder from 14:00 to 16:00, when the array is "
                "exporting and the extra draw is free, to bank thermal mass in the slab "
                "and the walls. Then let the house drift from 72F to "
                f"{COMFORT_BAND_F[1]}F across 17:00-19:00, worth {r.hvac_shed_kw} kW in "
                "the two hours that matter. Drift is capped at the permitted two hours "
                f"and both ends stay inside the {COMFORT_BAND_F[0]}-{COMFORT_BAND_F[1]}F "
                "occupied band. This is the only action anyone in the house experiences, "
                "which is why the plan is routed for approval rather than dispatched."
            ),
            "start_time": iso_hour(17),
            "end_time": iso_hour(19),
            "magnitude": 4,
            "unit": "°F",
            "estimated_peak_reduction_kw": r.hvac_shed_kw,
            "estimated_savings_usd": 0.1,
            "constraints_checked": [
                "occupied_comfort_band_70_76f",
                "max_drift_duration_2h",
                "precool_min_setpoint_70f",
                "zone_temp_max_76f",
            ],
        },
    ]


# --------------------------------------------------------------------------- #
# Scripted run                                                                 #
# --------------------------------------------------------------------------- #


def build_script(r: "OptimizationResult") -> list[Step]:
    return [
        Step(
            type="thinking",
            message=(
                "Run started. This site is a house, so the peak is almost certainly one "
                "appliance rather than a load shape -- at this scale a single wall charger "
                "is bigger than everything else in the building put together. I want to "
                "confirm that before I go looking for anything subtle."
            ),
            delay_ms=800,
            duration_ms=820,
        ),
        Step(
            type="tool_call",
            tool="get_energy_forecast",
            message=f'get_energy_forecast(building_id="{RESIDENCE_ID}", horizon_hours=24)',
            payload={"building_id": RESIDENCE_ID, "horizon_hours": 24},
        ),
        Step(
            type="tool_result",
            tool="get_energy_forecast",
            invoke="get_energy_forecast",
            message=(
                f"Peak confirmed: {r.baseline_peak_kw} kW at {r.baseline_peak_hour}:00, "
                f"{round1(r.baseline_peak_kw - r.threshold_kw)} kW over the "
                f"{r.threshold_kw:.0f} kW cap and over it for {r.hours_over_threshold} "
                "consecutive hours from 17:00. The rest of the day never clears 2 kW, and "
                "between 11:00 and 17:00 the house is a net exporter -- it runs to "
                f"{r.min_grid_kw} kW at noon. This is one evening event, not a load "
                "problem."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_electricity_prices",
            invoke="get_electricity_prices",
            message=(
                "Tariff loaded, and the shape of this bill matters. Energy is $0.09/kWh "
                "off-peak and $0.16/kWh from 14:00 to 20:00, but the household is "
                "enrolled in demand response: every kW the meter goes over "
                f"{r.threshold_kw:.0f} kW in a month carries an $8.50 penalty. At this "
                "scale the penalty is worth far more than the energy, so the objective is "
                "the cap, not the kWh."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_battery_state",
            invoke="get_battery_state",
            message=(
                f"Two wall units, {BUILDING['battery_capacity_kwh']} kWh together behind a "
                f"{r.inverter_kw:.0f} kW inverter, and they are at "
                f"{BASELINE_PARTS.soc[NOW_HOUR]}% at 10:00 -- the inverter fills the pack "
                "from PV before it serves the house, so today's own array has done this. "
                "It tops out at 11:00 and then sits idle all afternoon. The owner holds a "
                f"{r.reserve_floor_pct:.0f}% reserve for outages, which still leaves "
                f"{r.dispatchable_kwh} kWh I can genuinely move."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_ev_requirements",
            invoke="get_ev_requirements",
            message=(
                "One bay, one car, and a great deal of slack. It plugs in at 17:30 wanting "
                f"{EV_SESSION_KWH} kWh to reach 80%, the charger does {EV_CHARGER_KW} kW, "
                "and the owner's only stated requirement is 80% by 07:00. That is a "
                "three-hour job with thirteen hours to do it in -- the deadline is not the "
                "constraint here, the start time is."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_hvac_constraints",
            invoke="get_hvac_constraints",
            message=(
                f"One heat pump, {BUILDING['hvac_zones']} zones, 72F setpoint, and a "
                f"{COMFORT_BAND_F[0]}-{COMFORT_BAND_F[1]}F occupied band with two hours of "
                "permitted drift. It is flat out at 1.8 kW from 14:00 to 19:00 against an "
                "80F afternoon. Small next to the charger, but a house has real thermal "
                "mass and the 14:00-16:00 solar is being exported for nothing, so "
                "pre-cooling is genuinely free here rather than merely cheap."
            ),
        ),
        Step(
            type="thinking",
            message=(
                f"One {EV_CHARGER_KW} kW load with thirteen hours of slack, against a "
                f"{r.threshold_kw:.0f} kW cap. Moving it is obvious -- but moving it is "
                "not sufficient: park the session at 22:00 untouched and the meter reads "
                f"{UNSHAVED_2200_KW} kW at 22:00 and I have relocated the violation rather "
                "than removed it. The pack is full and idle from 11:00, so the right shape "
                "is to move the session and then run it off storage. I will hand the "
                "optimizer all three resources and let it place them."
            ),
            duration_ms=1040,
        ),
        Step(
            type="tool_call",
            tool="run_schedule_optimizer",
            message=(
                'run_schedule_optimizer(objective="minimize_peak_then_cost", '
                'horizon_hours=24, resources=["battery","ev","hvac"])'
            ),
            payload={
                "objective": "minimize_peak_then_cost",
                "horizon_hours": 24,
                "resources": ["battery", "ev", "hvac"],
                "hard_constraint": f"peak_kw <= {BUILDING['peak_threshold_kw']}",
                "solver": "CP-SAT",
            },
            delay_ms=2400,
        ),
        Step(
            type="tool_result",
            tool="run_schedule_optimizer",
            invoke="run_schedule_optimizer",
            message=(
                f"Solver returned an optimal schedule in {r.solve_time_ms / 1000:.1f} s. "
                f"Peak drops from {r.baseline_peak_kw} kW to {r.optimized_peak_kw} kW, a "
                f"{r.peak_reduction_kw} kW cut, and the binding interval moves from "
                f"{r.baseline_peak_hour}:00 to {r.optimized_peak_hour}:00 -- the moment "
                "the car starts. That is also why the battery is scheduled at 22:00 "
                "rather than during the evening: with the session gone the house only "
                "draws 1.0 kW at 18:00, and discharging into that would export the pack "
                "for nothing."
            ),
            duration_ms=r.solve_time_ms,
        ),
        Step(
            type="tool_result",
            tool="validate_schedule",
            invoke="validate_schedule",
            message=(
                f"All 11 constraints pass. The meter never exceeds {r.optimized_peak_kw} "
                f"kW, so the cap holds with {_cap_headroom(r)} kW to spare. The pack ends "
                f"at {r.end_soc_pct}%, comfortably above the {r.reserve_floor_pct:.0f}% "
                "outage reserve. The car reaches 80% at 00:47, six hours before the 07:00 "
                f"deadline. Indoor temperature tops out at {COMFORT_BAND_F[1]}F for two "
                "hours and no longer."
            ),
        ),
        Step(
            type="decision",
            tool="save_action_plan",
            invoke="save_action_plan",
            message=(
                "Committing a three-action plan: move the charging session to 22:00, "
                f"discharge the pack at {r.battery_flat_kw} kW to cover it, and pre-cool "
                f"then float the setpoint between {COMFORT_BAND_F[0]}F and "
                f"{COMFORT_BAND_F[1]}F across the evening. Worth about "
                f"${r.demand_charge_avoided_usd:.2f} of avoided demand-response penalty "
                "this month."
            ),
        ),
        Step(
            type="tool_call",
            tool="request_human_approval",
            invoke="request_human_approval",
            message=(
                "Two of the three actions are invisible to the household, but letting the "
                "house run to 76F between 17:00 and 19:00 is not, and neither is deciding "
                "when somebody else's car charges. Sending all three to the owner."
            ),
            payload={"requires_approval": True, "action_count": 3, "approvers": ["homeowner"]},
        ),
        Step(
            type="complete",
            message=(
                "Investigation complete. Plan is ready for review; nothing will be "
                "dispatched until it is approved."
            ),
            payload={
                "peak_reduction_kw": r.peak_reduction_kw,
                "savings_usd": r.savings_usd,
                "demand_charge_avoided_usd": r.demand_charge_avoided_usd,
            },
        ),
    ]


FIXTURE = BuildingFixture(
    building=BUILDING,
    baseline_parts=BASELINE_PARTS,
    baseline_grid=BASELINE_GRID_KW,
    actual_load_kw=metered_actuals(BASELINE_GRID_KW, NOW_HOUR),
    summary_extras={
        "current_load_kw": BASELINE_GRID_KW[NOW_HOUR],
        "battery_soc_pct": BASELINE_PARTS.soc[NOW_HOUR],
        "solar_generation_kw": SOLAR_KW[NOW_HOUR],
        "ev_connected": 0,
        "hvac_setpoint_f": 72,
        "outdoor_temp_f": 68,
    },
    tool_facts=TOOL_FACTS,
    policy=POLICY,
    plan_summary=plan_summary,
    build_actions=build_actions,
    build_script=build_script,
    published={
        "baseline_peak_kw": 13.4,
        "optimized_peak_kw": 4.1,
        "peak_reduction_kw": 9.3,
        "action_count": 3,
    },
)
