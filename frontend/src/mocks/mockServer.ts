/**
 * In-memory simulation of the GridShift backend.
 *
 * Used when NEXT_PUBLIC_USE_MOCK !== 'false'. It replays the scripted agent run
 * in real time so the UI exercises exactly the same polling loop it will use
 * against FastAPI: startRun() stamps a clock, getEvents() reveals the events
 * whose scheduled offset has elapsed, and getPlan() 404s until the run is done.
 *
 * State is keyed per building. Two buildings can hold a finished plan at the
 * same time, and resetting one leaves the others alone -- which is what the
 * building selector needs, since switching sites must not wipe a run you are
 * still reading.
 *
 * Only src/lib/api.ts should import this module.
 */

import type {
  Action,
  ActionDecisionResponse,
  ActionPlan,
  AgentEvent,
  BuildingsResponse,
  DashboardSummary,
  EventsResponse,
  ForecastResponse,
  ResetResponse,
  RunResponse,
  RunStatus,
} from '@/types/api';
import { ApiError } from '@/lib/errors';
import {
  AGENT_SCRIPT,
  BUILDINGS,
  DEFAULT_BUILDING_ID,
  NOW_ISO,
  SCRIPT_DURATION_MS,
  type BuildingFixture,
  type ScriptedEvent,
  getFixture,
  validateFixtures,
} from './fixtures';

/** Timing wobble applied per event so the log does not tick like a metronome. */
const JITTER_MS = 150;

interface RunState {
  run_id: string;
  building_id: string;
  script: ScriptedEvent[];
  /** performance/Date clock at startRun(). */
  started_at_ms: number;
  started_at_iso: string;
  /** Effective reveal offset per scripted event, jittered and monotonic. */
  reveal_offsets_ms: number[];
  /** Built lazily, the first time getPlan() succeeds. */
  plan: ActionPlan | null;
}

/** building_id -> its most recent run. At most one run per building. */
const runsByBuilding = new Map<string, RunState>();
/** run_id -> building_id, so run-scoped endpoints do not need a building. */
const buildingByRun = new Map<string, string>();
let runCounter = 0;

// Fixtures are generated, not hand-typed, so check the arithmetic once on load.
validateFixtures();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Small, variable latency so loading states are actually visible. */
function networkLag(): Promise<void> {
  return delay(90 + Math.random() * 140);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireFixture(endpoint: string, buildingId: string): BuildingFixture {
  const fixture = getFixture(buildingId);
  if (!fixture) {
    throw new ApiError(404, endpoint, `Unknown building "${buildingId}".`);
  }
  return fixture;
}

/**
 * Jittered reveal schedule. Jitter is computed once per run (not per poll) so
 * an event can never appear and then disappear, and offsets are forced
 * non-decreasing so events always surface in seq order.
 */
function buildRevealOffsets(script: ScriptedEvent[]): number[] {
  let previous = -1;
  return script.map((event) => {
    const jittered = event.offset_ms + (Math.random() * 2 - 1) * JITTER_MS;
    const offset = Math.max(previous + 1, Math.round(jittered), 0);
    previous = offset;
    return offset;
  });
}

/** Event timestamps hang off the fixture's "now" plus the scripted offset. */
function eventTimestamp(offsetMs: number): string {
  return new Date(Date.parse(NOW_ISO) + offsetMs).toISOString();
}

function materializeEvent(run: RunState, index: number): AgentEvent {
  const scripted = run.script[index];
  return {
    id: `${run.run_id}-evt-${String(scripted.seq).padStart(2, '0')}`,
    run_id: run.run_id,
    seq: scripted.seq,
    timestamp: eventTimestamp(scripted.offset_ms),
    type: scripted.type,
    tool_name: scripted.tool_name,
    message: scripted.message,
    payload: scripted.payload ? clone(scripted.payload) : null,
    duration_ms: scripted.duration_ms,
  };
}

/**
 * Plan status from the actions:
 *   any still pending            -> awaiting_approval
 *   all decided, >= 1 approved   -> approved
 *   all decided, none approved   -> rejected
 */
function derivePlanStatus(actions: Action[]): RunStatus {
  const allDecided = actions.every((a) => a.status !== 'pending');
  if (!allDecided) return 'awaiting_approval';
  return actions.some((a) => a.status === 'approved') ? 'approved' : 'rejected';
}

function requireRun(endpoint: string, runId: string): RunState {
  const buildingId = buildingByRun.get(runId);
  const run = buildingId ? runsByBuilding.get(buildingId) : undefined;
  if (!run || run.run_id !== runId) {
    throw new ApiError(404, endpoint, `Run ${runId} not found. Start a run first.`);
  }
  return run;
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

export const mockServer = {
  async getBuildings(): Promise<BuildingsResponse> {
    await networkLag();
    return clone({ buildings: [...BUILDINGS] });
  },

  async getSummary(buildingId: string = DEFAULT_BUILDING_ID): Promise<DashboardSummary> {
    await networkLag();
    return requireFixture('/api/dashboard/summary', buildingId).buildSummary();
  },

  async getForecast(buildingId: string = DEFAULT_BUILDING_ID): Promise<ForecastResponse> {
    await networkLag();
    return clone(requireFixture('/api/forecast', buildingId).buildForecast());
  },

  async startRun(buildingId: string = DEFAULT_BUILDING_ID): Promise<RunResponse> {
    await networkLag();
    const fixture = requireFixture('/api/gridshift/run', buildingId);

    runCounter += 1;
    const runId = `run-${Date.now().toString(36)}-${runCounter}`;
    const startedAt = new Date();

    // A new run supersedes this building's previous one.
    const previous = runsByBuilding.get(buildingId);
    if (previous) buildingByRun.delete(previous.run_id);

    runsByBuilding.set(buildingId, {
      run_id: runId,
      building_id: buildingId,
      script: fixture.script,
      started_at_ms: startedAt.getTime(),
      started_at_iso: startedAt.toISOString(),
      reveal_offsets_ms: buildRevealOffsets(fixture.script),
      plan: null,
    });
    buildingByRun.set(runId, buildingId);

    return { run_id: runId, status: 'running', started_at: startedAt.toISOString() };
  },

  async getEvents(runId: string): Promise<EventsResponse> {
    await networkLag();
    const run = requireRun(`/api/gridshift/${runId}/events`, runId);

    const elapsed = Date.now() - run.started_at_ms;
    const events: AgentEvent[] = [];
    for (let i = 0; i < run.script.length; i += 1) {
      if (run.reveal_offsets_ms[i] <= elapsed) {
        events.push(materializeEvent(run, i));
      }
    }

    const isComplete = events.length === run.script.length;
    const status: RunStatus = isComplete
      ? (run.plan?.status ?? 'awaiting_approval')
      : 'running';

    return { run_id: runId, status, events, is_complete: isComplete };
  },

  async getPlan(runId: string): Promise<ActionPlan> {
    await networkLag();
    const endpoint = `/api/gridshift/${runId}/plan`;
    const run = requireRun(endpoint, runId);

    const elapsed = Date.now() - run.started_at_ms;
    const lastOffset = run.reveal_offsets_ms[run.reveal_offsets_ms.length - 1];
    if (elapsed < lastOffset) {
      throw new ApiError(
        404,
        endpoint,
        'Plan is not ready yet. The agent run is still in progress.',
      );
    }

    run.plan ??= requireFixture(endpoint, run.building_id).buildPlan(runId);
    return clone(run.plan);
  },

  async decideAction(
    actionId: string,
    decision: 'approved' | 'rejected',
  ): Promise<ActionDecisionResponse> {
    await networkLag();
    const endpoint = `/api/actions/${actionId}/${decision === 'approved' ? 'approve' : 'reject'}`;

    // Actions are unique across buildings, so find the plan that owns this one.
    let plan: ActionPlan | null = null;
    let action: Action | undefined;
    for (const run of runsByBuilding.values()) {
      const match = run.plan?.actions.find((a) => a.id === actionId);
      if (run.plan && match) {
        plan = run.plan;
        action = match;
        break;
      }
    }

    if (!plan || !action) {
      throw new ApiError(404, endpoint, 'No action plan is awaiting a decision.');
    }
    if (action.status !== 'pending') {
      throw new ApiError(409, endpoint, `Action ${actionId} was already ${action.status}.`);
    }

    action.status = decision;
    plan.status = derivePlanStatus(plan.actions);

    return { action: clone(action), plan: clone(plan) };
  },

  async resetDemo(buildingId: string = DEFAULT_BUILDING_ID): Promise<ResetResponse> {
    await networkLag();
    const fixture = requireFixture('/api/demo/reset', buildingId);

    const existing = runsByBuilding.get(buildingId);
    if (existing) buildingByRun.delete(existing.run_id);
    runsByBuilding.delete(buildingId);

    return {
      ok: true,
      message: `Demo reset for ${fixture.building.name}. Forecast and building state restored; no run in progress.`,
    };
  },
};

/** Exported for tests / debugging only. */
export const MOCK_RUN_DURATION_MS = SCRIPT_DURATION_MS;
/** Exported for tests / debugging only. */
export const DEFAULT_SCRIPT_LENGTH = AGENT_SCRIPT.length;
