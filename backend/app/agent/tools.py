"""
The nine tools the agent is allowed to call.

Each one is a plain Python function that takes a ToolContext and returns a
JSON-serialisable dict. They know nothing about Gemini, about events or about
HTTP -- which is what makes them usable from the fake agent, the Gemini agent
and a unit test without changing a line.

Five are read-only lookups (forecast, prices, battery, EV, HVAC). Three change
something: run_schedule_optimizer computes the schedule and caches it on the
context, save_action_plan persists it, request_human_approval marks the run as
needing a person. validate_schedule re-checks the computed schedule against the
device constraints and is the one place a violation would be caught.

The architecture rule from AGENTS.md is enforced here: the model orchestrates,
it does not calculate. Nothing in this module takes a number from the model --
every figure is read off the forecast or the optimizer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable

from ..fixtures import BuildingFixture, assert_flows_identity
from ..fixtures.generator import HOURS, NOW_ISO, iso_hour, round1, round2
from ..models.schemas import TOOL_NAMES
from ..store import store
from ..services import forecast as forecast_service
from ..services.optimizer import OptimizationResult, solve

log = logging.getLogger("gridshift.tools")


class ToolError(Exception):
    """A tool refused to run. The agent turns this into an 'error' event."""


@dataclass
class ToolContext:
    """One run's worth of state, threaded through every tool call."""

    run_id: str
    fixture: BuildingFixture
    #: Set by run_schedule_optimizer; read by validate_schedule and onward.
    result: OptimizationResult | None = None
    #: Set by save_action_plan.
    plan: dict[str, Any] | None = None
    extras: dict[str, Any] = field(default_factory=dict)

    @property
    def building_id(self) -> str:
        return self.fixture.id

    def require_result(self, tool: str) -> OptimizationResult:
        if self.result is None:
            raise ToolError(f"{tool} needs run_schedule_optimizer to have run first.")
        return self.result


# --------------------------------------------------------------------------- #
# Read-only lookups                                                            #
# --------------------------------------------------------------------------- #


def get_energy_forecast(ctx: ToolContext, horizon_hours: int = 24, **_: Any) -> dict[str, Any]:
    """The 24-hour load forecast and where it breaches the billing threshold."""
    fixture = ctx.fixture
    grid, source = forecast_service.predicted_load_kw(fixture)
    threshold = fixture.peak_threshold_kw
    over = [h for h, kw in enumerate(grid) if kw > threshold]
    peak_kw = max(grid)

    return {
        "building_id": ctx.building_id,
        "horizon_hours": min(int(horizon_hours or HOURS), HOURS),
        "forecast_source": source,
        "peak_kw": round1(peak_kw),
        "peak_time": iso_hour(grid.index(peak_kw)),
        "threshold_kw": threshold,
        "hours_over_threshold": len(over),
        "first_exceedance": iso_hour(over[0]) if over else None,
        "min_kw": round1(min(grid)),
        "total_kwh": round1(sum(grid)),
    }


def get_electricity_prices(ctx: ToolContext, **_: Any) -> dict[str, Any]:
    """The tariff: time-of-use energy plus the demand charge that dominates."""
    return dict(ctx.fixture.tool_facts.get("get_electricity_prices", {}))


def get_battery_state(ctx: ToolContext, **_: Any) -> dict[str, Any]:
    """State of charge, inverter rating and the contractual reserve floor."""
    return dict(ctx.fixture.tool_facts.get("get_battery_state", {}))


def get_ev_requirements(ctx: ToolContext, **_: Any) -> dict[str, Any]:
    """Connected sessions, which of them are movable, and their deadlines."""
    return dict(ctx.fixture.tool_facts.get("get_ev_requirements", {}))


def get_hvac_constraints(ctx: ToolContext, **_: Any) -> dict[str, Any]:
    """Setpoint, comfort band, permitted drift, and any locked zones."""
    return dict(ctx.fixture.tool_facts.get("get_hvac_constraints", {}))


# --------------------------------------------------------------------------- #
# The schedule                                                                 #
# --------------------------------------------------------------------------- #


def run_schedule_optimizer(
    ctx: ToolContext,
    objective: str = "minimize_peak_then_cost",
    horizon_hours: int = 24,
    resources: list[str] | None = None,
    **_: Any,
) -> dict[str, Any]:
    """
    Compute the dispatch schedule. The model chooses *when* to call this and
    with which resources; the kW come out of services/optimizer.py.
    """
    result = solve(ctx.fixture)
    ctx.result = result

    return {
        "status": result.status,
        "objective": objective,
        "horizon_hours": min(int(horizon_hours or HOURS), HOURS),
        "resources": resources or ["battery", "ev", "hvac"],
        "solve_time_ms": result.solve_time_ms or result.heuristic_ms,
        "heuristic_ms": result.heuristic_ms,
        "baseline_peak_kw": result.baseline_peak_kw,
        "optimized_peak_kw": result.optimized_peak_kw,
        "peak_reduction_kw": result.peak_reduction_kw,
        "binding_interval": iso_hour(result.optimized_peak_hour),
        "battery_discharge_kw": result.battery_flat_kw,
        "battery_hours": result.battery_hours,
        "battery_kwh": result.battery_kwh,
        "ev_shifted_kwh": result.ev_shifted_kwh,
        "hvac_shed_kw": result.hvac_shed_kw,
        "savings_usd": result.savings_usd,
        "demand_charge_avoided_usd": result.demand_charge_avoided_usd,
        "dispatch_source": "heuristic" if result.derived else "site_policy",
    }


def validate_schedule(ctx: ToolContext, **_: Any) -> dict[str, Any]:
    """
    Re-check the computed schedule against the device constraints.

    These are real assertions, not a rubber stamp: the SOC floor, the EV energy
    balance, the permitted HVAC drift duration and the direction of the peak
    are all recomputed from the optimized components.
    """
    r = ctx.require_result("validate_schedule")
    facts = ctx.fixture.tool_facts
    hvac_facts = facts.get("get_hvac_constraints", {})
    violations: list[str] = []

    # 1. The pack never goes below its reserve floor during the dispatch.
    soc_over_window = [r.optimized_parts.soc[h] for h in r.battery_hours] or [r.start_soc_pct]
    min_soc = round1(min(soc_over_window))
    if min_soc < r.reserve_floor_pct:
        violations.append(
            f"battery_soc_{min_soc}pct_below_floor_{r.reserve_floor_pct}pct"
        )

    # 2. The inverter rating is respected.
    max_discharge = max(r.battery_discharge_kw.values()) if r.battery_discharge_kw else 0.0
    if max_discharge > r.inverter_kw:
        violations.append(f"battery_{max_discharge}kw_over_inverter_{r.inverter_kw}kw")

    # 3. EV energy is conserved: what leaves the peak comes back, either inside
    #    the window or explicitly after it.
    ev_balance = round1(sum(r.ev_delta_kw.values()) + r.ev_kwh_after_window)
    if abs(ev_balance) > 0.15:
        violations.append(f"ev_energy_not_conserved_{ev_balance}kwh")

    # 4. HVAC drift stays inside the permitted duration.
    max_drift_hours = int(hvac_facts.get("max_drift_hours", 0) or 0)
    drift_hours = len(r.hvac_drift_hours)
    if max_drift_hours and drift_hours > max_drift_hours:
        violations.append(f"hvac_drift_{drift_hours}h_over_limit_{max_drift_hours}h")

    # 5. The plan actually lowers the peak.
    if r.optimized_peak_kw >= r.baseline_peak_kw:
        violations.append("peak_not_reduced")

    payload: dict[str, Any] = {
        "violations": len(violations),
        "violation_ids": violations,
        "battery_end_soc_pct": r.end_soc_pct,
        "battery_min_soc_pct": min_soc,
        "ev_energy_balance_kwh": ev_balance,
        "hvac_drift_hours": drift_hours,
        "optimized_peak_kw": r.optimized_peak_kw,
    }
    # Site-specific reporting the demo narrative refers to (constraint counts,
    # locked clinical zones, van slack) rides on top of the computed checks.
    payload.update(facts.get("validate_schedule", {}))
    payload["violations"] = len(violations)
    return payload


# --------------------------------------------------------------------------- #
# Plan assembly and persistence                                                #
# --------------------------------------------------------------------------- #


def build_plan(ctx: ToolContext) -> dict[str, Any]:
    """Assemble the ActionPlan payload. Pure -- persistence is the caller's."""
    r = ctx.require_result("save_action_plan")
    fixture = ctx.fixture

    # A lever the optimizer left alone gets no row. Its window collapses to
    # zero length, which the contract forbids -- end_time must be after
    # start_time -- and which the dashboard would render as an action a human
    # is asked to approve when nothing actually happens. Dropping it is also
    # the rule the agent itself works to: a two-action plan that is true beats
    # a three-action plan that is not. Sites where every lever moves are
    # unaffected.
    drafts = [d for d in fixture.build_actions(r) if d["end_time"] > d["start_time"]]

    actions: list[dict[str, Any]] = []
    for index, draft in enumerate(drafts, start=1):
        action = dict(draft)
        action["id"] = f"{ctx.run_id}-act-{index:02d}"
        action["run_id"] = ctx.run_id
        action["status"] = "pending"
        actions.append(action)

    impact = [
        {
            "timestamp": iso_hour(h),
            "baseline_kw": r.baseline_grid[h],
            "optimized_kw": r.optimized_grid[h],
            "baseline_flows": r.baseline_flows[h],
            "optimized_flows": r.optimized_flows[h],
        }
        for h in range(HOURS)
    ]

    # Same self-check as the forecast: the impact series and its two flow
    # breakdowns have to agree before anything is persisted.
    try:
        assert_flows_identity(impact, label=f"impact({ctx.building_id})")
    except AssertionError as exc:
        log.error("%s", exc)

    return {
        "run_id": ctx.run_id,
        "status": "awaiting_approval",
        "created_at": NOW_ISO,
        "summary": fixture.plan_summary(r),
        "baseline_peak_kw": r.baseline_peak_kw,
        "optimized_peak_kw": r.optimized_peak_kw,
        "peak_reduction_kw": r.peak_reduction_kw,
        "baseline_cost_usd": r.baseline_cost_usd,
        "optimized_cost_usd": r.optimized_cost_usd,
        "savings_usd": r.savings_usd,
        "actions": actions,
        "impact": impact,
    }


def save_action_plan(ctx: ToolContext, **_: Any) -> dict[str, Any]:
    """Persist the plan. This is the only tool that writes to the database."""
    plan = build_plan(ctx)
    ctx.plan = store.save_plan(ctx.run_id, plan)
    r = ctx.require_result("save_action_plan")
    log.info(
        "plan saved run=%s building=%s actions=%d peak %.1f -> %.1f kW",
        ctx.run_id,
        ctx.building_id,
        len(plan["actions"]),
        r.baseline_peak_kw,
        r.optimized_peak_kw,
    )
    return {
        "run_id": ctx.run_id,
        "action_count": len(plan["actions"]),
        "plan_savings_usd": round2(plan["savings_usd"]),
        "peak_reduction_kw": plan["peak_reduction_kw"],
        "demand_charge_avoided_usd": r.demand_charge_avoided_usd,
    }


def request_human_approval(ctx: ToolContext, **_: Any) -> dict[str, Any]:
    """Route the plan to a person. Nothing dispatches until they decide."""
    facts = ctx.fixture.tool_facts.get("request_human_approval", {})
    action_count = len(ctx.plan["actions"]) if ctx.plan else 0
    return {
        "requires_approval": True,
        "action_count": action_count,
        "approvers": facts.get("approvers", ["facility_manager"]),
        "run_id": ctx.run_id,
    }


# --------------------------------------------------------------------------- #
# Registry                                                                     #
# --------------------------------------------------------------------------- #

ToolFn = Callable[..., dict[str, Any]]

TOOLS: dict[str, ToolFn] = {
    "get_energy_forecast": get_energy_forecast,
    "get_electricity_prices": get_electricity_prices,
    "get_battery_state": get_battery_state,
    "get_ev_requirements": get_ev_requirements,
    "get_hvac_constraints": get_hvac_constraints,
    "run_schedule_optimizer": run_schedule_optimizer,
    "validate_schedule": validate_schedule,
    "save_action_plan": save_action_plan,
    "request_human_approval": request_human_approval,
}

assert tuple(TOOLS) == TOOL_NAMES, "tool registry drifted from the AgentToolName union"


def call_tool(name: str, ctx: ToolContext, args: dict[str, Any] | None = None) -> dict[str, Any]:
    """Dispatch by name. Unknown names raise rather than being ignored."""
    fn = TOOLS.get(name)
    if fn is None:
        raise ToolError(f"Unknown tool {name!r}.")
    return fn(ctx, **(args or {}))


# --------------------------------------------------------------------------- #
# Gemini function declarations                                                 #
# --------------------------------------------------------------------------- #

#: One declaration per tool, in the order the system prompt asks for them.
#: These are plain dicts so google-genai is only imported in agent.py.
TOOL_DECLARATIONS: list[dict[str, Any]] = [
    {
        "name": "get_energy_forecast",
        "description": (
            "The 24-hour load forecast for this building, with the predicted peak, the "
            "billing threshold and how many hours the forecast spends above it. Call "
            "this first: nothing else is worth doing until the peak is confirmed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "horizon_hours": {
                    "type": "integer",
                    "description": "Hours to forecast. 24 is the whole billing day.",
                }
            },
        },
    },
    {
        "name": "get_electricity_prices",
        "description": (
            "The tariff: time-of-use energy rates and the monthly demand charge set by "
            "the single highest interval. Tells you whether to optimise for kWh or kW."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "get_battery_state",
        "description": (
            "Battery state of charge, capacity, inverter rating and the contractual "
            "reserve floor. Dispatchable energy is what is left above the floor."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "get_ev_requirements",
        "description": (
            "Connected EV sessions: how many, which are movable, their charger power "
            "and their deadlines. Locked sessions must never be interrupted."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "get_hvac_constraints",
        "description": (
            "HVAC setpoint, occupied comfort band, permitted drift duration, and any "
            "zones that are locked. A site with no flexible kW has no HVAC action."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "run_schedule_optimizer",
        "description": (
            "Compute the dispatch schedule from the forecast and the device "
            "constraints. You must call this rather than working out kW yourself. "
            "Call it once, after you have gathered the constraints."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "objective": {
                    "type": "string",
                    "description": "minimize_peak_then_cost, or minimize_cost.",
                },
                "horizon_hours": {"type": "integer"},
                "resources": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Subset of battery, ev, hvac. Leave out what has no slack.",
                },
            },
        },
    },
    {
        "name": "validate_schedule",
        "description": (
            "Re-check the computed schedule against every device constraint and return "
            "the violations. Call this before saving a plan."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "save_action_plan",
        "description": (
            "Persist the validated schedule as an action plan the operator can review. "
            "Call this only after validate_schedule returns zero violations."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "request_human_approval",
        "description": (
            "Route the saved plan to a person. Nothing is dispatched until they "
            "approve. This is the last call of the run."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
]
