"""
The shape of one building fixture.

A fixture is *data plus narration*. It contributes:

  * the static nameplate record served by GET /api/buildings,
  * the baseline 24-hour flow components the forecast service publishes,
  * the device facts the five read-only agent tools return,
  * a DispatchPolicy -- the site-configured dispatch shape the optimizer
    honours (leave a field None and the heuristic derives it instead),
  * callables that turn the optimizer's computed result into the plan summary,
    the actions and the 14-step narrative the fake agent replays.

Nothing in a fixture invents a number that the optimizer could compute. Every
kW, dollar and percentage in the prose is formatted from the OptimizationResult
so the sentence and the chart can never drift apart.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

from .generator import FlowComponents

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from ..services.optimizer import OptimizationResult


@dataclass(frozen=True)
class DispatchPolicy:
    """
    The dispatch shape for one site.

    This is what a real optimizer would *solve for*. The reference heuristic in
    services/optimizer.py derives each field when it is left None and honours
    it when the site pins it, so the demo curves and a genuinely computed
    schedule come out of the same code path.
    """

    #: hour -> kW discharged into the building. None lets the heuristic size it.
    battery_discharge_kw: dict[int, float] | None = None
    #: hour -> signed kW moved. Negative removes load, positive adds it back.
    ev_delta_kw: dict[int, float] = field(default_factory=dict)
    #: hour -> signed kW. Positive is pre-cooling, negative is setpoint drift.
    hvac_delta_kw: dict[int, float] = field(default_factory=dict)
    #: The hours the setpoint is genuinely raised, when that is narrower than
    #: the negative deltas above. Coasting on banked thermal mass also shows as
    #: a negative delta but is not drift, and must not count against the
    #: permitted drift duration. None means "every negative hour is drift".
    hvac_drift_hours: list[int] | None = None
    #: kWh of a shifted EV session that lands after this 24-hour window.
    ev_kwh_after_window: float = 0.0
    #: Overnight recharge billed back at the off-peak rate. None -> discharged kWh.
    battery_recharge_kwh: float | None = None


@dataclass
class Step:
    """
    One step of the scripted run the fake agent replays.

    `invoke` names the tool that really executes at this step -- the fake agent
    does not fabricate tool output, it calls services/tools.py exactly as the
    Gemini agent does and puts the returned dict in the event payload.
    """

    #: Event type written for this step.
    type: str
    tool: str | None = None
    message: str = ""
    #: Payload for steps that do not carry a tool result (args, or a summary).
    payload: dict[str, Any] | None = None
    #: Tool to execute at this step, if any.
    invoke: str | None = None
    invoke_args: dict[str, Any] = field(default_factory=dict)
    #: Simulated thinking pause before the event is written, in milliseconds.
    delay_ms: float = 1200.0
    #: Overrides the measured duration when the narrative wants a stated one.
    duration_ms: int | None = None


#: A fixture callable receives the computed optimization result.
ResultFn = Callable[["OptimizationResult"], Any]


@dataclass
class BuildingFixture:
    """Everything the reference backend needs to serve one site."""

    building: dict[str, Any]
    #: Authored baseline components. The published curve is derived from them.
    baseline_parts: FlowComponents
    #: Published baseline grid curve, in kW, 24 entries.
    baseline_grid: list[float]
    #: Metered history; None from "now" onward.
    actual_load_kw: list[float | None]
    #: The DashboardSummary fields that are not derived from the curves.
    summary_extras: dict[str, Any]
    #: Static device facts returned by the read-only tools, keyed by tool name.
    tool_facts: dict[str, dict[str, Any]]
    policy: DispatchPolicy
    #: result -> the plan's one-paragraph rationale.
    plan_summary: ResultFn
    #: result -> list of action dicts, without id/run_id/status.
    build_actions: ResultFn
    #: result -> the 14 steps the fake agent replays.
    build_script: ResultFn
    #: Published headline numbers, asserted by the test suite.
    published: dict[str, float] = field(default_factory=dict)

    @property
    def id(self) -> str:
        return str(self.building["id"])

    @property
    def name(self) -> str:
        return str(self.building["name"])

    @property
    def peak_threshold_kw(self) -> float:
        return float(self.building["peak_threshold_kw"])
