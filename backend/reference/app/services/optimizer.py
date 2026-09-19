"""
The schedule optimizer.

This is a deterministic heuristic, not a solver. It exists so the rest of the
reference -- the agent loop, the event stream, the plan endpoint, the flow
identity -- can be exercised end to end against numbers that are actually
computed from the forecast rather than hard-coded.

Three levers, applied in a fixed order because each one changes the curve the
next one sees:

  1. EV shift    move flexible charging out of the peak-setting hours into a
                 window that still meets every session's deadline. Energy is
                 conserved exactly; only the timing changes.
  2. HVAC        pre-cool while it is cheap, then let the setpoint drift for
                 the permitted number of hours. Signed kW per hour.
  3. Battery     flat discharge across the hours that are still over
                 threshold, sized by whichever binds first: the inverter, the
                 energy above the state-of-charge reserve floor, or the height
                 of the exceedance.

Each lever can be *pinned* by the site's DispatchPolicy or *derived* here. The
four demo buildings pin theirs, because the published demo has a known answer;
a site with an empty policy gets the derivation, and the test suite runs both
paths. Either way the optimized curve is re-derived from the components
through the flow identity, so an action's stated kW really is what moves the
line.

    TODO: replace with OR-Tools. This heuristic applies the three levers in a
    fixed order and never backtracks, so it cannot trade one against another --
    it will not, for example, discharge the battery harder in order to buy the
    HVAC action a shorter drift. `solve_with_ortools()` below is where a CP-SAT
    model belongs: one integer variable per (resource, hour), the flow identity
    as a linear constraint, `minimize(peak, then cost)` as a lexicographic
    objective, and the same OptimizationResult on the way out so nothing
    downstream has to change.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..fixtures.generator import (
    DEMAND_CHARGE_USD_PER_KW,
    HOURS,
    OFF_PEAK_USD_PER_KWH,
    FlowComponents,
    energy_cost,
    grid_from_components,
    round1,
    round2,
    soc_walk,
    to_flows,
)

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from ..fixtures.spec import BuildingFixture


@dataclass
class OptimizationResult:
    """
    Everything the plan, the prose and the agent's narration are computed from.

    Nothing downstream recomputes any of this; if a number appears in a
    sentence it was read off this object.
    """

    building_id: str
    building_name: str
    threshold_kw: float

    baseline_parts: FlowComponents
    optimized_parts: FlowComponents
    baseline_grid: list[float]
    optimized_grid: list[float]
    baseline_flows: list[dict[str, float]]
    optimized_flows: list[dict[str, float]]

    baseline_peak_kw: float
    baseline_peak_hour: int
    optimized_peak_kw: float
    optimized_peak_hour: int
    peak_reduction_kw: float

    baseline_cost_usd: float
    optimized_cost_usd: float
    savings_usd: float
    demand_charge_avoided_usd: float

    over_threshold_hours: list[int]
    first_exceedance_hour: int | None

    battery_discharge_kw: dict[int, float]
    battery_kwh: float
    battery_recharge_kwh: float
    start_soc_pct: float
    end_soc_pct: float
    reserve_floor_pct: float
    dispatchable_kwh: float
    inverter_kw: float

    ev_delta_kw: dict[int, float]
    ev_kwh_after_window: float
    hvac_delta_kw: dict[int, float]
    #: Site-declared drift hours, when coasting makes the negative deltas wider
    #: than the actual setpoint change. None means "derive from the deltas".
    hvac_drift_hours_declared: list[int] | None

    #: True when the heuristic sized the dispatch itself rather than reading it
    #: off the site's DispatchPolicy.
    derived: bool
    #: Wall-clock cost of this heuristic, for the tool result.
    heuristic_ms: int
    #: Narrative solve time the demo reports, when the site declares one.
    solve_time_ms: int
    status: str = "OPTIMAL"
    extras: dict[str, Any] = field(default_factory=dict)

    # ---------------------------------------------------------------- helpers

    @property
    def battery_hours(self) -> list[int]:
        return sorted(self.battery_discharge_kw)

    @property
    def battery_flat_kw(self) -> float:
        values = set(self.battery_discharge_kw.values())
        return round1(next(iter(values))) if len(values) == 1 else 0.0

    @property
    def hours_over_threshold(self) -> int:
        return len(self.over_threshold_hours)

    @property
    def ev_shift_from_hours(self) -> list[int]:
        return sorted(h for h, kw in self.ev_delta_kw.items() if kw < 0)

    @property
    def ev_shift_to_hours(self) -> list[int]:
        return sorted(h for h, kw in self.ev_delta_kw.items() if kw > 0)

    @property
    def ev_shifted_kwh(self) -> float:
        return round1(-sum(kw for kw in self.ev_delta_kw.values() if kw < 0))

    @property
    def hvac_precool_hours(self) -> list[int]:
        return sorted(h for h, kw in self.hvac_delta_kw.items() if kw > 0)

    @property
    def hvac_drift_hours(self) -> list[int]:
        if self.hvac_drift_hours_declared is not None:
            return sorted(self.hvac_drift_hours_declared)
        return sorted(h for h, kw in self.hvac_delta_kw.items() if kw < 0)

    @property
    def hvac_shed_kw(self) -> float:
        drift = [abs(kw) for kw in self.hvac_delta_kw.values() if kw < 0]
        return round1(max(drift)) if drift else 0.0

    @property
    def min_grid_kw(self) -> float:
        return round1(min(self.baseline_grid))


# --------------------------------------------------------------------------- #
# Derivations -- used when a site has not pinned its dispatch shape            #
# --------------------------------------------------------------------------- #


def _contiguous_block(hours: list[int]) -> list[int]:
    """The longest run of consecutive hours in an ascending list."""
    if not hours:
        return []
    best: list[int] = []
    current = [hours[0]]
    for h in hours[1:]:
        if h == current[-1] + 1:
            current.append(h)
        else:
            if len(current) > len(best):
                best = current
            current = [h]
    return current if len(current) > len(best) else best


def derive_ev_shift(
    baseline_ev: list[float], over_hours: list[int], ev_facts: dict[str, Any]
) -> dict[int, float]:
    """
    Move the flexible sessions out of the over-threshold hours and re-queue
    them, hour for hour, in the first slot that clears the site's earliest
    permitted shift time. Energy is conserved exactly.
    """
    flexible = float(ev_facts.get("flexible_sessions", 0) or 0)
    charger_kw = float(
        ev_facts.get("charger_power_kw_each") or ev_facts.get("charger_power_kw") or 0
    )
    movable_kw = flexible * charger_kw
    if movable_kw <= 0 or not over_hours:
        return {}

    from_hours = [h for h in over_hours if baseline_ev[h] >= movable_kw]
    if not from_hours:
        return {}

    earliest = int(ev_facts.get("earliest_shift_hour", max(over_hours) + 1))
    start = max(earliest, max(over_hours) + 1)
    to_hours = [h for h in range(start, HOURS)][: len(from_hours)]

    delta: dict[int, float] = {h: -movable_kw for h in from_hours}
    for h in to_hours:
        delta[h] = delta.get(h, 0.0) + movable_kw
    return {h: round1(kw) for h, kw in delta.items() if abs(kw) > 1e-9}


def derive_hvac_shift(
    over_hours: list[int], hvac_facts: dict[str, Any]
) -> dict[int, float]:
    """
    Pre-cool for the permitted drift duration immediately before the first
    exceedance, then drift through the same number of the worst hours.
    """
    shed_kw = float(hvac_facts.get("estimated_shed_kw", 0) or 0)
    drift_hours = int(hvac_facts.get("max_drift_hours", 0) or 0)
    if shed_kw <= 0 or drift_hours <= 0 or not over_hours:
        return {}

    first = min(over_hours)
    precool = [h for h in range(max(0, first - drift_hours), first)]
    drift = over_hours[:drift_hours]

    delta: dict[int, float] = {h: shed_kw for h in precool}
    for h in drift:
        delta[h] = delta.get(h, 0.0) - shed_kw
    return {h: round1(kw) for h, kw in delta.items() if abs(kw) > 1e-9}


def derive_battery_discharge(
    interim_grid: list[float],
    threshold_kw: float,
    battery_facts: dict[str, Any],
) -> dict[int, float]:
    """
    Flat peak shaving across the hours that are still over threshold after the
    EV and HVAC levers. Sized by whichever binds first: the inverter rating,
    the dispatchable energy above the reserve floor, or the exceedance itself.
    """
    dispatchable_kwh = float(battery_facts.get("dispatchable_kwh", 0) or 0)
    max_kw = float(battery_facts.get("max_discharge_kw", 0) or 0)
    over = [h for h, kw in enumerate(interim_grid) if kw > threshold_kw]
    window = _contiguous_block(over)
    if not window or dispatchable_kwh <= 0 or max_kw <= 0:
        return {}

    needed_kw = max(interim_grid[h] - threshold_kw for h in window)
    flat_kw = round1(min(max_kw, dispatchable_kwh / len(window), needed_kw))
    if flat_kw <= 0:
        return {}
    return {h: flat_kw for h in window}


# --------------------------------------------------------------------------- #
# The heuristic                                                                #
# --------------------------------------------------------------------------- #


def optimize(fixture: "BuildingFixture") -> OptimizationResult:
    """Run the three levers over one building's baseline and price the result."""
    started = time.perf_counter()

    threshold = fixture.peak_threshold_kw
    baseline = fixture.baseline_parts
    baseline_grid = list(fixture.baseline_grid)
    policy = fixture.policy

    battery_facts = fixture.tool_facts.get("get_battery_state", {})
    ev_facts = fixture.tool_facts.get("get_ev_requirements", {})
    hvac_facts = fixture.tool_facts.get("get_hvac_constraints", {})

    over_hours = [h for h, kw in enumerate(baseline_grid) if kw > threshold]

    # --- lever 1: EV --------------------------------------------------------
    derived = False
    ev_delta = dict(policy.ev_delta_kw)
    if not ev_delta:
        ev_delta = derive_ev_shift(baseline.ev, over_hours, ev_facts)
        derived = derived or bool(ev_delta)

    # --- lever 2: HVAC ------------------------------------------------------
    # A site whose HVAC tool reports no flexible kW (the unconditioned high
    # bay) derives an empty delta -- the reference never invents an action.
    hvac_delta = dict(policy.hvac_delta_kw)
    if not hvac_delta:
        hvac_delta = derive_hvac_shift(over_hours, hvac_facts)
        derived = derived or bool(hvac_delta)

    ev = [round1(baseline.ev[h] + ev_delta.get(h, 0.0)) for h in range(HOURS)]
    hvac = [round1(baseline.hvac[h] + hvac_delta.get(h, 0.0)) for h in range(HOURS)]

    # --- lever 3: battery ---------------------------------------------------
    interim = FlowComponents(
        base=list(baseline.base),
        ev=ev,
        hvac=hvac,
        solar=list(baseline.solar),
        battery=list(baseline.battery),
    )
    interim_grid = grid_from_components(interim)

    if policy.battery_discharge_kw is None:
        discharge = derive_battery_discharge(interim_grid, threshold, battery_facts)
        derived = True
    else:
        discharge = dict(policy.battery_discharge_kw)

    capacity_kwh = float(fixture.building["battery_capacity_kwh"])
    # SOC at the start of the day, backed out of the baseline walk so the
    # optimized walk starts from the same place. (The residence charges from PV
    # all morning, so its 10:00 reading is not its 00:00 reading.)
    start_soc = round1(
        baseline.soc[0] + (baseline.battery[0] / capacity_kwh) * 100 if baseline.soc else 0.0
    )
    # The baseline battery series survives (the residence charges from PV all
    # morning); the dispatch hours are written over the top of it.
    battery = list(baseline.battery)
    for h, kw in discharge.items():
        battery[h] = round1(kw)

    optimized = FlowComponents(
        base=list(baseline.base),
        ev=ev,
        hvac=hvac,
        solar=list(baseline.solar),
        battery=battery,
        soc=soc_walk(battery, start_soc, capacity_kwh),
    )
    optimized_grid = grid_from_components(optimized)

    # --- price it -----------------------------------------------------------
    battery_kwh = round1(sum(kw for kw in discharge.values() if kw > 0))
    recharge_kwh = (
        battery_kwh if policy.battery_recharge_kwh is None else float(policy.battery_recharge_kwh)
    )

    baseline_peak = max(baseline_grid)
    optimized_peak = max(optimized_grid)
    baseline_cost = round2(energy_cost(baseline_grid))
    optimized_cost = round2(energy_cost(optimized_grid) + recharge_kwh * OFF_PEAK_USD_PER_KWH)
    peak_reduction = round1(baseline_peak - optimized_peak)

    end_soc = optimized.soc[max(discharge)] if discharge else optimized.soc[-1]

    return OptimizationResult(
        building_id=fixture.id,
        building_name=fixture.name,
        threshold_kw=threshold,
        baseline_parts=baseline,
        optimized_parts=optimized,
        baseline_grid=baseline_grid,
        optimized_grid=optimized_grid,
        baseline_flows=to_flows(baseline_grid, baseline),
        optimized_flows=to_flows(optimized_grid, optimized),
        baseline_peak_kw=round1(baseline_peak),
        baseline_peak_hour=baseline_grid.index(baseline_peak),
        optimized_peak_kw=round1(optimized_peak),
        optimized_peak_hour=optimized_grid.index(optimized_peak),
        peak_reduction_kw=peak_reduction,
        baseline_cost_usd=baseline_cost,
        optimized_cost_usd=optimized_cost,
        savings_usd=round2(baseline_cost - optimized_cost),
        demand_charge_avoided_usd=round2(peak_reduction * DEMAND_CHARGE_USD_PER_KW),
        over_threshold_hours=over_hours,
        first_exceedance_hour=over_hours[0] if over_hours else None,
        battery_discharge_kw=discharge,
        battery_kwh=battery_kwh,
        battery_recharge_kwh=round1(recharge_kwh),
        start_soc_pct=round1(start_soc),
        end_soc_pct=round1(end_soc),
        reserve_floor_pct=float(battery_facts.get("reserve_floor_pct", 0.0)),
        dispatchable_kwh=float(battery_facts.get("dispatchable_kwh", 0.0)),
        inverter_kw=float(fixture.building["battery_max_kw"]),
        ev_delta_kw=ev_delta,
        ev_kwh_after_window=policy.ev_kwh_after_window,
        hvac_delta_kw=hvac_delta,
        hvac_drift_hours_declared=policy.hvac_drift_hours,
        derived=derived,
        heuristic_ms=int((time.perf_counter() - started) * 1000),
        solve_time_ms=int(
            fixture.tool_facts.get("run_schedule_optimizer", {}).get("solve_time_ms", 0)
        ),
    )


# --------------------------------------------------------------------------- #
# The production seam                                                          #
# --------------------------------------------------------------------------- #


def solve_with_ortools(fixture: "BuildingFixture") -> OptimizationResult:
    """
    Where the real optimizer goes.

    Build a CP-SAT model with one integer variable per (resource, hour) in
    watts, constrain each hour to the flow identity, add the device
    constraints the tools already report (SOC floor and inverter rating, EV
    energy and deadlines, HVAC drift duration and comfort band), and minimise
    the peak lexicographically before the energy cost. Return the same
    OptimizationResult and nothing downstream changes.
    """
    raise NotImplementedError(
        "OR-Tools solver not implemented in the reference backend. "
        "Use optimize() (the deterministic heuristic) or wire CP-SAT in here."
    )
