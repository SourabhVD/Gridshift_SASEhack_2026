"""
The agent run loop.

Two modes behind one surface:

  GRIDSHIFT_AGENT=fake    replays a 14-step script. The narration is written,
                          the *data* is not: every step marked `invoke` calls
                          the real function in services/tools.py and the event
                          payload is whatever that function returned. Steps are
                          spaced 0.8-2.4 s apart so the dashboard's 1 s poll
                          loop sees the feed arrive the way it will in
                          production. No API key needed.

  GRIDSHIFT_AGENT=gemini  google-genai function calling over the same nine
                          tools, same wrapper, same events.

=============================================================================
The part to keep when you adapt this into backend/app: `ToolInvoker.invoke`.
=============================================================================

Every tool invocation goes through one function that

    1. writes a `tool_call` event carrying the arguments, BEFORE the call,
    2. times the call,
    3. writes a `tool_result` event carrying the returned dict and
       `duration_ms`, AFTER it,
    4. turns any exception into an `error` event and re-raises.

That ordering is what the activity feed renders: the dashboard shows a tool as
in-flight when it has seen the call but not the result. If a tool is ever
called outside this wrapper, that tool becomes invisible to the operator -- and
an agent whose work is invisible is an agent nobody will approve. Automatic
function calling in the SDK is deliberately disabled for exactly this reason:
the loop below drives the calls so the wrapper always runs.

The fake script suppresses three of the fourteen announcements (the tool_call
half of the lookups it narrates as a single line) purely to reproduce the
demo's 14-event shape. Gemini mode announces every call.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from ..config import get_settings
from ..fixtures import BuildingFixture, get_fixture
from ..store import store
from .tools import TOOL_DECLARATIONS, ToolContext, ToolError, call_tool

log = logging.getLogger("gridshift.agent")

#: Hard stop on the Gemini loop so a confused model cannot bill forever.
MAX_MODEL_TURNS = 16

SYSTEM_PROMPT = """\
You are GridShift, an energy operations agent for commercial and residential \
buildings. A run starts because today's load forecast tripped a peak-risk \
flag. Your job is to find out whether the peak is real, work out which loads \
are genuinely flexible, have the optimizer compute a dispatch schedule, check \
it, and route it to a human.

Investigate in this order, one tool call at a time:

  1. get_energy_forecast     confirm the peak and how long it lasts
  2. get_electricity_prices  learn whether kW or kWh is the thing to minimise
  3. get_battery_state       find the dispatchable energy above the reserve floor
  4. get_ev_requirements     find which charging sessions have deadline slack
  5. get_hvac_constraints    find the permitted drift, and any locked zones
  6. run_schedule_optimizer  compute the schedule; pass only the resources that
                             actually have slack
  7. validate_schedule       confirm zero violations
  8. save_action_plan        persist it
  9. request_human_approval  hand it to the operator, and stop

Rules you do not break:

  * You never calculate a schedule yourself. kW, kWh and dollar figures come \
from run_schedule_optimizer and from no other source. If you want a number, \
call a tool.
  * You never invent flexibility. If a tool reports zero flexible kW -- an \
unconditioned warehouse has no thermal mass to pre-cool -- say so plainly and \
leave that resource out. A two-action plan that is true beats a three-action \
plan that is not.
  * Safety constraints are hard. Reserve floors, clinical zones, locked \
vehicles and comfort bands are not negotiable against savings.
  * Nothing is dispatched. The run ends with a plan awaiting a person.

Between calls, write one or two sentences of plain reasoning: what you just \
learned and what it rules in or out. Those lines are shown to the operator in \
the activity feed, so write them for a facility manager, not for a log file. \
Do not use markdown."""


def _user_prompt(fixture: BuildingFixture) -> str:
    b = fixture.building
    return (
        f"Building {b['id']} ({b['name']}, {b['type']}, {b['area_sqft']:,} sqft) has "
        f"tripped its peak-risk flag against a {b['peak_threshold_kw']} kW billing "
        f"threshold. On site: a {b['battery_capacity_kwh']} kWh battery behind a "
        f"{b['battery_max_kw']} kW inverter, {b['ev_bays']} EV bays, "
        f"{b['solar_capacity_kw']} kW of PV and {b['hvac_zones']} HVAC zones. "
        "Investigate and produce an action plan for approval."
    )


# --------------------------------------------------------------------------- #
# Event writing                                                                #
# --------------------------------------------------------------------------- #


@dataclass
class ToolInvoker:
    """
    Writes one event per agent step, and wraps every tool call in a
    call/result pair. This is the contract the frontend's activity feed reads.
    """

    ctx: ToolContext

    # ------------------------------------------------------------ primitives

    def emit(
        self,
        type: str,
        message: str,
        *,
        tool_name: str | None = None,
        payload: dict[str, Any] | None = None,
        duration_ms: int | None = None,
    ) -> dict[str, Any]:
        event = store.append_event(
            self.ctx.run_id,
            type=type,
            message=message,
            tool_name=tool_name,
            payload=payload,
            duration_ms=duration_ms,
        )
        log.info(
            "[%s] seq=%02d %-11s %-22s %s%s",
            self.ctx.run_id,
            event["seq"],
            event["type"],
            tool_name or "-",
            (f"{duration_ms} ms " if duration_ms is not None else ""),
            _one_line(message),
        )
        return event

    # ------------------------------------------------------------- the wrapper

    def invoke(
        self,
        name: str,
        args: dict[str, Any] | None = None,
        *,
        announce: bool = True,
        call_message: str | None = None,
        result_message: str | None = None,
        emit_result: bool = True,
        result_type: str = "tool_result",
        result_duration_ms: int | None = None,
    ) -> dict[str, Any]:
        """
        Call one tool with a `tool_call` event before it and a `tool_result`
        event after it. Keep this shape; everything the operator sees depends
        on it.
        """
        args = args or {}
        if announce:
            self.emit(
                "tool_call",
                call_message or _render_call(name, args),
                tool_name=name,
                payload=args or None,
            )

        started = time.perf_counter()
        try:
            result = call_tool(name, self.ctx, args)
        except Exception as exc:  # noqa: BLE001 - reported, then re-raised
            elapsed = int((time.perf_counter() - started) * 1000)
            self.emit(
                "error",
                f"{name} failed: {exc}",
                tool_name=name,
                payload={"error": type(exc).__name__, "detail": str(exc)},
                duration_ms=elapsed,
            )
            raise

        elapsed = int((time.perf_counter() - started) * 1000)
        if emit_result:
            self.emit(
                result_type,
                result_message or f"{name} returned {len(result)} fields.",
                tool_name=name,
                payload=result,
                duration_ms=result_duration_ms if result_duration_ms is not None else elapsed,
            )
        return result


def _render_call(name: str, args: dict[str, Any]) -> str:
    rendered = ", ".join(f"{k}={json.dumps(v)}" for k, v in args.items())
    return f"{name}({rendered})"


def _one_line(message: str, limit: int = 96) -> str:
    flat = " ".join(message.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


# --------------------------------------------------------------------------- #
# Fake agent                                                                   #
# --------------------------------------------------------------------------- #


async def _sleep(delay_ms: float) -> None:
    seconds = (delay_ms / 1000.0) * get_settings().agent_speed
    if seconds > 0:
        await asyncio.sleep(seconds)


async def run_fake(invoker: ToolInvoker) -> None:
    """
    Replay the site's scripted investigation, calling the real tools.

    The script is built from the *computed* optimization result, so the
    narration and the payloads agree by construction. Note that the result is
    computed twice: once here to write the script, and once inside
    run_schedule_optimizer when the agent reaches that step. The heuristic is
    deterministic, so both produce the same schedule.
    """
    ctx = invoker.ctx
    from .optimizer import optimize  # local import keeps the module graph flat

    script = ctx.fixture.build_script(optimize(ctx.fixture))

    for step in script:
        await _sleep(step.delay_ms)

        # execute_run() writes the canonical 'complete' event for both modes,
        # so the script's final step only contributes its pause. 13 + 1 = 14.
        if step.type == "complete":
            return

        if step.invoke:
            invoker.invoke(
                step.invoke,
                step.invoke_args or (step.payload if step.type == "tool_call" else {}),
                # The three announced lookups keep the demo's 14-event shape.
                announce=step.type == "tool_call",
                call_message=step.message,
                result_message=step.message,
                emit_result=step.type != "tool_call",
                result_type="decision" if step.type == "decision" else "tool_result",
                result_duration_ms=step.duration_ms,
            )
            continue

        invoker.emit(
            step.type,
            step.message,
            tool_name=step.tool,
            payload=step.payload,
            duration_ms=step.duration_ms,
        )


# --------------------------------------------------------------------------- #
# Gemini agent                                                                 #
# --------------------------------------------------------------------------- #


async def run_gemini(invoker: ToolInvoker) -> None:
    """
    Drive the same nine tools with google-genai function calling.

    Automatic function calling is switched off on purpose: the SDK would
    execute the tools for us and the call/result events would never be
    written. The loop below does what the SDK would do, plus the wrapper.
    """
    from google import genai  # noqa: PLC0415 - optional dependency
    from google.genai import types  # noqa: PLC0415

    settings = get_settings()
    client = genai.Client(api_key=settings.gemini_api_key)

    tool_config = types.Tool(
        function_declarations=[
            types.FunctionDeclaration(**declaration) for declaration in TOOL_DECLARATIONS
        ]
    )
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        tools=[tool_config],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        temperature=0.2,
    )

    contents: list[Any] = [
        types.Content(role="user", parts=[types.Part(text=_user_prompt(invoker.ctx.fixture))])
    ]

    approved = False
    for turn in range(MAX_MODEL_TURNS):
        response = await asyncio.to_thread(
            client.models.generate_content,
            model=settings.gemini_model,
            contents=contents,
            config=config,
        )

        candidate = (response.candidates or [None])[0]
        parts = list(getattr(getattr(candidate, "content", None), "parts", None) or [])
        calls = [p.function_call for p in parts if getattr(p, "function_call", None)]
        texts = [p.text.strip() for p in parts if getattr(p, "text", None) and p.text.strip()]

        # Model prose between calls becomes the operator-visible reasoning. A
        # turn that also commits the plan is a decision, not a musing.
        commits = any(call.name == "save_action_plan" for call in calls)
        for text in texts:
            invoker.emit(
                "decision" if commits else "thinking",
                text,
                tool_name="save_action_plan" if commits else None,
            )

        if not calls:
            if texts:
                break
            invoker.emit("error", "The model returned neither text nor a tool call.")
            break

        contents.append(candidate.content)
        response_parts = []
        for call in calls:
            args = dict(call.args or {})
            try:
                result = invoker.invoke(call.name, args)
            except ToolError as exc:
                result = {"error": str(exc)}
            except Exception as exc:  # noqa: BLE001 - already reported as an event
                result = {"error": f"{type(exc).__name__}: {exc}"}
            if call.name == "request_human_approval" and "error" not in result:
                approved = True
            response_parts.append(
                types.Part.from_function_response(name=call.name, response=result)
            )

        contents.append(types.Content(role="user", parts=response_parts))

        if approved:
            break
    else:
        invoker.emit(
            "error",
            f"Stopped after {MAX_MODEL_TURNS} model turns without reaching approval.",
        )


# --------------------------------------------------------------------------- #
# Entry point                                                                  #
# --------------------------------------------------------------------------- #


async def execute_run(run_id: str, building_id: str) -> None:
    """
    Run the agent to completion and set the run's terminal status.

    Called as a background task by POST /api/gridshift/run, which has already
    returned the run id to the client.
    """
    settings = get_settings()
    fixture = get_fixture(building_id)
    if fixture is None:  # pragma: no cover - the route checks this first
        store.set_status(run_id, "failed", error=f"unknown building {building_id}")
        return

    ctx = ToolContext(run_id=run_id, fixture=fixture)
    invoker = ToolInvoker(ctx)
    mode = settings.effective_agent_mode
    if settings.agent_mode == "gemini" and mode == "fake":
        log.warning("GRIDSHIFT_AGENT=gemini but GEMINI_API_KEY is empty; running fake mode")

    started = time.perf_counter()
    log.info("run %s started building=%s agent=%s", run_id, building_id, mode)

    try:
        if mode == "gemini":
            await run_gemini(invoker)
        else:
            await run_fake(invoker)

        if not store.has_plan(run_id):
            invoker.emit(
                "error",
                "The run finished without saving an action plan, so there is nothing "
                "to approve.",
            )
            store.set_status(run_id, "failed", error="no plan saved")
            return

        elapsed = time.perf_counter() - started
        plan = store.get_plan(run_id)
        invoker.emit(
            "complete",
            f"Investigation complete in {elapsed:.1f} s. Plan is ready for review; "
            "nothing will be dispatched until it is approved.",
            payload={
                "duration_s": round(elapsed, 1),
                "action_count": len(plan["actions"]),
                "peak_reduction_kw": plan["peak_reduction_kw"],
                "savings_usd": plan["savings_usd"],
            },
        )
        store.set_status(run_id, "awaiting_approval")
        log.info("run %s complete in %.1f s", run_id, elapsed)

    except asyncio.CancelledError:  # pragma: no cover - shutdown path
        store.set_status(run_id, "failed", error="cancelled")
        raise
    except Exception as exc:  # noqa: BLE001 - a failed run must still be readable
        log.exception("run %s failed", run_id)
        invoker.emit("error", f"The run failed: {exc}", payload={"error": type(exc).__name__})
        store.set_status(run_id, "failed", error=str(exc))
