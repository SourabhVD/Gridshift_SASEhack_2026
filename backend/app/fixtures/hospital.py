"""
sea-hospital-002 -- Harborview Medical Annex. The hard case.

Ported from frontend/src/mocks/buildings/hospital.ts.

A hospital never really turns off: the overnight floor sits around 600 kW and
the midday plateau runs 830-884 kW, six hours of it over the 800 kW threshold.
HVAC is the dominant load, the battery carries a 30% critical-care reserve
floor instead of the usual 20%, and only two of the four ambulance chargers may
be moved at all.

The reserve floor is what shapes the plan: the inverter is rated 400 kW and the
optimizer wanted 110 kW, but 76% SOC minus a 30% floor is 368 kWh and the
over-threshold block is six hours long. 60 kW is the largest flat discharge
that covers all six hours without touching the floor, so that is what gets
dispatched.
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
    js_round,
    metered_actuals,
    piecewise,
    solar_bell,
    with_hours,
    zeros,
)
from .spec import BuildingFixture, DispatchPolicy, Step

if TYPE_CHECKING:  # pragma: no cover
    from ..services.optimizer import OptimizationResult

HOSPITAL_ID = "sea-hospital-002"

BUILDING: dict[str, Any] = {
    "id": HOSPITAL_ID,
    "name": "Harborview Medical Annex",
    "type": "hospital",
    "address": "325 9th Avenue, Seattle, WA 98104",
    "floors": 6,
    "area_sqft": 210_000,
    "peak_threshold_kw": 800,
    "battery_capacity_kwh": 800,
    "battery_max_kw": 400,
    "ev_bays": 4,
    "solar_capacity_kw": 90,
    "hvac_zones": 42,
}

RESERVE_FLOOR_PCT = 30
START_SOC_PCT = 76
#: Ambulance chargers. Four bays, two of them clinically movable.
EV_CHARGER_KW = 11

# --------------------------------------------------------------------------- #
# Baseline                                                                     #
# --------------------------------------------------------------------------- #

#: Flat overnight floor, a long morning ramp as theatres and imaging come up,
#: then a 12:00-18:00 plateau. Peak 884 kW at 14:00, over 800 kW for six hours.
BASELINE_GRID_KW: list[float] = [
    js_round(v)
    for v in piecewise(
        [
            (0, 604),
            (3, 588),
            (5, 600),
            (8, 748),
            (11, 772),
            (12, 838),
            (14, 884),
            (16, 852),
            (17, 830),
            (20, 716),
            (23, 612),
        ]
    )
]

SOLAR_KW = solar_bell(72, 13, 5.5)

#: Two ambulances on charge from 10:00; the movable pair joins 14:00-16:00.
BASELINE_EV = with_hours(
    with_hours(zeros(), hour_range(10, 18), 2 * EV_CHARGER_KW),
    hour_range(14, 16),
    4 * EV_CHARGER_KW,
)

BASELINE_HVAC = hvac_profile(
    BASELINE_GRID_KW,
    HvacShareSpec(night=0.34, day_min=0.36, day_max=0.42, day_start=6, day_end=22),
)

BASELINE_PARTS = FlowComponents(
    base=base_from_grid(
        BASELINE_GRID_KW, ev=BASELINE_EV, hvac=BASELINE_HVAC, solar=SOLAR_KW, battery=zeros()
    ),
    ev=BASELINE_EV,
    hvac=BASELINE_HVAC,
    solar=SOLAR_KW,
    battery=zeros(),
    soc=flat(START_SOC_PCT),
)

# --------------------------------------------------------------------------- #
# Device facts                                                                 #
# --------------------------------------------------------------------------- #

TOOL_FACTS: dict[str, dict[str, Any]] = {
    "get_electricity_prices": {
        "off_peak_usd_per_kwh": 0.09,
        "on_peak_usd_per_kwh": 0.16,
        "on_peak_window": "14:00-20:00",
        "demand_charge_usd_per_kw": 8.5,
    },
    "get_battery_state": {
        "soc_pct": START_SOC_PCT,
        "capacity_kwh": 800,
        "available_kwh": 608,
        "max_discharge_kw": 400,
        "reserve_floor_pct": RESERVE_FLOOR_PCT,
        "reserve_reason": "critical_care_ride_through",
        "dispatchable_kwh": 368,
    },
    "get_ev_requirements": {
        "sessions_connected": 4,
        "flexible_sessions": 2,
        "locked_sessions": 2,
        "lock_reason": "frontline_dispatch_readiness",
        "earliest_shift_time": iso_hour(18),
        "earliest_shift_hour": 19,
        "target_soc_pct": 80,
        "charger_power_kw_each": EV_CHARGER_KW,
    },
    "get_hvac_constraints": {
        "zones_total": 42,
        "clinical_zones_locked": 16,
        "non_clinical_zones_flexible": 26,
        "max_drift_f": 2,
        "max_drift_hours": 2,
        "non_clinical_max_temp_f": 76,
        "estimated_shed_kw": 35,
    },
    "run_schedule_optimizer": {
        "objective": "minimize_peak_then_cost",
        "resources": ["battery", "ev", "hvac"],
        "locked_zones": 16,
        "solver": "CP-SAT",
        "solve_time_ms": 3104,
        "unconstrained_battery_kw": 110,
    },
    "validate_schedule": {
        "constraints_checked": 17,
        "reserve_floor_pct": RESERVE_FLOOR_PCT,
        "clinical_zones_untouched": 16,
        "frontline_min_soc_pct": 84,
        "hvac_drift_hours": 2,
    },
    "request_human_approval": {
        "approvers": ["facilities_director", "clinical_engineering_on_call"]
    },
}

# --------------------------------------------------------------------------- #
# Dispatch policy                                                              #
# --------------------------------------------------------------------------- #

DISCHARGE_KW = 60.0
DISCHARGE_HOURS = hour_range(12, 18)

POLICY = DispatchPolicy(
    battery_discharge_kw={h: DISCHARGE_KW for h in DISCHARGE_HOURS},
    #: The two movable ambulances re-charge after the evening shift change.
    ev_delta_kw={14: -22.0, 15: -22.0, 19: 22.0, 20: 22.0},
    #: Pre-cool the non-clinical wings, then drift +2F through the hottest hours.
    hvac_delta_kw={10: 15.0, 11: 15.0, 13: -35.0, 14: -35.0},
    battery_recharge_kwh=DISCHARGE_KW * len(DISCHARGE_HOURS),
)


# --------------------------------------------------------------------------- #
# Plan                                                                         #
# --------------------------------------------------------------------------- #


def plan_summary(r: "OptimizationResult") -> str:
    return " ".join(
        [
            f"Today's forecast peaks at {r.baseline_peak_kw:.0f} kW at",
            f"{r.baseline_peak_hour}:00 and stays above the {r.threshold_kw:.0f} kW",
            f"threshold for {r.hours_over_threshold} straight hours, 12:00 through 18:00.",
            "That length is the binding constraint, not the height: the pack holds",
            f"608 kWh at {r.start_soc_pct:.0f}% SOC but the critical-care policy reserves",
            f"{r.reserve_floor_pct:.0f}% of it, leaving {r.dispatchable_kwh:.0f} kWh.",
            f"Spread across six hours that is {r.battery_flat_kw:.0f} kW, well under the",
            f"{r.inverter_kw:.0f} kW inverter -- so the battery alone cannot carry this and",
            "the plan adds two narrow, reversible levers on top. Non-clinical air",
            "handlers pre-cool at 10:00-12:00 and then drift +2F for the two hottest",
            f"hours, worth {r.hvac_shed_kw:.0f} kW; patient rooms, theatres and imaging are",
            "excluded outright. Two of the four ambulance chargers move to 19:00, after",
            "the shift change, while the two on standby keep charging through. Together",
            f"the peak falls from {r.baseline_peak_kw:.0f} kW to {r.optimized_peak_kw:.0f} kW,",
            f"a {r.peak_reduction_kw:.0f} kW cut worth about",
            f"${r.demand_charge_avoided_usd:.2f} on the demand charge, with",
            f"${r.savings_usd:.2f} of day-ahead energy saved on top. The battery ends the",
            f"window at {r.end_soc_pct:.0f}% SOC, one point above the floor, which is",
            "exactly where a hospital should not be without a human agreeing to it first.",
        ]
    )


def build_actions(r: "OptimizationResult") -> list[dict[str, Any]]:
    return [
        {
            "type": "battery_discharge",
            "title": f"Discharge battery at {r.battery_flat_kw:.0f} kW, 12:00-18:00",
            "description": (
                f"Dispatch {r.battery_kwh:.0f} kWh from the 800 kWh pack flat across all "
                "six over-threshold hours, taking SOC from "
                f"{r.start_soc_pct:.0f}% to {r.end_soc_pct:.0f}%. The "
                f"{r.reserve_floor_pct:.0f}% critical-care reserve floor, not the "
                f"{r.inverter_kw:.0f} kW inverter, is what caps this at "
                f"{r.battery_flat_kw:.0f} kW -- a deeper, shorter discharge would clear "
                "14:00 but leave 17:00 and 18:00 exposed. Recharges overnight at the "
                "$0.09/kWh off-peak rate."
            ),
            "start_time": iso_hour(12),
            "end_time": iso_hour(18),
            "magnitude": r.battery_flat_kw,
            "unit": "kW",
            "estimated_peak_reduction_kw": r.battery_flat_kw,
            "estimated_savings_usd": 25.2,
            "constraints_checked": [
                "soc_reserve_floor_30pct_critical_care",
                "max_discharge_400kw",
                "islanding_capability_preserved",
                "single_cycle_per_day",
            ],
        },
        {
            "type": "hvac_setpoint",
            "title": "Pre-cool non-clinical zones, then drift +2F 13:00-15:00",
            "description": (
                "Pre-cool the 26 non-clinical zones (admin, lobby, cafeteria, plant "
                "rooms) from 10:00 to 12:00, then let them rise 2F for the 13:00-15:00 "
                f"block, worth {r.hvac_shed_kw:.0f} kW. The 16 clinical zones -- patient "
                "rooms, operating theatres, imaging, pharmacy and the isolation suite -- "
                "are excluded and hold their setpoints and pressure relationships "
                "unchanged."
            ),
            "start_time": iso_hour(13),
            "end_time": iso_hour(15),
            "magnitude": 2,
            "unit": "°F",
            "estimated_peak_reduction_kw": r.hvac_shed_kw,
            "estimated_savings_usd": 11.2,
            "constraints_checked": [
                "clinical_zones_excluded",
                "operating_theatre_pressure_cascade_held",
                "non_clinical_max_temp_76f",
                "max_drift_duration_2h",
            ],
        },
        {
            "type": "ev_charging_shift",
            "title": "Shift 2 of 4 ambulance chargers to 19:00-21:00",
            "description": (
                "Move the two reserve ambulances off charge during 14:00-16:00 and "
                f"re-start them at 19:00, after the shift change, at {EV_CHARGER_KW} kW "
                "each. The two front-line ambulances on standby are locked -- they must "
                "hold above 80% at all times and are never interrupted. Energy is "
                f"unchanged; this action exists only to take {2 * EV_CHARGER_KW} kW out "
                "of the peak-setting block."
            ),
            "start_time": iso_hour(19),
            "end_time": iso_hour(21),
            "magnitude": 2 * EV_CHARGER_KW,
            "unit": "kW",
            "estimated_peak_reduction_kw": 2 * EV_CHARGER_KW,
            "estimated_savings_usd": 0,
            "constraints_checked": [
                "frontline_pair_never_interrupted",
                "reserve_pair_min_soc_80pct_by_2200",
                "dispatch_readiness_2_vehicles_minimum",
                "site_charger_limit_44kw",
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
                "Run started on a hospital, so the bar is different: nothing that touches "
                "patient care is on the table. Before I look for savings I need to know "
                "how long the building is over threshold, because duration usually "
                "decides what the battery can do here."
            ),
            delay_ms=800,
            duration_ms=900,
        ),
        Step(
            type="tool_call",
            tool="get_energy_forecast",
            message=f'get_energy_forecast(building_id="{HOSPITAL_ID}", horizon_hours=24)',
            payload={"building_id": HOSPITAL_ID, "horizon_hours": 24},
        ),
        Step(
            type="tool_result",
            tool="get_energy_forecast",
            invoke="get_energy_forecast",
            message=(
                f"Peak confirmed: {r.baseline_peak_kw:.0f} kW at {r.baseline_peak_hour}:00, "
                f"{r.baseline_peak_kw - r.threshold_kw:.0f} kW over the "
                f"{r.threshold_kw:.0f} kW threshold. The worrying number is the width -- "
                f"{r.hours_over_threshold} consecutive hours over threshold, 12:00 through "
                "18:00, against four at a typical office."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_electricity_prices",
            invoke="get_electricity_prices",
            message=(
                "Tariff loaded. Same Seattle City Light schedule as the rest of the "
                "portfolio: $0.09/kWh off-peak, $0.16/kWh from 14:00 to 20:00, $8.50/kW "
                "monthly demand charge set by the single highest interval."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_battery_state",
            invoke="get_battery_state",
            message=(
                f"Battery is at {r.start_soc_pct:.0f}% SOC, 608 kWh on an 800 kWh pack "
                f"behind a {r.inverter_kw:.0f} kW inverter. The reserve floor here is "
                f"{r.reserve_floor_pct:.0f}%, not the usual 20% -- the pack is part of the "
                f"critical-care ride-through -- so only {r.dispatchable_kwh:.0f} kWh is "
                "dispatchable."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_ev_requirements",
            invoke="get_ev_requirements",
            message=(
                f"Four ambulance chargers at {EV_CHARGER_KW} kW. Two are front-line "
                "vehicles on standby and must stay above 80% at all times -- they are not "
                "movable at any hour. The two reserve vehicles can be deferred, but not "
                "before 18:00, when the shift changes."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_hvac_constraints",
            invoke="get_hvac_constraints",
            message=(
                "HVAC is 42 zones, and 16 of them are clinical: patient rooms, theatres, "
                "imaging, pharmacy, isolation. Those are locked on both setpoint and "
                "pressure cascade. The remaining 26 non-clinical zones may drift 2F for "
                f"up to two hours, worth about {r.hvac_shed_kw:.0f} kW."
            ),
        ),
        Step(
            type="thinking",
            message=(
                f"{r.dispatchable_kwh:.0f} kWh over a six-hour block is "
                f"{r.battery_flat_kw:.0f} kW flat -- far below what the inverter could do, "
                "but a deeper discharge would clear 14:00 and leave 17:00 and 18:00 "
                "uncovered, and the demand charge only cares about the highest interval "
                "that survives. So: battery flat across all six hours, HVAC and EV on top "
                "for the two worst ones. Handing that shape to the optimizer."
            ),
            duration_ms=1200,
        ),
        Step(
            type="tool_call",
            tool="run_schedule_optimizer",
            message=(
                'run_schedule_optimizer(objective="minimize_peak_then_cost", '
                'horizon_hours=24, resources=["battery","ev","hvac"], locked_zones=16)'
            ),
            payload={
                "objective": "minimize_peak_then_cost",
                "horizon_hours": 24,
                "resources": ["battery", "ev", "hvac"],
                "locked_zones": 16,
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
                f"{r.optimized_peak_kw:.0f} kW, a {r.peak_reduction_kw:.0f} kW cut. It "
                "wanted 110 kW on the battery and the reserve floor refused, so the "
                "binding intervals are now 16:00 and 18:00, tied -- shedding harder at "
                "14:00 buys nothing."
            ),
            duration_ms=r.solve_time_ms,
        ),
        Step(
            type="tool_result",
            tool="validate_schedule",
            invoke="validate_schedule",
            message=(
                f"All 17 constraints pass. Battery ends the window at {r.end_soc_pct:.0f}% "
                f"SOC, one point above the {r.reserve_floor_pct:.0f}% critical-care floor. "
                "Both front-line ambulances stay above 80% throughout. All 16 clinical "
                "zones are untouched and the theatre pressure cascade holds."
            ),
        ),
        Step(
            type="decision",
            tool="save_action_plan",
            invoke="save_action_plan",
            message=(
                f"Committing a three-action plan: hold {r.battery_flat_kw:.0f} kW on the "
                "battery from 12:00 to 18:00, drift the 26 non-clinical HVAC zones +2F "
                "for two hours, and move the two reserve ambulance chargers to 19:00."
            ),
        ),
        Step(
            type="tool_call",
            tool="request_human_approval",
            invoke="request_human_approval",
            message=(
                "This one is not close to automatic. The battery finishes one point off a "
                "critical-care reserve floor and the HVAC action touches occupied space, "
                "so it goes to the facilities director and the on-call clinical engineer "
                "together."
            ),
            payload={
                "requires_approval": True,
                "action_count": 3,
                "approvers": ["facilities_director", "clinical_engineering_on_call"],
            },
        ),
        Step(
            type="complete",
            message=(
                "Investigation complete. Plan is ready for review; nothing will be "
                "dispatched until both approvers sign off."
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
        "battery_soc_pct": START_SOC_PCT,
        "solar_generation_kw": SOLAR_KW[NOW_HOUR],
        "ev_connected": 2,
        "hvac_setpoint_f": 70,
        "outdoor_temp_f": 71,
    },
    tool_facts=TOOL_FACTS,
    policy=POLICY,
    plan_summary=plan_summary,
    build_actions=build_actions,
    build_script=build_script,
    published={
        "baseline_peak_kw": 884,
        "optimized_peak_kw": 792,
        "peak_reduction_kw": 92,
        "action_count": 3,
    },
)
