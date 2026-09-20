"""
The CP-SAT optimizer.

`optimize()` applies three levers in a fixed order and never backtracks, so it
cannot trade one against another. `solve_with_ortools()` models all three at
once and minimises the peak lexicographically before cost, which is why it
finds deeper cuts on every site.

The properties pinned here are the ones a wrong model would quietly break: the
flow identity, non-negativity, energy conservation, the device limits, and the
guarantee that the solver can never do worse than leaving the building alone.
That last one is also why there is no fallback path -- every constraint admits
the untouched baseline, so "infeasible" is not a reachable state.
"""

from __future__ import annotations

import pytest

from app.config import get_settings
from app.fixtures import FIXTURES, assert_flows_identity
from app.fixtures.generator import HOURS
from app.services.optimizer import optimize, solve, solve_with_ortools

IDS = [f.id for f in FIXTURES]


@pytest.fixture(scope="module")
def solved():
    """One solve per building, reused across the property checks."""
    return {f.id: solve_with_ortools(f) for f in FIXTURES}


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_every_building_solves_to_optimality(fixture, solved) -> None:
    result = solved[fixture.id]
    assert result.status == "OPTIMAL"
    assert result.solve_time_ms >= 0


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_flow_identity_holds_on_the_solved_curve(fixture, solved) -> None:
    result = solved[fixture.id]
    points = [
        {"predicted_load_kw": result.optimized_grid[h], "flows": result.optimized_flows[h]}
        for h in range(HOURS)
    ]
    assert_flows_identity(points, label=f"cpsat({fixture.id})")


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_published_fields_stay_non_negative(fixture, solved) -> None:
    """Only battery_kw may be signed. Grid may export where the site already did."""
    result = solved[fixture.id]
    for hour, flows in enumerate(result.optimized_flows):
        for field in ("base_kw", "ev_kw", "hvac_kw", "solar_kw"):
            assert flows[field] >= 0, f"{fixture.id} {field} at {hour}: {flows[field]}"


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_never_worse_than_doing_nothing(fixture, solved) -> None:
    """
    The baseline is a feasible point of the model and is fed in as a hint, so
    the solver cannot return something worse than it. This is the property the
    absence of a fallback rests on.
    """
    result = solved[fixture.id]
    assert result.optimized_peak_kw <= result.baseline_peak_kw + 1e-9
    assert result.peak_reduction_kw >= 0


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_at_least_as_good_as_the_heuristic(fixture, solved) -> None:
    """A solver that loses to a fixed-order pass is not earning its place."""
    assert solved[fixture.id].peak_reduction_kw >= optimize(fixture).peak_reduction_kw - 1e-9


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_energy_is_conserved_not_deleted(fixture, solved) -> None:
    """
    Shifting is not shedding. The EV sessions keep their kWh and the HVAC puts
    back whatever the drift shed, so neither lever can fake a saving by simply
    serving less load.
    """
    result = solved[fixture.id]
    baseline = fixture.baseline_parts
    assert sum(result.optimized_parts.ev) == pytest.approx(sum(baseline.ev), abs=0.05)
    assert sum(result.optimized_parts.hvac) == pytest.approx(sum(baseline.hvac), abs=0.05)


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_device_limits_are_respected(fixture, solved) -> None:
    """The inverter rating, the reserve floor, and the declared drift budget."""
    result = solved[fixture.id]
    inverter = float(fixture.building["battery_max_kw"])
    baseline = fixture.baseline_parts

    headroom = max((abs(v) for v in baseline.battery), default=0.0)
    for hour, kw in enumerate(result.optimized_parts.battery):
        assert abs(kw) <= max(inverter, headroom) + 1e-9, f"{fixture.id} h{hour}: {kw} kW"

    floor = float(fixture.tool_facts.get("get_battery_state", {}).get("reserve_floor_pct", 0.0))
    allowed = min(floor, min(baseline.soc, default=floor))
    assert min(result.optimized_parts.soc) >= allowed - 0.05

    max_drift = int(
        fixture.tool_facts.get("get_hvac_constraints", {}).get("max_drift_hours", 0) or 0
    )
    drifting = sum(
        1 for h in range(HOURS) if result.optimized_parts.hvac[h] < baseline.hvac[h] - 1e-9
    )
    assert drifting <= max_drift


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_no_export_the_site_was_not_already_doing(fixture, solved) -> None:
    """
    A site with enough PV exports at midday, so the grid floor cannot be zero.
    It is pinned at the baseline's own export instead: dumping the pack into
    the grid for an energy credit is not a schedule anyone would approve.
    """
    result = solved[fixture.id]
    allowed = min(0.0, min(fixture.baseline_grid))
    assert min(result.optimized_grid) >= allowed - 1e-9


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_the_solve_is_reproducible(fixture) -> None:
    """Fixed seed, one worker: the demo's numbers must not move between takes."""
    first = solve_with_ortools(fixture)
    second = solve_with_ortools(fixture)
    assert first.optimized_grid == second.optimized_grid
    assert first.optimized_peak_kw == second.optimized_peak_kw
    assert first.savings_usd == second.savings_usd


def test_the_mode_switch_selects_the_right_optimizer(monkeypatch) -> None:
    fixture = FIXTURES[0]

    monkeypatch.setenv("GRIDSHIFT_OPTIMIZER", "heuristic")
    get_settings.cache_clear()
    try:
        assert solve(fixture).optimized_peak_kw == optimize(fixture).optimized_peak_kw
    finally:
        get_settings.cache_clear()

    monkeypatch.setenv("GRIDSHIFT_OPTIMIZER", "ortools")
    get_settings.cache_clear()
    try:
        assert solve(fixture).status == "OPTIMAL"
    finally:
        get_settings.cache_clear()


def test_the_solver_beats_the_heuristic_somewhere(solved) -> None:
    """
    Not a tie on every site, or the extra machinery buys nothing.

    Trading the levers against each other is the whole point: the solver will
    discharge harder to buy the HVAC a shorter drift when that lowers the peak,
    which a fixed-order pass cannot find.
    """
    better = [
        f.id
        for f in FIXTURES
        if solved[f.id].peak_reduction_kw > optimize(f).peak_reduction_kw + 0.05
    ]
    assert better, "CP-SAT matched the heuristic everywhere; check the objective"
