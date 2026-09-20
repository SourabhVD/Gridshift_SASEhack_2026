"""
sea-office-001 -- Cascade Commerce Center. The default building.

Ported from frontend/src/mocks/buildings/office.ts. The published curves are
unchanged; the optimized curve is computed by services/optimizer.py and every
number and clock time in the prose below is formatted from that result.

Two optimizers reach that result and they do not produce the same shape, which
is why nothing here is typed by hand:

  * GRIDSHIFT_OPTIMIZER=heuristic replays the DispatchPolicy at the bottom of
    this module. That is a flat 90 kW battery block over 14:00-17:00, four
    fleet vans moved to the evening, and a pre-cool followed by two hours of
    setpoint drift.
  * The CP-SAT default derives its own dispatch. On this building it varies
    the battery rate hour by hour, thins EV charging across the whole afternoon
    and re-queues it late, and declines the HVAC lever outright.

A sentence that states a window therefore has to be built from the window the
lever actually used. The DispatchPolicy below and the table it implies are site
inputs for the heuristic path, not a description of what the default optimizer
will do.

base_kw is identical between the baseline and the optimized curve either way,
which is the point: no action in this plan changes what the building actually
needs, only when and from where it is served.
"""

from __future__ import annotations

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
    next_day_iso,
    energy_phrase,
    round1,
    solver_label,
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
        "solver": solver_label(),
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

PRICES = TOOL_FACTS["get_electricity_prices"]
BATTERY_FACTS = TOOL_FACTS["get_battery_state"]
EV_FACTS = TOOL_FACTS["get_ev_requirements"]
HVAC_FACTS = TOOL_FACTS["get_hvac_constraints"]
VALIDATION_FACTS = TOOL_FACTS["validate_schedule"]

#: What the six bays can pull together, which is the site's EV allocation.
EV_SITE_ALLOCATION_KW = BUILDING["ev_bays"] * EV_CHARGER_KW

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
# Formatting helpers                                                           #
# --------------------------------------------------------------------------- #


def _kw(value: float) -> str:
    """A kW figure carrying a decimal only when it has one: 90.0 -> 90."""
    return f"{round1(value):g}"


def _clock(hour: int) -> str:
    """An hour as a wall clock. An exclusive end of 24 reads as 00:00."""
    return "%02d:00" % (hour % HOURS)


def _stamp(hour: int) -> str:
    """ISO timestamp for a window edge. An exclusive end of 24 is next midnight."""
    return iso_hour(hour) if hour < HOURS else next_day_iso(0)


def _join(parts: list[str]) -> str:
    if len(parts) <= 1:
        return parts[0] if parts else ""
    return ", ".join(parts[:-1]) + " and " + parts[-1]


#: Small counts read as words in a sentence, the way the rest of the prose does.
_NUMBER_WORDS = [
    "no", "one", "two", "three", "four", "five", "six",
    "seven", "eight", "nine", "ten", "eleven", "twelve",
]


def _count(value: int) -> str:
    return _NUMBER_WORDS[value] if 0 <= value < len(_NUMBER_WORDS) else str(value)


def _an(text: str) -> str:
    """'a' or 'an' in front of an interpolated figure: 84 kW takes 'an'."""
    digits = str(text).lstrip()
    return "an" if digits.startswith("8") or digits[:2] in ("11", "18") else "a"


def _seconds(ms: int) -> str:
    """A solve time that does not round a real 23 ms answer down to 0.0 s."""
    return f"{ms / 1000:.1f} s" if ms >= 1000 else f"{ms} ms"


def _runs(hours: list[int]) -> list[tuple[int, int]]:
    """The contiguous runs in a set of active hours, as (start, exclusive end)."""
    runs: list[list[int]] = []
    for h in sorted(hours):
        if runs and h == runs[-1][1]:
            runs[-1][1] = h + 1
        else:
            runs.append([h, h + 1])
    return [(start, end) for start, end in runs]


def _span(hours: list[int]) -> str:
    """
    How a lever's active hours read in a sentence.

    One block becomes a range. A split dispatch is named block by block
    instead, because a single range would claim hours the curve never touches.
    """
    blocks = _runs(hours)
    if not blocks:
        return ""
    return _join(
        [f"{_clock(a)}-{_clock(b)}" if b - a > 1 else _clock(a) for a, b in blocks]
    )


def _rates(series: dict[int, float]) -> str:
    """Hour by hour kW, for a lever whose rate is not the same every hour."""
    return _join([f"{_kw(kw)} kW at {_clock(h)}" for h, kw in sorted(series.items())])


def _battery_is_flat(r: "OptimizationResult") -> bool:
    return len(set(r.battery_discharge_kw.values())) == 1


def _ev_deadline_hour(key: str) -> int:
    """The hour out of an ISO deadline the EV tool reports."""
    return int(str(EV_FACTS["deadlines"][key])[11:13])


def _ev_cuts(r: "OptimizationResult") -> dict[int, float]:
    return {h: -kw for h, kw in r.ev_delta_kw.items() if kw < 0}


def _hvac_swing_f(r: "OptimizationResult") -> float:
    """The declared setpoint change, which is zero when nothing drifts."""
    if not r.hvac_drift_hours:
        return 0.0
    return float(HVAC_FACTS["max_setpoint_f"] - HVAC_FACTS["current_setpoint_f"])


# -- one clause per lever, shared by the summary, the actions and the script --


def _battery_clause(r: "OptimizationResult") -> str:
    hours = r.battery_hours
    if not hours:
        return "the battery holds at its baseline"
    if _battery_is_flat(r):
        return f"the battery carries {_kw(r.battery_flat_kw)} kW through {_span(hours)}"
    return (
        f"the battery discharges across {_span(hours)}, "
        f"peaking at {_kw(r.battery_flat_kw)} kW"
    )


def _ev_clause(r: "OptimizationResult") -> str:
    out_hours = r.ev_shift_from_hours
    into_hours = r.ev_shift_to_hours
    if not out_hours or not into_hours:
        return "the EV schedule stays where it is"
    return (
        f"{r.ev_shifted_kwh:.0f} kWh of EV charging moves out of {_span(out_hours)} "
        f"into {_span(into_hours)}"
    )


def _hvac_clause(r: "OptimizationResult") -> str:
    if not r.hvac_delta_kw:
        return f"the HVAC setpoint stays at {HVAC_FACTS['current_setpoint_f']}F all day"
    precool = r.hvac_precool_hours
    drift = r.hvac_drift_hours
    if precool and drift:
        span = _span(precool)
        return (
            f"{_an(span)} {span} pre-cool lets the setpoint float to "
            f"{HVAC_FACTS['max_setpoint_f']}F across {_span(drift)}"
        )
    if drift:
        return (
            f"the setpoint floats to {HVAC_FACTS['max_setpoint_f']}F "
            f"across {_span(drift)}"
        )
    return f"the HVAC plant pre-cools across {_span(precool)}"


# --------------------------------------------------------------------------- #
# Plan                                                                         #
# --------------------------------------------------------------------------- #


def plan_summary(r: "OptimizationResult") -> str:
    if r.battery_recharge_kwh > 0:
        cost_line = (
            f"{energy_phrase(r.savings_usd)} once the "
            f"{r.battery_recharge_kwh:.0f} kWh overnight battery recharge is paid back."
        )
    else:
        cost_line = (
            f"{energy_phrase(r.savings_usd)}, and the pack's own recharge is already "
            "inside that figure because it happens within the modelled day."
        )

    concerns: list[str] = []
    if r.hvac_delta_kw:
        concerns.append("the HVAC action is the one occupants can feel")
    if r.battery_hours:
        concerns.append(f"the pack is drawn down to {r.end_soc_pct:.0f}%")
    if r.ev_shift_to_hours:
        concerns.append(
            f"EV charging is pushed as late as {_clock(r.ev_shift_to_hours[-1])}"
        )
    reason = _join(concerns) if concerns else "the plan touches shared equipment"

    return " ".join(
        [
            f"Today's forecast peaks at {r.baseline_peak_kw:.0f} kW at",
            f"{_clock(r.baseline_peak_hour)}, {r.baseline_peak_kw - r.threshold_kw:.0f} kW",
            f"above the {r.threshold_kw:.0f} kW threshold, and stays over it for",
            f"{r.hours_over_threshold} hours. No single resource covers that gap, so all",
            "three levers went to the optimizer together. What came back:",
            f"{_battery_clause(r)}, {_ev_clause(r)}, and {_hvac_clause(r)}. Together they",
            f"cut the billing peak from {r.baseline_peak_kw:.0f} kW to",
            f"{r.optimized_peak_kw:.0f} kW. {cost_line} The real prize is the demand",
            f"charge, where {_an(f'{r.peak_reduction_kw:.0f}')} {r.peak_reduction_kw:.0f}",
            "kW lower peak avoids about",
            f"${r.demand_charge_avoided_usd:.2f} on this month's bill at",
            f"${PRICES['demand_charge_usd_per_kw']:.2f}/kW. This plan is routed for",
            f"approval rather than dispatched because {reason}.",
        ]
    )


def _battery_action(r: "OptimizationResult") -> dict[str, Any]:
    hours = r.battery_hours
    capacity_kwh = BUILDING["battery_capacity_kwh"]

    if not hours:
        title = "Hold the battery, no discharge in this plan"
        description = (
            "The optimizer found no hour where discharging the pack bought a lower "
            f"billing peak, so the {capacity_kwh:.0f} kWh battery is left alone and SOC "
            f"holds at {r.start_soc_pct:.0f}%. Nothing is asked of the inverter and "
            "there is no energy to buy back."
        )
    else:
        span = _span(hours)
        if _battery_is_flat(r):
            title = f"Discharge battery at {_kw(r.battery_flat_kw)} kW, {span}"
            rate_line = (
                f"The rate is flat at {_kw(r.battery_flat_kw)} kW, inside the "
                f"{r.inverter_kw:.0f} kW inverter rating."
            )
        else:
            title = (
                f"Discharge battery across {span}, peaking at {_kw(r.battery_flat_kw)} kW"
            )
            rate_line = (
                f"The rate is not flat: {_rates(r.battery_discharge_kw)}. The deepest "
                f"of those stays inside the {r.inverter_kw:.0f} kW inverter rating."
            )

        pieces = [
            f"Dispatch {r.battery_kwh:.0f} kWh from the {capacity_kwh:.0f} kWh pack "
            f"across {span}.",
            rate_line,
            f"SOC runs from {r.start_soc_pct:.0f}% at the start of the day to "
            f"{r.end_soc_pct:.0f}% when the discharge ends, clear of the "
            f"{r.reserve_floor_pct:.0f}% reserve floor.",
        ]

        charge_hours = sorted(h for h, kw in r.battery_delta_kw.items() if kw < 0)
        if r.battery_recharge_kwh > 0:
            pieces.append(
                f"The {r.battery_recharge_kwh:.0f} kWh recharge is billed back overnight "
                f"at the ${PRICES['off_peak_usd_per_kwh']:.2f}/kWh off-peak rate."
            )
        elif charge_hours:
            pieces.append(
                f"The pack is charged back inside the same day, at {_span(charge_hours)}, "
                "and that energy is already priced in the curve, so the dollar figure on "
                "this row is what the discharge is worth after paying to put it back."
            )
        description = " ".join(pieces)

    start, end = r.battery_window
    return {
        "type": "battery_discharge",
        "title": title,
        "description": description,
        "start_time": _stamp(start),
        "end_time": _stamp(end),
        "magnitude": r.battery_flat_kw,
        "unit": "kW",
        "estimated_peak_reduction_kw": r.battery_cut_at_peak_kw,
        # This lever's own worth at the tariff. The three rows sum to the plan.
        "estimated_savings_usd": r.battery_savings_usd,
        "constraints_checked": [
            "soc_reserve_floor_20pct",
            "max_discharge_250kw",
            "single_cycle_per_day",
            "recharge_window_available_overnight",
        ],
    }


def _ev_action(r: "OptimizationResult") -> dict[str, Any]:
    out_hours = r.ev_shift_from_hours
    into_hours = r.ev_shift_to_hours
    cuts = _ev_cuts(r)
    deepest_kw = round1(max(cuts.values())) if cuts else 0.0

    if not cuts or not into_hours:
        title = "Leave the EV schedule unchanged"
        description = (
            "The optimizer moved no charging. All "
            f"{_count(EV_FACTS['sessions_connected'])} connected sessions keep the hours "
            "they already have, so there is no shift here, no peak contribution and no "
            "saving to claim on this row."
        )
    else:
        title = (
            f"Move {r.ev_shifted_kwh:.0f} kWh of EV charging out of {_span(out_hours)} "
            f"into {_span(into_hours)}"
        )

        bays = deepest_kw / EV_CHARGER_KW
        whole_bays = round(bays)
        site_bays = int(BUILDING["ev_bays"])
        if whole_bays > 0 and abs(bays - whole_bays) < 0.05:
            share = (
                f"all {_count(site_bays)} bays"
                if whole_bays >= site_bays
                else f"{_count(whole_bays)} of the {_count(site_bays)} bays"
            )
            depth = f"{_kw(deepest_kw)} kW, which is {share} at {EV_CHARGER_KW} kW each"
        else:
            depth = (
                f"{_kw(deepest_kw)} kW against the "
                f"{_kw(EV_SITE_ALLOCATION_KW)} kW site allocation"
            )

        if len(set(cuts.values())) == 1:
            shape = f"Every hour in that block is cut by the same {depth}."
        else:
            shape = (
                f"The cut is not the same every hour. It deepens to {depth}, and the "
                "shallower hours are trimmed rather than stopped."
            )

        if r.ev_savings_usd > 0:
            money = (
                "The hours it lands in price lower than the hours it leaves, which is "
                f"where the ${r.ev_savings_usd:.2f} on this row comes from."
            )
        elif r.ev_savings_usd < 0:
            money = (
                "The hours it lands in price higher than the hours it leaves, so it "
                f"costs ${-r.ev_savings_usd:.2f} in energy and is bought back by the "
                "lower peak."
            )
        else:
            money = (
                "Energy cost is unchanged because the hours it leaves and the hours it "
                "lands in price the same. This action exists purely to take load out of "
                "the peak-setting interval."
            )

        pieces = [
            f"Take {r.ev_shifted_kwh:.0f} kWh of charging out of {_span(out_hours)} and "
            f"re-queue it at {_span(into_hours)}.",
            shape,
            f"{_count(EV_FACTS['sessions_connected']).capitalize()} sessions are "
            f"connected: {_count(EV_FACTS['flexible_sessions'])} fleet vans are the "
            f"flexible ones and {_count(EV_FACTS['locked_sessions'])} staff vehicles "
            f"depart at {_clock(_ev_deadline_hour('departing'))}.",
            "Total EV energy over the day is unchanged, so this moves load rather than "
            "removing it.",
            money,
        ]

        fleet_hour = _ev_deadline_hour("fleet")
        if into_hours[-1] >= fleet_hour:
            pieces.append(
                f"The last re-queued block sits at {_clock(into_hours[-1])}, later than "
                f"the {_clock(fleet_hour)} fleet deadline the charging tool reports, so "
                "that is the thing to check before approving."
            )
        description = " ".join(pieces)

    start, end = r.ev_window
    return {
        "type": "ev_charging_shift",
        "title": title,
        "description": description,
        "start_time": _stamp(start),
        "end_time": _stamp(end),
        "magnitude": deepest_kw,
        "unit": "kW",
        "estimated_peak_reduction_kw": r.ev_cut_at_peak_kw,
        "estimated_savings_usd": r.ev_savings_usd,
        "constraints_checked": [
            "ev_target_soc_80pct_met",
            "deadline_1800_respected_for_2_departing",
            "deadline_2200_respected_for_4_fleet",
            "site_charger_limit_69kw",
        ],
    }


def _hvac_action(r: "OptimizationResult") -> dict[str, Any]:
    current_f = HVAC_FACTS["current_setpoint_f"]
    max_f = HVAC_FACTS["max_setpoint_f"]
    precool_f = HVAC_FACTS["min_precool_setpoint_f"]
    band = HVAC_FACTS["occupied_band_f"]
    allowed_hours = HVAC_FACTS["max_drift_hours"]
    swing_f = _hvac_swing_f(r)

    precool = r.hvac_precool_hours
    drift = r.hvac_drift_hours
    coast = [h for h, kw in sorted(r.hvac_delta_kw.items()) if kw < 0 and h not in drift]

    if not r.hvac_delta_kw:
        title = "No HVAC change in this plan"
        description = (
            f"The optimizer left the setpoint at {current_f}F for the whole day. It "
            "found no hour where pre-cooling and then letting the zones drift bought a "
            "lower peak than the battery and the EV schedule already deliver, so there "
            "is no shed on this row, no dollars, and nothing occupants can feel. The "
            f"{max_f}F ceiling, the {_count(allowed_hours)} permitted drift hours and "
            f"the {band[0]}-{band[1]}F occupied band all go unused."
        )
    else:
        if precool and drift:
            title = (
                f"Pre-cool {_span(precool)}, then float setpoint "
                f"+{swing_f:.0f}F at {_span(drift)}"
            )
        elif drift:
            title = f"Float setpoint +{swing_f:.0f}F at {_span(drift)}"
        else:
            title = f"Pre-cool {_span(precool)}, no setpoint drift"

        pieces = []
        if precool:
            pieces.append(
                f"Drop to {precool_f}F across {_span(precool)} to bank thermal mass."
            )
        if drift:
            allowance = (
                f"which uses the full {_count(allowed_hours)} hours of drift the site "
                "permits"
                if len(drift) >= allowed_hours
                else f"which is {_count(len(drift))} of the {_count(allowed_hours)} "
                "drift hours the site permits"
            )
            pieces.append(
                f"Let the setpoint rise from {current_f}F to {max_f}F across "
                f"{_span(drift)}, {allowance} and stays inside the "
                f"{band[0]}-{band[1]}F occupied comfort band."
            )
        if coast:
            pieces.append(
                f"The zones also sit below baseline at {_span(coast)}, coasting on the "
                "banked mass at an unchanged setpoint, which is not drift."
            )
        pieces.append(
            f"The deepest hourly shed is {_kw(r.hvac_shed_kw)} kW; at the "
            f"{_clock(r.baseline_peak_hour)} baseline peak this action takes off "
            f"{_kw(r.hvac_cut_at_peak_kw)} kW."
        )
        description = " ".join(pieces)

    # A lever that did nothing has a zero-length window, and that is what the
    # row carries: the honest alternative to a start and end it never had.
    start, end = r.hvac_window
    return {
        "type": "hvac_setpoint",
        "title": title,
        "description": description,
        "start_time": _stamp(start),
        "end_time": _stamp(end),
        "magnitude": swing_f,
        "unit": "°F",
        "estimated_peak_reduction_kw": r.hvac_cut_at_peak_kw,
        "estimated_savings_usd": r.hvac_savings_usd,
        "constraints_checked": [
            "zone_temp_max_75f",
            "max_drift_duration_2h",
            "occupied_comfort_band_68_75f",
            "precool_min_setpoint_70f",
        ],
    }


def build_actions(r: "OptimizationResult") -> list[dict[str, Any]]:
    return [_battery_action(r), _ev_action(r), _hvac_action(r)]


# --------------------------------------------------------------------------- #
# Scripted run                                                                 #
# --------------------------------------------------------------------------- #


def _binding_interval_note(r: "OptimizationResult") -> str:
    """Why the optimized peak sits where it does, read off the optimized curve."""
    at_peak = [
        h for h, kw in enumerate(r.optimized_grid) if abs(kw - r.optimized_peak_kw) < 0.05
    ]
    if len(at_peak) > 1:
        return (
            f"The optimized curve is flat at {r.optimized_peak_kw:.0f} kW for "
            f"{len(at_peak)} hours of the day, so there is no single interval left to "
            "shave: anything further would have to lift the whole ceiling."
        )
    note = (
        f"Note the new peak is set by {_clock(r.optimized_peak_hour)}, not "
        f"{_clock(r.baseline_peak_hour)}"
    )
    if r.ev_delta_kw.get(r.optimized_peak_hour, 0.0) > 0:
        note += ", where the re-queued EV load becomes the binding interval"
    return note + f", so shedding harder at {_clock(r.baseline_peak_hour)} would not help."


def _validation_note(r: "OptimizationResult") -> str:
    if r.battery_hours:
        # "above the floor" stopped being true the day the engine took over:
        # it runs this pack down to exactly 20%, which is a fact worth saying
        # out loud rather than papering over, because it is the reason the
        # plan wants a human.
        margin = round1(r.end_soc_pct - r.reserve_floor_pct)
        where = (
            f"on the {r.reserve_floor_pct:.0f}% floor exactly, with nothing to spare"
            if margin <= 0.05
            else f"{margin:g} points above the {r.reserve_floor_pct:.0f}% floor"
        )
        battery_line = f"The pack ends its discharge at {r.end_soc_pct:.0f}% SOC, {where}."
    else:
        battery_line = "The battery was not dispatched, so the reserve floor is untouched."

    if r.ev_shift_to_hours:
        ev_line = (
            "EV energy over the day is conserved exactly and the re-queued charging "
            f"runs {_span(r.ev_shift_to_hours)}."
        )
    else:
        ev_line = "No EV session moved, so every deadline keeps the slack it started with."

    if r.hvac_delta_kw:
        hvac_line = (
            f"HVAC drift is {_count(len(r.hvac_drift_hours))} hours and tops out at "
            f"{HVAC_FACTS['max_setpoint_f']}F."
        )
    else:
        hvac_line = "HVAC was not touched, so no comfort constraint is engaged at all."

    return " ".join(
        [
            f"All {VALIDATION_FACTS['constraints_checked']} constraints pass.",
            battery_line,
            ev_line,
            hvac_line,
        ]
    )


def build_script(r: "OptimizationResult") -> list[Step]:
    over_hours = r.over_threshold_hours
    consecutive = "consecutive " if len(_runs(over_hours)) == 1 else ""

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
                f"Peak confirmed: {r.baseline_peak_kw:.0f} kW at "
                f"{_clock(r.baseline_peak_hour)}, "
                f"{r.baseline_peak_kw - r.threshold_kw:.0f} kW over the "
                f"{r.threshold_kw:.0f} kW threshold. The building stays above threshold "
                f"for {r.hours_over_threshold} {consecutive}hours, {_span(over_hours)}."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_electricity_prices",
            invoke="get_electricity_prices",
            message=(
                f"Tariff loaded. Energy is ${PRICES['off_peak_usd_per_kwh']:.2f}/kWh "
                f"off-peak and ${PRICES['on_peak_usd_per_kwh']:.2f}/kWh from "
                f"{PRICES['on_peak_window']}, but the real cost here is the "
                f"${PRICES['demand_charge_usd_per_kw']:.2f}/kW monthly demand charge set "
                "by the single highest interval."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_battery_state",
            invoke="get_battery_state",
            message=(
                f"Battery is at {r.start_soc_pct:.0f}% SOC, "
                f"{BATTERY_FACTS['available_kwh']:.0f} kWh available against a "
                f"{BUILDING['battery_capacity_kwh']:.0f} kWh pack and a "
                f"{r.inverter_kw:.0f} kW inverter. A {r.reserve_floor_pct:.0f}% reserve "
                f"floor is contractual, so {r.dispatchable_kwh:.0f} kWh is genuinely "
                "dispatchable today."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_ev_requirements",
            invoke="get_ev_requirements",
            message=(
                f"{_count(EV_FACTS['sessions_connected']).capitalize()} EVs are plugged "
                f"in. {_count(EV_FACTS['locked_sessions']).capitalize()} are staff "
                f"vehicles departing at {_clock(_ev_deadline_hour('departing'))} and "
                f"must reach {EV_FACTS['target_soc_pct']}% by then; the other "
                f"{_count(EV_FACTS['flexible_sessions'])} are fleet vans that only need "
                f"{EV_FACTS['target_soc_pct']}% by "
                f"{_clock(_ev_deadline_hour('fleet'))}. Those "
                f"{_count(EV_FACTS['flexible_sessions'])} are movable."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_hvac_constraints",
            invoke="get_hvac_constraints",
            message=(
                f"HVAC is at a {HVAC_FACTS['current_setpoint_f']}F setpoint and may "
                f"drift to {HVAC_FACTS['max_setpoint_f']}F for at most "
                f"{_count(HVAC_FACTS['max_drift_hours'])} hours while occupied. "
                "Pre-cooling to "
                f"{HVAC_FACTS['min_precool_setpoint_f']}F beforehand is permitted, which "
                "buys back most of the comfort cost."
            ),
        ),
        Step(
            type="thinking",
            message=(
                f"I have three levers: {r.dispatchable_kwh:.0f} kWh of battery, "
                f"{_count(EV_FACTS['flexible_sessions'])} movable EV sessions, and a "
                f"{_count(HVAC_FACTS['max_drift_hours'])}-hour HVAC drift. None of them "
                "alone "
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
                "solver": solver_label(),
            },
            delay_ms=2400,
        ),
        Step(
            type="tool_result",
            tool="run_schedule_optimizer",
            invoke="run_schedule_optimizer",
            message=(
                f"Solver returned an optimal schedule in {_seconds(r.solve_time_ms)}. "
                f"Peak drops from {r.baseline_peak_kw:.0f} kW to "
                f"{r.optimized_peak_kw:.0f} kW, "
                f"{_an(f'{r.peak_reduction_kw:.0f}')} {r.peak_reduction_kw:.0f} kW cut. "
                f"{_binding_interval_note(r)}"
            ),
            duration_ms=r.solve_time_ms,
        ),
        Step(
            type="tool_result",
            tool="validate_schedule",
            invoke="validate_schedule",
            message=_validation_note(r),
        ),
        Step(
            type="decision",
            tool="save_action_plan",
            invoke="save_action_plan",
            message=(
                f"Committing a three-action plan: {_battery_clause(r)}, "
                f"{_ev_clause(r)}, and {_hvac_clause(r)}."
            ),
        ),
        Step(
            type="tool_call",
            tool="request_human_approval",
            invoke="request_human_approval",
            message=(
                (
                    "The HVAC action changes occupant comfort, so this plan needs a "
                    "human. "
                    if r.hvac_delta_kw
                    else (
                        "Nothing in this plan changes occupant comfort, but it draws the "
                        f"pack down to {r.end_soc_pct:.0f}% and moves EV charging into "
                        "the late evening, so it still needs a human. "
                    )
                )
                + "Sending all three actions to the facility manager for approval."
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
