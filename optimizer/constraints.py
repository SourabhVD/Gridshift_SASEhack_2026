"""
GridShift Component 3 — per-device variables and constraints.

Each `add_*` function attaches its variables to an existing pywraplp solver and
returns (variables, net_load_contribution, penalty_terms). `optimizer.py`
assembles them; nothing here knows about the objective's prices.

Sign convention for net load: positive draws from the grid.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from optimizer.schemas import BatterySpec, EVSpec, HVACSpec, OptimizationOptions


@dataclass
class DeviceBlock:
    """Variables plus each hour's signed contribution to net load."""

    name: str
    variables: dict[str, Any] = field(default_factory=dict)
    net_contribution: list[Any] = field(default_factory=list)  # length T linear exprs
    penalties: list[Any] = field(default_factory=list)  # (expr, weight) pairs
    notes: dict[str, Any] = field(default_factory=dict)


def _binaries_enabled(options: OptimizationOptions, hours: int) -> bool:
    return options.use_binaries and hours <= options.max_binary_hours


def add_battery(solver, spec: BatterySpec, hours: int, options: OptimizationOptions) -> DeviceBlock:
    """Charge/discharge power with an SOC energy balance.

    SOC[t] = SOC[t-1] + eta_c * charge[t] - discharge[t] / eta_d   (1 h steps)

    Round-trip losses mean simultaneous charge+discharge is never profitable
    under an energy price, but a pure demand-charge objective can be
    indifferent, so binaries forbid it outright when enabled.
    """
    block = DeviceBlock(name=f"battery:{spec.name}")
    charge, discharge, soc = [], [], []
    inf = solver.infinity()

    for t in range(hours):
        charge.append(solver.NumVar(0, spec.max_charge_kw, f"bat_chg_{t}"))
        discharge.append(solver.NumVar(0, spec.max_discharge_kw, f"bat_dis_{t}"))
        soc.append(solver.NumVar(spec.kwh(spec.min_soc_pct), spec.kwh(spec.max_soc_pct), f"bat_soc_{t}"))

    previous = spec.kwh(spec.initial_soc_pct)
    for t in range(hours):
        solver.Add(
            soc[t] == previous + spec.charge_efficiency * charge[t] - discharge[t] / spec.discharge_efficiency,
            f"bat_balance_{t}",
        )
        previous = soc[t]
    solver.Add(soc[hours - 1] >= spec.kwh(spec.final_soc_pct), "bat_final_soc")

    if _binaries_enabled(options, hours):
        mode = [solver.BoolVar(f"bat_mode_{t}") for t in range(hours)]
        for t in range(hours):
            solver.Add(charge[t] <= spec.max_charge_kw * mode[t], f"bat_chg_mode_{t}")
            solver.Add(discharge[t] <= spec.max_discharge_kw * (1 - mode[t]), f"bat_dis_mode_{t}")
        block.variables["mode"] = mode
    else:
        block.notes["relaxed"] = "simultaneous charge/discharge not forbidden (LP relaxation)"

    block.variables.update({"charge_kw": charge, "discharge_kw": discharge, "soc_kwh": soc})
    block.net_contribution = [charge[t] - discharge[t] for t in range(hours)]
    _ = inf
    return block


def _session_window(spec: EVSpec, timestamps: pd.DatetimeIndex) -> np.ndarray:
    start = pd.Timestamp(spec.available_from)
    end = pd.Timestamp(spec.available_until)
    if timestamps.tz is not None:
        start = start.tz_localize(timestamps.tz) if start.tz is None else start.tz_convert(timestamps.tz)
        end = end.tz_localize(timestamps.tz) if end.tz is None else end.tz_convert(timestamps.tz)
    return ((timestamps >= start) & (timestamps < end)).astype(float)


def add_evs(solver, specs: list[EVSpec], timestamps: pd.DatetimeIndex, options: OptimizationOptions) -> DeviceBlock:
    """Shiftable charging inside each plug-in window.

    Delivered energy is what reaches the battery (after charger efficiency);
    the metered draw is the variable. Shortfall is penalised, not infeasible.
    """
    hours = len(timestamps)
    block = DeviceBlock(name="ev_fleet")
    draw_by_session: dict[str, list] = {}
    total_draw = [[] for _ in range(hours)]
    unmet_vars = {}

    for spec in specs:
        window = _session_window(spec, timestamps)
        if window.sum() == 0:
            block.notes.setdefault("sessions_outside_horizon", []).append(spec.asset_id)
            continue
        draw = [
            solver.NumVar(0, spec.max_charge_kw if window[t] else 0.0, f"ev_{spec.asset_id}_{t}")
            for t in range(hours)
        ]
        unmet = solver.NumVar(0, spec.energy_required_kwh, f"ev_unmet_{spec.asset_id}")
        solver.Add(
            solver.Sum([spec.charge_efficiency * draw[t] for t in range(hours)]) + unmet
            == spec.energy_required_kwh,
            f"ev_energy_{spec.asset_id}",
        )
        draw_by_session[spec.asset_id] = draw
        unmet_vars[spec.asset_id] = unmet
        block.penalties.append((unmet, options.unmet_ev_penalty_per_kwh * spec.priority))
        for t in range(hours):
            total_draw[t].append(draw[t])

    block.variables["draw_kw"] = draw_by_session
    block.variables["unmet_kwh"] = unmet_vars
    block.net_contribution = [solver.Sum(items) if items else 0 for items in total_draw]
    return block


def add_hvac(
    solver,
    spec: HVACSpec,
    forecast_load_kw: np.ndarray,
    timestamps: pd.DatetimeIndex,
    options: OptimizationOptions,
) -> DeviceBlock:
    """Curtailment with mandatory thermal rebound and comfort limits.

    curtail[t] <= min(fraction * forecast[t], max_curtail_kw)
    sum(rebound) == recovery_fraction * sum(curtail)      (energy paid back)
    rebound may not land in an hour that is itself curtailed.
    """
    hours = len(timestamps)
    block = DeviceBlock(name=f"hvac:{spec.name}")
    caps = spec.max_curtail_fraction * np.asarray(forecast_load_kw, dtype=float)
    if spec.max_curtail_kw is not None:
        caps = np.minimum(caps, spec.max_curtail_kw)

    curtail = [solver.NumVar(0, float(caps[t]), f"hvac_cut_{t}") for t in range(hours)]
    rebound = [solver.NumVar(0, float(max(caps[t], 1e-6)), f"hvac_reb_{t}") for t in range(hours)]

    solver.Add(
        solver.Sum(rebound) == spec.recovery_fraction * solver.Sum(curtail),
        "hvac_energy_recovery",
    )
    for t in range(hours):
        # No hour both sheds and pays back; keeps the schedule readable.
        solver.Add(curtail[t] + rebound[t] <= float(max(caps[t], 1e-6)), f"hvac_exclusive_{t}")

    if spec.daily_curtail_limit_kwh is not None:
        local_day = timestamps.tz_convert(timestamps.tz).date if timestamps.tz else timestamps.date
        frame = pd.DataFrame({"day": local_day, "idx": range(hours)})
        for day, group in frame.groupby("day"):
            solver.Add(
                solver.Sum([curtail[i] for i in group.idx]) <= spec.daily_curtail_limit_kwh,
                f"hvac_daily_{day}",
            )

    limit = spec.max_consecutive_hours
    if limit and limit < hours:
        if _binaries_enabled(options, hours):
            active = [solver.BoolVar(f"hvac_on_{t}") for t in range(hours)]
            for t in range(hours):
                solver.Add(curtail[t] <= float(max(caps[t], 1e-6)) * active[t], f"hvac_link_{t}")
            for t in range(hours - limit):
                solver.Add(solver.Sum(active[t : t + limit + 1]) <= limit, f"hvac_run_{t}")
            block.variables["active"] = active
        else:
            # LP fallback: cap energy in every rolling window instead of runs.
            for t in range(hours - limit):
                window_cap = float(caps[t : t + limit + 1].sum()) * limit / (limit + 1)
                solver.Add(solver.Sum(curtail[t : t + limit + 1]) <= window_cap, f"hvac_window_{t}")
            block.notes["relaxed"] = "consecutive-hour limit approximated by a rolling energy cap"

    block.variables.update({"curtail_kw": curtail, "rebound_kw": rebound})
    block.net_contribution = [rebound[t] - curtail[t] for t in range(hours)]
    # Comfort cost: shedding is not free even when it is allowed.
    block.penalties.extend((curtail[t], options.comfort_penalty_per_kwh) for t in range(hours))
    return block
