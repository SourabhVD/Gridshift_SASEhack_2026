"""
Pydantic models mirroring frontend/src/types/api.ts one for one.

Field names are the wire format and are snake_case on purpose. Every timestamp
is ISO 8601 *with* a timezone offset -- the frontend calls `Date.parse()` on
these and a naive string would be read as local time in the browser.

If you change anything in this file, change types/api.ts in the same commit.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

BuildingType = Literal["office", "hospital", "warehouse", "residence"]
RunStatus = Literal["idle", "running", "awaiting_approval", "approved", "rejected", "failed"]
AgentEventType = Literal["thinking", "tool_call", "tool_result", "decision", "error", "complete"]
ActionType = Literal["battery_discharge", "ev_charging_shift", "hvac_setpoint"]
ActionStatus = Literal["pending", "approved", "rejected", "executed"]

AgentToolName = Literal[
    "get_energy_forecast",
    "get_electricity_prices",
    "get_battery_state",
    "get_ev_requirements",
    "get_hvac_constraints",
    "run_schedule_optimizer",
    "validate_schedule",
    "save_action_plan",
    "request_human_approval",
]

#: Runtime copy of the union above; the tool registry is checked against it.
TOOL_NAMES: tuple[str, ...] = (
    "get_energy_forecast",
    "get_electricity_prices",
    "get_battery_state",
    "get_ev_requirements",
    "get_hvac_constraints",
    "run_schedule_optimizer",
    "validate_schedule",
    "save_action_plan",
    "request_human_approval",
)


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------- #
# GET /api/buildings                                                           #
# --------------------------------------------------------------------------- #


class Building(Model):
    #: The slug the frontend stores and sends back: "sea-office-001".
    id: str
    #: The row's UUID in the team's Postgres schema, where `buildings` is keyed
    #: on one. Extra to types/api.ts on purpose -- TypeScript ignores it, and
    #: every building-scoped endpoint accepts this form of the id as well.
    external_id: str | None = None
    name: str
    type: BuildingType
    address: str
    floors: int
    area_sqft: int
    peak_threshold_kw: float
    battery_capacity_kwh: float
    battery_max_kw: float
    ev_bays: int
    solar_capacity_kw: float
    hvac_zones: int


class BuildingsResponse(Model):
    buildings: list[Building]


# --------------------------------------------------------------------------- #
# Energy flows                                                                 #
# --------------------------------------------------------------------------- #


class EnergyFlows(Model):
    """
    One hour's breakdown. `battery_kw` is the only signed field:
    > 0 discharging into the building, < 0 charging from the grid.

        grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw
    """

    grid_kw: float
    solar_kw: float
    battery_kw: float
    ev_kw: float
    hvac_kw: float
    base_kw: float
    battery_soc_pct: float


# --------------------------------------------------------------------------- #
# GET /api/dashboard/summary                                                   #
# --------------------------------------------------------------------------- #


class DashboardSummary(Model):
    building_id: str
    building_type: BuildingType
    building_name: str
    timestamp: str
    current_load_kw: float
    predicted_peak_kw: float
    predicted_peak_time: str
    peak_threshold_kw: float
    battery_soc_pct: float
    battery_capacity_kwh: float
    battery_max_kw: float
    electricity_price_per_kwh: float
    solar_generation_kw: float
    ev_connected: int
    hvac_setpoint_f: float
    outdoor_temp_f: float


# --------------------------------------------------------------------------- #
# GET /api/forecast                                                            #
# --------------------------------------------------------------------------- #


class ForecastPoint(Model):
    timestamp: str
    predicted_load_kw: float
    actual_load_kw: float | None
    price_per_kwh: float
    is_peak: bool
    flows: EnergyFlows


class ForecastResponse(Model):
    building_name: str
    generated_at: str
    peak_threshold_kw: float
    points: list[ForecastPoint]


# --------------------------------------------------------------------------- #
# Agent run lifecycle                                                          #
# --------------------------------------------------------------------------- #


class AgentEvent(Model):
    id: str
    run_id: str
    seq: int
    timestamp: str
    type: AgentEventType
    tool_name: AgentToolName | None
    message: str
    payload: dict[str, Any] | None
    duration_ms: int | None


class RunRequest(Model):
    building_id: str
    #: Which metered day to plan. Empty means whatever the server serves.
    date: str = ""


class RunResponse(Model):
    run_id: str
    status: RunStatus
    started_at: str


class EventsResponse(Model):
    run_id: str
    status: RunStatus
    events: list[AgentEvent]
    is_complete: bool


# --------------------------------------------------------------------------- #
# Action plan                                                                  #
# --------------------------------------------------------------------------- #


class Action(Model):
    id: str
    run_id: str
    type: ActionType
    title: str
    description: str
    start_time: str
    end_time: str
    magnitude: float
    unit: str
    estimated_peak_reduction_kw: float
    estimated_savings_usd: float
    status: ActionStatus
    constraints_checked: list[str]


class ImpactPoint(Model):
    timestamp: str
    baseline_kw: float
    optimized_kw: float
    baseline_flows: EnergyFlows
    optimized_flows: EnergyFlows


class ActionPlan(Model):
    run_id: str
    status: RunStatus
    created_at: str
    summary: str
    baseline_peak_kw: float
    optimized_peak_kw: float
    peak_reduction_kw: float
    baseline_cost_usd: float
    optimized_cost_usd: float
    savings_usd: float
    actions: list[Action]
    impact: list[ImpactPoint] = Field(min_length=24, max_length=24)


class ActionDecisionResponse(Model):
    action: Action
    plan: ActionPlan


# --------------------------------------------------------------------------- #
# POST /api/demo/reset                                                         #
# --------------------------------------------------------------------------- #


class ResetRequest(Model):
    building_id: str


class ResetResponse(Model):
    ok: bool
    message: str


# --------------------------------------------------------------------------- #
# GET /api/backtests                                                           #
# --------------------------------------------------------------------------- #


class BacktestDates(Model):
    """Which real days this building can be planned against."""

    building_id: str
    #: Oldest first. Empty when the server is not in backtest mode, which is
    #: not an error: the dashboard then simply offers no picker.
    dates: list[str]
    #: The one being served right now, or "" if none.
    serving: str


# --------------------------------------------------------------------------- #
# GET /api/reports/backtest                                                    #
# --------------------------------------------------------------------------- #


class ReportDay(Model):
    """One metered day, put through the optimizer."""

    date: str
    baseline_peak_kw: float
    optimized_peak_kw: float
    peak_reduction_kw: float
    baseline_cost_usd: float
    optimized_cost_usd: float
    energy_savings_usd: float
    actions: int
    #: The harness's own scoring for the day, when it recorded any.
    mae_kw: float | None = None
    mape_pct: float | None = None
    r2: float | None = None


class ReportSummary(Model):
    """
    The period those days add up to.

    A demand charge is billed on the worst interval in the period, so
    `demand_charge_usd` comes from the highest baseline peak against the
    highest optimized one -- not from any single day. `best_day_claim_usd` is
    what quoting the best day alone would have said, which is what a one-day
    demo does.
    """

    days_covered: int
    first_date: str
    last_date: str
    billed_peak_baseline_kw: float
    billed_peak_optimized_kw: float
    billed_peak_reduction_kw: float
    demand_charge_usd_per_kw: float
    demand_charge_usd: float
    energy_savings_usd: float
    total_savings_usd: float
    mean_daily_peak_reduction_kw: float
    best_day: str
    best_day_peak_reduction_kw: float
    best_day_claim_usd: float
    best_day_overstates_by_usd: float
    mean_mae_kw: float | None = None
    mean_mape_pct: float | None = None
    mean_r2: float | None = None
    days_over_threshold: int
    threshold_kw: float


class BacktestReport(Model):
    building_id: str
    building_name: str
    days: list[ReportDay]
    #: Dates on disk this building could not be planned against.
    skipped_dates: list[str]
    #: None when no day was usable.
    summary: ReportSummary | None
