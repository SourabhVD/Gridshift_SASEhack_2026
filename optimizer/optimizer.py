"""
GridShift Component 3 — OR-Tools optimization engine.

    minimize   energy cost + demand charge + constraint-violation penalties
    subject to battery, EV and HVAC constraints (see constraints.py)

Formulation: linear MIP via `pywraplp` (SCIP, CBC fallback). Battery power and
SOC are continuous, so CP-SAT would force integer discretization for no gain;
the only integers here are the battery charge/discharge mode and the HVAC
run-length indicators.

Demand charge: billed on the monthly maximum, so the model pays only for what
the horizon adds on top of `month_to_date_peak_kw`. Over a 24 h horizon that is
the marginal demand cost of tomorrow; over a full month it is the whole bill.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from ortools.linear_solver import pywraplp

from optimizer.constraints import add_battery, add_evs, add_hvac
from optimizer.schemas import EVSpec, OptimizationInput, OptimizationResult

STATUS_NAMES = {
    pywraplp.Solver.OPTIMAL: "OPTIMAL",
    pywraplp.Solver.FEASIBLE: "FEASIBLE",
    pywraplp.Solver.INFEASIBLE: "INFEASIBLE",
    pywraplp.Solver.UNBOUNDED: "UNBOUNDED",
    pywraplp.Solver.ABNORMAL: "ABNORMAL",
    pywraplp.Solver.NOT_SOLVED: "NOT_SOLVED",
}


def _create_solver(name: str):
    solver = pywraplp.Solver.CreateSolver(name)
    if solver is None:
        solver = pywraplp.Solver.CreateSolver("CBC")
    if solver is None:
        raise RuntimeError("No OR-Tools MIP solver available (tried SCIP and CBC)")
    return solver


def unmanaged_ev_profile(specs: list[EVSpec], timestamps: pd.DatetimeIndex) -> np.ndarray:
    """Baseline behaviour: charge at full power from plug-in until satisfied."""
    from optimizer.constraints import _session_window

    profile = np.zeros(len(timestamps))
    for spec in specs:
        window = _session_window(spec, timestamps)
        remaining = spec.energy_required_kwh
        for t in np.flatnonzero(window):
            if remaining <= 0:
                break
            delivered = min(spec.max_charge_kw * spec.charge_efficiency, remaining)
            profile[t] += delivered / spec.charge_efficiency
            remaining -= delivered
    return profile


def cost_of_profile(net_kw: np.ndarray, request: OptimizationInput) -> dict[str, float]:
    rates = np.asarray(request.tariff.energy_rate_per_kwh, dtype=float)
    energy = float(np.sum(rates * net_kw))  # 1 h steps: kW == kWh
    excess = max(0.0, float(net_kw.max()) - request.month_to_date_peak_kw)
    demand = request.tariff.demand_rate_per_kw * excess
    return {
        "energy": energy,
        "demand": demand,
        "total": energy + demand,
        "peak_kw": float(net_kw.max()),
        "billable_peak_increase_kw": excess,
    }


def optimize(request: OptimizationInput) -> OptimizationResult:
    options = request.options
    hours = request.hours
    solver = _create_solver(options.solver_name)
    solver.SetTimeLimit(int(options.time_limit_s * 1000))

    blocks = []
    if request.battery is not None:
        blocks.append(add_battery(solver, request.battery, hours, options))
    if request.evs:
        blocks.append(add_evs(solver, request.evs, request.timestamps, options))
    if request.hvac is not None:
        blocks.append(add_hvac(solver, request.hvac, request.forecast_load_kw, request.timestamps, options))

    # --- net load -----------------------------------------------------------
    upper = float(request.forecast_load_kw.max()) * 3 + 1000
    net = [solver.NumVar(-upper if options.allow_grid_export else 0.0, upper, f"net_{t}") for t in range(hours)]
    for t in range(hours):
        contributions = [block.net_contribution[t] for block in blocks if block.net_contribution]
        solver.Add(net[t] == float(request.forecast_load_kw[t]) + solver.Sum(contributions), f"net_balance_{t}")

    # --- billable peak ------------------------------------------------------
    peak = solver.NumVar(0, upper, "peak_kw")
    for t in range(hours):
        solver.Add(peak >= net[t], f"peak_ge_{t}")
    peak_increase = solver.NumVar(0, upper, "billable_peak_increase_kw")
    solver.Add(peak_increase >= peak - request.month_to_date_peak_kw, "peak_increase_def")

    # --- objective ----------------------------------------------------------
    rates = np.asarray(request.tariff.energy_rate_per_kwh, dtype=float)
    objective = solver.Sum([float(rates[t]) * net[t] for t in range(hours)])
    objective += request.tariff.demand_rate_per_kw * peak_increase
    objective += options.peak_weight_per_kw * peak
    for block in blocks:
        for expr, weight in block.penalties:
            objective += weight * expr
    solver.Minimize(objective)

    status = solver.Solve()
    status_name = STATUS_NAMES.get(status, str(status))
    if status not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
        raise RuntimeError(f"Optimization failed with status {status_name}")

    return _build_result(request, blocks, net, status_name, solver)


def _values(variables) -> np.ndarray:
    return np.array([v.solution_value() for v in variables], dtype=float)


def _build_result(request, blocks, net, status_name, solver) -> OptimizationResult:
    hours = request.hours
    schedule = pd.DataFrame(
        {
            "timestamp": request.timestamps,
            "forecast_load_kw": request.forecast_load_kw,
            "energy_rate_per_kwh": np.asarray(request.tariff.energy_rate_per_kwh, dtype=float),
            "tariff_period": request.tariff.period_labels,
        }
    )

    violations = {"unmet_ev_kwh": 0.0, "hvac_curtailed_kwh": 0.0}
    by_name = {block.name.split(":")[0]: block for block in blocks}

    battery = by_name.get("battery")
    if battery is not None:
        charge = _values(battery.variables["charge_kw"])
        discharge = _values(battery.variables["discharge_kw"])
        soc = _values(battery.variables["soc_kwh"])
        schedule["battery_charge_kw"] = charge.round(3)
        schedule["battery_discharge_kw"] = discharge.round(3)
        schedule["battery_soc_kwh"] = soc.round(3)
        schedule["battery_soc_pct"] = (100 * soc / request.battery.capacity_kwh).round(2)
    else:
        schedule[["battery_charge_kw", "battery_discharge_kw", "battery_soc_kwh", "battery_soc_pct"]] = 0.0

    ev_block = by_name.get("ev_fleet")
    if ev_block is not None and ev_block.variables["draw_kw"]:
        draws = np.zeros(hours)
        for asset_id, variables in ev_block.variables["draw_kw"].items():
            values = _values(variables)
            draws += values
            schedule[f"ev_{asset_id}_kw"] = values.round(3)
        schedule["ev_charge_kw"] = draws.round(3)
        violations["unmet_ev_kwh"] = round(
            float(sum(v.solution_value() for v in ev_block.variables["unmet_kwh"].values())), 3
        )
    else:
        schedule["ev_charge_kw"] = 0.0

    hvac = by_name.get("hvac")
    if hvac is not None:
        curtail = _values(hvac.variables["curtail_kw"])
        rebound = _values(hvac.variables["rebound_kw"])
        schedule["hvac_curtail_kw"] = curtail.round(3)
        schedule["hvac_rebound_kw"] = rebound.round(3)
        violations["hvac_curtailed_kwh"] = round(float(curtail.sum()), 3)
    else:
        schedule[["hvac_curtail_kw", "hvac_rebound_kw"]] = 0.0

    optimized = _values(net)
    schedule["optimized_load_kw"] = optimized.round(3)

    baseline = request.forecast_load_kw + unmanaged_ev_profile(request.evs, request.timestamps)
    schedule["baseline_load_kw"] = baseline.round(3)

    baseline_cost = cost_of_profile(baseline, request)
    optimized_cost = cost_of_profile(optimized, request)
    savings = {
        key: round(baseline_cost[key] - optimized_cost[key], 4)
        for key in ("energy", "demand", "total")
    }

    notes = {block.name: block.notes for block in blocks if block.notes}
    return OptimizationResult(
        status=status_name,
        schedule=schedule,
        baseline_peak_kw=float(baseline.max()),
        optimized_peak_kw=float(optimized.max()),
        baseline_cost=baseline_cost,
        optimized_cost=optimized_cost,
        savings=savings,
        violations=violations,
        solver={
            "name": request.options.solver_name,
            "wall_time_ms": solver.WallTime(),
            "iterations": solver.Iterations(),
            "variables": solver.NumVariables(),
            "constraints": solver.NumConstraints(),
            "relaxation_notes": str(notes) if notes else "",
        },
    )
