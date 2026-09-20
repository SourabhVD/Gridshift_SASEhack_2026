"""
The flow identity, and the published headline numbers.

    grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw

holds at every hour of every building, on the baseline and on the optimized
curve, to within half a rounding step. If this drifts, the flow diagram and
the two charts start telling different stories about the same hour.
"""

from __future__ import annotations

import pytest
from .conftest import BUILDING_IDS, poll_until_complete
from fastapi.testclient import TestClient

from app.fixtures import FIXTURES, assert_flows_identity, get_fixture
from app.fixtures.generator import FLOW_TOLERANCE_KW as TOLERANCE_KW
from app.fixtures.generator import flow_residual
from app.services.optimizer import optimize


@pytest.mark.parametrize("fixture", FIXTURES, ids=[f.id for f in FIXTURES])
def test_flow_identity_holds(fixture) -> None:
    result = optimize(fixture)
    for hour in range(24):
        for label, flows in (
            ("baseline", result.baseline_flows[hour]),
            ("optimized", result.optimized_flows[hour]),
        ):
            residual = flow_residual(flows)
            assert abs(residual) <= TOLERANCE_KW, f"{fixture.id} {label} h{hour}: {residual} kW"


@pytest.mark.parametrize("fixture", FIXTURES, ids=[f.id for f in FIXTURES])
def test_published_numbers(fixture) -> None:
    """The reference reproduces the figures the frontend README publishes."""
    result = optimize(fixture)
    published = fixture.published
    assert result.baseline_peak_kw == pytest.approx(published["baseline_peak_kw"], abs=0.05)
    assert result.optimized_peak_kw == pytest.approx(published["optimized_peak_kw"], abs=0.05)
    assert len(fixture.build_actions(result)) == published["action_count"]
    for key in ("peak_reduction_kw", "baseline_cost_usd", "optimized_cost_usd", "savings_usd"):
        if key in published:
            assert getattr(result, key) == pytest.approx(published[key], abs=0.01)


@pytest.mark.parametrize("fixture", FIXTURES, ids=[f.id for f in FIXTURES])
def test_optimizer_respects_the_reserve_floor(fixture) -> None:
    result = optimize(fixture)
    for hour in result.battery_hours:
        assert result.optimized_parts.soc[hour] >= result.reserve_floor_pct


@pytest.mark.parametrize("fixture", FIXTURES, ids=[f.id for f in FIXTURES])
def test_ev_energy_is_conserved(fixture) -> None:
    """Shifting a session moves energy in time; it never deletes it."""
    result = optimize(fixture)
    balance = sum(result.ev_delta_kw.values()) + result.ev_kwh_after_window
    assert balance == pytest.approx(0.0, abs=0.15)


@pytest.mark.parametrize("fixture", FIXTURES, ids=[f.id for f in FIXTURES])
def test_heuristic_path_without_a_pinned_policy(fixture) -> None:
    """
    The same optimizer with the site's dispatch policy removed: it must still
    produce an identity-consistent schedule that does not raise the peak.
    """
    from dataclasses import replace

    from app.fixtures.spec import DispatchPolicy

    bare = replace(fixture, policy=DispatchPolicy())
    result = optimize(bare)

    assert result.derived is True
    assert result.optimized_peak_kw <= result.baseline_peak_kw
    for hour in range(24):
        assert abs(flow_residual(result.optimized_flows[hour])) <= TOLERANCE_KW
    for hour in result.battery_hours:
        assert result.optimized_parts.soc[hour] >= result.reserve_floor_pct - TOLERANCE_KW


@pytest.mark.parametrize("building_id", BUILDING_IDS)
def test_impact_series_matches_its_flows(client: TestClient, building_id: str) -> None:
    """`impact[h].baseline_flows.grid_kw === impact[h].baseline_kw`, both sides."""
    started = client.post("/api/gridshift/run", json={"building_id": building_id}).json()
    poll_until_complete(client, started["run_id"])
    plan = client.get(f"/api/gridshift/{started['run_id']}/plan").json()

    fixture = get_fixture(building_id)
    assert fixture is not None

    for point in plan["impact"]:
        assert point["baseline_flows"]["grid_kw"] == pytest.approx(
            point["baseline_kw"], abs=TOLERANCE_KW
        )
        assert point["optimized_flows"]["grid_kw"] == pytest.approx(
            point["optimized_kw"], abs=TOLERANCE_KW
        )
        assert abs(flow_residual(point["baseline_flows"])) <= TOLERANCE_KW
        assert abs(flow_residual(point["optimized_flows"])) <= TOLERANCE_KW

    assert plan["optimized_peak_kw"] == pytest.approx(
        max(p["optimized_kw"] for p in plan["impact"]), abs=TOLERANCE_KW
    )


@pytest.mark.parametrize("building_id", BUILDING_IDS)
def test_assert_flows_identity_over_live_responses(client: TestClient, building_id: str) -> None:
    """
    The exported helper, run the way the backend engineer should run it: over
    whole responses, not hand-picked hours.
    """
    forecast = client.get("/api/forecast", params={"building_id": building_id}).json()
    assert_flows_identity(forecast, label=f"forecast({building_id})")

    started = client.post("/api/gridshift/run", json={"building_id": building_id}).json()
    poll_until_complete(client, started["run_id"])
    plan = client.get(f"/api/gridshift/{started['run_id']}/plan").json()
    assert_flows_identity(plan, label=f"plan({building_id})")


def test_assert_flows_identity_catches_a_break() -> None:
    """The helper is only useful if it actually fails on a bad payload."""
    good = {
        "grid_kw": 10.0,
        "base_kw": 6.0,
        "ev_kw": 3.0,
        "hvac_kw": 2.0,
        "solar_kw": 1.0,
        "battery_kw": 0.0,
    }
    assert_flows_identity([good])

    with pytest.raises(AssertionError, match="flow identity"):
        assert_flows_identity([{**good, "grid_kw": 12.0}])

    with pytest.raises(AssertionError, match="missing flow fields"):
        assert_flows_identity([{"grid_kw": 1.0}])

    with pytest.raises(AssertionError, match="predicted_load_kw"):
        assert_flows_identity([{"predicted_load_kw": 11.0, "flows": good}])
