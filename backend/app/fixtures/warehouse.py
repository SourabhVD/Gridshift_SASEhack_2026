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

The two actions are the only rows a human approves, so every clock time and
every figure in them is read off the OptimizationResult rather than typed. The
two optimizers do not agree on shape -- the heuristic discharges a flat rate
across one block, while the solver splits the battery across two separated
hours and spreads the van charging over six evening ones -- and a literal that
matched one of them would contradict the other's curve.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

from .generator import (
    HOURS,
    NOW_HOUR,
    OFF_PEAK_USD_PER_KWH,
    FlowComponents,
    HvacShareSpec,
    base_from_grid,
    flat,
    hour_range,
    hvac_profile,
    iso_hour,
    js_round,
    metered_actuals,
    next_day_iso,
    energy_phrase,
    round1,
    solver_label,
    round2,
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
#: This is the site-pinned shape, which the heuristic honours and the solver is
#: free to improve on, so nothing in the prose below reads these directly.
STAYING_VANS = [math.ceil(n / 2) for n in BASELINE_VANS]
MOVED_VANS = [n // 2 for n in BASELINE_VANS]

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
        "solver": solver_label(),
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
# Reading the dispatch back                                                    #
# --------------------------------------------------------------------------- #
#
# The heuristic shaves a flat rate across one contiguous block. The CP-SAT
# solver varies the rate hour to hour, and on this site it splits the battery
# across two separated hours and spreads the van charging over six evening
# ones. So a row cannot state a window, a rate or a dollar figure that was
# typed: it has to describe whatever the dispatch turned out to be. These
# helpers do that describing once, for both optimizers.


def _clock(hour: int) -> str:
    """Wall-clock label for an hour. 24 reads as midnight, not 24:00."""
    return "%02d:00" % (hour % HOURS)


def _runs(hours: list[int]) -> list[list[int]]:
    """Ascending hours grouped into runs of consecutive hours."""
    active = sorted(hours)
    if not active:
        return []
    grouped: list[list[int]] = [[active[0]]]
    for hour in active[1:]:
        if hour == grouped[-1][-1] + 1:
            grouped[-1].append(hour)
        else:
            grouped.append([hour])
    return grouped


def _span(hours: list[int]) -> str:
    """
    The clock phrase for the hours a lever is actually active.

    One run of consecutive hours reads as a block, "14:00-17:00", with the end
    exclusive. A split dispatch reads as the hours themselves, "14:00 and
    22:00", because calling that a block would describe a shed that never
    happened in the gap.
    """
    grouped = _runs(hours)
    if not grouped:
        return ""
    parts = [
        f"{_clock(run[0])}-{_clock(run[-1] + 1)}" if len(run) > 1 else _clock(run[0])
        for run in grouped
    ]
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _edge(hour: int) -> str:
    """A window edge as a timestamp. Ends are exclusive, so hour 24 is midnight."""
    return next_day_iso(0) if hour >= HOURS else iso_hour(hour)


def _hours_at_peak(r: "OptimizationResult") -> int:
    """How many hours of the optimized curve sit at its own maximum."""
    return sum(1 for kw in r.optimized_grid if abs(kw - r.optimized_peak_kw) <= 0.05)


def _house_peak_kw(r: "OptimizationResult") -> float:
    """The site's worst hour with the vans taken back out of it."""
    return max(r.baseline_grid[h] - r.baseline_parts.ev[h] for h in range(HOURS))


def _deepest_ev_cut_kw(r: "OptimizationResult") -> float:
    """The most any single hour gives up out of the charging block."""
    return round1(max((-kw for kw in r.ev_delta_kw.values() if kw < 0), default=0.0))


def _battery_rate_phrase(r: "OptimizationResult") -> str:
    """One flat rate, or the deepest of several."""
    if len(set(r.battery_discharge_kw.values())) == 1:
        return f"a flat {r.battery_flat_kw:.0f} kW"
    return f"{r.battery_flat_kw:.0f} kW at the deepest hour"


def _battery_sentence(r: "OptimizationResult") -> str:
    """What the pack does, whatever shape the dispatch came out in."""
    if not r.battery_hours:
        return (
            "The battery is left alone: this schedule found nothing worth doing with "
            "it, so there is no discharge to approve."
        )
    head = (
        f"The battery runs at {_span(r.battery_hours)} at {_battery_rate_phrase(r)}, "
        f"{r.battery_kwh:.0f} kWh in all."
    )
    if r.battery_cut_at_peak_kw > 0:
        return (
            f"{head} That takes {r.battery_cut_at_peak_kw:.0f} kW straight off the "
            f"{r.baseline_peak_hour}:00 peak."
        )
    return (
        f"{head} None of it lands on the {r.baseline_peak_hour}:00 peak hour, so it "
        "takes nothing off the baseline peak; what it does is hold down the hours that "
        "would otherwise stand above the rest of the day once the vans have moved."
    )


# --------------------------------------------------------------------------- #
# Plan                                                                         #
# --------------------------------------------------------------------------- #


def plan_summary(r: "OptimizationResult") -> str:
    peak_ev_kw = r.baseline_parts.ev[r.baseline_peak_hour]
    level_hours = _hours_at_peak(r)
    level = (
        f", and the curve sits level at that figure for {level_hours} hours, so there"
        " is nothing left to flatten"
        if level_hours > 1
        else ""
    )
    return " ".join(
        [
            f"Today's forecast peaks at {r.baseline_peak_kw:.0f} kW at",
            f"{r.baseline_peak_hour}:00, {r.baseline_peak_kw - r.threshold_kw:.0f} kW above",
            f"the {r.threshold_kw:.0f} kW threshold, and the cause is unambiguous: the",
            f"building itself never draws more than about {_house_peak_kw(r):.0f} kW, and",
            f"the other {peak_ev_kw:.0f} kW is 24 delivery vans charging at once between",
            "13:00 and 17:00. So the plan does not shed anything, it re-queues.",
            f"{r.ev_shifted_kwh:.0f} kWh of van charging comes out of",
            f"{_span(r.ev_shift_from_hours)} and the same energy goes back in at",
            f"{_span(r.ev_shift_to_hours)}, and because the vans are not back on route",
            "until 05:00 nobody waits on a charge.",
            _battery_sentence(r),
            f"Peak falls from {r.baseline_peak_kw:.0f} kW to {r.optimized_peak_kw:.0f} kW,",
            f"a {r.peak_reduction_kw:.0f} kW cut worth about",
            f"${r.demand_charge_avoided_usd:.2f} on the demand charge, while",
            f"{energy_phrase(r.savings_usd, 'the day-ahead energy bill')}. There is",
            "deliberately no HVAC",
            "action: an unconditioned high bay with dock doors cycling has no thermal",
            "mass to pre-cool and no comfort band to borrow against, so offering one",
            f"would be theatre. The new binding interval is {r.optimized_peak_hour}:00 at",
            f"{r.optimized_peak_kw:.0f} kW,",
            f"{r.threshold_kw - r.optimized_peak_kw:.0f} kW under threshold{level}.",
        ]
    )


def build_actions(r: "OptimizationResult") -> list[dict[str, Any]]:
    charger_limit_kw = BUILDING["ev_bays"] * VAN_CHARGER_KW
    capacity_kwh = BUILDING["battery_capacity_kwh"]

    # -- the fleet ---------------------------------------------------------- #
    ev_start, ev_end = r.ev_window
    from_span = _span(r.ev_shift_from_hours)
    to_span = _span(r.ev_shift_to_hours)
    deepest_cut_kw = _deepest_ev_cut_kw(r)
    busiest_ev_kw = round1(max(r.optimized_parts.ev)) if r.optimized_parts.ev else 0.0

    if r.ev_delta_kw:
        ev_title = f"Re-queue {r.ev_shifted_kwh:.0f} kWh of van charging into {to_span}"
        ev_lines = [
            "The vans are the peak, so the schedule re-queues them rather than "
            f"shedding anything. {r.ev_shifted_kwh:.0f} kWh comes out of {from_span} "
            f"and the same {r.ev_shifted_kwh:.0f} kWh goes back in at {to_span}, at "
            f"{VAN_CHARGER_KW} kW a bay.",
            f"The hour that gives up the most sheds {deepest_cut_kw:.0f} kW, and the "
            f"busiest charging hour left anywhere in the day is {busiest_ev_kw:.0f} kW "
            f"against the {charger_limit_kw} kW site limit.",
            "The day's van energy is identical either way, so every vehicle reaches "
            "the same state of charge, and the fleet does not leave the yard until "
            "05:00, which is six hours of slack.",
        ]
        if r.ev_cut_at_peak_kw > 0:
            ev_lines.append(
                f"At the {r.baseline_peak_hour}:00 peak interval this takes "
                f"{r.ev_cut_at_peak_kw:.0f} kW off the site."
            )
        else:
            ev_lines.append(
                f"None of the charging it moves sat on the {r.baseline_peak_hour}:00 "
                "peak interval, so it takes nothing off the baseline peak."
            )
    else:
        ev_title = "No van charging moved"
        ev_lines = [
            "This schedule leaves the charging block exactly where it is. No session "
            "is re-queued and no charge is held back, so there is nothing here to "
            "approve and no saving to claim."
        ]

    # -- the pack ----------------------------------------------------------- #
    batt_start, batt_end = r.battery_window
    batt_span = _span(r.battery_hours)
    recharge_in_day = {h: round1(-kw) for h, kw in r.battery_delta_kw.items() if kw < 0}
    soc_floor_pct = (
        round1(min(r.optimized_parts.soc)) if r.optimized_parts.soc else r.end_soc_pct
    )

    if r.battery_hours:
        batt_title = f"Discharge battery {r.battery_kwh:.0f} kWh at {batt_span}"
        batt_lines = [
            f"Dispatch {r.battery_kwh:.0f} kWh from the {capacity_kwh} kWh pack at "
            f"{batt_span}, {_battery_rate_phrase(r)} against a "
            f"{r.inverter_kw:.0f} kW inverter."
        ]
        if len(_runs(r.battery_hours)) > 1:
            batt_lines.append(
                "Those hours are separated rather than one block, and the pack sits "
                "idle in between."
            )
        if recharge_in_day:
            batt_lines.append(
                f"Charging of {sum(recharge_in_day.values()):.0f} kWh at "
                f"{_span(sorted(recharge_in_day))} keeps the pack whole inside the "
                "same day, billed at the price of those hours."
            )
        elif r.battery_recharge_kwh > 0:
            batt_lines.append(
                f"The pack is refilled with {r.battery_recharge_kwh:.0f} kWh overnight "
                f"at the ${OFF_PEAK_USD_PER_KWH:.2f} rate, after this window."
            )
        if abs(r.end_soc_pct - r.start_soc_pct) < 0.05:
            batt_lines.append(
                "State of charge ends the run where it started, at "
                f"{r.start_soc_pct:.0f}%, and never drops below {soc_floor_pct:.0f}% "
                f"against a {r.reserve_floor_pct:.0f}% floor."
            )
        else:
            batt_lines.append(
                f"State of charge goes from {r.start_soc_pct:.0f}% to "
                f"{r.end_soc_pct:.0f}%, never below {soc_floor_pct:.0f}% against a "
                f"{r.reserve_floor_pct:.0f}% floor."
            )
        if r.battery_cut_at_peak_kw > 0:
            batt_lines.append(
                f"At the {r.baseline_peak_hour}:00 peak interval it takes "
                f"{r.battery_cut_at_peak_kw:.0f} kW off the site."
            )
        else:
            batt_lines.append(
                f"It does not run at the {r.baseline_peak_hour}:00 peak interval, so "
                "its contribution to the baseline peak reduction is zero; the hours it "
                "does run are the ones that would otherwise stand above the rest of "
                "the day after the van shift."
            )
        # The overnight refill is billed against the plan, not against this
        # lever, so a row whose recharge falls outside the window has to say
        # what it left out or its dollar figure will not reconcile with the
        # headline the reader is holding it against.
        refill_cost_usd = round2(r.battery_recharge_kwh * OFF_PEAK_USD_PER_KWH)
        if r.battery_savings_usd > 0.005:
            batt_lines.append(
                "At the tariff the discharged energy is worth "
                f"${r.battery_savings_usd:.2f}."
            )
            if refill_cost_usd > 0.005:
                batt_lines.append(
                    f"The overnight refill costs ${refill_cost_usd:.2f} and is billed "
                    "against the plan rather than against this row, so the battery is "
                    f"worth ${round2(r.battery_savings_usd - refill_cost_usd):.2f} net "
                    "today."
                )
        elif r.battery_savings_usd < -0.005:
            batt_lines.append(
                "At the tariff the round trip costs "
                f"${-r.battery_savings_usd:.2f} of energy, which the peak work pays for."
            )
        else:
            batt_lines.append(
                "At the tariff it is worth $0.00: the energy the pack buys back costs "
                "exactly what the discharge saves. This is load shaping, not "
                "arbitrage, and it should not be approved expecting a spread."
            )
        batt_lines.append(
            "It also leaves headroom if a route runs late and the afternoon cohort "
            "arrives bunched."
        )
    else:
        batt_title = "No battery discharge today"
        batt_lines = [
            "This schedule leaves the pack at its baseline. Nothing is discharged and "
            "nothing is bought back, so there is no shed here to approve and no "
            "energy value either way. State of charge holds at "
            f"{r.start_soc_pct:.0f}% against a {r.reserve_floor_pct:.0f}% floor."
        ]

    return [
        {
            "type": "ev_charging_shift",
            "title": ev_title,
            "description": " ".join(ev_lines),
            "start_time": _edge(ev_start),
            "end_time": _edge(ev_end),
            "magnitude": deepest_cut_kw,
            "unit": "kW",
            "estimated_peak_reduction_kw": r.ev_cut_at_peak_kw,
            "estimated_savings_usd": r.ev_savings_usd,
            "constraints_checked": [
                "all_vans_full_by_0500_departure",
                "site_charger_limit_264kw",
                "per_bay_limit_11kw",
                "no_van_session_split_across_gaps",
            ],
        },
        {
            "type": "battery_discharge",
            "title": batt_title,
            "description": " ".join(batt_lines),
            "start_time": _edge(batt_start),
            "end_time": _edge(batt_end),
            "magnitude": r.battery_flat_kw,
            "unit": "kW",
            "estimated_peak_reduction_kw": r.battery_cut_at_peak_kw,
            "estimated_savings_usd": r.battery_savings_usd,
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
    charger_limit_kw = BUILDING["ev_bays"] * VAN_CHARGER_KW
    fleet_kw = r.baseline_parts.ev[r.baseline_peak_hour]
    fleet_share_pct = round((fleet_kw / r.baseline_peak_kw) * 100)
    first_over = (
        r.first_exceedance_hour
        if r.first_exceedance_hour is not None
        else r.baseline_peak_hour
    )
    busiest_ev_kw = round1(max(r.optimized_parts.ev)) if r.optimized_parts.ev else 0.0
    level_hours = _hours_at_peak(r)
    level_tail = (
        f", and {level_hours} hours now sit at that same level -- there is nothing "
        "left to flatten."
        if level_hours > 1
        else "."
    )
    battery_decision = (
        f"and discharge the battery at {_span(r.battery_hours)}"
        if r.battery_hours
        else "and leave the battery at its baseline"
    )
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
                f"{r.hours_over_threshold} hours from {first_over}:00. Note the shape -- "
                f"the site is at {r.baseline_grid[12]:.0f} kW at noon and "
                f"{r.baseline_grid[13]:.0f} kW an hour later. That is not a building "
                "warming up, that is something plugging in."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_electricity_prices",
            invoke="get_electricity_prices",
            message=(
                "Tariff loaded. $0.09/kWh off-peak, $0.16/kWh from 14:00 to 20:00, "
                "$8.50/kW monthly demand charge. Worth noting that 18:00-20:00 is still "
                "on-peak, so charge moved only that far saves demand charge but not "
                "energy. Anything that reaches 20:00 or later saves both."
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
                f"{fleet_kw:.0f} kW of them at the peak hour, which is "
                f"{fleet_share_pct}% of it. They do not depart until 05:00, so every "
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
                "create the peak and every van has six hours of slack, moving charge "
                "into the evening is worth more than anything the battery can do -- and "
                "it costs nobody anything. I will let the optimizer decide where that "
                "charge lands, and what if anything the battery should do on top."
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
                "solver": solver_label(),
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
                f"moving {r.ev_shifted_kwh:.0f} kWh of van charging out of "
                f"{_span(r.ev_shift_from_hours)} into {_span(r.ev_shift_to_hours)}. The "
                f"binding interval moves to {r.optimized_peak_hour}:00 at "
                f"{r.optimized_peak_kw:.0f} kW{level_tail}"
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
                f"the busiest charging hour in the schedule is {busiest_ev_kw:.0f} kW "
                f"against the {charger_limit_kw} kW site limit. Battery ends at "
                f"{r.end_soc_pct:.0f}%, well clear of the {r.reserve_floor_pct:.0f}% "
                "floor."
            ),
        ),
        Step(
            type="decision",
            tool="save_action_plan",
            invoke="save_action_plan",
            message=(
                f"Committing a two-action plan: re-queue {r.ev_shifted_kwh:.0f} kWh of "
                f"van charging into {_span(r.ev_shift_to_hours)}, {battery_decision}. "
                "No HVAC action -- there is no flexibility there to recommend."
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
