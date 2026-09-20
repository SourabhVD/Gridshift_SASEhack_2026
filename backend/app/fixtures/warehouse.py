"""
sea-warehouse-003 -- Duwamish Logistics Hub. The easy case, structurally.

Ported from frontend/src/mocks/buildings/warehouse.ts.

A single-storey shed whose own load barely moves (90 kW overnight, ~160 kW
while the sortation lines run) and whose entire peak problem is a delivery
fleet. Twenty-four vans plug in as they come off route between 13:00 and 17:00,
11 kW each, and that block alone pushes the site from 110 kW to 426 kW against
a 350 kW threshold.

Because the vans are the peak, staggering them is the whole plan. HVAC gets no
action at all: an unconditioned high bay with dock-door infiltration has no
thermal mass to pre-cool and no occupant comfort band to borrow against, so the
tool reports zero flexible kW and the optimizer produces two actions rather
than inventing a third.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

from .generator import (
    HOURS,
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
    solar_bell,
    zeros,
)
from .spec import BuildingFixture, DispatchPolicy, Step

if TYPE_CHECKING:  # pragma: no cover
    from ..services.optimizer import OptimizationResult

WAREHOUSE_ID = "sea-warehouse-003"

BUILDING: dict[str, Any] = {
    "id": WAREHOUSE_ID,
    "name": "Duwamish Logistics Hub",
    "type": "warehouse",
    "address": "4600 E Marginal Way S, Seattle, WA 98134",
    "floors": 1,
    "area_sqft": 320_000,
    "peak_threshold_kw": 350,
    "battery_capacity_kwh": 1000,
    "battery_max_kw": 500,
    "ev_bays": 24,
    "solar_capacity_kw": 90,
    "hvac_zones": 6,
}

RESERVE_FLOOR_PCT = 10
START_SOC_PCT = 90
VAN_CHARGER_KW = 11

# --------------------------------------------------------------------------- #
# Baseline                                                                     #
# --------------------------------------------------------------------------- #

#: Vans returning from route. 22 are on charge by 13:00, the last two by 14:00,
#: and the first eight are finished by 16:00. Peak concurrency is 24 bays.
VANS_ON_CHARGE: dict[int, int] = {13: 22, 14: 24, 15: 24, 16: 18}
BASELINE_VANS: list[int] = [VANS_ON_CHARGE.get(h, 0) for h in range(HOURS)]
BASELINE_EV: list[float] = [n * VAN_CHARGER_KW for n in BASELINE_VANS]

SOLAR_KW = solar_bell(75, 13, 5.5)

#: 90 kW overnight, 160 kW once the building opens at 06:00.
BASE_LOAD_KW: list[float] = [160.0 if 6 <= h < 22 else 90.0 for h in range(HOURS)]

_HVAC_SHARE = HvacShareSpec(night=0.06, day_min=0.10, day_max=0.13, day_start=6, day_end=22)

#: Grid-pinned so the published curve is an integer series: HVAC is taken as a
#: share of a provisional curve, then base_kw falls out as the residual.
_PROVISIONAL_HVAC = hvac_profile(
    [BASE_LOAD_KW[h] + BASELINE_EV[h] for h in range(HOURS)], _HVAC_SHARE
)

BASELINE_GRID_KW: list[float] = [
    js_round(BASE_LOAD_KW[h] + BASELINE_EV[h] + _PROVISIONAL_HVAC[h] - SOLAR_KW[h])
    for h in range(HOURS)
]

BASELINE_HVAC = hvac_profile(BASELINE_GRID_KW, _HVAC_SHARE)

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
# The fleet split                                                              #
# --------------------------------------------------------------------------- #

#: Half of every arrival cohort keeps its afternoon slot; the other half is
#: re-queued five hours later. Van-hours are preserved exactly (44 either side).
STAYING_VANS = [math.ceil(n / 2) for n in BASELINE_VANS]
MOVED_VANS = [n // 2 for n in BASELINE_VANS]
STAYING_VAN_COUNT = max(STAYING_VANS)
MOVED_VAN_COUNT = max(MOVED_VANS)

_EV_DELTA: dict[int, float] = {}
for _h, _n in enumerate(BASELINE_VANS):
    if MOVED_VANS[_h]:
        _EV_DELTA[_h] = -float(MOVED_VANS[_h] * VAN_CHARGER_KW)
        _EV_DELTA[_h + 5] = float(MOVED_VANS[_h] * VAN_CHARGER_KW)

DISCHARGE_KW = 60.0
DISCHARGE_HOURS = hour_range(14, 17)

POLICY = DispatchPolicy(
    battery_discharge_kw={h: DISCHARGE_KW for h in DISCHARGE_HOURS},
    ev_delta_kw=_EV_DELTA,
    #: No HVAC action: the high bay has nothing useful to give.
    hvac_delta_kw={},
    battery_recharge_kwh=DISCHARGE_KW * len(DISCHARGE_HOURS),
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
        "capacity_kwh": 1000,
        "available_kwh": 900,
        "max_discharge_kw": 500,
        "reserve_floor_pct": RESERVE_FLOOR_PCT,
        "dispatchable_kwh": 800,
    },
    "get_ev_requirements": {
        "sessions_connected": 24,
        "flexible_sessions": 24,
        "locked_sessions": 0,
        "charger_power_kw_each": VAN_CHARGER_KW,
        "arrival_window": "13:00-17:00",
        "departure_time": "05:00",
        "earliest_shift_hour": 18,
        "slack_hours": 6,
    },
    "get_hvac_constraints": {
        "zones_total": 6,
        "conditioned_zones": 1,
        "flexible_kw": 0,
        "reason": "unconditioned_high_bay_no_thermal_mass",
        "mezzanine_share_pct": 4,
    },
    "run_schedule_optimizer": {
        "objective": "minimize_peak_then_cost",
        "resources": ["battery", "ev"],
        "excluded_resources": ["hvac"],
        "solver": "CP-SAT",
        "solve_time_ms": 1418,
    },
    "validate_schedule": {
        "constraints_checked": 9,
        "vans_charged_by_departure": 24,
        "min_van_slack_hours": 6,
    },
    "request_human_approval": {"approvers": ["dispatch_supervisor"]},
}


# --------------------------------------------------------------------------- #
# Plan                                                                         #
# --------------------------------------------------------------------------- #


def plan_summary(r: "OptimizationResult") -> str:
    return " ".join(
        [
            f"Today's forecast peaks at {r.baseline_peak_kw:.0f} kW at",
            f"{r.baseline_peak_hour}:00, {r.baseline_peak_kw - r.threshold_kw:.0f} kW above",
            f"the {r.threshold_kw:.0f} kW threshold, and the cause is unambiguous: the",
            "building itself never draws more than about 180 kW, and the other",
            f"{24 * VAN_CHARGER_KW} kW is 24 delivery vans charging at once between 13:00",
            "and 17:00. So the plan does not shed anything, it re-queues.",
            f"{STAYING_VAN_COUNT} vans keep their afternoon slot, {MOVED_VAN_COUNT} move to",
            "18:00-22:00, and because the vans are not back on route until 05:00 nobody",
            f"waits on a charge. The battery then takes {r.battery_flat_kw:.0f} kW out of",
            "14:00-17:00, which is worth more as arbitrage than as peak shaving -- it",
            f"moves {r.battery_kwh:.0f} kWh from the $0.16 on-peak window to the $0.09",
            f"overnight rate. Peak falls from {r.baseline_peak_kw:.0f} kW to",
            f"{r.optimized_peak_kw:.0f} kW, a {r.peak_reduction_kw:.0f} kW cut worth about",
            f"${r.demand_charge_avoided_usd:.2f} on the demand charge, plus",
            f"${r.savings_usd:.2f} of day-ahead energy. There is deliberately no HVAC",
            "action: an unconditioned high bay with dock doors cycling has no thermal",
            "mass to pre-cool and no comfort band to borrow against, so offering one",
            "would be theatre. The new binding interval is the 19:00-21:00 evening block,",
            "and it sits comfortably under threshold.",
        ]
    )


def build_actions(r: "OptimizationResult") -> list[dict[str, Any]]:
    moved_kw = MOVED_VAN_COUNT * VAN_CHARGER_KW
    return [
        {
            "type": "ev_charging_shift",
            "title": f"Stagger {MOVED_VAN_COUNT} of 24 vans into 18:00-22:00",
            "description": (
                f"Split each arrival cohort in half: {STAYING_VAN_COUNT} vans keep their "
                f"13:00-17:00 slot and {MOVED_VAN_COUNT} are re-queued into 18:00-22:00 "
                f"at {VAN_CHARGER_KW} kW each. Van-hours are identical either way, so "
                "every vehicle reaches the same state of charge -- the fleet does not "
                "leave the yard until 05:00, which is six hours of slack. This single "
                f"action takes {moved_kw} kW out of the peak-setting interval."
            ),
            "start_time": iso_hour(18),
            "end_time": iso_hour(22),
            "magnitude": moved_kw,
            "unit": "kW",
            "estimated_peak_reduction_kw": moved_kw,
            "estimated_savings_usd": 14.6,
            "constraints_checked": [
                "all_vans_full_by_0500_departure",
                "site_charger_limit_264kw",
                "per_bay_limit_11kw",
                "no_van_session_split_across_gaps",
            ],
        },
        {
            "type": "battery_discharge",
            "title": f"Discharge battery at {r.battery_flat_kw:.0f} kW, 14:00-17:00",
            "description": (
                f"Dispatch {r.battery_kwh:.0f} kWh from the 1000 kWh pack across the three "
                f"on-peak afternoon hours, taking SOC from {r.start_soc_pct:.0f}% to "
                f"{r.end_soc_pct:.0f}% -- nowhere near the {r.reserve_floor_pct:.0f}% "
                f"floor, and a fraction of the {r.inverter_kw:.0f} kW inverter. This is "
                f"mostly an arbitrage action: {r.battery_kwh:.0f} kWh bought back "
                "overnight at $0.09 instead of drawn at $0.16. It also leaves headroom if "
                "a route runs late and the afternoon cohort arrives bunched."
            ),
            "start_time": iso_hour(14),
            "end_time": iso_hour(17),
            "magnitude": r.battery_flat_kw,
            "unit": "kW",
            "estimated_peak_reduction_kw": r.battery_flat_kw,
            "estimated_savings_usd": 12.6,
            "constraints_checked": [
                "soc_reserve_floor_10pct",
                "max_discharge_500kw",
                "single_cycle_per_day",
                "recharge_window_available_overnight",
            ],
        },
    ]


# --------------------------------------------------------------------------- #
# Scripted run                                                                 #
# --------------------------------------------------------------------------- #


def build_script(r: "OptimizationResult") -> list[Step]:
    fleet_share_pct = round((24 * VAN_CHARGER_KW / r.baseline_peak_kw) * 100)
    return [
        Step(
            type="thinking",
            message=(
                "Run started. A distribution shed usually has one dominant flexible load "
                "rather than several small ones, so rather than surveying everything "
                "evenly I want to find out first how much of this peak is the building "
                "and how much is the fleet."
            ),
            delay_ms=800,
            duration_ms=850,
        ),
        Step(
            type="tool_call",
            tool="get_energy_forecast",
            message=f'get_energy_forecast(building_id="{WAREHOUSE_ID}", horizon_hours=24)',
            payload={"building_id": WAREHOUSE_ID, "horizon_hours": 24},
        ),
        Step(
            type="tool_result",
            tool="get_energy_forecast",
            invoke="get_energy_forecast",
            message=(
                f"Peak confirmed: {r.baseline_peak_kw:.0f} kW at {r.baseline_peak_hour}:00, "
                f"{r.baseline_peak_kw - r.threshold_kw:.0f} kW over the "
                f"{r.threshold_kw:.0f} kW threshold, above it for "
                f"{r.hours_over_threshold} hours from 13:00. Note the shape -- the site is "
                f"at {r.baseline_grid[12]:.0f} kW at noon and {r.baseline_grid[13]:.0f} kW "
                "an hour later. That is not a building warming up, that is something "
                "plugging in."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_electricity_prices",
            invoke="get_electricity_prices",
            message=(
                "Tariff loaded. $0.09/kWh off-peak, $0.16/kWh from 14:00 to 20:00, "
                "$8.50/kW monthly demand charge. Worth noting that 18:00-20:00 is still "
                "on-peak, so anything I move into the early evening saves demand charge "
                "but not energy."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_battery_state",
            invoke="get_battery_state",
            message=(
                f"Battery is at {r.start_soc_pct:.0f}% SOC, 900 kWh on a 1000 kWh pack "
                f"behind a {r.inverter_kw:.0f} kW inverter, with only a "
                f"{r.reserve_floor_pct:.0f}% floor. This is the least constrained resource "
                f"in the portfolio -- {r.dispatchable_kwh:.0f} kWh dispatchable, far more "
                "than this peak needs."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_ev_requirements",
            invoke="get_ev_requirements",
            message=(
                f"There it is. Twenty-four delivery vans at {VAN_CHARGER_KW} kW, all "
                "plugging in as they come off route between 13:00 and 17:00 -- "
                f"{24 * VAN_CHARGER_KW} kW at full concurrency, which is "
                f"{fleet_share_pct}% of the peak. They do not depart until 05:00, so every "
                "one of them has six hours of slack."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_hvac_constraints",
            invoke="get_hvac_constraints",
            message=(
                "HVAC has nothing to offer here. Six zones, all unconditioned high bay on "
                "destratification fans and dock-door make-up air; no cooling setpoint to "
                "float, no thermal mass to pre-charge, and the office mezzanine is 4% of "
                "the load. I am dropping HVAC from the resource list rather than "
                "pretending it is a lever."
            ),
        ),
        Step(
            type="thinking",
            message=(
                "So this is a queueing problem, not a shedding problem. If the vans "
                "create the peak and every van has six hours of slack, splitting the "
                "fleet across two windows is worth more than anything the battery can do "
                "-- and it costs nobody anything. I will let the optimizer place the "
                "split and use the battery for on-peak arbitrage on top."
            ),
            duration_ms=1050,
        ),
        Step(
            type="tool_call",
            tool="run_schedule_optimizer",
            message=(
                'run_schedule_optimizer(objective="minimize_peak_then_cost", '
                'horizon_hours=24, resources=["battery","ev"])'
            ),
            payload={
                "objective": "minimize_peak_then_cost",
                "horizon_hours": 24,
                "resources": ["battery", "ev"],
                "excluded_resources": ["hvac"],
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
                f"{r.optimized_peak_kw:.0f} kW, a {r.peak_reduction_kw:.0f} kW cut, by "
                f"splitting the fleet {STAYING_VAN_COUNT}/{MOVED_VAN_COUNT} across "
                f"afternoon and evening. The binding interval moves to "
                f"{r.optimized_peak_hour}:00 -- the evening cohort now sets the peak, "
                "which is why splitting further would not help."
            ),
            duration_ms=r.solve_time_ms,
        ),
        Step(
            type="tool_result",
            tool="validate_schedule",
            invoke="validate_schedule",
            message=(
                "All 9 constraints pass. Every van reaches full charge before the 05:00 "
                f"departure with hours to spare, no bay exceeds {VAN_CHARGER_KW} kW, and "
                "the site stays under the 264 kW charger limit in both windows. Battery "
                f"ends at {r.end_soc_pct:.0f}%, well clear of the "
                f"{r.reserve_floor_pct:.0f}% floor."
            ),
        ),
        Step(
            type="decision",
            tool="save_action_plan",
            invoke="save_action_plan",
            message=(
                f"Committing a two-action plan: re-queue {MOVED_VAN_COUNT} of the 24 vans "
                f"into 18:00-22:00, and discharge the battery at {r.battery_flat_kw:.0f} "
                "kW from 14:00 to 17:00. No HVAC action -- there is no flexibility there "
                "to recommend."
            ),
        ),
        Step(
            type="tool_call",
            tool="request_human_approval",
            invoke="request_human_approval",
            message=(
                "Neither action affects a person, so this is the cleanest plan in the "
                "portfolio -- but re-queueing the fleet changes the yard schedule, so the "
                "dispatch supervisor should see it before it runs."
            ),
            payload={
                "requires_approval": True,
                "action_count": 2,
                "approvers": ["dispatch_supervisor"],
            },
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
        "battery_soc_pct": START_SOC_PCT,
        "solar_generation_kw": SOLAR_KW[NOW_HOUR],
        "ev_connected": 0,
        "hvac_setpoint_f": 68,
        "outdoor_temp_f": 71,
    },
    tool_facts=TOOL_FACTS,
    policy=POLICY,
    plan_summary=plan_summary,
    build_actions=build_actions,
    build_script=build_script,
    published={
        "baseline_peak_kw": 426,
        "optimized_peak_kw": 311,
        "action_count": 2,
    },
)
