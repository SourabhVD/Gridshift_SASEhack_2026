"""
The run lifecycle, exactly as the dashboard drives it.

start -> poll events -> read plan -> approve one action -> reject another ->
re-decide (409) -> reset. Plus the per-building isolation the building selector
depends on.
"""

from __future__ import annotations

from conftest import poll_until_complete
from fastapi.testclient import TestClient

OFFICE = "sea-office-001"
HOSPITAL = "sea-hospital-002"


def start(client: TestClient, building_id: str) -> str:
    response = client.post("/api/gridshift/run", json={"building_id": building_id})
    assert response.status_code == 200
    return response.json()["run_id"]


def test_plan_404s_until_the_run_completes(client: TestClient) -> None:
    run_id = start(client, OFFICE)
    # The run is detached, so the plan may or may not exist yet; what must not
    # happen is a 500 or a half-built plan.
    early = client.get(f"/api/gridshift/{run_id}/plan")
    assert early.status_code in {200, 404}
    if early.status_code == 404:
        assert "not ready" in early.json()["detail"].lower()

    poll_until_complete(client, run_id)
    assert client.get(f"/api/gridshift/{run_id}/plan").status_code == 200


def test_events_are_cumulative_and_ordered(client: TestClient) -> None:
    run_id = start(client, OFFICE)
    body = poll_until_complete(client, run_id)

    assert body["run_id"] == run_id
    assert body["is_complete"] is True
    assert len(body["events"]) == 14, "the demo narrative is 14 events"

    # Every tool_call is answered, and every tool the run used really ran.
    calls = [e for e in body["events"] if e["type"] == "tool_call"]
    results = [e for e in body["events"] if e["type"] in {"tool_result", "decision"}]
    assert calls and results
    for event in results:
        assert event["payload"], f"{event['tool_name']} result carried no payload"

    forecast_result = next(
        e for e in results if e["tool_name"] == "get_energy_forecast"
    )
    assert forecast_result["payload"]["peak_kw"] == 522
    assert forecast_result["payload"]["threshold_kw"] == 450

    # The optimizer's own event carries the numbers the plan is built from.
    optimizer_result = next(e for e in results if e["tool_name"] == "run_schedule_optimizer")
    assert optimizer_result["payload"]["optimized_peak_kw"] == 438
    assert optimizer_result["duration_ms"] is not None

    validate_result = next(e for e in results if e["tool_name"] == "validate_schedule")
    assert validate_result["payload"]["violations"] == 0


def test_approve_then_reject_then_conflict(client: TestClient) -> None:
    run_id = start(client, OFFICE)
    poll_until_complete(client, run_id)
    plan = client.get(f"/api/gridshift/{run_id}/plan").json()
    first, second = plan["actions"][0]["id"], plan["actions"][1]["id"]

    approved = client.post(f"/api/actions/{first}/approve")
    assert approved.status_code == 200
    body = approved.json()
    assert body["action"]["id"] == first
    assert body["action"]["status"] == "approved"
    # Still awaiting: one action decided is not the whole plan decided.
    assert body["plan"]["status"] == "awaiting_approval"
    assert len(body["plan"]["impact"]) == 24

    rejected = client.post(f"/api/actions/{second}/reject").json()
    assert rejected["action"]["status"] == "rejected"

    # Re-deciding either one is a conflict, not a silent no-op.
    for action_id, verb in ((first, "approve"), (first, "reject"), (second, "approve")):
        conflict = client.post(f"/api/actions/{action_id}/{verb}")
        assert conflict.status_code == 409
        assert "already" in conflict.json()["detail"]

    assert client.post("/api/actions/act-does-not-exist/approve").status_code == 404


def test_plan_status_follows_its_actions(client: TestClient) -> None:
    run_id = start(client, OFFICE)
    poll_until_complete(client, run_id)
    actions = client.get(f"/api/gridshift/{run_id}/plan").json()["actions"]

    for action in actions[:-1]:
        client.post(f"/api/actions/{action['id']}/reject")
    final = client.post(f"/api/actions/{actions[-1]['id']}/approve").json()

    # All decided with at least one approval -> approved.
    assert final["plan"]["status"] == "approved"
    assert client.get(f"/api/gridshift/{run_id}/events").json()["status"] == "approved"


def test_reject_everything_marks_the_plan_rejected(client: TestClient) -> None:
    run_id = start(client, OFFICE)
    poll_until_complete(client, run_id)
    actions = client.get(f"/api/gridshift/{run_id}/plan").json()["actions"]

    for action in actions:
        body = client.post(f"/api/actions/{action['id']}/reject").json()
    assert body["plan"]["status"] == "rejected"


def test_reset_clears_only_that_building(client: TestClient) -> None:
    office_run = start(client, OFFICE)
    hospital_run = start(client, HOSPITAL)
    poll_until_complete(client, office_run)
    poll_until_complete(client, hospital_run)

    reset = client.post("/api/demo/reset", json={"building_id": OFFICE})
    assert reset.status_code == 200
    assert reset.json()["ok"] is True
    assert "Cascade Commerce Center" in reset.json()["message"]

    assert client.get(f"/api/gridshift/{office_run}/events").status_code == 404
    assert client.get(f"/api/gridshift/{office_run}/plan").status_code == 404
    # The other building's run is untouched.
    assert client.get(f"/api/gridshift/{hospital_run}/events").status_code == 200
    assert client.get(f"/api/gridshift/{hospital_run}/plan").status_code == 200


def test_a_new_run_supersedes_the_previous_one(client: TestClient) -> None:
    first = start(client, OFFICE)
    poll_until_complete(client, first)
    second = start(client, OFFICE)
    poll_until_complete(client, second)

    assert first != second
    assert client.get(f"/api/gridshift/{first}/events").status_code == 404
    assert client.get(f"/api/gridshift/{second}/plan").status_code == 200


def test_cors_preflight_allows_the_dashboard(client: TestClient) -> None:
    """The browser will not read a response it was not given permission for."""
    response = client.options(
        "/api/gridshift/run",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "POST" in response.headers["access-control-allow-methods"]
