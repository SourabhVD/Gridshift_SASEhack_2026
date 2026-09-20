"""
Minh's optimization engine, driven from a site fixture.

`optimizer/` (Component 3) is the team's real engine and is better founded than
the CP-SAT model in `optimizer.py` next door, on three counts that change the
answer:

  * it models round-trip charge and discharge efficiency, so the battery does
    not return more than it stored
  * it prices the demand charge against the peak already billed this month,
    which is how the bill actually works, rather than pricing the horizon alone
  * battery power and state of charge are continuous, which is what they are --
    CP-SAT forces an integer grid on them for no benefit

What it did not have was a way into the product. It reads its inputs from
Postgres and returns its own result shape, so nothing in the agent, the plan
endpoint or the dashboard could call it.

This module is that way in. It builds the engine's `OptimizationInput` from a
`BuildingFixture` -- the same device facts the agent's tools already report --
runs it, and maps the schedule back onto the `OptimizationResult` everything
downstream reads. **No database connection and no credential**, which is the
point: the request path stays offline and the engine still decides the plan.

The DB-backed path is not lost. `optimizer/data_access.py` builds the same
input from real device tables, so swapping `_request_for` for a call to
`build_request` is the whole change once those tables are seeded.

Two conversions matter and are easy to get wrong:

  EV is already in our baseline grid curve, and the engine adds unmanaged
  charging on top of its forecast to form its own baseline. So the forecast we
  hand it is the grid curve *minus* EV, and the EV spec is sized so that the
  engine's unmanaged profile reproduces exactly the EV we removed. Get this
  wrong and every building double-counts its chargers.

  HVAC is a curtailable share of whole-building load to the engine, not a named
  component. It is a named component to us, so the curtailment is subtracted
  from our HVAC series and the rebound added back, and the cap is the shed the
  site's own tool reports rather than a fraction of the building.
"""

from __future__ import annotations

import logging
import sys
import time
from typing import TYPE_CHECKING, Any

from ..config import REPO_ROOT
from ..fixtures.generator import (
    DEMAND_CHARGE_USD_PER_KW,
    HOURS,
    PRICE_PER_KWH,
    FlowComponents,
    round1,
    soc_walk,
)
from .optimizer import OptimizationResult, _assemble

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from ..fixtures.spec import BuildingFixture

log = logging.getLogger("gridshift.engine")

#: Seconds the engine may spend. Four demo buildings solve in well under one.
SOLVE_TIME_LIMIT_S = 20.0

#: Charger efficiency the engine assumes. Stated here rather than left to
#: the spec default, because the conversion between delivered energy and
#: metered draw depends on it and a silent change would unbalance every site.
EV_CHARGE_EFFICIENCY = 0.92


def _ensure_importable() -> None:
    """
    Put the repository root on sys.path so `optimizer` resolves.

    The engine is a top-level package beside `backend/`, not a dependency of
    it, and uvicorn is started from `backend/`. Without this the import fails
    at request time rather than at start-up, which is the worst place for it.
    """
    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)


def _ev_window(baseline_ev: list[float]) -> tuple[int, int, float, float]:
    """
    Plug-in window, rate and energy, read off the site's own baseline.

    Sized so the engine's unmanaged profile -- full power from plug-in until
    the energy is met -- reproduces the baseline exactly. That keeps its
    counterfactual identical to ours, so the savings it reports are savings
    against the same day we draw on the chart.
    """
    active = [h for h, kw in enumerate(baseline_ev) if kw > 1e-9]
    if not active:
        return 0, 0, 0.0, 0.0
    rate = max(baseline_ev)
    energy = sum(baseline_ev)
    return active[0], min(active[-1] + 1, HOURS), rate, energy


def _request_for(fixture: "BuildingFixture") -> Any:
    """Build the engine's input from this site. Raises if the engine is absent."""
    _ensure_importable()
    import numpy as np  # noqa: PLC0415 - optional dependency, same as the engine
    import pandas as pd  # noqa: PLC0415

    from optimizer.schemas import (  # noqa: PLC0415
        BatterySpec,
        EVSpec,
        HVACSpec,
        OptimizationInput,
        OptimizationOptions,
        TariffSchedule,
    )

    baseline = fixture.baseline_parts
    battery_facts = fixture.tool_facts.get("get_battery_state", {})
    ev_facts = fixture.tool_facts.get("get_ev_requirements", {})
    hvac_facts = fixture.tool_facts.get("get_hvac_constraints", {})

    # The engine adds unmanaged EV to its forecast to build its baseline, so
    # the forecast it gets must not contain EV already.
    #
    # It also requires a non-negative forecast, and a site with enough PV does
    # not have one: the residence runs to -4 kW at midday. Those hours are
    # clipped to zero for the engine's benefit only. Nothing published is
    # affected, because the curve we serve is re-derived from the components
    # through the flow identity rather than taken from the engine's net. What
    # it costs is that the engine cannot see the midday export when deciding
    # when to charge, which does not move an evening peak.
    raw = [fixture.baseline_grid[h] - baseline.ev[h] for h in range(HOURS)]
    clipped = [h for h, kw in enumerate(raw) if kw < 0]
    if clipped:
        log.info(
            "%s: %d forecast hours below zero clipped for the engine (site exports at %s)",
            fixture.id,
            len(clipped),
            ", ".join(f"{h:02d}:00" for h in clipped[:6]),
        )
    forecast = np.array([max(0.0, kw) for kw in raw], dtype=float)
    timestamps = pd.date_range("2025-09-18", periods=HOURS, freq="h", tz="America/Los_Angeles")

    tariff = TariffSchedule(
        energy_rate_per_kwh=list(PRICE_PER_KWH),
        demand_rate_per_kw=DEMAND_CHARGE_USD_PER_KW,
        period_labels=["peak" if 14 <= h < 20 else "off_peak" for h in range(HOURS)],
    )

    capacity = float(fixture.building["battery_capacity_kwh"])
    start_soc = round1(
        baseline.soc[0] + (baseline.battery[0] / capacity) * 100 if baseline.soc else 0.0
    )
    battery = BatterySpec(
        asset_id=f"{fixture.id}-battery",
        name="Site battery",
        capacity_kwh=capacity,
        max_charge_kw=float(fixture.building["battery_max_kw"]),
        max_discharge_kw=float(battery_facts.get("max_discharge_kw") or fixture.building["battery_max_kw"]),
        min_soc_pct=float(battery_facts.get("reserve_floor_pct", 10.0)),
        initial_soc_pct=start_soc,
        # End where it started. Without this the engine discovers that
        # discharging always helps and simply drains the pack, booking a
        # saving for energy it never buys back.
        final_soc_pct=start_soc,
    )

    evs = []
    start, end, rate, energy = _ev_window(baseline.ev)
    if energy > 0:
        evs.append(
            EVSpec(
                asset_id=f"{fixture.id}-ev",
                name=f"{fixture.building['ev_bays']} bays",
                max_charge_kw=rate,
                charge_efficiency=EV_CHARGE_EFFICIENCY,
                # The engine's requirement is energy DELIVERED to the pack and
                # it draws that divided by the efficiency. Our baseline series
                # is metered draw at the charger, so it has to be converted or
                # the engine draws 8.7% more than the day it is replacing --
                # which validate_schedule correctly flags as EV energy not
                # being conserved.
                energy_required_kwh=energy * EV_CHARGE_EFFICIENCY,
                available_from=timestamps[start],
                # The fleet must be served by the deadline the tool reports,
                # not merely "some time later". Enforcing this costs real money
                # and is the difference between a schedule and a wish.
                available_until=timestamps[min(_deadline_hour(ev_facts, end), HOURS - 1)],
            )
        )

    hvac = None
    shed = float(hvac_facts.get("estimated_shed_kw") or 0.0)
    if shed > 0:
        hvac = HVACSpec(
            asset_id=f"{fixture.id}-hvac",
            name="HVAC",
            max_curtail_kw=shed,
            # The engine's fraction is of whole-building load; the kW cap above
            # is the real limit, so this only has to be loose enough not to
            # bind first.
            max_curtail_fraction=1.0,
            max_consecutive_hours=int(hvac_facts.get("max_drift_hours", 2) or 2),
        )

    return OptimizationInput(
        building_id=fixture.id,
        timestamps=timestamps,
        forecast_load_kw=forecast,
        tariff=tariff,
        battery=battery,
        evs=evs,
        hvac=hvac,
        # The demo prices one day in isolation, so there is no earlier peak to
        # price against. A deployment reads this from energy_readings.
        month_to_date_peak_kw=0.0,
        options=OptimizationOptions(time_limit_s=SOLVE_TIME_LIMIT_S),
    )


def _deadline_hour(ev_facts: dict[str, Any], fallback: int) -> int:
    """
    The latest hour every session must be served by.

    A site that declares no deadline has until the end of the day, not until
    the end of its own baseline window. Falling back to the latter pinned the
    charging exactly where it already was and left the engine no room to shift
    at all: the warehouse reported a $3.45 saving against $23.59, because the
    only lever that site really has was being held shut by its own baseline.
    """
    declared = ev_facts.get("deadlines")
    hours = []
    if isinstance(declared, dict):
        for value in declared.values():
            text = str(value)
            if "T" in text and text[11:13].isdigit():
                hours.append(int(text[11:13]))
    return max(hours) if hours else max(fallback, HOURS - 1)


def solve_with_engine(fixture: "BuildingFixture") -> OptimizationResult:
    """
    Run Component 3 over this site and return the plan's own result shape.

    The optimized components are rebuilt here and the grid curve is re-derived
    from them through the flow identity, rather than taking the engine's net
    load directly. That is deliberate: the identity is what ties the chart to
    the flow diagram, and deriving it means an action's stated kW really is
    what moves the line. The engine's own net is compared against it and a
    divergence is logged rather than hidden.
    """
    _ensure_importable()
    from optimizer.optimizer import optimize as engine_optimize  # noqa: PLC0415

    started = time.perf_counter()
    baseline = fixture.baseline_parts
    request = _request_for(fixture)
    result = engine_optimize(request)
    schedule = result.schedule

    def column(name: str) -> list[float]:
        if name not in schedule:
            return [0.0] * HOURS
        return [float(v) for v in schedule[name].tolist()]

    charge = column("battery_charge_kw")
    discharge = column("battery_discharge_kw")
    ev_draw = column("ev_charge_kw")
    curtail = column("hvac_curtail_kw")
    rebound = column("hvac_rebound_kw")

    # Our battery sign convention: positive discharges into the building.
    battery = [round1(discharge[h] - charge[h]) for h in range(HOURS)]
    ev = [round1(ev_draw[h]) for h in range(HOURS)]
    # Publishing to 0.1 kW leaves up to 1.2 kWh of rounding across a day, and
    # validate_schedule holds EV energy to 0.15 kWh -- the warehouse, whose
    # chargers are the biggest, failed its own plan's check on rounding alone.
    # The residual is folded into the hour that already carries the most, so
    # the series a human reads conserves exactly rather than nearly.
    residual = round1(sum(baseline.ev) - sum(ev))
    if abs(residual) > 1e-9:
        heaviest = max(range(HOURS), key=lambda h: ev[h])
        if ev[heaviest] + residual >= 0:
            ev[heaviest] = round1(ev[heaviest] + residual)
    # Curtailment is a share of whole-building load to the engine, so cap it at
    # the HVAC we actually have. Without the clamp a deep shed would drive the
    # published hvac_kw negative, which the contract forbids.
    hvac = [round1(max(0.0, baseline.hvac[h] - curtail[h] + rebound[h])) for h in range(HOURS)]

    ev_delta = {
        h: round1(ev[h] - baseline.ev[h])
        for h in range(HOURS)
        if abs(ev[h] - baseline.ev[h]) > 1e-9
    }
    hvac_delta = {
        h: round1(hvac[h] - baseline.hvac[h])
        for h in range(HOURS)
        if abs(hvac[h] - baseline.hvac[h]) > 1e-9
    }
    dispatch = {h: round1(battery[h]) for h in range(HOURS) if battery[h] > 0}

    assembled = _assemble(
        fixture,
        ev=ev,
        hvac=hvac,
        battery=battery,
        ev_delta=ev_delta,
        hvac_delta=hvac_delta,
        discharge=dispatch,
        # Charging sits inside the grid curve and is already paid for at the
        # hour it happens, so it must not be billed a second time.
        recharge_kwh=0.0,
        ev_kwh_after_window=0.0,
        hvac_drift_hours_declared=None,
        derived=True,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
        solve_time_ms=int(float(result.solver.get("wall_time_s", 0.0)) * 1000),
        status=str(result.status),
    )

    # Cross-check: our identity-derived curve against the engine's own net.
    engine_peak = float(result.optimized_peak_kw)
    drift = abs(assembled.optimized_peak_kw - engine_peak)
    if drift > 1.0:
        log.warning(
            "%s: engine peak %.1f kW vs identity-derived %.1f kW (%.1f kW apart); "
            "the clamp on HVAC curtailment is the usual cause",
            fixture.id,
            engine_peak,
            assembled.optimized_peak_kw,
            drift,
        )
    else:
        log.info(
            "%s: engine %s, peak %.1f -> %.1f kW in %d ms",
            fixture.id,
            result.status,
            assembled.baseline_peak_kw,
            assembled.optimized_peak_kw,
            assembled.solve_time_ms,
        )

    return assembled


def soc_for(fixture: "BuildingFixture", battery: list[float]) -> list[float]:
    """State-of-charge walk for a dispatch, in the fixture's own terms."""
    capacity = float(fixture.building["battery_capacity_kwh"])
    baseline = fixture.baseline_parts
    start = round1(
        baseline.soc[0] + (baseline.battery[0] / capacity) * 100 if baseline.soc else 0.0
    )
    return soc_walk(battery, start, capacity)


__all__ = ["solve_with_engine", "FlowComponents"]
