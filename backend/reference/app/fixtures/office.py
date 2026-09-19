"""
sea-office-001 -- Cascade Commerce Center. The default building.

Ported from frontend/src/mocks/buildings/office.ts. The published curves are
unchanged; what was a hand-written optimized curve there is computed here by
services/optimizer.py from the dispatch policy at the bottom of this module,
and every number in the prose is formatted from that result.

How the optimized flows reconcile with the baseline:

    hour   battery    EV                    HVAC        net vs baseline
    11,12       0     -                     +24 / +18   +24 / +18  pre-cool
    13          0     -                     -22         -22        coasting
    14      +90 kW    69 -> 23 kW (-46)     -14         -150
    15      +90 kW    69 -> 23 kW (-46)     -18         -154
    16      +90 kW    -                     -            -90
    18,19       0     0 -> 46 kW (+46)      -           +46 / +46  shifted

base_kw is identical between the two curves, which is the point: no action in
this plan changes what the building actually needs, only when and from where
it is served.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .generator import (
    NOW_HOUR,
    FlowComponents,
    HvacShareSpec,
    base_from_grid,
    flat,
    hour_range,
    hvac_profile,
    iso_hour,
    with_hours,
    zeros,
)
from .spec import BuildingFixture, DispatchPolicy, Step

if TYPE_CHECKING:  # pragma: no cover
    from ..services.optimizer import OptimizationResult

OFFICE_ID = "sea-office-001"

BUILDING: dict[str, Any] = {
    "id": OFFICE_ID,
    "name": "Cascade Commerce Center",
    "type": "office",
    "address": "1200 4th Avenue, Seattle, WA 98101",
    "floors": 12,
    "area_sqft": 150_000,
    "peak_threshold_kw": 450,
    "battery_capacity_kwh": 500,
    "battery_max_kw": 250,
    "ev_bays": 6,
    "solar_capacity_kw": 75,
    "hvac_zones": 18,
}

# --------------------------------------------------------------------------- #
# Published curves                                                             #
# --------------------------------------------------------------------------- #

#: ML forecast. Peak 522 kW at 15:00; over 450 kW for 13:00-17:00 (4 hours).
BASELINE_LOAD_KW: list[float] = [
    182, 178, 174, 172, 176, 188, 221, 274, 328, 372, 396, 404,
    418, 458, 496, 522, 511, 436, 392, 338, 286, 243, 210, 191,
]

#: Metered load. None from NOW_HOUR onward.
ACTUAL_LOAD_KW: list[float | None] = [
    179.4, 176.8, 173.2, 171.9, 175.5, 187.3, 219.6, 271.4, 326.8, 384.2,
] + [None] * 14

#: Rooftop PV. Clear September day, ~60 kW at solar noon on a 75 kW array.
SOLAR_KW: list[float] = [
    0, 0, 0, 0, 0, 0, 3.2, 11.5, 24.8, 38.6, 49.2, 56.8,
    60.4, 58.1, 51.3, 40.7, 27.4, 14.2, 4.6, 0, 0, 0, 0, 0,
]

#: Six bays at 11.5 kW share a 69 kW site allocation, 09:00-16:00.
EV_CHARGER_KW = 11.5
BASELINE_EV = with_hours(zeros(), hour_range(9, 16), 6 * EV_CHARGER_KW)

BASELINE_HVAC = hvac_profile(
    BASELINE_LOAD_KW,
    HvacShareSpec(night=0.15, day_min=0.25, day_max=0.35, day_start=6, day_end=21),
)

BASELINE_PARTS = FlowComponents(
    base=base_from_grid(
        BASELINE_LOAD_KW, ev=BASELINE_EV, hvac=BASELINE_HVAC, solar=SOLAR_KW, battery=zeros()
    ),
    ev=BASELINE_EV,
    hvac=BASELINE_HVAC,
    solar=SOLAR_KW,
    battery=zeros(),
    soc=flat(82),
)

# --------------------------------------------------------------------------- #
# Device facts -- what the five read-only tools report                         #
# --------------------------------------------------------------------------- #

TOOL_FACTS: dict[str, dict[str, Any]] = {
    "get_electricity_prices": {
        "off_peak_usd_per_kwh": 0.09,
        "on_peak_usd_per_kwh": 0.16,
        "on_peak_window": "14:00-20:00",
        "demand_charge_usd_per_kw": 8.5,
    },
    "get_battery_state": {
        "soc_pct": 82,
        "capacity_kwh": 500,
        "available_kwh": 410,
        "max_discharge_kw": 250,
        "reserve_floor_pct": 20,
        "dispatchable_kwh": 310,
    },
    "get_ev_requirements": {
        "sessions_connected": 6,
        "flexible_sessions": 4,
        "locked_sessions": 2,
        "target_soc_pct": 80,
        "deadlines": {"departing": iso_hour(18), "fleet": iso_hour(22)},
        "charger_power_kw_each": EV_CHARGER_KW,
        "earliest_shift_hour": 18,
    },
    "get_hvac_constraints": {
        "current_setpoint_f": 72,
        "max_setpoint_f": 75,
        "min_precool_setpoint_f": 70,
        "max_drift_hours": 2,
        "occupied_band_f": [68, 75],
    },
    "run_schedule_optimizer": {
        "objective": "minimize_peak_then_cost",
        "resources": ["battery", "ev", "hvac"],
        "solver": "CP-SAT",
        "solve_time_ms": 2312,
    },
    "validate_schedule": {
        "constraints_checked": 12,
        "ev_deadlines_met": 6,
        "hvac_max_temp_f": 75,
        "hvac_drift_hours": 2,
    },
    "request_human_approval": {"approvers": ["facility_manager"]},
}

# --------------------------------------------------------------------------- #
# Dispatch policy                                                              #
# --------------------------------------------------------------------------- #

POLICY = DispatchPolicy(
    #: 90 kW out of the pack for the three core peak hours, idle otherwise.
    battery_discharge_kw={h: 90.0 for h in hour_range(14, 17)},
    #: Four fleet vans leave 14:00-16:00 and re-appear at 18:00.
    ev_delta_kw={14: -46.0, 15: -46.0, 18: 46.0, 19: 46.0},
    #: Pre-cool, coast, then let the setpoint float through the worst hours.
    hvac_delta_kw={11: 24.0, 12: 18.0, 13: -22.0, 14: -14.0, 15: -18.0},
    #: 13:00 is the building coasting on banked thermal mass at an unchanged
    #: setpoint; only 14:00-16:00 is drift, which is the permitted two hours.
    hvac_drift_hours=[14, 15],
    battery_recharge_kwh=270,
)


# --------------------------------------------------------------------------- #
# Plan                                                                         #
# --------------------------------------------------------------------------- #


def plan_summary(r: "OptimizationResult") -> str:
    return " ".join(
        [
            f"Today's forecast peaks at {r.baseline_peak_kw:.0f} kW at",
            f"{r.baseline_peak_hour}:00, {r.baseline_peak_kw - r.threshold_kw:.0f} kW above",
            f"the {r.threshold_kw:.0f} kW threshold, and stays over it for",
            f"{r.hours_over_threshold} hours. No single resource covers that gap, so the",
            f"plan stacks three: the battery carries {r.battery_flat_kw:.0f} kW through the",
            "14:00-17:00 core, four of the six EV sessions move to the evening where",
            "they have deadline slack, and an 11:00-13:00 pre-cool lets the HVAC",
            "setpoint float to 75F during the worst two hours without leaving the",
            "comfort band. Together they cut the billing peak from",
            f"{r.baseline_peak_kw:.0f} kW to {r.optimized_peak_kw:.0f} kW. Day-ahead energy",
            f"cost falls only ${r.savings_usd:.2f} once the overnight battery recharge is",
            "paid back -- the real prize is the demand charge, where a",
            f"{r.peak_reduction_kw:.0f} kW lower peak avoids about",
            f"${r.demand_charge_avoided_usd:.2f} on this month's bill at $8.50/kW. The HVAC",
            "action is the only one occupants can feel, which is why this plan is",
            "routed for approval rather than dispatched.",
        ]
    )


def build_actions(r: "OptimizationResult") -> list[dict[str, Any]]:
    battery_kw = r.battery_flat_kw
    return [
        {
            "type": "battery_discharge",
            "title": f"Discharge battery at {battery_kw:.0f} kW, 14:00-17:00",
            "description": (
                f"Dispatch {r.battery_kwh:.0f} kWh from the 500 kWh pack across the three "
                f"core peak hours, taking SOC from {r.start_soc_pct:.0f}% to "
                f"{r.end_soc_pct:.0f}% and staying clear of the "
                f"{r.reserve_floor_pct:.0f}% reserve floor. Recharges overnight at the "
                "$0.09/kWh off-peak rate."
            ),
            "start_time": iso_hour(14),
            "end_time": iso_hour(17),
            "magnitude": battery_kw,
            "unit": "kW",
            "estimated_peak_reduction_kw": battery_kw,
            # Attribution of the plan's energy saving across the three levers.
            "estimated_savings_usd": 18.9,
            "constraints_checked": [
                "soc_reserve_floor_20pct",
                "max_discharge_250kw",
                "single_cycle_per_day",
                "recharge_window_available_overnight",
            ],
        },
        {
            "type": "ev_charging_shift",
            "title": "Shift 4 of 6 EV sessions to 18:00-20:00",
            "description": (
                f"Move {r.ev_shifted_kwh:.0f} kWh of fleet-van charging (4 sessions at "
                f"{EV_CHARGER_KW} kW) out of the 14:00-16:00 window. Those vans only need "
                "80% by 22:00, while the two staff vehicles departing at 18:00 keep their "
                "current schedule. Energy cost is unchanged because both windows are "
                "on-peak -- this action exists purely to take load out of the "
                "peak-setting interval."
            ),
            "start_time": iso_hour(18),
            "end_time": iso_hour(20),
            "magnitude": 46,
            "unit": "kW",
            "estimated_peak_reduction_kw": 46,
            "estimated_savings_usd": 0,
            "constraints_checked": [
                "ev_target_soc_80pct_met",
                "deadline_1800_respected_for_2_departing",
                "deadline_2200_respected_for_4_fleet",
                "site_charger_limit_69kw",
            ],
        },
        {
            "type": "hvac_setpoint",
            "title": "Pre-cool 11:00-13:00, then float setpoint +3F",
            "description": (
                "Drop to 70F from 11:00 to 13:00 to bank thermal mass, then let the "
                "setpoint rise from 72F to 75F for the 14:00-16:00 peak. Drift is capped "
                "at the permitted two hours and stays inside the 68-75F occupied comfort "
                "band."
            ),
            "start_time": iso_hour(14),
            "end_time": iso_hour(16),
            "magnitude": 3,
            "unit": "°F",
            "estimated_peak_reduction_kw": 18,
            "estimated_savings_usd": 3.32,
            "constraints_checked": [
                "zone_temp_max_75f",
                "max_drift_duration_2h",
                "occupied_comfort_band_68_75f",
                "precool_min_setpoint_70f",
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
                "Run started. Today's forecast tripped the peak-risk flag, so before "
                "recommending anything I need to confirm the peak is real and find out "
                "which loads are actually flexible."
            ),
            delay_ms=800,
            duration_ms=900,
        ),
        Step(
            type="tool_call",
            tool="get_energy_forecast",
            message=f'get_energy_forecast(building_id="{OFFICE_ID}", horizon_hours=24)',
            payload={"building_id": OFFICE_ID, "horizon_hours": 24},
        ),
        Step(
            type="tool_result",
            tool="get_energy_forecast",
            invoke="get_energy_forecast",
            message=(
                f"Peak confirmed: {r.baseline_peak_kw:.0f} kW at {r.baseline_peak_hour}:00, "
                f"{r.baseline_peak_kw - r.threshold_kw:.0f} kW over the "
                f"{r.threshold_kw:.0f} kW threshold. The building stays above threshold "
                f"for {r.hours_over_threshold} consecutive hours, 13:00 through 17:00."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_electricity_prices",
            invoke="get_electricity_prices",
            message=(
                "Tariff loaded. Energy is $0.09/kWh off-peak and $0.16/kWh from 14:00 to "
                "20:00, but the real cost here is the $8.50/kW monthly demand charge set "
                "by the single highest interval."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_battery_state",
            invoke="get_battery_state",
            message=(
                f"Battery is at {r.start_soc_pct:.0f}% SOC, 410 kWh available against a "
                "500 kWh pack and a 250 kW inverter. A 20% reserve floor is contractual, "
                f"so {r.dispatchable_kwh:.0f} kWh is genuinely dispatchable today."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_ev_requirements",
            invoke="get_ev_requirements",
            message=(
                "Six EVs are plugged in. Two are staff vehicles departing at 18:00 and "
                "must reach 80% by then; the other four are fleet vans that only need 80% "
                "by 22:00. Those four are movable."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_hvac_constraints",
            invoke="get_hvac_constraints",
            message=(
                "HVAC is at a 72F setpoint and may drift to 75F for at most two hours "
                "while occupied. Pre-cooling to 70F beforehand is permitted, which buys "
                "back most of the comfort cost."
            ),
        ),
        Step(
            type="thinking",
            message=(
                f"I have three levers: {r.dispatchable_kwh:.0f} kWh of battery, four "
                "movable EV sessions, and a two-hour HVAC drift. None of them alone "
                f"covers {r.baseline_peak_kw - r.threshold_kw:.0f} kW for "
                f"{r.hours_over_threshold} hours, so I will hand all three to the "
                "optimizer together rather than guess at a split."
            ),
            duration_ms=1100,
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
                f"Peak drops from {r.baseline_peak_kw:.0f} kW to "
                f"{r.optimized_peak_kw:.0f} kW, a {r.peak_reduction_kw:.0f} kW cut. Note "
                f"the new peak is set by {r.optimized_peak_hour}:00, not "
                f"{r.baseline_peak_hour}:00 -- the shifted EV load becomes the binding "
                "interval, so shedding harder at 15:00 would not help."
            ),
            duration_ms=r.solve_time_ms,
        ),
        Step(
            type="tool_result",
            tool="validate_schedule",
            invoke="validate_schedule",
            message=(
                "All 12 constraints pass. Battery ends the window at "
                f"{r.end_soc_pct:.0f}% SOC, above the {r.reserve_floor_pct:.0f}% floor. "
                "Every EV still reaches 80% before its own deadline. HVAC drift is "
                "exactly two hours and tops out at 75F."
            ),
        ),
        Step(
            type="decision",
            tool="save_action_plan",
            invoke="save_action_plan",
            message=(
                f"Committing a three-action plan: discharge the battery at "
                f"{r.battery_flat_kw:.0f} kW from 14:00 to 17:00, move four EV sessions "
                "to the evening, and pre-cool then let the setpoint float 3F during the "
                "peak."
            ),
        ),
        Step(
            type="tool_call",
            tool="request_human_approval",
            invoke="request_human_approval",
            message=(
                "The HVAC action changes occupant comfort, so this plan needs a human. "
                "Sending all three actions to the facility manager for approval."
            ),
            payload={"requires_approval": True, "action_count": 3},
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
    baseline_grid=BASELINE_LOAD_KW,
    actual_load_kw=ACTUAL_LOAD_KW,
    summary_extras={
        "current_load_kw": BASELINE_LOAD_KW[NOW_HOUR],
        "battery_soc_pct": 82,
        "solar_generation_kw": SOLAR_KW[NOW_HOUR],
        "ev_connected": 6,
        "hvac_setpoint_f": 72,
        "outdoor_temp_f": 71,
    },
    tool_facts=TOOL_FACTS,
    policy=POLICY,
    plan_summary=plan_summary,
    build_actions=build_actions,
    build_script=build_script,
    published={
        "baseline_peak_kw": 522,
        "optimized_peak_kw": 438,
        "peak_reduction_kw": 84,
        "baseline_cost_usd": 869.59,
        "optimized_cost_usd": 847.37,
        "savings_usd": 22.22,
        "action_count": 3,
    },
)
