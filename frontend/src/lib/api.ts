/**
 * The only module that talks to the GridShift backend.
 *
 * Three interchangeable behaviours behind one surface, picked by
 * NEXT_PUBLIC_USE_MOCK and parsed once in src/lib/apiMode.ts:
 *
 *   'true' (default) -> 'mock'     src/mocks/mockServer.ts, in-memory
 *   'false'          -> 'real'     fetch against NEXT_PUBLIC_API_BASE_URL
 *   'partial'        -> 'partial'  fetch first, fall back to the mock per
 *                                  endpoint the backend does not serve yet
 *
 * 'partial' exists so a real backend can be integrated one endpoint at a time.
 * A call falls back ONLY when the endpoint is plainly not there:
 *
 *   - the fetch threw (backend down, CORS, DNS) or hit the timeout below
 *   - HTTP 404, 501, 502, 503, 504
 *   - 2xx with a body missing the fields this endpoint must return
 *
 * Everything else -- 400, 401, 403, 409, 422, 500 -- is thrown as an ApiError,
 * because those are the backend's own bugs and hiding them behind fixtures is
 * how an integration silently stops progressing.
 *
 * Run-scoped endpoints do not decide for themselves. A run that started on the
 * mock stays on the mock for its events, plan and approvals (its ids are
 * prefixed 'mock-', see below); a run that started on the backend stays on the
 * backend, because the mock has never heard of that run id and falling back
 * would only turn one error into a more confusing one.
 *
 * UI components must NOT import this directly -- consume useGridShift() from
 * src/lib/store.tsx instead, which owns loading, polling and error state.
 */

import type {
  BacktestDates,
  BacktestReport,
  Action,
  ActionDecisionResponse,
  ActionPlan,
  BuildingsResponse,
  DashboardSummary,
  EventsResponse,
  ForecastResponse,
  ResetResponse,
  RunResponse,
} from '@/types/api';
import { ApiError, ApiShapeError } from '@/lib/errors';
import { apiMode, endpointStatus, isMockMode, type EndpointKey } from '@/lib/apiMode';
import { mockServer } from '@/mocks/mockServer';

export { ApiError } from '@/lib/errors';
export {
  apiMode,
  endpointStatus,
  isMockMode,
  ENDPOINT_KEYS,
  ENDPOINT_PATHS,
} from '@/lib/apiMode';
export type {
  ApiMode,
  EndpointKey,
  EndpointState,
  EndpointStatusMap,
} from '@/lib/apiMode';

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * True when fixture data can reach the UI -- i.e. in 'mock' AND in 'partial'.
 * Kept under the old name because src/lib/store.tsx exposes it as `isMock`,
 * which drives the MOCK badge in the header. A badge that wants to be precise
 * about partial mode should read `endpointStatus` instead.
 */
export const IS_MOCK = isMockMode;

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
).replace(/\/+$/, '');

/** Ceiling on a normal call. A hung backend must not hang the dashboard. */
export const REQUEST_TIMEOUT_MS = 8_000;

/** Tighter ceiling for the 1 s poll loop, so a stall degrades within a tick. */
export const POLL_TIMEOUT_MS = 4_000;

/** Statuses that mean "this endpoint is not implemented / not up yet". */
const FALLBACK_STATUSES: ReadonlySet<number> = new Set([404, 501, 502, 503, 504]);

/* -------------------------------------------------------------------------- */
/* Shape checks                                                                */
/* -------------------------------------------------------------------------- */

type FieldKind = 'array' | 'object' | 'string' | 'number' | 'boolean';

/** Returns a description of the first bad field, or null when it looks right. */
type ShapeCheck = (body: unknown) => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deliberately shallow: only the top-level fields the store dereferences
 * without checking. This is a "did I reach the right endpoint" test, not a
 * schema validator -- a subtly wrong payload is the backend's bug to fix, and
 * must not be swapped for fixtures behind the team's back.
 */
function shapeOf(spec: Readonly<Record<string, FieldKind>>): ShapeCheck {
  return (body) => {
    if (!isRecord(body)) return 'body is not an object';
    for (const [field, kind] of Object.entries(spec)) {
      const value = body[field];
      const ok =
        kind === 'array'
          ? Array.isArray(value)
          : kind === 'object'
            ? isRecord(value)
            : typeof value === kind;
      if (!ok) return `missing or invalid "${field}"`;
    }
    return null;
  };
}

const SHAPE = {
  buildings: shapeOf({ buildings: 'array' }),
  summary: shapeOf({
    building_id: 'string',
    current_load_kw: 'number',
    peak_threshold_kw: 'number',
  }),
  forecast: shapeOf({ points: 'array' }),
  run: shapeOf({ run_id: 'string' }),
  events: shapeOf({ events: 'array', is_complete: 'boolean' }),
  plan: shapeOf({ actions: 'array', impact: 'array' }),
  decision: shapeOf({ action: 'object', plan: 'object' }),
  reset: shapeOf({ ok: 'boolean' }),
} as const;

/* -------------------------------------------------------------------------- */
/* Real transport                                                              */
/* -------------------------------------------------------------------------- */

/** Best-effort extraction of FastAPI's {"detail": "..."} error body. */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'detail' in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === 'string') return detail;
      return JSON.stringify(detail);
    }
  } catch {
    /* non-JSON body; fall through to the generic message */
  }
  return res.statusText || 'Request failed';
}

interface RequestOptions extends RequestInit {
  /** AbortController deadline. Defaults to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Top-level fields this endpoint must return. */
  validate?: ShapeCheck;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, validate, ...init } = options;
  const url = `${API_BASE_URL}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...init.headers },
      });
    } catch {
      // Status 0 == never got an HTTP answer, whether it timed out or threw.
      throw controller.signal.aborted
        ? new ApiError(0, path, `${path} timed out after ${timeoutMs} ms (${url}).`)
        : new ApiError(
            0,
            path,
            `Could not reach the GridShift API at ${url}. Is the backend running?`,
          );
    }

    if (!res.ok) {
      throw new ApiError(
        res.status,
        path,
        `${res.status} ${await readErrorDetail(res)} (${path})`,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (controller.signal.aborted) {
        throw new ApiError(0, path, `${path} timed out after ${timeoutMs} ms (${url}).`);
      }
      throw new ApiShapeError(res.status, path, 'body was not JSON');
    }

    const bad = validate?.(body);
    if (bad) throw new ApiShapeError(res.status, path, bad);

    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Partial mode                                                                */
/* -------------------------------------------------------------------------- */

/** "The endpoint is not there", as opposed to "the endpoint is broken". */
function isMissingEndpoint(err: unknown): boolean {
  if (err instanceof ApiShapeError) return true;
  if (!(err instanceof ApiError)) return false;
  return err.status === 0 || FALLBACK_STATUSES.has(err.status);
}

/** Try the backend; drop to the mock only when the endpoint is missing. */
async function tryReal<T>(
  key: EndpointKey,
  real: () => Promise<T>,
  mock: () => Promise<T>,
): Promise<T> {
  try {
    const value = await real();
    endpointStatus.markLive(key);
    return value;
  } catch (err) {
    if (!isMissingEndpoint(err)) throw err;
    endpointStatus.markFallback(key); // logs once per endpoint, not per poll
    return mock();
  }
}

/** Record 'live' on success without otherwise changing the call. */
async function asLive<T>(key: EndpointKey, real: () => Promise<T>): Promise<T> {
  const value = await real();
  endpointStatus.markLive(key);
  return value;
}

/* ---------------------------------------------------- mock id bookkeeping -- */

/**
 * Ids minted by the mock while in partial mode carry this prefix, so a run that
 * began on fixtures can never be mistaken for one the backend knows about --
 * and so a `mock-run-...` id in the devtools says which half of the app you are
 * looking at. The prefix is added here, not in mockServer.ts: the mock stays
 * unaware that partial mode exists.
 */
const MOCK_ID_PREFIX = 'mock-';

const mockRunIds = new Set<string>();
const mockActionIds = new Set<string>();

function tagId(id: string): string {
  return `${MOCK_ID_PREFIX}${id}`;
}

function untagId(id: string): string {
  return id.startsWith(MOCK_ID_PREFIX) ? id.slice(MOCK_ID_PREFIX.length) : id;
}

/** True when this run started on the mock and must stay there. */
export function isMockRunId(runId: string): boolean {
  return mockRunIds.has(runId);
}

/** True when this action belongs to a mock-issued plan. */
export function isMockActionId(actionId: string): boolean {
  return mockActionIds.has(actionId);
}

function tagRunResponse(res: RunResponse): RunResponse {
  const runId = tagId(res.run_id);
  mockRunIds.add(runId);
  return { ...res, run_id: runId };
}

function tagEventsResponse(res: EventsResponse): EventsResponse {
  const runId = tagId(res.run_id);
  return {
    ...res,
    run_id: runId,
    events: res.events.map((event) => ({ ...event, run_id: runId })),
  };
}

function tagAction(action: Action): Action {
  const actionId = tagId(action.id);
  mockActionIds.add(actionId);
  return { ...action, id: actionId, run_id: tagId(action.run_id) };
}

function tagPlan(plan: ActionPlan): ActionPlan {
  return { ...plan, run_id: tagId(plan.run_id), actions: plan.actions.map(tagAction) };
}

function tagDecision(res: ActionDecisionResponse): ActionDecisionResponse {
  return { action: tagAction(res.action), plan: tagPlan(res.plan) };
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Building-scoped endpoints take the site id: a `building_id` query parameter
 * on GETs, a `building_id` body field on POSTs. Run-scoped endpoints
 * (`/events`, `/plan`) and action-scoped ones do not -- the run id already
 * identifies the building.
 */
function withBuilding(path: string, buildingId: string): string {
  return `${path}?building_id=${encodeURIComponent(buildingId)}`;
}

/** GET /api/buildings -- every site this deployment knows about. */
export function getBuildings(): Promise<BuildingsResponse> {
  const mock = () => mockServer.getBuildings();
  const real = () =>
    request<BuildingsResponse>('/api/buildings', { validate: SHAPE.buildings });

  if (apiMode === 'mock') return mock();
  if (apiMode === 'real') return real();
  return tryReal('buildings', real, mock);
}

/**
 * `date` names one of the real metered days the backend has on disk. Empty
 * means whatever it is configured to serve, which is every mock's case and
 * the default everywhere else.
 */
function withDate(path: string, date: string): string {
  return date ? `${path}${path.includes('?') ? '&' : '?'}date=${encodeURIComponent(date)}` : path;
}

/** GET /api/dashboard/summary?building_id=&date= */
export function getSummary(buildingId: string, date = ''): Promise<DashboardSummary> {
  const mock = () => mockServer.getSummary(buildingId);
  const real = () =>
    request<DashboardSummary>(withDate(withBuilding('/api/dashboard/summary', buildingId), date), {
      validate: SHAPE.summary,
    });

  if (apiMode === 'mock') return mock();
  if (apiMode === 'real') return real();
  return tryReal('summary', real, mock);
}

/** GET /api/forecast?building_id=&date= */
export function getForecast(buildingId: string, date = ''): Promise<ForecastResponse> {
  const mock = () => mockServer.getForecast(buildingId);
  const real = () =>
    request<ForecastResponse>(withDate(withBuilding('/api/forecast', buildingId), date), {
      validate: SHAPE.forecast,
    });

  if (apiMode === 'mock') return mock();
  if (apiMode === 'real') return real();
  return tryReal('forecast', real, mock);
}

/**
 * POST /api/gridshift/run -- body: { building_id }
 *
 * This call decides the whole run: if it falls back, the run id it returns is
 * 'mock-' prefixed and every later call for that run goes to the mock too.
 */
export function startRun(buildingId: string, date = ''): Promise<RunResponse> {
  const mock = () => mockServer.startRun(buildingId);
  const real = () =>
    request<RunResponse>('/api/gridshift/run', {
      method: 'POST',
      body: JSON.stringify({ building_id: buildingId, date }),
      validate: SHAPE.run,
    });

  if (apiMode === 'mock') return mock();
  if (apiMode === 'real') return real();
  return tryReal('run', real, () => mock().then(tagRunResponse));
}

/** GET /api/gridshift/{run_id}/events -- cumulative, poll until is_complete. */
export function getEvents(runId: string): Promise<EventsResponse> {
  if (apiMode === 'mock') return mockServer.getEvents(runId);

  if (apiMode === 'partial' && mockRunIds.has(runId)) {
    endpointStatus.markFallback('events');
    return mockServer.getEvents(untagId(runId)).then(tagEventsResponse);
  }

  const real = () =>
    request<EventsResponse>(`/api/gridshift/${encodeURIComponent(runId)}/events`, {
      timeoutMs: POLL_TIMEOUT_MS,
      validate: SHAPE.events,
    });
  // A backend-issued run cannot be served by the mock, so no fallback here.
  return apiMode === 'partial' ? asLive('events', real) : real();
}

/** GET /api/gridshift/{run_id}/plan -- 404s until the run is complete. */
export function getPlan(runId: string): Promise<ActionPlan> {
  if (apiMode === 'mock') return mockServer.getPlan(runId);

  if (apiMode === 'partial' && mockRunIds.has(runId)) {
    endpointStatus.markFallback('plan');
    return mockServer.getPlan(untagId(runId)).then(tagPlan);
  }

  const real = () =>
    request<ActionPlan>(`/api/gridshift/${encodeURIComponent(runId)}/plan`, {
      timeoutMs: POLL_TIMEOUT_MS,
      validate: SHAPE.plan,
    });
  // Never falls back: on a backend run, 404 means "plan not ready yet", which
  // is part of the contract, not a missing endpoint.
  return apiMode === 'partial' ? asLive('plan', real) : real();
}

function decideAction(
  actionId: string,
  decision: 'approve' | 'reject',
): Promise<ActionDecisionResponse> {
  const outcome = decision === 'approve' ? 'approved' : 'rejected';

  if (apiMode === 'mock') return mockServer.decideAction(actionId, outcome);

  if (apiMode === 'partial' && mockActionIds.has(actionId)) {
    endpointStatus.markFallback('actions');
    return mockServer.decideAction(untagId(actionId), outcome).then(tagDecision);
  }

  const real = () =>
    request<ActionDecisionResponse>(
      `/api/actions/${encodeURIComponent(actionId)}/${decision}`,
      { method: 'POST', validate: SHAPE.decision },
    );
  // The action belongs to a backend plan; the mock could not decide it.
  return apiMode === 'partial' ? asLive('actions', real) : real();
}

/** POST /api/actions/{id}/approve */
export function approveAction(actionId: string): Promise<ActionDecisionResponse> {
  return decideAction(actionId, 'approve');
}

/** POST /api/actions/{id}/reject */
export function rejectAction(actionId: string): Promise<ActionDecisionResponse> {
  return decideAction(actionId, 'reject');
}

/**
 * POST /api/demo/reset -- body: { building_id }. Resets only that building.
 *
 * In partial mode both sides are reset: whichever endpoints are live keep
 * serving the backend's fresh state, and the ones still on fixtures must not be
 * left holding a finished run from before the reset.
 */
export function resetDemo(buildingId: string): Promise<ResetResponse> {
  const mock = () => mockServer.resetDemo(buildingId);
  const real = () =>
    request<ResetResponse>('/api/demo/reset', {
      method: 'POST',
      body: JSON.stringify({ building_id: buildingId }),
      validate: SHAPE.reset,
    });

  if (apiMode === 'mock') return mock();
  if (apiMode === 'real') return real();

  return (async () => {
    // Best effort: a building the fixtures do not know must not mask a
    // successful backend reset.
    const mockResult = await mock().catch(() => null);
    try {
      const result = await real();
      endpointStatus.markLive('reset');
      return result;
    } catch (err) {
      if (!isMissingEndpoint(err)) throw err;
      endpointStatus.markFallback('reset');
      if (mockResult) return mockResult;
      return mock();
    }
  })();
}

/**
 * GET /api/backtests?building_id=
 *
 * There is no mock for this: the fixtures are one authored day and have no
 * calendar behind them. An empty list is the honest answer and the dashboard
 * simply offers no picker, which is what should happen when the backend is
 * not serving real days either.
 */
export function getBacktestDates(buildingId: string): Promise<BacktestDates> {
  const empty: BacktestDates = { building_id: buildingId, dates: [], serving: '' };
  if (apiMode === 'mock') return Promise.resolve(empty);
  const real = () =>
    request<BacktestDates>(withBuilding('/api/backtests', buildingId));
  if (apiMode === 'real') return real();
  return real().catch(() => empty);
}

/** GET /api/reports/backtest?building_id= -- see the note above about mocks. */
export function getBacktestReport(buildingId: string): Promise<BacktestReport | null> {
  if (apiMode === 'mock') return Promise.resolve(null);
  const real = () =>
    request<BacktestReport>(withBuilding('/api/reports/backtest', buildingId));
  if (apiMode === 'real') return real();
  return real().catch(() => null);
}

export const api = {
  getBuildings,
  getSummary,
  getForecast,
  getBacktestDates,
  getBacktestReport,
  startRun,
  getEvents,
  getPlan,
  approveAction,
  rejectAction,
  resetDemo,
};
