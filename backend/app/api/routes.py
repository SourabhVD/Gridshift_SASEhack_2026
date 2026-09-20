"""
The nine endpoints the dashboard calls.

Routes do no business logic: they validate the request, call a service, map a
service exception to a status code, and hand the result to a Pydantic model
for serialisation. The response_model on each route is what guarantees the
payload matches frontend/src/types/api.ts -- if a service starts returning a
different shape, the route fails loudly here rather than quietly in a chart.

Building-scoped endpoints take `building_id` as a query parameter on GETs and
as a body field on POSTs, which is what src/lib/api.ts sends. Run-scoped and
action-scoped endpoints do not: the run id already identifies the building.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query, status

from ..fixtures import FIXTURES
from ..models.schemas import (
    ActionDecisionResponse,
    ActionPlan,
    Building,
    BuildingsResponse,
    DashboardSummary,
    EventsResponse,
    ForecastResponse,
    ResetRequest,
    ResetResponse,
    RunRequest,
    RunResponse,
)
from ..services import forecast as forecast_service
from ..agent.runner import execute_run
from ..services.forecast import UnknownBuilding
from ..store import Conflict, NotFound, store

log = logging.getLogger("gridshift.api")

router = APIRouter(prefix="/api", tags=["gridshift"])

#: Strong references to in-flight agent tasks, so the event loop cannot
#: garbage-collect a run halfway through.
_RUNNING: set[asyncio.Task[None]] = set()


def _not_found(exc: Exception) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


# --------------------------------------------------------------------------- #
# Buildings                                                                    #
# --------------------------------------------------------------------------- #


@router.get("/buildings", response_model=BuildingsResponse)
def get_buildings() -> BuildingsResponse:
    """Every site this deployment knows about. The default is first."""
    return BuildingsResponse(buildings=[Building(**f.building) for f in FIXTURES])


# --------------------------------------------------------------------------- #
# Dashboard                                                                    #
# --------------------------------------------------------------------------- #


@router.get("/dashboard/summary", response_model=DashboardSummary)
def get_summary(building_id: str = Query(...)) -> DashboardSummary:
    try:
        return DashboardSummary(**forecast_service.build_summary(building_id))
    except UnknownBuilding as exc:
        raise _not_found(exc) from exc


@router.get("/forecast", response_model=ForecastResponse)
def get_forecast(building_id: str = Query(...)) -> ForecastResponse:
    try:
        return ForecastResponse(**forecast_service.build_forecast(building_id))
    except UnknownBuilding as exc:
        raise _not_found(exc) from exc


# --------------------------------------------------------------------------- #
# Agent run                                                                    #
# --------------------------------------------------------------------------- #


@router.post("/gridshift/run", response_model=RunResponse)
async def start_run(body: RunRequest) -> RunResponse:
    """
    Start an agent run and return immediately.

    The run takes about 17 seconds. The response carries the run id so the
    dashboard can start polling /events on its next tick; the agent itself runs
    as a detached asyncio task. It is not a BackgroundTask because those only
    start *after* the response is sent and are tied to the request's lifetime,
    and this run outlives the request by design.
    """
    try:
        fixture = forecast_service.require_fixture(body.building_id)
    except UnknownBuilding as exc:
        raise _not_found(exc) from exc

    # Runs are keyed on the canonical slug, so a run started with the UUID form
    # of the id is still the run that a reset by slug clears.
    run = store.create_run(fixture.id)
    task = asyncio.create_task(execute_run(run["run_id"], fixture.id))
    _RUNNING.add(task)
    task.add_done_callback(_RUNNING.discard)

    return RunResponse(run_id=run["run_id"], status="running", started_at=run["started_at"])


@router.get("/gridshift/{run_id}/events", response_model=EventsResponse)
def get_events(run_id: str) -> EventsResponse:
    """
    Every event emitted so far, ascending by seq. Cumulative, not a delta --
    the dashboard replaces its list on each poll rather than appending.
    """
    try:
        run = store.get_run(run_id)
    except NotFound as exc:
        raise _not_found(exc) from exc

    events = store.get_events(run_id)
    is_complete = run["status"] != "running"
    return EventsResponse(
        run_id=run_id,
        status=run["status"],
        events=events,
        is_complete=is_complete,
    )


@router.get("/gridshift/{run_id}/plan", response_model=ActionPlan)
def get_plan(run_id: str) -> ActionPlan:
    """404s until the run has finished and the agent has saved a plan."""
    try:
        store.get_run(run_id)
        return ActionPlan(**store.get_plan(run_id))
    except NotFound as exc:
        raise _not_found(exc) from exc


# --------------------------------------------------------------------------- #
# Approvals                                                                    #
# --------------------------------------------------------------------------- #


def _decide(action_id: str, decision: str) -> ActionDecisionResponse:
    try:
        action, plan = store.decide_action(action_id, decision)
    except Conflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except NotFound as exc:
        raise _not_found(exc) from exc

    log.info("action %s %s; plan is now %s", action_id, decision, plan["status"])
    return ActionDecisionResponse(action=action, plan=plan)


@router.post("/actions/{action_id}/approve", response_model=ActionDecisionResponse)
def approve_action(action_id: str) -> ActionDecisionResponse:
    """409 if this action has already been approved or rejected."""
    return _decide(action_id, "approved")


@router.post("/actions/{action_id}/reject", response_model=ActionDecisionResponse)
def reject_action(action_id: str) -> ActionDecisionResponse:
    """409 if this action has already been approved or rejected."""
    return _decide(action_id, "rejected")


# --------------------------------------------------------------------------- #
# Demo reset                                                                   #
# --------------------------------------------------------------------------- #


@router.post("/demo/reset", response_model=ResetResponse)
def reset_demo(body: ResetRequest) -> ResetResponse:
    """Clears only the building you pass; a run on another one survives."""
    try:
        fixture = forecast_service.require_fixture(body.building_id)
    except UnknownBuilding as exc:
        raise _not_found(exc) from exc

    store.reset_building(fixture.id)
    return ResetResponse(
        ok=True,
        message=(
            f"Demo reset for {fixture.name}. Forecast and building state restored; "
            "no run in progress."
        ),
    )
