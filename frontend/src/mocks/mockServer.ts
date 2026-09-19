/**
 * In-memory simulation of the GridShift backend.
 *
 * Used when NEXT_PUBLIC_USE_MOCK !== 'false'. It replays the scripted agent run
 * in real time so the UI exercises exactly the same polling loop it will use
 * against FastAPI: startRun() stamps a clock, getEvents() reveals the events
 * whose scheduled offset has elapsed, and getPlan() 404s until the run is done.
 *
 * Only src/lib/api.ts should import this module.
 */

import type {
  Action,
  ActionDecisionResponse,
  ActionPlan,
  AgentEvent,
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
  NOW_ISO,
  SCRIPT_DURATION_MS,
  buildForecast,
  buildPlan,
  buildSummary,
} from './fixtures';

/** Timing wobble applied per event so the log does not tick like a metronome. */
const JITTER_MS = 150;

interface RunState {
  run_id: string;
  /** performance/Date clock at startRun(). */
  started_at_ms: number;
  started_at_iso: string;
  /** Effective reveal offset per scripted event, jittered and monotonic. */
  reveal_offsets_ms: number[];
  /** Built lazily, the first time getPlan() succeeds. */
  plan: ActionPlan | null;
}

let currentRun: RunState | null = null;
let runCounter = 0;

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

/**
 * Jittered reveal schedule. Jitter is computed once per run (not per poll) so
 * an event can never appear and then disappear, and offsets are forced
 * non-decreasing so events always surface in seq order.
 */
function buildRevealOffsets(): number[] {
  let previous = -1;
  return AGENT_SCRIPT.map((event) => {
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

function materializeEvent(index: number, runId: string): AgentEvent {
  const scripted = AGENT_SCRIPT[index];
  return {
    id: `${runId}-evt-${String(scripted.seq).padStart(2, '0')}`,
    run_id: runId,
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
  if (!currentRun || currentRun.run_id !== runId) {
    throw new ApiError(404, endpoint, `Run ${runId} not found. Start a run first.`);
  }
  return currentRun;
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

export const mockServer = {
  async getSummary(): Promise<DashboardSummary> {
    await networkLag();
    return buildSummary();
  },

  async getForecast(): Promise<ForecastResponse> {
    await networkLag();
    return buildForecast();
  },

  async startRun(): Promise<RunResponse> {
    await networkLag();
    runCounter += 1;
    const runId = `run-${Date.now().toString(36)}-${runCounter}`;
    const startedAt = new Date();

    currentRun = {
      run_id: runId,
      started_at_ms: startedAt.getTime(),
      started_at_iso: startedAt.toISOString(),
      reveal_offsets_ms: buildRevealOffsets(),
      plan: null,
    };

    return { run_id: runId, status: 'running', started_at: currentRun.started_at_iso };
  },

  async getEvents(runId: string): Promise<EventsResponse> {
    await networkLag();
    const run = requireRun(`/api/gridshift/${runId}/events`, runId);

    const elapsed = Date.now() - run.started_at_ms;
    const events: AgentEvent[] = [];
    for (let i = 0; i < AGENT_SCRIPT.length; i += 1) {
      if (run.reveal_offsets_ms[i] <= elapsed) {
        events.push(materializeEvent(i, runId));
      }
    }

    const isComplete = events.length === AGENT_SCRIPT.length;
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

    run.plan ??= buildPlan(runId);
    return clone(run.plan);
  },

  async decideAction(
    actionId: string,
    decision: 'approved' | 'rejected',
  ): Promise<ActionDecisionResponse> {
    await networkLag();
    const endpoint = `/api/actions/${actionId}/${decision === 'approved' ? 'approve' : 'reject'}`;

    if (!currentRun?.plan) {
      throw new ApiError(404, endpoint, 'No action plan is awaiting a decision.');
    }

    const plan = currentRun.plan;
    const action = plan.actions.find((a) => a.id === actionId);
    if (!action) {
      throw new ApiError(404, endpoint, `Action ${actionId} not found in the current plan.`);
    }
    if (action.status !== 'pending') {
      throw new ApiError(
        409,
        endpoint,
        `Action ${actionId} was already ${action.status}.`,
      );
    }

    action.status = decision;
    plan.status = derivePlanStatus(plan.actions);

    return { action: clone(action), plan: clone(plan) };
  },

  async resetDemo(): Promise<ResetResponse> {
    await networkLag();
    currentRun = null;
    return {
      ok: true,
      message: 'Demo reset. Forecast and building state restored; no run in progress.',
    };
  },
};

/** Exported for tests / debugging only. */
export const MOCK_RUN_DURATION_MS = SCRIPT_DURATION_MS;
