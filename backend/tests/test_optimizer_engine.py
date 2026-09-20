"""
Component 3, the optimization engine, as the product actually runs it.

`GRIDSHIFT_OPTIMIZER=engine` is the default, so this is the solver behind every
plan the demo shows -- and until this file existed it was the only one of the
three with no properties pinned to it. The gap was not theoretical: the engine
prices round-trip battery losses and the other two do not, and the state of
charge published alongside its schedule was being re-derived with a lossless
walk. That put the office at 100.9% at midday, below its own 20% reserve floor
at 18:00, and 57 points adrift by midnight on a schedule the engine had built
to end exactly where it started. Every one of those is visible on the
dashboard; none of them failed a test.

The checks here mirror `test_optimizer_cpsat.py` where the property is the
same, because two solvers feeding one contract have to agree about what a
schedule is allowed to say. The ones that are specific to this path are the
state-of-charge bounds, end-of-day neutrality, and the EV deadline -- the
three places where the engine knows something the adapter has to carry across
faithfully rather than recompute.
"""

from __future__ import annotations

import pytest

from app.fixtures import FIXTURES, assert_flows_identity
from app.fixtures.generator import HOURS
from app.services.engine import _deadline_hour, solve_with_engine

IDS = [f.id for f in FIXTURES]


@pytest.fixture(scope="module")
def solved():
    """One solve per building, reused across the property checks."""
    return {f.id: solve_with_engine(f) for f in FIXTURES}


def _floor_pct(fixture) -> float:
    return float(
        fixture.tool_facts.get("get_battery_state", {}).get("reserve_floor_pct", 0.0)
    )


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
    assert_flows_identity(points, label=f"engine({fixture.id})")


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_published_fields_stay_non_negative(fixture, solved) -> None:
    """Only battery_kw may be signed. Grid may export where the site already did."""
    result = solved[fixture.id]
    for hour, flows in enumerate(result.optimized_flows):
        for field in ("base_kw", "ev_kw", "hvac_kw", "solar_kw"):
            assert flows[field] >= 0, f"{fixture.id} {field} at {hour}: {flows[field]}"


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_never_worse_than_doing_nothing(fixture, solved) -> None:
    result = solved[fixture.id]
    assert result.optimized_peak_kw <= result.baseline_peak_kw + 1e-9
    assert result.peak_reduction_kw >= 0
    assert result.savings_usd > 0


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_state_of_charge_stays_inside_the_pack(fixture, solved) -> None:
    """
    A pack cannot hold more than it holds, and the reserve floor is
    contractual. The engine treats both as hard bounds on its own SOC
    variable, so anything outside them means the number on the dashboard did
    not come from the schedule underneath it.
    """
    soc = solved[fixture.id].optimized_parts.soc
    allowed_floor = min(_floor_pct(fixture), solved[fixture.id].start_soc_pct)
    assert max(soc) <= 100.0 + 0.05, f"{fixture.id} charges past full: {max(soc)}%"
    assert min(soc) >= allowed_floor - 0.05, f"{fixture.id} breaks its floor: {min(soc)}%"


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_the_pack_ends_the_day_where_it_started(fixture, solved) -> None:
    """
    Energy neutrality, and the reason the engine's savings are smaller than
    CP-SAT's were: it has to buy back everything it spends, at 95% each way.
    A pack that ends the day lower has booked a saving for energy nobody paid
    for.
    """
    result = solved[fixture.id]
    assert result.optimized_parts.soc[-1] == pytest.approx(result.start_soc_pct, abs=0.5)


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_energy_is_conserved_not_deleted(fixture, solved) -> None:
    """
    Shifting is not shedding. Charging at 92% means the engine's requirement
    is energy delivered while our series is metered draw, so the adapter has
    to convert between them; getting that backwards drew 8.7% more than the
    day it replaced.
    """
    result = solved[fixture.id]
    baseline = fixture.baseline_parts
    assert sum(result.optimized_parts.ev) == pytest.approx(sum(baseline.ev), abs=0.15)
    assert sum(result.optimized_parts.hvac) == pytest.approx(sum(baseline.hvac), abs=0.15)


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_every_session_is_served_by_its_deadline(fixture, solved) -> None:
    """
    The fleet has to be charged by the hour the site reports, not merely some
    time later. Enforcing this costs real money -- the office's cut drops from
    149.7 to 138.4 kW under CP-SAT once it binds -- which is exactly why it is
    the constraint most likely to be quietly dropped.
    """
    ev = solved[fixture.id].optimized_parts.ev
    deadline = _deadline_hour(fixture.tool_facts.get("get_ev_requirements", {}), 0)
    late = [h for h in range(deadline, HOURS) if ev[h] > 1e-9]
    assert not late, f"{fixture.id} still charging at {late}, deadline {deadline}:00"


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_device_limits_are_respected(fixture, solved) -> None:
    """The inverter rating, and the drift budget the site declared."""
    result = solved[fixture.id]
    inverter = float(fixture.building["battery_max_kw"])
    baseline = fixture.baseline_parts

    headroom = max((abs(v) for v in baseline.battery), default=0.0)
    for hour, kw in enumerate(result.optimized_parts.battery):
        assert abs(kw) <= max(inverter, headroom) + 1e-9, f"{fixture.id} h{hour}: {kw} kW"

    max_drift = int(
        fixture.tool_facts.get("get_hvac_constraints", {}).get("max_drift_hours", 0) or 0
    )
    drifting = sum(
        1 for h in range(HOURS) if result.optimized_parts.hvac[h] < baseline.hvac[h] - 1e-9
    )
    assert drifting <= max_drift


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_no_export_the_site_was_not_already_doing(fixture, solved) -> None:
    """Dumping the pack into the grid for a credit is not a schedule anyone
    would approve, so the floor is the site's own baseline export."""
    result = solved[fixture.id]
    allowed = min(0.0, min(fixture.baseline_grid))
    assert min(result.optimized_grid) >= allowed - 1e-9


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_the_reported_solve_time_is_the_real_one(fixture, solved) -> None:
    """
    The scripted agent reads this out. The engine reports milliseconds under
    `wall_time_ms`; the adapter was reading a `wall_time_s` key that does not
    exist, so every plan claimed a 0 ms solve and the narration said "in
    0.0 s" of a solve that really took tens of milliseconds.
    """
    assert solved[fixture.id].solve_time_ms > 0


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_the_solve_is_reproducible(fixture) -> None:
    """The demo's numbers must not move between takes."""
    first = solve_with_engine(fixture)
    second = solve_with_engine(fixture)
    assert first.optimized_grid == second.optimized_grid
    assert first.optimized_parts.soc == second.optimized_parts.soc
