"""
Contract shapes for every endpoint, against all four buildings.

These assert the wire format the frontend depends on, not the business logic:
field names, unions, timezone-aware timestamps, and the two invariants that tie
the flow diagram to the charts.
"""

from __future__ import annotations

import re

import pytest
from .conftest import BUILDING_IDS, poll_until_complete
from fastapi.testclient import TestClient

#: ISO 8601 with an explicit offset. A naive timestamp is read as browser-local
#: time by Date.parse(), which silently shifts the whole dashboard.
ISO_WITH_OFFSET = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$")

FLOW_FIELDS = {
    "grid_kw",
    "solar_kw",
    "battery_kw",
    "ev_kw",
    "hvac_kw",
    "base_kw",
    "battery_soc_pct",
}

TOOL_NAMES = {
    "get_energy_forecast",
    "get_electricity_prices",
    "get_battery_state",
    "get_ev_requirements",
    "get_hvac_constraints",
    "run_schedule_optimizer",
    "validate_schedule",
    "save_action_plan",
    "request_human_approval",
}


def test_health(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["agent"] == "fake"


def test_buildings(client: TestClient) -> None:
    response = client.get("/api/buildings")
    assert response.status_code == 200
    buildings = response.json()["buildings"]

    assert [b["id"] for b in buildings] == BUILDING_IDS
    assert buildings[0]["id"] == "sea-office-001", "the default building comes first"
    for building in buildings:
        assert building["type"] in {"office", "hospital", "warehouse", "residence"}
        assert building["peak_threshold_kw"] > 0
        assert building["battery_max_kw"] <= building["battery_capacity_kwh"]


@pytest.mark.parametrize("building_id", BUILDING_IDS)
def test_summary(client: TestClient, building_id: str) -> None:
    response = client.get("/api/dashboard/summary", params={"building_id": building_id})
    assert response.status_code == 200
    body = response.json()

    assert body["building_id"] == building_id
    assert ISO_WITH_OFFSET.match(body["timestamp"])
    assert ISO_WITH_OFFSET.match(body["predicted_peak_time"])
    assert body["predicted_peak_kw"] >= body["current_load_kw"]
    assert 0 <= body["battery_soc_pct"] <= 100
    assert body["electricity_price_per_kwh"] > 0


@pytest.mark.parametrize("building_id", BUILDING_IDS)
def test_forecast(client: TestClient, building_id: str) -> None:
    response = client.get("/api/forecast", params={"building_id": building_id})
    assert response.status_code == 200
    body = response.json()

    points = body["points"]
    assert len(points) == 24
    for hour, point in enumerate(points):
        assert ISO_WITH_OFFSET.match(point["timestamp"])
        assert set(point["flows"]) == FLOW_FIELDS
        # The invariant the flow diagram and the demand chart both rely on.
        assert point["flows"]["grid_kw"] == pytest.approx(point["predicted_load_kw"], abs=0.05)
        assert point["is_peak"] == (point["predicted_load_kw"] > body["peak_threshold_kw"])
        # Metered history stops at "now"; the future is null, never zero.
        assert (point["actual_load_kw"] is None) == (hour >= 10)


def test_building_ids_resolve_as_slug_or_uuid(client: TestClient) -> None:
    """
    The frontend sends slugs; the team's Postgres schema keys buildings on a
    UUID. Both forms have to reach the same building, and the payload always
    publishes the slug as `id` because that is what is in localStorage.
    """
    buildings = client.get("/api/buildings").json()["buildings"]
    office = buildings[0]
    assert office["id"] == "sea-office-001"
    assert office["external_id"] and "-" in office["external_id"]

    by_slug = client.get("/api/dashboard/summary", params={"building_id": office["id"]}).json()
    by_uuid = client.get(
        "/api/dashboard/summary", params={"building_id": office["external_id"]}
    ).json()
    assert by_slug == by_uuid
    assert by_uuid["building_id"] == office["id"], "responses speak slugs"

    # A run started with the UUID is the run a reset by slug clears.
    run_id = client.post(
        "/api/gridshift/run", json={"building_id": office["external_id"]}
    ).json()["run_id"]
    poll_until_complete(client, run_id)
    client.post("/api/demo/reset", json={"building_id": office["id"]})
    assert client.get(f"/api/gridshift/{run_id}/events").status_code == 404


def test_unknown_building_is_422(client: TestClient) -> None:
    """
    A validation failure, not a missing endpoint.

    404 here would be read by the frontend's partial mode as "not implemented
    yet", and it would quietly serve mock data instead of surfacing the error.
    `detail` stays a plain string, unlike FastAPI's own list-valued 422.
    """
    for path in ("/api/dashboard/summary", "/api/forecast"):
        response = client.get(path, params={"building_id": "nope-000"})
        assert response.status_code == 422
        assert "nope-000" in response.json()["detail"]

    assert client.post("/api/gridshift/run", json={"building_id": "nope-000"}).status_code == 422
    assert client.post("/api/demo/reset", json={"building_id": "nope-000"}).status_code == 422


def test_unknown_run_is_404(client: TestClient) -> None:
    assert client.get("/api/gridshift/run-nope/events").status_code == 404
    assert client.get("/api/gridshift/run-nope/plan").status_code == 404


@pytest.mark.parametrize("building_id", BUILDING_IDS)
def test_event_and_plan_shapes(client: TestClient, building_id: str) -> None:
    started = client.post("/api/gridshift/run", json={"building_id": building_id}).json()
    assert started["status"] == "running"
    assert ISO_WITH_OFFSET.match(started["started_at"])

    events_body = poll_until_complete(client, started["run_id"])
    events = events_body["events"]

    assert events_body["status"] == "awaiting_approval"
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    for event in events:
        assert event["run_id"] == started["run_id"]
        assert event["type"] in {
            "thinking",
            "tool_call",
            "tool_result",
            "decision",
            "error",
            "complete",
        }
        assert event["tool_name"] is None or event["tool_name"] in TOOL_NAMES
        assert ISO_WITH_OFFSET.match(event["timestamp"])
        assert event["message"]
    assert events[-1]["type"] == "complete"
    assert not any(e["type"] == "error" for e in events)

    plan = client.get(f"/api/gridshift/{started['run_id']}/plan").json()
    assert plan["run_id"] == started["run_id"]
    assert plan["status"] == "awaiting_approval"
    assert len(plan["impact"]) == 24
    assert 2 <= len(plan["actions"]) <= 3
    for action in plan["actions"]:
        assert action["status"] == "pending"
        assert action["type"] in {"battery_discharge", "ev_charging_shift", "hvac_setpoint"}
        assert ISO_WITH_OFFSET.match(action["start_time"])
        assert ISO_WITH_OFFSET.match(action["end_time"])
        assert action["start_time"] < action["end_time"]
        assert action["constraints_checked"]
        assert action["unit"] in {"kW", "°F"}
