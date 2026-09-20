"""
sea-hospital-002 -- Harborview Medical Annex. The hard case.

Ported from frontend/src/mocks/buildings/hospital.ts.

A hospital never really turns off: the overnight floor sits around 600 kW and
the midday plateau runs 830-884 kW, six hours of it over the 800 kW threshold.
HVAC is the dominant load, the battery carries a 30% critical-care reserve
floor instead of the usual 20%, and only two of the four ambulance chargers may
be moved at all.

The reserve floor is what makes this site the hard one. The inverter is rated
400 kW and an unconstrained pack would have run 110 kW, but 76% SOC minus a 30%
floor is 368 kWh against a six-hour block, so it is energy rather than power
that decides how deep the discharge can go.

The DispatchPolicy below pins the flat 60 kW answer, which is what the
heuristic dispatches. The CP-SAT solver is free to charge the pack first and
vary the rate hour by hour, and it does. So nothing in the prose below assumes
either shape: every clock time, kW and dollar figure in the plan, the actions
and the script is read off the OptimizationResult, including the state-of-charge
walk against the 30% floor.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Iterable

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
    next_day_iso,
    piecewise,
    energy_phrase,
    round1,
    solver_label,
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
        "solver": solver_label(),
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
# Saying what the dispatch actually did                                        #
# --------------------------------------------------------------------------- #
#
# The text below used to be written around the heuristic's shape: one flat rate
# across one contiguous window. A solver varies the rate hour by hour and may
# split a lever across separated hours, which left rows stating windows their
# own curve contradicted. So every clock time, kW and dollar figure here is
# formatted from the result. These helpers only format. They decide nothing.

#: The declared non-clinical setpoint change, in F. The HVAC row's magnitude.
DRIFT_F = TOOL_FACTS["get_hvac_constraints"]["max_drift_f"]
#: What the two clinically movable ambulance chargers draw between them.
MOVABLE_EV_KW = TOOL_FACTS["get_ev_requirements"]["flexible_sessions"] * EV_CHARGER_KW
#: The overnight rate an out-of-window recharge is billed back at.
OFF_PEAK_USD_PER_KWH = TOOL_FACTS["get_electricity_prices"]["off_peak_usd_per_kwh"]


def _clock(hour: int) -> str:
    """Wall-clock label for an hour boundary. Hour 24 is the end of the day."""
    return "%02d:00" % (hour % 24)


def _end_iso(hour: int) -> str:
    """End timestamp for a window, rolling into the next day at midnight."""
    return next_day_iso(0) if hour >= 24 else iso_hour(hour)


def _num(value: float) -> str:
    """A kW, a kWh or a percentage point, without a pointless trailing .0."""
    return ("%.0f" if abs(value - round(value)) < 0.05 else "%.1f") % value


def _points(margin: float) -> str:
    return "point" if abs(margin - 1) < 0.05 else "points"


def _join(parts: list[str]) -> str:
    if len(parts) < 2:
        return parts[0] if parts else ""
    return "%s and %s" % (", ".join(parts[:-1]), parts[-1])


def _runs(hours: Iterable[int]) -> list[list[int]]:
    """The hours grouped into runs of consecutive ones."""
    out: list[list[int]] = []
    for h in sorted(hours):
        if out and h == out[-1][-1] + 1:
            out[-1].append(h)
        else:
            out.append([h])
    return out


def _hours_phrase(hours: Iterable[int]) -> str:
    """
    When a lever was active, in plain English.

    A run of consecutive hours reads as one window with an exclusive end, the
    same convention start_time and end_time carry. Separated hours are listed
    out instead, so a split dispatch can never read as a block.
    """
    parts: list[str] = []
    for run in _runs(hours):
        if len(run) > 1:
            parts.append("%s to %s" % (_clock(run[0]), _clock(run[-1] + 1)))
        else:
            parts.append(_clock(run[0]))
    return _join(parts)


def _window_label(window: tuple[int, int]) -> str:
    """The compact form a title carries: 12:00-19:00."""
    start, end = window
    return "%s-%s" % (_clock(start), _clock(end))


def _is_flat(discharge: dict[int, float]) -> bool:
    return len(set(discharge.values())) == 1


def _battery_shape(r: "OptimizationResult") -> str:
    """How the pack runs, in one phrase: flat, or varying and how deep."""
    hours = r.battery_hours
    if not hours:
        return ""
    if _is_flat(r.battery_discharge_kw):
        return "a flat %s kW across %s" % (_num(r.battery_flat_kw), _hours_phrase(hours))
    deepest = max(hours, key=lambda h: r.battery_discharge_kw[h])
    return "a rate that changes every hour across %s, deepest at %s kW at %s" % (
        _hours_phrase(hours),
        _num(r.battery_flat_kw),
        _clock(deepest),
    )


def _ev_deepest(r: "OptimizationResult") -> tuple[int | None, float]:
    """The hour the EV shift takes the most out, and how much it takes."""
    removals = {h: -kw for h, kw in r.ev_delta_kw.items() if kw < 0}
    if not removals:
        return None, 0.0
    hour = max(removals, key=lambda h: removals[h])
    return hour, round1(removals[hour])


def _charge_hours(r: "OptimizationResult") -> list[int]:
    """The hours the pack is filling rather than discharging."""
    return sorted(h for h, kw in r.battery_delta_kw.items() if kw < 0)


# --------------------------------------------------------------------------- #
# Plan                                                                         #
# --------------------------------------------------------------------------- #


def plan_summary(r: "OptimizationResult") -> str:
    capacity_kwh = float(BUILDING["battery_capacity_kwh"])
    held_kwh = capacity_kwh * r.start_soc_pct / 100
    floor_margin = round1(r.end_soc_pct - r.reserve_floor_pct)
    charge_hours = _charge_hours(r)
    before_run = [h for h in charge_hours if r.battery_hours and h < r.battery_hours[0]]
    after_run = [h for h in charge_hours if r.battery_hours and h > r.battery_hours[-1]]

    parts = [
        f"Today's forecast peaks at {_num(r.baseline_peak_kw)} kW at",
        f"{_clock(r.baseline_peak_hour)} and stays above the {_num(r.threshold_kw)} kW",
        f"threshold for {r.hours_over_threshold} straight hours,",
        f"{_hours_phrase(r.over_threshold_hours)}.",
        "That length is the binding constraint, not the height: the pack holds",
        f"{_num(held_kwh)} kWh at {_num(r.start_soc_pct)}% SOC but the critical-care",
        f"policy reserves {_num(r.reserve_floor_pct)}% of it, leaving",
        f"{_num(r.dispatchable_kwh)} kWh to work with from where it sits now.",
    ]

    if r.battery_hours:
        parts.append(f"The battery runs at {_battery_shape(r)},")
        parts.append(f"{_num(r.battery_kwh)} kWh in all.")
        if before_run and r.battery_kwh > r.dispatchable_kwh:
            parts.append(
                f"That is more than the {_num(r.dispatchable_kwh)} kWh sitting above the "
                f"floor now because the pack charges at {_hours_phrase(before_run)} first."
            )
        if after_run:
            parts.append(f"It buys the energy back at {_hours_phrase(after_run)}.")
        elif r.battery_recharge_kwh:
            parts.append(
                f"The {_num(r.battery_recharge_kwh)} kWh goes back in overnight at the "
                f"off-peak rate, ${r.battery_recharge_kwh * OFF_PEAK_USD_PER_KWH:.2f} of the "
                "day-ahead bill that no single action carries."
            )
    else:
        parts.append("The battery is not dispatched at all in this plan.")

    drift = r.hvac_drift_hours
    precool = r.hvac_precool_hours
    if drift and precool:
        parts.append(
            f"Non-clinical air handlers pre-cool across {_hours_phrase(precool)} and then "
            f"drift +{DRIFT_F}F across {_hours_phrase(drift)}, worth "
            f"{_num(r.hvac_shed_kw)} kW in each drifting hour and "
            f"${r.hvac_savings_usd:.2f} across the day;"
        )
        parts.append("patient rooms, theatres and imaging are excluded outright.")
    elif drift:
        parts.append(
            f"Non-clinical air handlers drift +{DRIFT_F}F across {_hours_phrase(drift)} "
            f"with no pre-cool ahead of it, worth {_num(r.hvac_shed_kw)} kW while they "
            "drift; patient rooms, theatres and imaging are excluded outright."
        )
    elif precool:
        parts.append(
            f"Non-clinical air handlers pre-cool across {_hours_phrase(precool)} and never "
            "give it back as a drift; the clinical zones are untouched either way."
        )
    else:
        parts.append("No HVAC setpoint moves in this plan, clinical or otherwise.")

    if r.ev_delta_kw:
        parts.append(
            f"{_num(r.ev_shifted_kwh)} kWh of ambulance charging comes out of "
            f"{_hours_phrase(r.ev_shift_from_hours)} and is re-queued across "
            f"{_hours_phrase(r.ev_shift_to_hours)}, after the evening shift change."
        )
    else:
        parts.append("The ambulance chargers are left exactly where they are.")

    parts.append(
        f"Together the peak falls from {_num(r.baseline_peak_kw)} kW to "
        f"{_num(r.optimized_peak_kw)} kW, a {_num(r.peak_reduction_kw)} kW cut worth about "
        f"${r.demand_charge_avoided_usd:.2f} on the demand charge, and "
        f"{energy_phrase(r.savings_usd, 'the day-ahead energy bill')} alongside it."
    )

    if r.battery_hours and floor_margin <= 2:
        parts.append(
            f"The battery comes off its run at {_num(r.end_soc_pct)}% SOC, "
            f"{_num(floor_margin)} {_points(floor_margin)} above the "
            f"{_num(r.reserve_floor_pct)}% floor, which is exactly where a hospital should "
            "not be without a human agreeing to it first."
        )
    elif r.battery_hours:
        # Whether a second approver is needed depends on whether the optimizer
        # actually took the HVAC lever. It usually does not -- with the pack
        # and the bays holding the ceiling there is no peak left for setpoint
        # drift to buy -- and claiming "the HVAC action touches occupied space"
        # in a plan that moves no setpoint is both wrong and the sort of wrong
        # a clinician would catch immediately.
        approver_line = (
            "the HVAC action still touches occupied space, which is why this plan "
            "needs two people to agree to it"
            if r.hvac_delta_kw
            else "and no setpoint moves in this plan either, clinical or otherwise, so "
            "nothing here reaches a patient -- it still goes to a human because of the "
            "size of the overnight charge, not because of what it asks of the wards"
        )
        parts.append(
            f"The battery comes off its run at {_num(r.end_soc_pct)}% SOC, "
            f"{_num(floor_margin)} {_points(floor_margin)} clear of the "
            f"{_num(r.reserve_floor_pct)}% critical-care floor, so the ride-through is "
            f"never drawn into; {approver_line}."
        )
    return " ".join(parts)


def build_actions(r: "OptimizationResult") -> list[dict[str, Any]]:
    capacity_kwh = float(BUILDING["battery_capacity_kwh"])
    floor_margin = round1(r.end_soc_pct - r.reserve_floor_pct)
    charge_hours = _charge_hours(r)
    drift = r.hvac_drift_hours
    precool = r.hvac_precool_hours
    ev_deep_hour, ev_deep_kw = _ev_deepest(r)

    # --- the battery row ----------------------------------------------------
    if r.battery_hours:
        if _is_flat(r.battery_discharge_kw):
            battery_title = (
                f"Discharge battery at {_num(r.battery_flat_kw)} kW, "
                f"{_window_label(r.battery_window)}"
            )
        else:
            battery_title = (
                f"Discharge battery {_window_label(r.battery_window)}, "
                f"{_num(r.battery_flat_kw)} kW at the deepest"
            )
        battery_lines = [
            f"Dispatch {_num(r.battery_kwh)} kWh from the {_num(capacity_kwh)} kWh pack at "
            f"{_battery_shape(r)}."
        ]
        if len(_runs(r.battery_hours)) > 1:
            battery_lines.append(
                "This is not one block: the pack runs at those hours only and sits idle "
                "in between."
            )
        battery_lines.append(
            f"SOC comes off that run at {_num(r.end_soc_pct)}%, {_num(floor_margin)} "
            f"{_points(floor_margin)} above the {_num(r.reserve_floor_pct)}% critical-care "
            "reserve floor."
        )
        if floor_margin <= 2:
            battery_lines.append(
                f"That floor, not the {_num(r.inverter_kw)} kW inverter, is what caps the "
                f"rate: a deeper, shorter discharge would clear "
                f"{_clock(r.baseline_peak_hour)} and leave the end of the block exposed."
            )
        else:
            battery_lines.append(
                f"Neither limit binds here: the deepest hour is {_num(r.battery_flat_kw)} kW "
                f"against a {_num(r.inverter_kw)} kW inverter, and the pack never comes near "
                "the floor."
            )
        if r.battery_cut_at_peak_kw <= 0:
            battery_lines.append(
                f"None of it lands on the {_clock(r.baseline_peak_hour)} baseline peak, so "
                "this row claims no reduction there."
            )
        if charge_hours:
            battery_lines.append(
                f"The pack charges at {_hours_phrase(charge_hours)} to cover it; that "
                "charging is in the grid curve and is already paid for at those hours."
            )
        elif r.battery_recharge_kwh:
            battery_lines.append(
                f"Recharges the {_num(r.battery_recharge_kwh)} kWh overnight at the "
                f"${OFF_PEAK_USD_PER_KWH:.2f}/kWh off-peak rate, which costs "
                f"${r.battery_recharge_kwh * OFF_PEAK_USD_PER_KWH:.2f} and lands on the plan "
                "total rather than on this row."
            )
    else:
        battery_title = "Hold the battery: no discharge in this plan"
        battery_lines = [
            "The optimizer found no hour where discharging the pack lowered the peak or "
            "the bill, so the battery is not dispatched and SOC stays where it is at "
            f"{_num(r.start_soc_pct)}%, well above the {_num(r.reserve_floor_pct)}% "
            "critical-care reserve floor."
        ]

    # --- the HVAC row -------------------------------------------------------
    if drift and precool:
        hvac_title = (
            f"Pre-cool non-clinical zones, then drift +{DRIFT_F}F across "
            f"{_hours_phrase(drift)}"
        )
        hvac_lines = [
            "Pre-cool the 26 non-clinical zones (admin, lobby, cafeteria, plant rooms) "
            f"across {_hours_phrase(precool)}, then let them rise {DRIFT_F}F across "
            f"{_hours_phrase(drift)}, which takes {_num(r.hvac_shed_kw)} kW off the line in "
            "each drifting hour."
        ]
    elif drift:
        hvac_title = f"Drift non-clinical zones +{DRIFT_F}F across {_hours_phrase(drift)}"
        hvac_lines = [
            f"Let the 26 non-clinical zones (admin, lobby, cafeteria, plant rooms) rise "
            f"{DRIFT_F}F across {_hours_phrase(drift)}, which takes "
            f"{_num(r.hvac_shed_kw)} kW off the line in each drifting hour. There is no "
            "pre-cool ahead of it in this plan."
        ]
    elif precool:
        hvac_title = f"Pre-cool non-clinical zones across {_hours_phrase(precool)}"
        hvac_lines = [
            "Pre-cool the 26 non-clinical zones (admin, lobby, cafeteria, plant rooms) "
            f"across {_hours_phrase(precool)}. No setpoint is allowed to drift back up "
            "afterwards in this plan, so the zones only ever run cooler than scheduled."
        ]
    else:
        hvac_title = "Hold every HVAC setpoint: no drift in this plan"
        hvac_lines = [
            "The optimizer made no HVAC change at any hour, so there is no shed to "
            "approve here. All 42 zones, clinical and non-clinical, hold the setpoints "
            "they are already running."
        ]

    if drift and len(_runs(drift)) > 1:
        hvac_lines.append(
            f"The drift hours are not consecutive: this is {len(_runs(drift))} separate "
            "releases rather than one block."
        )
    if drift or precool:
        hvac_lines.append(
            "The 16 clinical zones -- patient rooms, operating theatres, imaging, pharmacy "
            "and the isolation suite -- are excluded and hold their setpoints and pressure "
            "relationships unchanged."
        )
    if r.hvac_cut_at_peak_kw > 0:
        hvac_lines.append(
            f"{_num(r.hvac_cut_at_peak_kw)} kW of it comes out of the "
            f"{_clock(r.baseline_peak_hour)} baseline peak itself."
        )
    elif r.hvac_delta_kw:
        hvac_lines.append(
            f"None of it lands on the {_clock(r.baseline_peak_hour)} baseline peak, so this "
            f"row claims no reduction there; it is worth ${r.hvac_savings_usd:.2f} on energy."
        )

    # --- the EV row ---------------------------------------------------------
    if r.ev_delta_kw:
        ev_title = (
            f"Shift ambulance charging out of {_hours_phrase(r.ev_shift_from_hours)} into "
            f"{_hours_phrase(r.ev_shift_to_hours)}"
        )
        ev_lines = [
            f"Take {_num(r.ev_shifted_kwh)} kWh of charging out of "
            f"{_hours_phrase(r.ev_shift_from_hours)} and re-queue it across "
            f"{_hours_phrase(r.ev_shift_to_hours)}. Energy is unchanged; this action exists "
            "only to take load out of the peak-setting hours."
        ]
        if r.ev_shift_to_hours and min(r.ev_shift_to_hours) >= 18:
            ev_lines.append("Every re-queued hour falls after the 18:00 shift change.")
        if ev_deep_kw > MOVABLE_EV_KW + 0.05:
            ev_lines.append(
                f"At its deepest, {_clock(ev_deep_hour)}, it holds off {_num(ev_deep_kw)} kW, "
                f"more than the {_num(MOVABLE_EV_KW)} kW the two reserve ambulances draw "
                "between them, so at that hour it is not only the reserve pair standing off "
                "charge."
            )
        else:
            ev_lines.append(
                f"The deepest hour gives up {_num(ev_deep_kw)} kW, the two reserve "
                "ambulances and no more; the two front-line vehicles hold above 80% and are "
                "never interrupted."
            )
        if r.ev_cut_at_peak_kw > 0:
            ev_lines.append(
                f"{_num(r.ev_cut_at_peak_kw)} kW of that comes out of the "
                f"{_clock(r.baseline_peak_hour)} baseline peak."
            )
        else:
            ev_lines.append(
                f"None of it lands on the {_clock(r.baseline_peak_hour)} baseline peak, so "
                "this row claims no reduction there."
            )
    else:
        ev_title = "Leave the ambulance chargers on their own schedule"
        ev_lines = [
            "No charging session moved: the optimizer could not take load out of the "
            "peak-setting hours without pushing a vehicle past the hours the site allows, "
            "so all four chargers run exactly as scheduled."
        ]

    return [
        {
            "type": "battery_discharge",
            "title": battery_title,
            "description": " ".join(battery_lines),
            "start_time": iso_hour(r.battery_window[0]),
            "end_time": _end_iso(r.battery_window[1]),
            "magnitude": r.battery_flat_kw,
            "unit": "kW",
            "estimated_peak_reduction_kw": r.battery_cut_at_peak_kw,
            "estimated_savings_usd": r.battery_savings_usd,
            "constraints_checked": [
                "soc_reserve_floor_30pct_critical_care",
                "max_discharge_400kw",
                "islanding_capability_preserved",
                "single_cycle_per_day",
            ],
        },
        {
            "type": "hvac_setpoint",
            "title": hvac_title,
            "description": " ".join(hvac_lines),
            "start_time": iso_hour(r.hvac_window[0]),
            "end_time": _end_iso(r.hvac_window[1]),
            "magnitude": DRIFT_F if r.hvac_delta_kw else 0,
            "unit": "°F",
            "estimated_peak_reduction_kw": r.hvac_cut_at_peak_kw,
            "estimated_savings_usd": r.hvac_savings_usd,
            "constraints_checked": [
                "clinical_zones_excluded",
                "operating_theatre_pressure_cascade_held",
                "non_clinical_max_temp_76f",
                "max_drift_duration_2h",
            ],
        },
        {
            "type": "ev_charging_shift",
            "title": ev_title,
            "description": " ".join(ev_lines),
            "start_time": iso_hour(r.ev_window[0]),
            "end_time": _end_iso(r.ev_window[1]),
            "magnitude": ev_deep_kw,
            "unit": "kW",
            "estimated_peak_reduction_kw": r.ev_cut_at_peak_kw,
            "estimated_savings_usd": r.ev_savings_usd,
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
    battery_facts = TOOL_FACTS["get_battery_state"]
    hvac_facts = TOOL_FACTS["get_hvac_constraints"]
    unconstrained_kw = TOOL_FACTS["run_schedule_optimizer"]["unconstrained_battery_kw"]
    floor_margin = round1(r.end_soc_pct - r.reserve_floor_pct)
    drift = r.hvac_drift_hours
    ev_deep_hour, ev_deep_kw = _ev_deepest(r)

    binding = [h for h, kw in enumerate(r.optimized_grid) if kw >= r.optimized_peak_kw - 0.05]
    if len(binding) <= 3:
        binding_phrase = (
            f"the binding intervals are now {_join([_clock(h) for h in binding])}, so "
            f"shedding harder at {_clock(r.baseline_peak_hour)} alone buys nothing"
        )
    else:
        binding_phrase = (
            f"{len(binding)} separate hours now sit level at {_num(r.optimized_peak_kw)} kW, "
            "so there is no single interval left to shave"
        )

    if not r.battery_hours:
        battery_clause = "leave the battery alone"
    elif _is_flat(r.battery_discharge_kw):
        battery_clause = (
            f"hold {_num(r.battery_flat_kw)} kW on the battery across "
            f"{_hours_phrase(r.battery_hours)}"
        )
    else:
        battery_clause = (
            f"run the battery across {_hours_phrase(r.battery_hours)}, "
            f"{_num(r.battery_flat_kw)} kW at the deepest"
        )

    if drift:
        hvac_clause = (
            f"drift the 26 non-clinical HVAC zones +{DRIFT_F}F across {_hours_phrase(drift)}"
        )
    else:
        hvac_clause = "leave every HVAC setpoint where it is"

    if r.ev_delta_kw:
        ev_clause = (
            f"move {_num(r.ev_shifted_kwh)} kWh of ambulance charging into "
            f"{_hours_phrase(r.ev_shift_to_hours)}"
        )
    else:
        ev_clause = "leave the ambulance chargers on their own schedule"

    if ev_deep_kw > MOVABLE_EV_KW + 0.05:
        ev_check = (
            f"The line to confirm by hand is the EV shift: at {_clock(ev_deep_hour)} it "
            f"holds off {_num(ev_deep_kw)} kW, more than the {_num(MOVABLE_EV_KW)} kW the "
            "reserve pair draws between them."
        )
    elif r.ev_delta_kw:
        ev_check = "Both front-line ambulances stay above 80% throughout."
    else:
        ev_check = "No charging session moved, so all four ambulances keep their schedule."

    if floor_margin <= 2:
        approval_message = (
            f"This one is not close to automatic. The battery finishes "
            f"{_num(floor_margin)} {_points(floor_margin)} off a critical-care reserve "
            "floor and the HVAC action touches occupied space, so it goes to the "
            "facilities director and the on-call clinical engineer together."
        )
    else:
        approval_message = (
            f"This one is not close to automatic. The battery keeps {_num(floor_margin)} "
            f"{_points(floor_margin)} of clearance on the critical-care floor, but the HVAC "
            "action touches occupied space and the plan moves charging on vehicles someone "
            "has to be able to dispatch, so it goes to the facilities director and the "
            "on-call clinical engineer together."
        )

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
                f"Peak confirmed: {_num(r.baseline_peak_kw)} kW at "
                f"{_clock(r.baseline_peak_hour)}, "
                f"{_num(r.baseline_peak_kw - r.threshold_kw)} kW over the "
                f"{_num(r.threshold_kw)} kW threshold. The worrying number is the width -- "
                f"{r.hours_over_threshold} consecutive hours over threshold, "
                f"{_hours_phrase(r.over_threshold_hours)}, against four at a typical office."
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
                f"Battery is at {_num(r.start_soc_pct)}% SOC, "
                f"{_num(battery_facts['available_kwh'])} kWh of the "
                f"{_num(battery_facts['capacity_kwh'])} kWh pack, behind a "
                f"{_num(r.inverter_kw)} kW inverter. The reserve floor here is "
                f"{_num(r.reserve_floor_pct)}%, not the usual 20% -- the pack is part of the "
                f"critical-care ride-through -- so only {_num(r.dispatchable_kwh)} kWh is "
                "dispatchable from where it sits."
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
                f"pressure cascade. The remaining 26 non-clinical zones may drift "
                f"{hvac_facts['max_drift_f']}F for up to "
                f"{hvac_facts['max_drift_hours']} hours, worth about "
                f"{_num(hvac_facts['estimated_shed_kw'])} kW while they do."
            ),
        ),
        Step(
            type="thinking",
            message=(
                f"{_num(r.dispatchable_kwh)} kWh above the floor against "
                f"{r.hours_over_threshold} hours over threshold is the whole problem here: "
                f"it is energy that limits this pack, not the {_num(r.inverter_kw)} kW "
                "inverter. "
                "HVAC and the two movable ambulance chargers have to cover whatever the "
                "battery cannot, and the demand charge only cares about the highest "
                "interval that survives. Handing all three levers to the optimizer "
                "together rather than picking the shape for it."
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
                f"Peak drops from {_num(r.baseline_peak_kw)} kW to "
                f"{_num(r.optimized_peak_kw)} kW, a {_num(r.peak_reduction_kw)} kW cut. The "
                f"deepest hour on the battery is {_num(r.battery_flat_kw)} kW against the "
                f"{unconstrained_kw} kW an unconstrained pack would have taken, and "
                f"{binding_phrase}."
            ),
            duration_ms=r.solve_time_ms,
        ),
        Step(
            type="tool_result",
            tool="validate_schedule",
            invoke="validate_schedule",
            message=(
                f"All {TOOL_FACTS['validate_schedule']['constraints_checked']} constraints "
                f"pass. Battery comes off its run at {_num(r.end_soc_pct)}% SOC, "
                f"{_num(floor_margin)} {_points(floor_margin)} above the "
                f"{_num(r.reserve_floor_pct)}% critical-care floor. All 16 clinical zones "
                f"are untouched and the theatre pressure cascade holds. {ev_check}"
            ),
        ),
        Step(
            type="decision",
            tool="save_action_plan",
            invoke="save_action_plan",
            message=(
                f"Committing a three-action plan: {battery_clause}, {hvac_clause}, and "
                f"{ev_clause}."
            ),
        ),
        Step(
            type="tool_call",
            tool="request_human_approval",
            invoke="request_human_approval",
            message=approval_message,
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
