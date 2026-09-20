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
def test_the_pack_ends_the_day_no_worse_off(fixture, solved) -> None:
    """
    Energy neutrality, and it is not optional.

    Discharging always lowers both the peak and the bill, so without this the
    solver drains to the reserve floor and never buys the energy back -- a
    saving that exists only because the model let it spend stored energy for
    free. The heuristic is not held to this, which is why it can post a deeper
    cut on a site where the battery is the binding lever.
    """
    result = solved[fixture.id]
    assert result.optimized_parts.soc[-1] >= min(
        result.start_soc_pct, fixture.baseline_parts.soc[-1]
    ) - 0.1


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_the_plan_actually_saves_money(fixture, solved) -> None:
    """
    Charging is inside the grid curve, so it must not be billed again.

    `_assemble` adds a recharge cost on top for the heuristic, whose recharge
    happens after the modelled day. Passing the solver's charged kWh there too
    billed it twice and made the optimized day cost more than doing nothing.
    """
    assert solved[fixture.id].savings_usd > 0


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_the_battery_action_has_a_real_rate(fixture, solved) -> None:
    """
    A varying dispatch must not report 0 kW.

    `battery_flat_kw` returned 0 for any non-flat profile, which a live run
    turned into an action titled "Discharge battery at 0 kW".
    """
    result = solved[fixture.id]
    if result.battery_discharge_kw:
        assert result.battery_flat_kw > 0
        assert result.battery_flat_kw == pytest.approx(
            max(result.battery_discharge_kw.values()), abs=0.05
        )


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_the_dispatch_is_not_smeared_across_the_day(fixture, solved) -> None:
    """
    Off-peak energy is a flat price, so cycling the pack at 01:00 costs the
    model nothing and it will do it unless told otherwise. The third solve
    pass minimises battery movement once peak and cost are both pinned, which
    turns a dispatch spread over ten hours into one that reads as a decision.
    """
    hours = sorted(solved[fixture.id].battery_discharge_kw)
    if len(hours) > 1:
        assert max(hours) - min(hours) <= 12, f"{fixture.id} discharges at {hours}"


def test_the_solver_wins_where_it_is_not_holding_itself_back(solved) -> None:
    """
    CP-SAT must beat the fixed-order pass on most sites, or the machinery
    buys nothing. It is not required to win everywhere: it obeys end-of-day
    energy neutrality and the heuristic does not, so on a site where the
    battery is the binding lever the heuristic can post a deeper cut by
    spending charge it never replaces.
    """
    wins = [
        f.id
        for f in FIXTURES
        if solved[f.id].peak_reduction_kw > optimize(f).peak_reduction_kw + 0.05
    ]
    assert len(wins) >= len(FIXTURES) - 1, f"CP-SAT only won on {wins}"


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
