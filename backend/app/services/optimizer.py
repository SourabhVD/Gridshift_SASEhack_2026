"""
The schedule optimizer. Two of them, over the same three levers.

`solve()` picks between them on GRIDSHIFT_OPTIMIZER and is what the agent
calls. Both return the same OptimizationResult through the same `_assemble()`,
so they cannot disagree about how a schedule is priced or which fields the
plan reads.

`solve_with_ortools()` is the real one and the default: a CP-SAT model with one
integer variable per (resource, hour), the flow identity as a linear constraint
each hour, and a lexicographic objective -- minimise the peak, then minimise
cost at that peak. Because it holds all three levers at once it can trade them
against each other, discharging harder to buy the HVAC a shorter drift when
that lowers the peak. It roughly doubles the demand charge avoided on three of
the four demo sites.

`optimize()` is the deterministic heuristic that came first. It stays reachable
by configuration because the figures in the frontend README were computed from
it, and because running the two side by side is how you show the solver earns
its place.

Three levers. The heuristic applies them in a fixed order, because each one
changes the curve the next one sees:

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

The heuristic never backtracks, which is its ceiling: it cannot discharge the
battery harder in order to buy the HVAC action a shorter drift, because by the
time it reaches the battery the HVAC decision is already made. That is the gap
the CP-SAT model closes.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..fixtures.generator import (
    DEMAND_CHARGE_USD_PER_KW,
    HOURS,
    OFF_PEAK_USD_PER_KWH,
    PRICE_PER_KWH,
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
        """
        The rate the battery action is described by.

        The heuristic discharges flat, so this is simply that value. A solver
        can vary the rate hour to hour, and then the headline is the deepest
        one -- the figure the inverter has to support. It must never be 0 for
        a real dispatch: returning that produced an action titled "Discharge
        battery at 0 kW" in a live run.
        """
        values = set(self.battery_discharge_kw.values())
        if not values:
            return 0.0
        return round1(next(iter(values)) if len(values) == 1 else max(values))

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
# Shared result assembly                                                       #
# --------------------------------------------------------------------------- #


def _assemble(
    fixture: "BuildingFixture",
    *,
    ev: list[float],
    hvac: list[float],
    battery: list[float],
    ev_delta: dict[int, float],
    hvac_delta: dict[int, float],
    discharge: dict[int, float],
    recharge_kwh: float,
    ev_kwh_after_window: float,
    hvac_drift_hours_declared: list[int] | None,
    derived: bool,
    elapsed_ms: int,
    solve_time_ms: int,
    status: str = "OPTIMAL",
) -> OptimizationResult:
    """
    Price a dispatch and package it, whatever produced it.

    Both the heuristic and the CP-SAT solver come through here, so the two can
    never disagree about how a schedule is costed or which fields the plan
    reads. The optimized curve is re-derived from the components through the
    flow identity rather than being reported separately, so an action's stated
    kW really is what moves the line.
    """
    threshold = fixture.peak_threshold_kw
    baseline = fixture.baseline_parts
    baseline_grid = list(fixture.baseline_grid)
    capacity_kwh = float(fixture.building["battery_capacity_kwh"])
    battery_facts = fixture.tool_facts.get("get_battery_state", {})

    over_hours = [h for h, kw in enumerate(baseline_grid) if kw > threshold]

    # SOC at the start of the day, backed out of the baseline walk so the
    # optimized walk starts from the same place. (The residence charges from PV
    # all morning, so its 10:00 reading is not its 00:00 reading.)
    start_soc = round1(
        baseline.soc[0] + (baseline.battery[0] / capacity_kwh) * 100 if baseline.soc else 0.0
    )

    optimized = FlowComponents(
        base=list(baseline.base),
        ev=ev,
        hvac=hvac,
        solar=list(baseline.solar),
        battery=battery,
        soc=soc_walk(battery, start_soc, capacity_kwh),
    )
    optimized_grid = grid_from_components(optimized)

    battery_kwh = round1(sum(kw for kw in discharge.values() if kw > 0))

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
        ev_kwh_after_window=ev_kwh_after_window,
        hvac_delta_kw=hvac_delta,
        hvac_drift_hours_declared=hvac_drift_hours_declared,
        derived=derived,
        heuristic_ms=elapsed_ms,
        solve_time_ms=solve_time_ms,
        status=status,
    )


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

    # The baseline battery series survives (the residence charges from PV all
    # morning); the dispatch hours are written over the top of it.
    battery = list(baseline.battery)
    for h, kw in discharge.items():
        battery[h] = round1(kw)

    battery_kwh = round1(sum(kw for kw in discharge.values() if kw > 0))
    recharge_kwh = (
        battery_kwh if policy.battery_recharge_kwh is None else float(policy.battery_recharge_kwh)
    )

    return _assemble(
        fixture,
        ev=ev,
        hvac=hvac,
        battery=battery,
        ev_delta=ev_delta,
        hvac_delta=hvac_delta,
        discharge=discharge,
        recharge_kwh=recharge_kwh,
        ev_kwh_after_window=policy.ev_kwh_after_window,
        hvac_drift_hours_declared=policy.hvac_drift_hours,
        derived=derived,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
        solve_time_ms=int(
            fixture.tool_facts.get("run_schedule_optimizer", {}).get("solve_time_ms", 0)
        ),
    )


# --------------------------------------------------------------------------- #
# The production seam                                                          #
# --------------------------------------------------------------------------- #


#: Everything is modelled in tenths of a kW, so CP-SAT works in integers and
#: every value it returns is already on the 0.1 kW grid the wire format uses.
#: That is what keeps the flow identity exact after conversion: a sum of
#: multiples of 0.1 is a multiple of 0.1, with no float residue to round away.
DECI = 10

#: Prices in hundredths of a cent per kWh, so the cost objective is integral.
#: 0.09 USD -> 900, 0.16 -> 1600.
PRICE_SCALE = 10_000

#: CP-SAT gets far longer than it needs for 72 variables over 24 hours. The
#: cap only matters if someone points this at a much larger horizon.
SOLVE_TIME_LIMIT_S = 5.0


def _deci(value: float) -> int:
    return int(round(value * DECI))


def solve_with_ortools(fixture: "BuildingFixture") -> OptimizationResult:
    """
    The real optimizer: a CP-SAT model over the same three levers.

    One integer variable per (resource, hour) in tenths of a kW. Each hour is
    tied to the flow identity, the device limits the tools already report
    become linear constraints, and the objective is lexicographic -- minimise
    the peak, then minimise cost at that peak. Returns the same
    OptimizationResult as the heuristic, so nothing downstream changes.

    Unlike the heuristic this can trade the levers against each other: it will
    discharge harder to buy the HVAC a shorter drift if that lowers the peak,
    which a fixed-order pass can never find.

    **The model is always feasible by construction.** Every constraint admits
    the untouched baseline, and the baseline is fed in as a solution hint, so
    the solver can never do worse than doing nothing and can never come back
    INFEASIBLE. That is deliberate: it is what makes this safe to run without a
    fallback path behind it.
    """
    from ortools.sat.python import cp_model  # noqa: PLC0415 - optional at import time

    started = time.perf_counter()

    threshold = fixture.peak_threshold_kw
    baseline = fixture.baseline_parts
    baseline_grid = list(fixture.baseline_grid)

    battery_facts = fixture.tool_facts.get("get_battery_state", {})
    ev_facts = fixture.tool_facts.get("get_ev_requirements", {})
    hvac_facts = fixture.tool_facts.get("get_hvac_constraints", {})

    base_d = [_deci(v) for v in baseline.base]
    solar_d = [_deci(v) for v in baseline.solar]
    ev_base_d = [_deci(v) for v in baseline.ev]
    hvac_base_d = [_deci(v) for v in baseline.hvac]
    batt_base_d = [_deci(v) for v in baseline.battery]

    model = cp_model.CpModel()

    # --- EV: the same energy, possibly at different hours -------------------
    # The cap is generous enough to admit the baseline whatever the tool says,
    # which is what keeps the baseline feasible.
    charger_kw = float(
        ev_facts.get("charger_power_kw_each") or ev_facts.get("charger_power_kw") or 0
    )
    bays = float(ev_facts.get("connected", 0) or ev_facts.get("sessions", 0) or 0)
    ev_cap_d = max(max(ev_base_d, default=0), _deci(charger_kw * bays))
    earliest = int(ev_facts.get("earliest_shift_hour", 0) or 0)

    ev = [model.NewIntVar(0, ev_cap_d, f"ev_{h}") for h in range(HOURS)]
    # Energy is conserved exactly: charging moves in time, it does not vanish.
    model.Add(sum(ev) == sum(ev_base_d))
    for h in range(HOURS):
        # A session cannot be served before the site says a shift may start,
        # unless the baseline was already charging then -- moving a car's
        # charge earlier than it arrived is not a schedule, it is fiction.
        if h < earliest and ev_base_d[h] == 0:
            model.Add(ev[h] == 0)

    # --- HVAC: pre-cool then drift, inside the comfort band -----------------
    shed_d = _deci(float(hvac_facts.get("estimated_shed_kw", 0) or 0))
    max_drift = int(hvac_facts.get("max_drift_hours", 0) or 0)

    hvac = [
        model.NewIntVar(max(0, hvac_base_d[h] - shed_d), hvac_base_d[h] + shed_d, f"hvac_{h}")
        for h in range(HOURS)
    ]
    # Thermal mass, not a free lunch: whatever the setpoint drift sheds has to
    # be put back in, so the day's cooling energy is unchanged.
    model.Add(sum(hvac) == sum(hvac_base_d))

    # At most max_drift hours may sit below the baseline. With shed_d or
    # max_drift at zero -- the unconditioned high bay -- this pins HVAC to the
    # baseline and the lever simply is not used.
    drifting = []
    for h in range(HOURS):
        flag = model.NewBoolVar(f"drift_{h}")
        model.Add(hvac[h] < hvac_base_d[h]).OnlyEnforceIf(flag)
        model.Add(hvac[h] >= hvac_base_d[h]).OnlyEnforceIf(flag.Not())
        drifting.append(flag)
    model.Add(sum(drifting) <= max_drift)

    # --- Battery: signed, inverter-limited, respecting the reserve floor ----
    capacity_kwh = float(fixture.building["battery_capacity_kwh"])
    inverter_d = max(
        _deci(float(fixture.building["battery_max_kw"])),
        max((abs(v) for v in batt_base_d), default=0),
    )
    start_soc = round1(
        baseline.soc[0] + (baseline.battery[0] / capacity_kwh) * 100 if baseline.soc else 0.0
    )

    capacity_d = _deci(capacity_kwh)
    start_d = int(round(start_soc / 100 * capacity_d))
    declared_floor_d = int(
        round(float(battery_facts.get("reserve_floor_pct", 0.0) or 0.0) / 100 * capacity_d
    ))
    baseline_soc_d = []
    running = start_d
    for value in batt_base_d:
        running -= value
        baseline_soc_d.append(running)

    # The solver will sit exactly on any floor it is given, because energy held
    # back is peak not shaved. Downstream, validate_schedule re-walks the state
    # of charge in percent with soc_walk, which rounds at every hour -- so an
    # exact landing here can read as a fraction below the floor there, and the
    # agent would reject its own plan. Half a percent of capacity absorbs that.
    margin_d = max(1, int(round(0.005 * capacity_d)))
    # Never let the floor exclude the baseline's own walk: a site whose
    # authored curve dips below its stated reserve must still be solvable, or
    # the model would be infeasible for that building alone.
    floor_d = min(declared_floor_d + margin_d, min(baseline_soc_d, default=declared_floor_d))
    ceiling_d = max(capacity_d, max(baseline_soc_d, default=capacity_d), start_d)

    batt = [model.NewIntVar(-inverter_d, inverter_d, f"batt_{h}") for h in range(HOURS)]
    soc = [model.NewIntVar(floor_d, ceiling_d, f"soc_{h}") for h in range(HOURS)]
    for h in range(HOURS):
        previous = start_d if h == 0 else soc[h - 1]
        # Positive kW discharges into the building and drains the pack.
        model.Add(soc[h] == previous - batt[h])

    # The pack must end the day no worse off than it started. Without this the
    # solver discovers that discharging always lowers both the peak and the
    # bill, drains to the reserve floor and never buys the energy back -- a
    # saving that exists only because the model let it spend stored energy for
    # free. It showed up as a battery "action" smeared across ten hours,
    # including one at midnight, for 552 kWh against the heuristic's 270.
    # Pinned to the baseline's own ending where that is lower, so a site whose
    # authored curve ends down is still feasible.
    model.Add(soc[HOURS - 1] >= min(start_d, baseline_soc_d[-1]))

    # --- The flow identity, hour by hour ------------------------------------
    grid_cap = max(base_d) + ev_cap_d + max(hvac_base_d, default=0) + shed_d + inverter_d
    baseline_grid_d = [_deci(v) for v in baseline_grid]
    grid = []
    for h in range(HOURS):
        # A site with enough PV exports at midday -- the residence's baseline
        # runs to -4 kW -- so the lower bound cannot be zero or its own curve
        # would be excluded. It is pinned at the baseline's export instead, so
        # the solver may keep an existing export but cannot invent a new one:
        # dumping the pack into the grid at noon for an energy credit prices
        # well under this tariff and is not a schedule anyone wants to approve.
        floor = min(0, baseline_grid_d[h])
        grid.append(model.NewIntVar(floor, grid_cap, f"grid_{h}"))
        model.Add(grid[h] == base_d[h] + ev[h] + hvac[h] - solar_d[h] - batt[h])

    peak = model.NewIntVar(0, grid_cap, "peak")
    model.AddMaxEquality(peak, grid)

    cost = sum(grid[h] * int(round(PRICE_PER_KWH[h] * PRICE_SCALE)) for h in range(HOURS))

    # The baseline is a feasible point. Hinting it means the solver starts from
    # "do nothing" and can only improve, and it is also the proof that this
    # model can never be infeasible.
    for h in range(HOURS):
        model.AddHint(ev[h], ev_base_d[h])
        model.AddHint(hvac[h], hvac_base_d[h])
        model.AddHint(batt[h], batt_base_d[h])

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = SOLVE_TIME_LIMIT_S
    # Fixed seed and a single worker: the same building must produce the same
    # plan every run, or the demo's numbers move between takes.
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 42

    # Phase 1: the lowest reachable peak. Demand charge dominates the bill, and
    # the whole product is about the peak, so it wins ties against energy cost.
    model.Minimize(peak)
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):  # pragma: no cover - see docstring
        raise RuntimeError(f"CP-SAT returned {solver.StatusName(status)} on a model that admits the baseline")
    best_peak = solver.Value(peak)

    # Phase 2: cheapest schedule that still hits that peak. Separate solves
    # rather than one weighted objective, so "minimise cost" cannot quietly
    # buy a worse peak by being large enough.
    model.Add(peak <= best_peak)
    model.Minimize(cost)
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):  # pragma: no cover
        raise RuntimeError(f"CP-SAT returned {solver.StatusName(status)} in the cost phase")
    best_cost = solver.Value(cost)

    # Phase 3: of the schedules that are equally cheap at that peak, take the
    # one that moves the battery least. Off-peak energy is a flat price here,
    # so cycling the pack at 01:00 costs the model nothing and it will happily
    # do it -- producing a dispatch smeared over ten hours including one at
    # midnight, which reads as noise rather than a decision. Real cycling is
    # not free (the pack wears), and this is the cheapest way to say so
    # without inventing a degradation cost. It cannot compromise the peak or
    # the bill, because both are already pinned.
    movement = []
    for h in range(HOURS):
        magnitude = model.NewIntVar(0, inverter_d, f"move_{h}")
        model.AddAbsEquality(magnitude, batt[h])
        movement.append(magnitude)
    model.Add(cost <= best_cost)
    model.Minimize(sum(movement))
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):  # pragma: no cover
        raise RuntimeError(f"CP-SAT returned {solver.StatusName(status)} in the churn phase")

    ev_out = [solver.Value(v) / DECI for v in ev]
    hvac_out = [solver.Value(v) / DECI for v in hvac]
    batt_out = [solver.Value(v) / DECI for v in batt]

    ev_delta = {
        h: round1(ev_out[h] - baseline.ev[h])
        for h in range(HOURS)
        if abs(ev_out[h] - baseline.ev[h]) > 1e-9
    }
    hvac_delta = {
        h: round1(hvac_out[h] - baseline.hvac[h])
        for h in range(HOURS)
        if abs(hvac_out[h] - baseline.hvac[h]) > 1e-9
    }
    # Only the discharge hours become a battery action; charging is how the
    # pack gets there and is not something a human approves separately.
    discharge = {h: round1(batt_out[h]) for h in range(HOURS) if batt_out[h] > 0}

    return _assemble(
        fixture,
        ev=[round1(v) for v in ev_out],
        hvac=[round1(v) for v in hvac_out],
        battery=[round1(v) for v in batt_out],
        ev_delta=ev_delta,
        hvac_delta=hvac_delta,
        discharge=discharge,
        # Zero, and it must be. _assemble adds this to the bill on top of the
        # grid curve, which is right for the heuristic because that recharge
        # happens after the modelled day. Here charging IS in the grid curve --
        # a negative battery hour raises grid_kw and is already paid for at
        # that hour's price. Passing the charged kWh as well bills it twice,
        # which showed up as the optimized day costing more than doing nothing.
        recharge_kwh=0.0,
        # Zero, and it has to be: this field is the energy re-queued *outside*
        # the modelled window, and the model conserves EV energy inside the 24
        # hours exactly. validate_schedule adds it to the sum of the deltas and
        # expects the total to be nil, so putting the shifted kWh here as well
        # would double-count them and the agent would fail its own check.
        ev_kwh_after_window=0.0,
        hvac_drift_hours_declared=None,
        derived=True,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
        solve_time_ms=int(solver.WallTime() * 1000),
        status=solver.StatusName(status),
    )


# --------------------------------------------------------------------------- #
# What the agent actually calls                                                #
# --------------------------------------------------------------------------- #


def solve(fixture: "BuildingFixture") -> OptimizationResult:
    """
    The configured optimizer. GRIDSHIFT_OPTIMIZER picks which.

    CP-SAT is the default and there is no fallback behind it, on purpose: the
    model admits the untouched baseline at every constraint and is hinted with
    it, so "no solution" is not a state it can reach. A fallback here would
    only hide a formulation bug that ought to be loud.

    The heuristic stays reachable by configuration because the figures in the
    frontend README were computed from it, and because comparing the two is
    how you show the solver is earning its place.
    """
    from ..config import get_settings  # noqa: PLC0415 - avoids an import cycle

    if get_settings().optimizer_mode == "heuristic":
        return optimize(fixture)
    return solve_with_ortools(fixture)
