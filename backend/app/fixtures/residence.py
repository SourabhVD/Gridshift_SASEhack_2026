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

A third, about the prose: no clock time and no dollar figure below is typed.
The action text here was originally authored against the heuristic, which
shaves a flat rate across one contiguous window. The CP-SAT solver does not:
on this house it discharges the pack at two hours that are five hours apart
and leaves the heat pump alone entirely. Every window, rate and figure is
therefore read back off the OptimizationResult, so the sentence a homeowner
approves describes the dispatch that is actually scheduled, whichever
optimizer produced it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Sequence

from .generator import (
    DEMAND_CHARGE_USD_PER_KW,
    HOURS,
    NOW_HOUR,
    OFF_PEAK_USD_PER_KWH,
    ON_PEAK_USD_PER_KWH,
    ON_PEAK_WINDOW,
    OUTDOOR_TEMP_F,
    PRICE_PER_KWH,
    FlowComponents,
    action_window,
    iso_hour,
    iso_minute,
    metered_actuals,
    next_day_iso,
    pv_priority_charge,
    energy_phrase,
    number_word,
    round1,
    solver_label,
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
#: Where the thermostat sits before anything is asked of it.
CURRENT_SETPOINT_F = 72
#: Hours of setpoint drift the household has agreed to.
MAX_DRIFT_HOURS = 2
#: The earliest the household will let a shifted session start.
EARLIEST_SHIFT_HOUR = 22
#: Hours between the plug-in time and the deadline.
EV_SLACK_HOURS = 13
#: The car must be here by 07:00 tomorrow.
EV_DEADLINE_HOUR = 7
#: State of charge the session is aiming at.
EV_TARGET_SOC_PCT = 80
#: Demand-response penalty per kW over the cap.
PENALTY_USD_PER_KW = DEMAND_CHARGE_USD_PER_KW
#: Actions in this site's plan. Fixed: the plan has one row per lever.
ACTION_COUNT = 3

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
#: How long that session takes at the charger's rated power.
EV_SESSION_HOURS = round1(EV_SESSION_KWH / EV_CHARGER_KW)

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
# What the baseline day looks like, read off the curves rather than typed      #
# --------------------------------------------------------------------------- #

#: The evening exceedance: the hours the meter is over the cap.
OVER_HOURS: list[int] = [
    h for h, kw in enumerate(BASELINE_GRID_KW) if kw > BUILDING["peak_threshold_kw"]
]
#: The worst the meter gets outside that event.
QUIET_MAX_KW = round1(
    max(kw for h, kw in enumerate(BASELINE_GRID_KW) if h not in OVER_HOURS)
)
#: The hours the house is a net exporter, and where that bottoms out.
EXPORT_HOURS: list[int] = [h for h, kw in enumerate(BASELINE_GRID_KW) if kw < 0]
EXPORT_MIN_HOUR = BASELINE_GRID_KW.index(min(BASELINE_GRID_KW))
#: The hour the pack reaches full on the baseline walk, and the level it holds.
FULL_HOUR = BASELINE_PARTS.soc.index(max(BASELINE_PARTS.soc))
FULL_SOC_PCT = round1(max(BASELINE_PARTS.soc))
#: The heat pump's flat-out hours and the afternoon that causes them.
HVAC_PEAK_KW = round1(max(HVAC_KW))
HVAC_FLAT_OUT_HOURS: list[int] = [h for h, kw in enumerate(HVAC_KW) if kw == HVAC_PEAK_KW]
AFTERNOON_HIGH_F = round1(max(OUTDOOR_TEMP_F))

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

#: What the earliest permitted shift hour would read if the whole session were
#: parked there and the pack stayed idle. A pre-solve counterfactual, which is
#: the only reason the number is allowed to exist outside the result.
UNSHAVED_SHIFT_HOUR_KW = round1(
    BASE_KW[EARLIEST_SHIFT_HOUR]
    + EV_CHARGER_KW
    + HVAC_KW[EARLIEST_SHIFT_HOUR]
    - SOLAR_KW[EARLIEST_SHIFT_HOUR]
)
DISPATCHABLE_KWH = round1(((FULL_SOC_PCT - RESERVE_FLOOR_PCT) / 100) * BUILDING["battery_capacity_kwh"])

EV_DEADLINE = next_day_iso(EV_DEADLINE_HOUR)

# --------------------------------------------------------------------------- #
# Device facts                                                                 #
# --------------------------------------------------------------------------- #

TOOL_FACTS: dict[str, dict[str, Any]] = {
    "get_electricity_prices": {
        "off_peak_usd_per_kwh": OFF_PEAK_USD_PER_KWH,
        "on_peak_usd_per_kwh": ON_PEAK_USD_PER_KWH,
        "on_peak_window": ON_PEAK_WINDOW,
        "demand_response_cap_kw": BUILDING["peak_threshold_kw"],
        "penalty_usd_per_kw": PENALTY_USD_PER_KW,
    },
    "get_battery_state": {
        "soc_pct": BASELINE_PARTS.soc[NOW_HOUR],
        "capacity_kwh": BUILDING["battery_capacity_kwh"],
        "units": 2,
        "max_discharge_kw": BUILDING["battery_max_kw"],
        "reserve_floor_pct": RESERVE_FLOOR_PCT,
        "dispatchable_kwh": DISPATCHABLE_KWH,
        "full_at": iso_hour(FULL_HOUR),
    },
    "get_ev_requirements": {
        "sessions_connected": 1,
        "flexible_sessions": 1,
        "locked_sessions": 0,
        "charger_power_kw": EV_CHARGER_KW,
        "energy_required_kwh": EV_SESSION_KWH,
        "target_soc_pct": EV_TARGET_SOC_PCT,
        "deadline": EV_DEADLINE,
        "plug_in_time": iso_minute(17, 30),
        "earliest_shift_hour": EARLIEST_SHIFT_HOUR,
        "slack_hours": EV_SLACK_HOURS,
    },
    "get_hvac_constraints": {
        "zones": BUILDING["hvac_zones"],
        "current_setpoint_f": CURRENT_SETPOINT_F,
        "occupied_band_f": COMFORT_BAND_F,
        "max_drift_hours": MAX_DRIFT_HOURS,
        "min_precool_setpoint_f": COMFORT_BAND_F[0],
        "peak_draw_kw": HVAC_PEAK_KW,
    },
    "run_schedule_optimizer": {
        "objective": "minimize_peak_then_cost",
        "resources": ["battery", "ev", "hvac"],
        "hard_constraint": f"peak_kw <= {BUILDING['peak_threshold_kw']}",
        "solver": solver_label(),
        "solve_time_ms": 912,
    },
    "validate_schedule": {
        "constraints_checked": 11,
        "ev_target_met_at": iso_minute(0, 47, "2025-09-19"),
        "hvac_max_temp_f": COMFORT_BAND_F[1],
        "hvac_drift_hours": MAX_DRIFT_HOURS,
    },
    "request_human_approval": {"approvers": ["homeowner"]},
}


# --------------------------------------------------------------------------- #
# Reading a dispatch back out                                                  #
# --------------------------------------------------------------------------- #
#
# Everything below turns a computed dispatch into English. The rule is that a
# row never describes a shape it has not checked: a battery that runs at two
# separated hours is described as two draws, a lever that did nothing says so,
# and the windows on the row are the windows the curve moved in.


def _clock(hour: int) -> str:
    """24-hour clock label. Hour 24 is midnight, not 24:00."""
    return "%02d:00" % (hour % 24)


def _is_block(hours: Sequence[int]) -> bool:
    """True when the hours run back to back, so one span describes them."""
    return bool(hours) and hours[-1] - hours[0] + 1 == len(hours)


def _hours_text(hours: Sequence[int]) -> str:
    """'18:00 and 23:00', or '17:00, 18:00 and 19:00'."""
    labels = [_clock(h) for h in hours]
    if not labels:
        return "no hours"
    if len(labels) == 1:
        return labels[0]
    return ", ".join(labels[:-1]) + " and " + labels[-1]


def _when_text(hours: Sequence[int]) -> str:
    """
    How to say when a lever ran.

    A contiguous run gets a span with an exclusive end, the way the window on
    the row reads. A split dispatch gets its hours listed, because calling it
    a span would describe a block that never happened.
    """
    if not hours:
        return "at no hour"
    if len(hours) == 1:
        return f"at {_clock(hours[0])}"
    if _is_block(hours):
        return f"from {_clock(hours[0])} to {_clock(hours[-1] + 1)}"
    return "across " + _hours_text(hours)


def _window_iso(window: tuple[int, int]) -> tuple[str, str]:
    """
    Start and end timestamps for an action window.

    The end hour is exclusive, and hour 24 is midnight tomorrow rather than a
    24:00 no parser accepts. A window of (0, 0) -- a lever that did nothing --
    comes back as a zero-length window, which is the honest shape for a row
    that carries no dispatch.
    """
    start, end = window
    end_iso = next_day_iso(end - HOURS) if end >= HOURS else iso_hour(end)
    return iso_hour(start), end_iso


def _rates_text(discharge: dict[int, float]) -> str:
    """'8.8 kW at 18:00 and 7.5 kW at 23:00'."""
    parts = [f"{kw} kW at {_clock(h)}" for h, kw in sorted(discharge.items())]
    if not parts:
        return "nothing"
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _battery_rate_phrase(r: "OptimizationResult") -> str:
    """A flat dispatch states its rate; a varying one states its deepest."""
    rates = set(r.battery_discharge_kw.values())
    if len(rates) == 1:
        return f"{r.battery_flat_kw} kW"
    return f"up to {r.battery_flat_kw} kW"


def _battery_charge_hours(r: "OptimizationResult") -> list[int]:
    """Hours the optimizer puts energy back in that the baseline did not."""
    return sorted(h for h, kw in r.battery_delta_kw.items() if kw < 0)


def _soc_before_dispatch(r: "OptimizationResult") -> float:
    """Where the pack sits in the hour before its first discharge."""
    hours = r.battery_hours
    if not hours or hours[0] == 0:
        return round1(r.start_soc_pct)
    return round1(r.optimized_parts.soc[hours[0] - 1])


def _grid_without_battery(r: "OptimizationResult") -> list[float]:
    """
    The optimized curve with the pack's whole day taken back out.

    grid = base + ev + hvac - solar - battery, so adding the battery's signed
    change back to the optimized curve is the schedule the levers would produce
    with the pack left idle. That counterfactual is the whole case for the
    battery action, and it has to be computed rather than remembered: the two
    optimizers put the dispatch at different hours.
    """
    delta = r.battery_delta_kw
    return [round1(kw + delta.get(h, 0.0)) for h, kw in enumerate(r.optimized_grid)]


def _ev_moved_kw(r: "OptimizationResult") -> float:
    """The deepest single hour the charging session is cut by."""
    cuts = [-kw for kw in r.ev_delta_kw.values() if kw < 0]
    return round1(max(cuts)) if cuts else 0.0


def _ev_tail_clock(r: "OptimizationResult") -> str:
    """When the part of the session that runs past midnight finishes."""
    minutes = int(round((r.ev_kwh_after_window / EV_CHARGER_KW) * 60))
    return "%02d:%02d" % divmod(minutes, 60)


def _ev_moves_off_peak(r: "OptimizationResult") -> bool:
    """True when every hour given up is on-peak and every hour taken is not."""
    out = r.ev_shift_from_hours
    into = r.ev_shift_to_hours
    if not out or not into:
        return False
    return all(PRICE_PER_KWH[h] == ON_PEAK_USD_PER_KWH for h in out) and all(
        PRICE_PER_KWH[h] == OFF_PEAK_USD_PER_KWH for h in into
    )


def _hvac_precool_kw(r: "OptimizationResult") -> float:
    lifts = [kw for kw in r.hvac_delta_kw.values() if kw > 0]
    return round1(max(lifts)) if lifts else 0.0


def _hvac_setpoint_change_f(r: "OptimizationResult") -> float:
    """
    How far the thermostat is actually asked to move, in degrees.

    Drift is the bigger move and names the row when both happen. A pre-cool
    with no drift is still a real setpoint change, and a lever that did
    nothing is zero rather than the band it was allowed to use.
    """
    if r.hvac_drift_hours:
        return float(COMFORT_BAND_F[1] - CURRENT_SETPOINT_F)
    if r.hvac_precool_hours:
        return float(CURRENT_SETPOINT_F - COMFORT_BAND_F[0])
    return 0.0


def _full_hour(r: "OptimizationResult") -> int:
    """The hour the pack first reaches its high point on the optimized walk."""
    soc = r.optimized_parts.soc
    return soc.index(max(soc))


def _cap_headroom(r: "OptimizationResult") -> float:
    return round1(r.threshold_kw - r.optimized_peak_kw)


def _binding_hour_text(r: "OptimizationResult") -> str:
    """What is actually happening in the hour that sets the new peak."""
    hour = r.optimized_peak_hour
    ev_kw = round1(r.optimized_parts.ev[hour])
    battery_kw = round1(r.optimized_parts.battery[hour])
    if ev_kw > 0:
        return f"the re-timed charging session draws {ev_kw} kW"
    if battery_kw < 0:
        return f"the pack is refilling at {round1(-battery_kw)} kW"
    return "the house alone accounts for it"


def _article(value: float) -> str:
    """'a' or 'an' in front of a spoken number, so 8.8 reads as 'an 8.8 kW cut'."""
    whole = str(value).lstrip("-").split(".")[0]
    return "an" if whole.startswith("8") or whole in {"11", "18"} else "a"


def _solve_time_text(r: "OptimizationResult") -> str:
    """
    Solve time in a unit that does not round the answer away.

    Formatting this in seconds reported a true 18 ms CP-SAT solve as '0.0 s',
    which reads as though nothing was timed at all.
    """
    if r.solve_time_ms < 1000:
        return f"{r.solve_time_ms} ms"
    return f"{r.solve_time_ms / 1000:.1f} s"


# --------------------------------------------------------------------------- #
# Plan                                                                         #
# --------------------------------------------------------------------------- #


def plan_summary(r: "OptimizationResult") -> str:
    monthly_energy_usd = round2(r.savings_usd * 30)
    over_start, over_end = action_window(r.over_threshold_hours)
    house_at_peak_kw = round1(
        r.baseline_parts.base[r.baseline_peak_hour] + r.baseline_parts.hvac[r.baseline_peak_hour]
    )
    unshaved = _grid_without_battery(r)
    unshaved_peak = round1(max(unshaved))
    unshaved_hour = unshaved.index(max(unshaved))
    reserve_margin = round1(r.end_soc_pct - r.reserve_floor_pct)

    if r.ev_shifted_kwh >= EV_SESSION_KWH - 0.05:
        ev_line = (
            f"the whole {EV_SESSION_KWH} kWh session moves to "
            f"{_hours_text(r.ev_shift_to_hours)}"
        )
    else:
        ev_line = (
            f"{r.ev_shifted_kwh} kWh of the {EV_SESSION_KWH} kWh session moves out of "
            f"{_hours_text(r.ev_shift_from_hours)} and into "
            f"{_hours_text(r.ev_shift_to_hours)}"
        )

    if r.battery_hours:
        battery_line = (
            f"and the two wall batteries, full by {_clock(_full_hour(r))}, run "
            f"{_when_text(r.battery_hours)} at {_battery_rate_phrase(r)}. Take the pack "
            f"back out of that schedule and the busiest hour would read {unshaved_peak} kW "
            f"at {_clock(unshaved_hour)}, so re-timing the car on its own would relocate "
            "the violation rather than remove it."
        )
    else:
        battery_line = (
            "and the two wall batteries are not called on at all: re-timing the car is "
            "enough on its own here."
        )

    if r.hvac_drift_hours:
        hvac_line = (
            f"The heat pump then pre-cools to {COMFORT_BAND_F[0]} F "
            f"{_when_text(r.hvac_precool_hours)} on solar the house is exporting anyway "
            f"and floats to {COMFORT_BAND_F[1]} F {_when_text(r.hvac_drift_hours)}, which "
            "is the only part of this anyone in the house can feel."
        )
    else:
        hvac_line = (
            "The heat pump is left exactly as it is: no pre-cool, no setpoint drift, "
            f"{CURRENT_SETPOINT_F} F all evening, so nobody in the house feels this plan "
            "at all."
        )

    recharge_line = (
        f", even after paying to put the {r.battery_recharge_kwh} kWh back into the pack"
        if r.battery_recharge_kwh > 0
        else ""
    )

    if r.ev_kwh_after_window > 0:
        car_line = (
            f"and the car reaches {EV_TARGET_SOC_PCT}% at {_ev_tail_clock(r)}, hours "
            f"before the {_clock(EV_DEADLINE_HOUR)} deadline."
        )
    else:
        car_line = (
            f"and the car finishes charging before midnight, well inside the "
            f"{_clock(EV_DEADLINE_HOUR)} deadline."
        )

    return " ".join(
        [
            f"This house sits under the utility's {r.threshold_kw:.0f} kW demand-response",
            f"cap, and tonight it breaks it: {r.baseline_peak_kw} kW at",
            f"{_clock(r.baseline_peak_hour)} and {r.hours_over_threshold} hours over the",
            f"line, {_clock(over_start)} to {_clock(over_end)}. The cause is not the house",
            f"-- cooking, lights and the heat pump together come to about",
            f"{house_at_peak_kw} kW in that hour -- it is that an {EV_CHARGER_KW} kW car",
            "charger starts at 17:30 on top of all of it. Nothing has to be given up. The",
            f"car is not driven until morning, so {ev_line},",
            battery_line,
            hvac_line,
            f"Billing peak falls from {r.baseline_peak_kw} kW to {r.optimized_peak_kw} kW,",
            f"{_cap_headroom(r)} kW clear of the cap, avoiding about",
            f"${r.demand_charge_avoided_usd:.2f} of demand-response penalty on this",
            f"month's bill; the highest hour left is {_clock(r.optimized_peak_hour)}, where",
            f"{_binding_hour_text(r)}. {energy_phrase(r.savings_usd, 'Day-ahead energy')},",
            f"roughly ${abs(monthly_energy_usd):.2f} over a 30-day month{recharge_line}. The",
            "pack ends",
            f"the night at {r.end_soc_pct}%, {reserve_margin} points above the",
            f"{r.reserve_floor_pct:.0f}% the owner holds back for outages,",
            car_line,
        ]
    )


def build_actions(r: "OptimizationResult") -> list[dict[str, Any]]:
    return [
        _ev_action(r),
        _battery_action(r),
        _hvac_action(r),
    ]


def _ev_action(r: "OptimizationResult") -> dict[str, Any]:
    start_iso, end_iso = _window_iso(r.ev_window)
    out_hours = r.ev_shift_from_hours
    into_hours = r.ev_shift_to_hours
    moved_kw = _ev_moved_kw(r)

    if not r.ev_delta_kw:
        title = "Leave the charging session where it is"
        description = (
            "The optimizer did not move the car on this run. The session charges exactly "
            f"as it would have done, so this row carries no kW and no saving. The "
            f"{EV_SLACK_HOURS} hours of slack against the "
            f"{_clock(EV_DEADLINE_HOUR)} deadline are still there and unused."
        )
    else:
        if r.ev_shifted_kwh >= EV_SESSION_KWH - 0.05:
            what = (
                f"The whole {EV_SESSION_KWH} kWh session comes out of "
                f"{_hours_text(out_hours)} and is re-queued at {_hours_text(into_hours)}."
            )
        else:
            rest = round1(EV_SESSION_KWH - r.ev_shifted_kwh)
            what = (
                f"{r.ev_shifted_kwh} kWh of the {EV_SESSION_KWH} kWh session comes out of "
                f"{_hours_text(out_hours)} and is re-queued at {_hours_text(into_hours)}; "
                f"the remaining {rest} kWh charges where it always did."
            )

        if r.ev_cut_at_peak_kw <= 0:
            at_peak = (
                f"At its deepest the move takes {moved_kw} kW out of a single hour, but "
                f"it does not touch the {_clock(r.baseline_peak_hour)} interval that sets "
                "the peak, so what this row is worth is the tariff rather than the cap; "
                "the pack covers that hour instead."
            )
        elif abs(moved_kw - r.ev_cut_at_peak_kw) < 0.05:
            at_peak = (
                f"Its deepest hour is the {_clock(r.baseline_peak_hour)} interval that "
                f"sets the peak, and it takes the whole {moved_kw} kW out of it."
            )
        else:
            at_peak = (
                f"At its deepest the move takes {moved_kw} kW out of a single hour, and "
                f"{r.ev_cut_at_peak_kw} kW of it comes out of the "
                f"{_clock(r.baseline_peak_hour)} interval that sets the peak."
            )

        if _ev_moves_off_peak(r):
            tariff = (
                f"Every hour it gives up is inside the {ON_PEAK_WINDOW} window at "
                f"${ON_PEAK_USD_PER_KWH:.2f}/kWh and every hour it takes is at the "
                f"${OFF_PEAK_USD_PER_KWH:.2f} overnight rate, worth "
                f"${r.ev_savings_usd:.2f}."
            )
        else:
            tariff = (
                f"Priced hour by hour at the tariff, the move is worth "
                f"${r.ev_savings_usd:.2f}."
            )

        if r.ev_kwh_after_window > 0:
            delivered = round1(sum(kw for kw in r.ev_delta_kw.values() if kw > 0))
            finish = (
                f"{delivered} kWh lands before midnight and the last "
                f"{r.ev_kwh_after_window} kWh finishes about {_ev_tail_clock(r)}."
            )
        else:
            finish = (
                "All of it is delivered before midnight, the last of it in the "
                f"{_clock(into_hours[-1])} hour."
            )

        tail = ", running past midnight" if r.ev_kwh_after_window > 0 else ""
        title = (
            f"Move {r.ev_shifted_kwh} kWh of EV charging to {_hours_text(into_hours)}"
            f"{tail}"
        )
        description = (
            f"Delay charging rather than slow it down. The car plugs in at 17:30 but is "
            f"not driven until the morning, so it has {EV_SLACK_HOURS} hours of slack "
            f"against an {EV_TARGET_SOC_PCT}%-by-{_clock(EV_DEADLINE_HOUR)} target. "
            f"{what} {at_peak} {tariff} {finish}"
        )

    return {
        "type": "ev_charging_shift",
        "title": title,
        "description": description,
        "start_time": start_iso,
        "end_time": end_iso,
        "magnitude": moved_kw,
        "unit": "kW",
        "estimated_peak_reduction_kw": r.ev_cut_at_peak_kw,
        "estimated_savings_usd": r.ev_savings_usd,
        "constraints_checked": [
            "ev_target_soc_80pct_by_0700",
            "single_session_not_split",
            "charger_limit_11_5kw",
            "demand_response_cap_9kw",
        ],
    }


def _battery_action(r: "OptimizationResult") -> dict[str, Any]:
    start_iso, end_iso = _window_iso(r.battery_window)
    hours = r.battery_hours

    if not hours:
        # No discharge does not always mean the pack did nothing: it can still
        # take energy in. State the derived figure rather than asserting a zero
        # the fields would contradict.
        title = "Hold the pack, no discharge scheduled"
        charge_hours = _battery_charge_hours(r)
        if charge_hours:
            description = (
                "The optimizer found no hour where discharging helps on this run, so "
                f"the pack only takes energy in, {_when_text(charge_hours)}. There is "
                "no discharge to approve here. What the pack does to the day's bill "
                f"either way is ${r.battery_savings_usd:.2f}, and the "
                f"{r.dispatchable_kwh} kWh above the {r.reserve_floor_pct:.0f}% outage "
                "reserve stays where it is."
            )
        else:
            description = (
                "The optimizer found no hour where discharging helps on this run, so "
                "the pack is left alone and this row carries no kW and no saving. The "
                f"{r.dispatchable_kwh} kWh above the {r.reserve_floor_pct:.0f}% outage "
                "reserve stays in the pack."
            )
    else:
        if _is_block(hours) and len(set(r.battery_discharge_kw.values())) == 1:
            shape = f"One run at a flat {r.battery_flat_kw} kW {_when_text(hours)}."
        elif _is_block(hours):
            shape = (
                f"One run {_when_text(hours)}, at a rate that changes hour to hour: "
                f"{_rates_text(r.battery_discharge_kw)}."
            )
        else:
            shape = (
                "This is not one block. The pack runs at two separated hours: "
                f"{_rates_text(r.battery_discharge_kw)}, and it is idle in between."
            )

        unshaved = _grid_without_battery(r)
        unshaved_peak = round1(max(unshaved))
        unshaved_hour = unshaved.index(max(unshaved))
        counterfactual = (
            f"Take the pack out of this schedule and the busiest hour would read "
            f"{unshaved_peak} kW at {_clock(unshaved_hour)}, which is what this action is "
            f"holding off the {r.threshold_kw:.0f} kW cap."
        )

        energy = (
            f"{r.battery_kwh} kWh out of a pack sitting at {_soc_before_dispatch(r)}% "
            f"when it starts ends the night at {r.end_soc_pct}%, "
            f"{round1(r.end_soc_pct - r.reserve_floor_pct)} points above the "
            f"{r.reserve_floor_pct:.0f}% outage reserve and inside the "
            f"{r.inverter_kw:.0f} kW inverter rating."
        )

        if r.battery_cut_at_peak_kw > 0:
            at_peak = (
                f"At the {_clock(r.baseline_peak_hour)} baseline peak interval this is "
                f"worth {r.battery_cut_at_peak_kw} kW on its own."
            )
        else:
            at_peak = (
                "The peak reduction on this row is 0 kW because the contract measures it "
                f"at the {_clock(r.baseline_peak_hour)} baseline peak interval and the "
                "pack does not run then; what it does is hold the new binding hour under "
                "the cap."
            )

        charge_hours = _battery_charge_hours(r)
        if charge_hours:
            refill = (
                f"The pack refills {_when_text(charge_hours)}, and the figure on this row "
                "is the pack's whole day at the tariff, not the discharge alone."
            )
        elif r.battery_recharge_kwh > 0:
            refill = (
                f"The {r.battery_recharge_kwh} kWh going back in is bought at the "
                f"${OFF_PEAK_USD_PER_KWH:.2f} overnight rate, about "
                f"${round2(r.battery_recharge_kwh * OFF_PEAK_USD_PER_KWH):.2f}, and that "
                "sits in the plan total rather than on this row."
            )
        else:
            refill = "Tomorrow's array puts the energy back at no cost."

        title = (
            f"Discharge the pack at {_battery_rate_phrase(r)} {_when_text(hours)}"
        )
        description = f"{shape} {counterfactual} {energy} {at_peak} {refill}"

    return {
        "type": "battery_discharge",
        "title": title,
        "description": description,
        "start_time": start_iso,
        "end_time": end_iso,
        "magnitude": r.battery_flat_kw,
        "unit": "kW",
        "estimated_peak_reduction_kw": r.battery_cut_at_peak_kw,
        "estimated_savings_usd": r.battery_savings_usd,
        "constraints_checked": [
            "soc_reserve_floor_20pct",
            "max_discharge_10kw",
            "single_cycle_per_day",
            "solar_recharge_available_tomorrow",
        ],
    }


def _hvac_action(r: "OptimizationResult") -> dict[str, Any]:
    start_iso, end_iso = _window_iso(r.hvac_window)
    precool = r.hvac_precool_hours
    drift = r.hvac_drift_hours

    if not r.hvac_delta_kw:
        title = f"No heat pump change: hold the setpoint at {CURRENT_SETPOINT_F}°F"
        description = (
            "The optimizer left the heat pump alone on this run. Nothing pre-cools, "
            f"nothing drifts, and the house holds {CURRENT_SETPOINT_F}F right through the "
            "evening, so this row carries 0°F of setpoint change and $0.00. The peak is "
            "taken by the charging session and the pack instead. The "
            f"{COMFORT_BAND_F[0]}-{COMFORT_BAND_F[1]}F band and the {MAX_DRIFT_HOURS} "
            "permitted drift hours were available and were not needed. The row has an "
            "empty window because there is nothing to schedule; it is here so the "
            "household can see the heat pump was considered rather than forgotten."
        )
    else:
        headline = []
        if precool:
            headline.append(
                f"Pre-cool to {COMFORT_BAND_F[0]}°F {_when_text(precool)}"
            )
        if drift:
            headline.append(f"float to {COMFORT_BAND_F[1]}°F {_when_text(drift)}")
        title = ", ".join(headline)

        parts = []
        if precool:
            parts.append(
                f"Run the heat pump {_hvac_precool_kw(r)} kW harder {_when_text(precool)}, "
                "while the array is still exporting and the extra draw is free, to bank "
                "thermal mass in the slab and the walls."
            )
        if drift:
            parts.append(
                f"Then let the house drift from {CURRENT_SETPOINT_F}F to "
                f"{COMFORT_BAND_F[1]}F {_when_text(drift)}, worth {r.hvac_shed_kw} kW in "
                "those hours."
            )
            parts.append(
                f"Drift is capped at the permitted {MAX_DRIFT_HOURS} hours and both ends "
                f"stay inside the {COMFORT_BAND_F[0]}-{COMFORT_BAND_F[1]}F occupied band."
            )
        if r.hvac_cut_at_peak_kw > 0:
            parts.append(
                f"At the {_clock(r.baseline_peak_hour)} baseline peak interval it is "
                f"worth {r.hvac_cut_at_peak_kw} kW."
            )
        parts.append(
            f"Priced at the tariff the whole lever comes to ${r.hvac_savings_usd:.2f}. "
            "This is the only action anyone in the house experiences, which is why the "
            "plan is routed for approval rather than dispatched."
        )
        description = " ".join(parts)

    return {
        "type": "hvac_setpoint",
        "title": title,
        "description": description,
        "start_time": start_iso,
        "end_time": end_iso,
        "magnitude": _hvac_setpoint_change_f(r),
        "unit": "°F",
        "estimated_peak_reduction_kw": r.hvac_cut_at_peak_kw,
        "estimated_savings_usd": r.hvac_savings_usd,
        "constraints_checked": [
            "occupied_comfort_band_70_76f",
            "max_drift_duration_2h",
            "precool_min_setpoint_70f",
            "zone_temp_max_76f",
        ],
    }


# --------------------------------------------------------------------------- #
# Scripted run                                                                 #
# --------------------------------------------------------------------------- #


def build_script(r: "OptimizationResult") -> list[Step]:
    over_start, over_end = action_window(r.over_threshold_hours)
    export_start, export_end = action_window(EXPORT_HOURS)
    flat_out_start, flat_out_end = action_window(HVAC_FLAT_OUT_HOURS)
    constraints = TOOL_FACTS["validate_schedule"]["constraints_checked"]

    if r.battery_hours:
        battery_plan = (
            f"discharge the pack at {_battery_rate_phrase(r)} "
            f"{_when_text(r.battery_hours)}"
        )
        battery_lands = f"the pack is scheduled {_when_text(r.battery_hours)}"
    else:
        battery_plan = "leave the pack alone"
        battery_lands = "the pack is not called on at all"

    if r.hvac_drift_hours:
        hvac_plan = (
            f"pre-cool then float the setpoint between {COMFORT_BAND_F[0]}F and "
            f"{COMFORT_BAND_F[1]}F {_when_text(r.hvac_drift_hours)}"
        )
        hvac_check = (
            f"Indoor temperature tops out at {COMFORT_BAND_F[1]}F for "
            f"{len(r.hvac_drift_hours)} hours and no longer."
        )
        approval_note = (
            "The pack and the charger are invisible to the household, but letting the "
            f"house run to {COMFORT_BAND_F[1]}F {_when_text(r.hvac_drift_hours)} is not, "
            "and neither is deciding when somebody else's car charges. Sending "
            f"{'both' if r.action_rows == 2 else 'all ' + number_word(r.action_rows)} to the owner."
        )
    else:
        hvac_plan = "leave the heat pump untouched"
        hvac_check = (
            f"Indoor temperature never leaves the {CURRENT_SETPOINT_F}F setpoint, because "
            "this plan does not ask the heat pump for anything."
        )
        approval_note = (
            "Nothing here is felt indoors: the setpoint does not move and the pack is "
            "silent. What still needs a person is deciding when somebody else's car "
            f"charges, so {'both' if r.action_rows == 2 else 'all ' + number_word(r.action_rows)} "
            "actions go to the owner."
        )

    if r.ev_kwh_after_window > 0:
        car_check = (
            f"The car reaches {EV_TARGET_SOC_PCT}% at {_ev_tail_clock(r)}, hours before "
            f"the {_clock(EV_DEADLINE_HOUR)} deadline."
        )
    else:
        car_check = (
            f"The car reaches {EV_TARGET_SOC_PCT}% before midnight, well inside the "
            f"{_clock(EV_DEADLINE_HOUR)} deadline."
        )

    if not r.ev_delta_kw:
        ev_plan = "leave the charging session where it is"
        ev_lands = "The charging session is not moved"
    elif r.ev_shifted_kwh >= EV_SESSION_KWH - 0.05:
        ev_plan = f"move the whole {EV_SESSION_KWH} kWh session to {_hours_text(r.ev_shift_to_hours)}"
        ev_lands = f"The whole session ends up at {_hours_text(r.ev_shift_to_hours)}"
    else:
        ev_plan = (
            f"move {r.ev_shifted_kwh} kWh of the charging session to "
            f"{_hours_text(r.ev_shift_to_hours)}"
        )
        ev_lands = (
            f"{r.ev_shifted_kwh} kWh of the session moves to "
            f"{_hours_text(r.ev_shift_to_hours)} and the rest charges where it was"
        )

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
                f"Peak confirmed: {r.baseline_peak_kw} kW at "
                f"{_clock(r.baseline_peak_hour)}, "
                f"{round1(r.baseline_peak_kw - r.threshold_kw)} kW over the "
                f"{r.threshold_kw:.0f} kW cap and over it for {r.hours_over_threshold} "
                f"consecutive hours, {_clock(over_start)} to {_clock(over_end)}. Outside "
                f"those hours the meter never passes {QUIET_MAX_KW} kW, and from "
                f"{_clock(export_start)} to {_clock(export_end)} the house is a net "
                f"exporter -- it runs to {r.min_grid_kw} kW at "
                f"{_clock(EXPORT_MIN_HOUR)}. This is one evening event, not a load "
                "problem."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_electricity_prices",
            invoke="get_electricity_prices",
            message=(
                f"Tariff loaded, and the shape of this bill matters. Energy is "
                f"${OFF_PEAK_USD_PER_KWH:.2f}/kWh off-peak and "
                f"${ON_PEAK_USD_PER_KWH:.2f}/kWh across {ON_PEAK_WINDOW}, but the "
                "household is enrolled in demand response: every kW the meter goes over "
                f"{r.threshold_kw:.0f} kW in a month carries a "
                f"${PENALTY_USD_PER_KW:.2f} penalty. At this scale the penalty is worth "
                "far more than the energy, so the objective is the cap, not the kWh."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_battery_state",
            invoke="get_battery_state",
            message=(
                f"Two wall units, {BUILDING['battery_capacity_kwh']} kWh together behind a "
                f"{r.inverter_kw:.0f} kW inverter, and they are at "
                f"{BASELINE_PARTS.soc[NOW_HOUR]}% at {_clock(NOW_HOUR)} -- the inverter "
                "fills the pack from PV before it serves the house, so today's own array "
                f"has done this. It tops out at {_clock(FULL_HOUR)} and then sits idle "
                f"all afternoon. The owner holds a {r.reserve_floor_pct:.0f}% reserve for "
                f"outages, which still leaves {r.dispatchable_kwh} kWh I can genuinely "
                "move."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_ev_requirements",
            invoke="get_ev_requirements",
            message=(
                "One bay, one car, and a great deal of slack. It plugs in at 17:30 wanting "
                f"{EV_SESSION_KWH} kWh to reach {EV_TARGET_SOC_PCT}%, the charger does "
                f"{EV_CHARGER_KW} kW, and the owner's only stated requirement is "
                f"{EV_TARGET_SOC_PCT}% by {_clock(EV_DEADLINE_HOUR)}. That is a "
                f"{EV_SESSION_HOURS} hour job with {EV_SLACK_HOURS} hours to do it in -- "
                "the deadline is not the constraint here, the start time is."
            ),
        ),
        Step(
            type="tool_result",
            tool="get_hvac_constraints",
            invoke="get_hvac_constraints",
            message=(
                f"One heat pump, {BUILDING['hvac_zones']} zones, {CURRENT_SETPOINT_F}F "
                f"setpoint, and a {COMFORT_BAND_F[0]}-{COMFORT_BAND_F[1]}F occupied band "
                f"with {MAX_DRIFT_HOURS} hours of permitted drift. It is flat out at "
                f"{HVAC_PEAK_KW} kW from {_clock(flat_out_start)} to "
                f"{_clock(flat_out_end)} against an {AFTERNOON_HIGH_F:.0f}F afternoon. "
                "Small next to the charger, but a house has real thermal mass and the "
                f"{_clock(export_start)} to {_clock(export_end)} solar is being exported "
                "for nothing, so pre-cooling would be genuinely free here rather than "
                "merely cheap."
            ),
        ),
        Step(
            type="thinking",
            message=(
                f"One {EV_CHARGER_KW} kW load with {EV_SLACK_HOURS} hours of slack, "
                f"against a {r.threshold_kw:.0f} kW cap. Moving it is obvious -- but "
                "moving it is not sufficient: park the whole session at "
                f"{_clock(EARLIEST_SHIFT_HOUR)} untouched and the meter reads "
                f"{UNSHAVED_SHIFT_HOUR_KW} kW there, and I have relocated the violation "
                f"rather than removed it. The pack is full and idle from "
                f"{_clock(FULL_HOUR)}, so the shape to look for is a re-timed session "
                "with storage underneath it. I will hand the optimizer all three "
                "resources and let it place them."
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
                "solver": solver_label(),
            },
            delay_ms=2400,
        ),
        Step(
            type="tool_result",
            tool="run_schedule_optimizer",
            invoke="run_schedule_optimizer",
            message=(
                f"Solver returned an optimal schedule in {_solve_time_text(r)}. "
                f"Peak drops from {r.baseline_peak_kw} kW to {r.optimized_peak_kw} kW, "
                f"{_article(r.peak_reduction_kw)} {r.peak_reduction_kw} kW cut, and the "
                "binding interval moves from "
                f"{_clock(r.baseline_peak_hour)} to {_clock(r.optimized_peak_hour)}, "
                f"where {_binding_hour_text(r)}. {ev_lands}, and {battery_lands} -- "
                "storage is placed where the meter is actually carrying something, not "
                "spread across the evening for its own sake."
            ),
            duration_ms=r.solve_time_ms,
        ),
        Step(
            type="tool_result",
            tool="validate_schedule",
            invoke="validate_schedule",
            message=(
                f"All {constraints} constraints pass. The meter never exceeds "
                f"{r.optimized_peak_kw} kW, so the cap holds with {_cap_headroom(r)} kW "
                f"to spare. The pack ends at {r.end_soc_pct}%, "
                f"{round1(r.end_soc_pct - r.reserve_floor_pct)} points above the "
                f"{r.reserve_floor_pct:.0f}% outage reserve. {car_check} {hvac_check}"
            ),
        ),
        Step(
            type="decision",
            tool="save_action_plan",
            invoke="save_action_plan",
            message=(
                f"Committing a {number_word(r.action_rows)}-action plan: {ev_plan}, {battery_plan}, and "
                f"{hvac_plan}. Worth about ${r.demand_charge_avoided_usd:.2f} of avoided "
                "demand-response penalty this month."
            ),
        ),
        Step(
            type="tool_call",
            tool="request_human_approval",
            invoke="request_human_approval",
            message=approval_note,
            payload={
                "requires_approval": True,
                "action_count": r.action_rows,
                "approvers": ["homeowner"],
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
        "battery_soc_pct": BASELINE_PARTS.soc[NOW_HOUR],
        "solar_generation_kw": SOLAR_KW[NOW_HOUR],
        "ev_connected": 0,
        "hvac_setpoint_f": CURRENT_SETPOINT_F,
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
