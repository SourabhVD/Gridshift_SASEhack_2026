/**
 * The only module that talks to the GridShift backend.
 *
 * Two interchangeable implementations behind one surface:
 *   NEXT_PUBLIC_USE_MOCK=true  (default) -> src/mocks/mockServer.ts, in-memory
 *   NEXT_PUBLIC_USE_MOCK=false           -> fetch against NEXT_PUBLIC_API_BASE_URL
 *
 * UI components must NOT import this directly -- consume useGridShift() from
 * src/lib/store.tsx instead, which owns loading, polling and error state.
 */

import type {
  ActionDecisionResponse,
  ActionPlan,
  BuildingsResponse,
  DashboardSummary,
  EventsResponse,
  ForecastResponse,
  ResetResponse,
  RunResponse,
} from '@/types/api';
import { ApiError } from '@/lib/errors';
import { mockServer } from '@/mocks/mockServer';

export { ApiError } from '@/lib/errors';

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/** Mock mode is the default so the frontend runs with no backend at all. */
export const IS_MOCK = process.env.NEXT_PUBLIC_USE_MOCK !== 'false';

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
).replace(/\/+$/, '');

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError(
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

  return (await res.json()) as T;
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
  return IS_MOCK ? mockServer.getBuildings() : request<BuildingsResponse>('/api/buildings');
}

/** GET /api/dashboard/summary?building_id= */
export function getSummary(buildingId: string): Promise<DashboardSummary> {
  return IS_MOCK
    ? mockServer.getSummary(buildingId)
    : request<DashboardSummary>(withBuilding('/api/dashboard/summary', buildingId));
}

/** GET /api/forecast?building_id= */
export function getForecast(buildingId: string): Promise<ForecastResponse> {
  return IS_MOCK
    ? mockServer.getForecast(buildingId)
    : request<ForecastResponse>(withBuilding('/api/forecast', buildingId));
}

/** POST /api/gridshift/run -- body: { building_id } */
export function startRun(buildingId: string): Promise<RunResponse> {
  return IS_MOCK
    ? mockServer.startRun(buildingId)
    : request<RunResponse>('/api/gridshift/run', {
        method: 'POST',
        body: JSON.stringify({ building_id: buildingId }),
      });
}

/** GET /api/gridshift/{run_id}/events -- cumulative, poll until is_complete. */
export function getEvents(runId: string): Promise<EventsResponse> {
  return IS_MOCK
    ? mockServer.getEvents(runId)
    : request<EventsResponse>(`/api/gridshift/${encodeURIComponent(runId)}/events`);
}

/** GET /api/gridshift/{run_id}/plan -- 404s until the run is complete. */
export function getPlan(runId: string): Promise<ActionPlan> {
  return IS_MOCK
    ? mockServer.getPlan(runId)
    : request<ActionPlan>(`/api/gridshift/${encodeURIComponent(runId)}/plan`);
}

/** POST /api/actions/{id}/approve */
export function approveAction(actionId: string): Promise<ActionDecisionResponse> {
  return IS_MOCK
    ? mockServer.decideAction(actionId, 'approved')
    : request<ActionDecisionResponse>(
        `/api/actions/${encodeURIComponent(actionId)}/approve`,
        { method: 'POST' },
      );
}

/** POST /api/actions/{id}/reject */
export function rejectAction(actionId: string): Promise<ActionDecisionResponse> {
  return IS_MOCK
    ? mockServer.decideAction(actionId, 'rejected')
    : request<ActionDecisionResponse>(
        `/api/actions/${encodeURIComponent(actionId)}/reject`,
        { method: 'POST' },
      );
}

/** POST /api/demo/reset -- body: { building_id }. Resets only that building. */
export function resetDemo(buildingId: string): Promise<ResetResponse> {
  return IS_MOCK
    ? mockServer.resetDemo(buildingId)
    : request<ResetResponse>('/api/demo/reset', {
        method: 'POST',
        body: JSON.stringify({ building_id: buildingId }),
      });
}

export const api = {
  getBuildings,
  getSummary,
  getForecast,
  startRun,
  getEvents,
  getPlan,
  approveAction,
  rejectAction,
  resetDemo,
};
