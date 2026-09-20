# API Contracts

The GridShift backend speaks HTTP + JSON. Every field name on the wire is
`snake_case`; every timestamp is ISO 8601 **with an explicit timezone offset**
(`2025-09-18T15:00:00-07:00`), and every timestamp belonging to a building is
expressed in that building's own local timezone, so the hour in the string is
the hour a facility manager standing in the lobby would read off the wall.
Numbers are plain JSON floats in kW, kWh, USD, percent or °F as named by their
suffix — never strings, never formatted, never rounded for display. The client
ignores unknown extra fields, so adding a field is backwards compatible;
renaming or removing one is not. The authoritative field list is
[`frontend/src/types/api.ts`](../frontend/src/types/api.ts) — when this document
and those types disagree, the types win. The in-memory mock in
[`frontend/src/mocks/`](../frontend/src/mocks/) is an executable example of
every payload below, and a runnable FastAPI implementation lives in
[`backend/reference/`](../backend/reference).

Every example in this document is the real `sea-office-001` payload, taken from
the fixtures, not invented.

---

## Conventions

### Base URL

```
http://localhost:8000
```

The frontend reads this from `NEXT_PUBLIC_API_BASE_URL` (trailing slashes are
stripped) and appends the paths below verbatim. All nine endpoints live under
`/api`.

### CORS

The dashboard runs at `http://localhost:3000` and calls the API cross-origin.
The backend must send:

- `Access-Control-Allow-Origin: http://localhost:3000`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`

The client sets `Content-Type: application/json` on **every** request, including
GETs. That is not a CORS-safelisted request header, so the browser sends an
`OPTIONS` preflight before every call — `OPTIONS` must be answered on all nine
paths, not just the POSTs. No cookies or `Authorization` header are sent, so
`Access-Control-Allow-Credentials` is not required. Requests are issued with
`cache: 'no-store'`.

### Error envelope

Errors use FastAPI's default body, and the HTTP status carries the meaning:

```json
{ "detail": "Unknown building \"sea-office-999\"." }
```

The client turns any non-2xx into an `ApiError` carrying `status`, the endpoint
path and `detail` as the message. A non-JSON error body degrades to the HTTP
status text. `detail` is shown to the user, so write it as a sentence, not a
stack trace. `status === 0` is client-side only: the fetch threw (backend down,
CORS refused, DNS) or hit the client timeout.

### What each status means to the client

| Status | Meaning to the frontend |
| ------ | ----------------------- |
| `200` | Success. Body must carry the endpoint's required top-level fields. |
| `404`, `501`, `502`, `503`, `504` | "Not implemented yet." In `partial` mode the call silently falls back to the mock; in `real` mode it surfaces as an `ApiError`. |
| `400`, `401`, `403`, `409`, `422`, `500` | The backend's own bug, or a real conflict. Always surfaced to the user, never masked by fixtures. |
| `2xx` with a missing required field | Treated exactly like a missing endpoint (`ApiShapeError`). |

Two consequences worth designing around:

- **Do not use `404` for validation failures.** An unknown `building_id` on a
  GET reads to the client as "this endpoint does not exist yet". Prefer `422`
  (or `400`) for a malformed or unknown id, and reserve `404` for genuinely
  absent resources — an unknown `run_id`, or a plan that is not ready.
- The one deliberate `404` in the contract is
  `GET /api/gridshift/{run_id}/plan` before the run completes. That call never
  falls back, so its `404` keeps its contract meaning.

Client-side timeouts are 8 000 ms for normal calls and 4 000 ms for the two
endpoints in the 1-second poll loop (`/events` and `/plan`). A handler that
cannot answer within 4 s will be abandoned mid-run.

### Idempotency of approve and reject

Approving or rejecting an action is a one-way transition out of `pending`.
A second decision on the same action — the same one or the opposite one — must
return `409` with `detail` naming the state it is already in:

```json
{ "detail": "Action act-battery-01 was already approved." }
```

`409` is in the "surface it" column, so the user sees the conflict rather than a
silently reordered plan. That is what makes the buttons safe to double-click.

### Polling cadence

1. `POST /api/gridshift/run` returns immediately with a `run_id`.
2. The client polls `GET /api/gridshift/{run_id}/events` **every 1 000 ms**,
   starting instantly (no dead first beat). Each response is the **cumulative**
   list of events so far, not a delta.
3. The first response with `"is_complete": true` stops the loop, and the client
   fetches `GET /api/gridshift/{run_id}/plan` **exactly once**.
4. Approve and reject are user-driven; nothing polls after the plan lands.

A 14-event run takes about 17 s of wall clock, so expect roughly 17 poll
requests per run. Keep the events handler cheap.

### The flows identity

Every `EnergyFlows` object — on forecast points, on baseline impact points and
on optimized impact points — must satisfy, to within 0.1 kW:

```
grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw
```

Three consumers (`base`, `ev`, `hvac`) are served first by the two on-site
sources (`solar`, `battery`); the grid covers the remainder. `battery_kw` is the
**only signed field**:

- `> 0` — discharging **into** the building (reduces the grid draw)
- `< 0` — charging **from** the grid (increases the grid draw)
- `= 0` — idle

Everything else is a non-negative magnitude. `grid_kw` itself may go negative
when on-site generation exceeds site load — the residence fixture exports at
−4.0 kW mid-afternoon, and both charts handle it.

Three more equalities the UI dereferences without checking:

- `forecast.points[h].flows.grid_kw === forecast.points[h].predicted_load_kw`
- `plan.impact[h].baseline_flows.grid_kw === plan.impact[h].baseline_kw`
- `plan.impact[h].optimized_flows.grid_kw === plan.impact[h].optimized_kw`

Break any of these and the flow diagram and the charts disagree on screen.

### Building identity: slug vs UUID

The API's `building_id` is the **slug** — `sea-office-001`, `sea-hospital-002`,
`sea-warehouse-003`, `sea-residence-004`. The database keys buildings by
`buildings.building_id UUID` instead, so the API layer owns the mapping:

- Accept **either** form wherever a `building_id` is taken (query parameter or
  request body). A caller holding a UUID must not be rejected.
- Always return the **slug** as `Building.id` and as
  `DashboardSummary.building_id`. The frontend persists the selected id in
  `localStorage` and compares it by string equality, so a response that echoes a
  UUID breaks the building selector.
- Keep the slug in the database — a `slug TEXT UNIQUE NOT NULL` column on
  `public.buildings` is the cheapest mapping and makes the seed data readable.

---

## Shared schemas

One block per type, copied from `frontend/src/types/api.ts`. The comments
explain semantics the type alone does not carry.

```ts
export type BuildingType = 'office' | 'hospital' | 'warehouse' | 'residence';
```

```ts
/** Static nameplate data for one site. Never changes during a session. */
export interface Building {
  id: string;
  name: string;
  type: BuildingType;
  address: string;
  floors: number;
  area_sqft: number;
  /** Demand threshold the facility is billed against. */
  peak_threshold_kw: number;
  battery_capacity_kwh: number;
  /** Inverter rating -- the most the battery can charge or discharge. */
  battery_max_kw: number;
  ev_bays: number;
  /** PV nameplate. Actual generation peaks below this. */
  solar_capacity_kw: number;
  hvac_zones: number;
}
```

```ts
export interface BuildingsResponse {
  buildings: Building[];
}
```

```ts
/**
 * Where one hour's energy comes from and goes to, for the flow diagram.
 * Only `battery_kw` is signed; see "The flows identity" above.
 */
export interface EnergyFlows {
  /** Net import from the utility. Equals the forecast/impact kW for this hour. */
  grid_kw: number;
  /** PV generation. 0 at night. */
  solar_kw: number;
  /** Signed: > 0 discharging into the building, < 0 charging from the grid. */
  battery_kw: number;
  /** EV charging draw across all occupied bays. */
  ev_kw: number;
  /** Cooling + ventilation draw. */
  hvac_kw: number;
  /** Everything else: lighting, plug loads, process equipment, elevators. */
  base_kw: number;
  /** State of charge at the end of this hour. */
  battery_soc_pct: number;
}
```

```ts
export interface DashboardSummary {
  building_id: string;
  building_type: BuildingType;
  building_name: string;
  /** ISO 8601 with timezone offset. "Now" for the whole dashboard. */
  timestamp: string;
  current_load_kw: number;
  predicted_peak_kw: number;
  /** ISO 8601 timestamp of the predicted peak interval. */
  predicted_peak_time: string;
  /** Demand threshold the facility is billed against. */
  peak_threshold_kw: number;
  battery_soc_pct: number;
  battery_capacity_kwh: number;
  battery_max_kw: number;
  electricity_price_per_kwh: number;
  solar_generation_kw: number;
  /** Number of EVs currently plugged in. */
  ev_connected: number;
  hvac_setpoint_f: number;
  outdoor_temp_f: number;
}
```

```ts
export interface ForecastPoint {
  /** ISO 8601, start of the hourly interval. */
  timestamp: string;
  predicted_load_kw: number;
  /** Metered value. Null for intervals that have not happened yet. */
  actual_load_kw: number | null;
  price_per_kwh: number;
  /** True when predicted_load_kw exceeds peak_threshold_kw. */
  is_peak: boolean;
  /** Breakdown of this hour. `flows.grid_kw === predicted_load_kw`. */
  flows: EnergyFlows;
}
```

```ts
export interface ForecastResponse {
  building_name: string;
  generated_at: string;
  peak_threshold_kw: number;
  points: ForecastPoint[];
}
```

```ts
export type RunStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'failed';
```

```ts
export type AgentEventType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'decision'
  | 'error'
  | 'complete';

/** The nine tools the agent is allowed to call. */
export type AgentToolName =
  | 'get_energy_forecast'
  | 'get_electricity_prices'
  | 'get_battery_state'
  | 'get_ev_requirements'
  | 'get_hvac_constraints'
  | 'run_schedule_optimizer'
  | 'validate_schedule'
  | 'save_action_plan'
  | 'request_human_approval';

export interface AgentEvent {
  id: string;
  run_id: string;
  /** Monotonic, 1-based ordering within a run. */
  seq: number;
  timestamp: string;
  type: AgentEventType;
  /** Null for 'thinking' / 'complete' / most 'error' events. */
  tool_name: AgentToolName | null;
  /** Human readable line for the activity log. */
  message: string;
  /** Structured data behind the message (tool args or tool output). */
  payload: Record<string, unknown> | null;
  /** Wall-clock cost of the step, when known. */
  duration_ms: number | null;
}
```

```ts
/** POST /api/gridshift/run */
export interface RunResponse {
  run_id: string;
  status: RunStatus;
  started_at: string;
}
```

```ts
/** GET /api/gridshift/{run_id}/events */
export interface EventsResponse {
  run_id: string;
  status: RunStatus;
  /** Every event emitted so far, ascending by seq. Cumulative, not a delta. */
  events: AgentEvent[];
  /** True once the agent has finished; the client then stops polling. */
  is_complete: boolean;
}
```

```ts
export type ActionType = 'battery_discharge' | 'ev_charging_shift' | 'hvac_setpoint';

export type ActionStatus = 'pending' | 'approved' | 'rejected' | 'executed';

export interface Action {
  id: string;
  run_id: string;
  type: ActionType;
  title: string;
  description: string;
  /** ISO 8601, inclusive start of the dispatch window. */
  start_time: string;
  /** ISO 8601, exclusive end of the dispatch window. */
  end_time: string;
  /** Size of the action, in `unit`. */
  magnitude: number;
  /** e.g. 'kW' or '°F'. */
  unit: string;
  /**
   * kW this action removes during the BASELINE peak interval. Per-action values
   * do not necessarily sum to ActionPlan.peak_reduction_kw, because the
   * optimized peak can be set by a different interval than the baseline peak.
   */
  estimated_peak_reduction_kw: number;
  estimated_savings_usd: number;
  status: ActionStatus;
  /** Constraint identifiers validate_schedule checked and passed. */
  constraints_checked: string[];
}
```

```ts
export interface ImpactPoint {
  timestamp: string;
  baseline_kw: number;
  optimized_kw: number;
  /** Do-nothing breakdown. `baseline_flows.grid_kw === baseline_kw`. */
  baseline_flows: EnergyFlows;
  /** Post-plan breakdown. `optimized_flows.grid_kw === optimized_kw`. */
  optimized_flows: EnergyFlows;
}
```

```ts
/** GET /api/gridshift/{run_id}/plan */
export interface ActionPlan {
  run_id: string;
  /** Typed as RunStatus; in practice 'awaiting_approval' | 'approved' | 'rejected'. */
  status: RunStatus;
  created_at: string;
  /** The agent's one-paragraph rationale, shown above the action list. */
  summary: string;
  baseline_peak_kw: number;
  optimized_peak_kw: number;
  peak_reduction_kw: number;
  baseline_cost_usd: number;
  optimized_cost_usd: number;
  savings_usd: number;
  actions: Action[];
  /** 24 hourly points, baseline vs optimized. */
  impact: ImpactPoint[];
}
```

```ts
/** POST /api/actions/{id}/approve | /reject */
export interface ActionDecisionResponse {
  action: Action;
  /** The whole plan after the decision, including the recomputed status. */
  plan: ActionPlan;
}
```

```ts
/** POST /api/demo/reset */
export interface ResetResponse {
  ok: boolean;
  message: string;
}
```

---

## `GET /api/buildings`

Every site this deployment knows about. Called once on page load to populate the
building selector; the app then opens on `sea-office-001`, or on whatever is in
`localStorage`.

**Request** — no parameters.

**Response `200`** — `BuildingsResponse`. Registry order is UI order, default
first.

```json
{
  "buildings": [
    {
      "id": "sea-office-001",
      "name": "Cascade Commerce Center",
      "type": "office",
      "address": "1200 4th Avenue, Seattle, WA 98101",
      "floors": 12,
      "area_sqft": 150000,
      "peak_threshold_kw": 450,
      "battery_capacity_kwh": 500,
      "battery_max_kw": 250,
      "ev_bays": 6,
      "solar_capacity_kw": 75,
      "hvac_zones": 18
    },
    {
      "id": "sea-hospital-002",
      "name": "Harborview Medical Annex",
      "type": "hospital",
      "address": "325 9th Avenue, Seattle, WA 98104",
      "floors": 6,
      "area_sqft": 210000,
      "peak_threshold_kw": 800,
      "battery_capacity_kwh": 800,
      "battery_max_kw": 400,
      "ev_bays": 4,
      "solar_capacity_kw": 90,
      "hvac_zones": 42
    },
    {
      "id": "sea-warehouse-003",
      "name": "Duwamish Logistics Hub",
      "type": "warehouse",
      "address": "4600 E Marginal Way S, Seattle, WA 98134",
      "floors": 1,
      "area_sqft": 320000,
      "peak_threshold_kw": 350,
      "battery_capacity_kwh": 1000,
      "battery_max_kw": 500,
      "ev_bays": 24,
      "solar_capacity_kw": 90,
      "hvac_zones": 6
    },
    {
      "id": "sea-residence-004",
      "name": "Alder Street Residence",
      "type": "residence",
      "address": "1418 E Alder Street, Seattle, WA 98122",
      "floors": 2,
      "area_sqft": 2400,
      "peak_threshold_kw": 9,
      "battery_capacity_kwh": 27,
      "battery_max_kw": 10,
      "ev_bays": 1,
      "solar_capacity_kw": 8.2,
      "hvac_zones": 2
    }
  ]
}
```

**Errors** — none expected. An empty deployment returns `{"buildings": []}`,
not `404`.

**Notes**

- Required top-level field: `buildings` (array). A response missing it is
  treated as "endpoint not implemented".
- `Building` is nameplate data: it must not change during a session and must not
  move with the clock. `peak_threshold_kw` here, in `DashboardSummary` and in
  `ForecastResponse` must all be the same number.
- `type` drives the building model in the 3D scene, so it must be one of the
  four `BuildingType` values.

---

## `GET /api/dashboard/summary`

Everything the KPI row shows, for one building, as of "now". This response also
defines "now" for the whole dashboard: the hour of `timestamp` becomes the time
cursor's starting position.

**Request**

| Parameter | In | Required | Example |
| --------- | -- | -------- | ------- |
| `building_id` | query | yes | `sea-office-001` |

```
GET /api/dashboard/summary?building_id=sea-office-001
```

**Response `200`** — `DashboardSummary`.

```json
{
  "building_id": "sea-office-001",
  "building_type": "office",
  "building_name": "Cascade Commerce Center",
  "timestamp": "2025-09-18T10:00:00-07:00",
  "current_load_kw": 396,
  "predicted_peak_kw": 522,
  "predicted_peak_time": "2025-09-18T15:00:00-07:00",
  "peak_threshold_kw": 450,
  "battery_soc_pct": 82,
  "battery_capacity_kwh": 500,
  "battery_max_kw": 250,
  "electricity_price_per_kwh": 0.09,
  "solar_generation_kw": 49.2,
  "ev_connected": 6,
  "hvac_setpoint_f": 72,
  "outdoor_temp_f": 71
}
```

**Errors**

| Status | When |
| ------ | ---- |
| `422` | `building_id` missing, malformed, or not a known building. |

**Notes**

- Required top-level fields: `building_id`, `current_load_kw`,
  `peak_threshold_kw`.
- `building_id` must echo the **slug**, even if the caller passed a UUID.
- `electricity_price_per_kwh` is the tariff rate for the *current* hour, not a
  daily average — $0.09/kWh at 10:00, $0.16/kWh inside the 14:00–20:00 on-peak
  window.
- `current_load_kw` must equal `predicted_load_kw` at the same hour in
  `GET /api/forecast`, and `predicted_peak_kw` / `predicted_peak_time` must be
  the maximum of that same forecast curve. The KPI tiles and the chart are read
  side by side.
- `battery_soc_pct` is a percentage (0–100), not a fraction.

---

## `GET /api/forecast`

The 24-hour demand curve the main chart draws: the day-ahead ML prediction,
metered actuals where they exist, the hourly tariff, and the energy-flow
breakdown behind every hour.

**Request**

| Parameter | In | Required | Example |
| --------- | -- | -------- | ------- |
| `building_id` | query | yes | `sea-office-001` |

```
GET /api/forecast?building_id=sea-office-001
```

**Response `200`** — `ForecastResponse`. `points` holds **24 entries**, hour 00
through hour 23 of the local day, in ascending time order. Three are shown here:
midnight, "now" (10:00), and the 15:00 peak.

```json
{
  "building_name": "Cascade Commerce Center",
  "generated_at": "2025-09-18T10:00:00-07:00",
  "peak_threshold_kw": 450,
  "points": [
    {
      "timestamp": "2025-09-18T00:00:00-07:00",
      "predicted_load_kw": 182,
      "actual_load_kw": 179.4,
      "price_per_kwh": 0.09,
      "is_peak": false,
      "flows": {
        "grid_kw": 182,
        "solar_kw": 0,
        "battery_kw": 0,
        "ev_kw": 0,
        "hvac_kw": 27.3,
        "base_kw": 154.7,
        "battery_soc_pct": 82
      }
    },
    {
      "timestamp": "2025-09-18T10:00:00-07:00",
      "predicted_load_kw": 396,
      "actual_load_kw": null,
      "price_per_kwh": 0.09,
      "is_peak": false,
      "flows": {
        "grid_kw": 396,
        "solar_kw": 49.2,
        "battery_kw": 0,
        "ev_kw": 69,
        "hvac_kw": 124.3,
        "base_kw": 251.9,
        "battery_soc_pct": 82
      }
    },
    {
      "timestamp": "2025-09-18T15:00:00-07:00",
      "predicted_load_kw": 522,
      "actual_load_kw": null,
      "price_per_kwh": 0.16,
      "is_peak": true,
      "flows": {
        "grid_kw": 522,
        "solar_kw": 40.7,
        "battery_kw": 0,
        "ev_kw": 69,
        "hvac_kw": 180.6,
        "base_kw": 313.1,
        "battery_soc_pct": 82
      }
    }
  ]
}
```

**Errors**

| Status | When |
| ------ | ---- |
| `422` | `building_id` missing, malformed, or not a known building. |

**Notes**

- Required top-level field: `points` (array).
- Exactly 24 points. The chart, the time cursor (0–23) and the flow diagram all
  index by hour; a short array leaves gaps on screen.
- `actual_load_kw` is `null` for every interval at or after "now" — hours 10–23
  in this example. Do not send `0`, and do not omit the key.
- `is_peak` is `predicted_load_kw > peak_threshold_kw`, strictly greater. The
  office is over threshold for four hours, 13:00–17:00.
- `flows.grid_kw` must equal `predicted_load_kw` exactly, and every `flows`
  object must satisfy the identity above.
- `flows` here is the **baseline** breakdown — what happens with no plan. For
  this building the baseline battery is idle all day (`battery_kw: 0`,
  `battery_soc_pct: 82`).
- There is no `building_id` in this response, only `building_name`. The client
  already knows which building it asked about.

---

## `POST /api/gridshift/run`

Starts an agent run for one building. **Returns immediately** — it must not
block while the agent thinks. The run executes in the background and its
progress is read through `/events`.

**Request**

```
POST /api/gridshift/run
Content-Type: application/json
```

```json
{ "building_id": "sea-office-001" }
```

**Response `200`** — `RunResponse`.

```json
{
  "run_id": "run-9f2c1a",
  "status": "running",
  "started_at": "2025-09-18T10:00:00-07:00"
}
```

**Errors**

| Status | When |
| ------ | ---- |
| `422` | `building_id` missing, malformed, or not a known building. |
| `500` | The run could not be scheduled at all. The UI shows `failed`. |

**Notes**

- Required top-level field: `run_id`.
- Must return in well under 8 s. Enqueue the agent (FastAPI `BackgroundTasks`,
  or an `asyncio.create_task`) and answer with `status: "running"` before the
  first tool call happens.
- `run_id` is opaque to the client but must be URL-safe: it is interpolated into
  `/api/gridshift/{run_id}/events`. Avoid slashes.
- A new run **supersedes** the building's previous run. At most one run per
  building is addressable at a time; the old run's id may stop resolving.
- Runs are per-building. Starting a run on `sea-office-001` must not disturb a
  run in flight on `sea-hospital-002`.
- A failure *inside* the agent is not reported here — it is reported as an
  `error` event plus `status: "failed"` on `/events`.

---

## `GET /api/gridshift/{run_id}/events`

The agent's activity log, polled every 1 000 ms while a run is in flight. No
`building_id`: the run id already identifies the building.

**Request** — path parameter `run_id`; no query parameters, no body.

```
GET /api/gridshift/run-9f2c1a/events
```

**Response `200`** — `EventsResponse`. This is a **mid-run** response: four
events have been emitted and the run is not finished. The complete office run
emits **14 events** over about 16.8 s.

```json
{
  "run_id": "run-9f2c1a",
  "status": "running",
  "is_complete": false,
  "events": [
    {
      "id": "run-9f2c1a-evt-01",
      "run_id": "run-9f2c1a",
      "seq": 1,
      "timestamp": "2025-09-18T10:00:00.000-07:00",
      "type": "thinking",
      "tool_name": null,
      "message": "Run started. Today's forecast tripped the peak-risk flag, so before recommending anything I need to confirm the peak is real and find out which loads are actually flexible.",
      "payload": null,
      "duration_ms": 900
    },
    {
      "id": "run-9f2c1a-evt-02",
      "run_id": "run-9f2c1a",
      "seq": 2,
      "timestamp": "2025-09-18T10:00:01.200-07:00",
      "type": "tool_call",
      "tool_name": "get_energy_forecast",
      "message": "get_energy_forecast(building_id=\"sea-office-001\", horizon_hours=24)",
      "payload": { "building_id": "sea-office-001", "horizon_hours": 24 },
      "duration_ms": null
    },
    {
      "id": "run-9f2c1a-evt-03",
      "run_id": "run-9f2c1a",
      "seq": 3,
      "timestamp": "2025-09-18T10:00:02.400-07:00",
      "type": "tool_result",
      "tool_name": "get_energy_forecast",
      "message": "Peak confirmed: 522 kW at 15:00, 72 kW over the 450 kW threshold. The building stays above threshold for four consecutive hours, 13:00 through 17:00.",
      "payload": {
        "peak_kw": 522,
        "peak_time": "2025-09-18T15:00:00-07:00",
        "threshold_kw": 450,
        "hours_over_threshold": 4,
        "first_exceedance": "2025-09-18T13:00:00-07:00"
      },
      "duration_ms": 840
    },
    {
      "id": "run-9f2c1a-evt-12",
      "run_id": "run-9f2c1a",
      "seq": 12,
      "timestamp": "2025-09-18T10:00:14.400-07:00",
      "type": "decision",
      "tool_name": "save_action_plan",
      "message": "Committing a three-action plan: discharge the battery at 90 kW from 14:00 to 17:00, move four EV sessions to the evening, and pre-cool then let the setpoint float 3°F during the peak.",
      "payload": { "action_count": 3, "plan_savings_usd": 22.22 },
      "duration_ms": 150
    }
  ]
}
```

The final poll of a healthy run returns all 14 events, with the envelope reading:

```json
{ "run_id": "run-9f2c1a", "status": "awaiting_approval", "is_complete": true }
```

**Errors**

| Status | When |
| ------ | ---- |
| `404` | Unknown `run_id`, including a run superseded by a newer one. |

**Notes**

- Required top-level fields: `events` (array), `is_complete` (boolean).
- **Cumulative, not a delta.** Every poll returns every event emitted so far.
  The client replaces its list wholesale; it does not append.
- **Append-only and ordered by `seq`.** `seq` is 1-based and monotonic within a
  run. An event that has been served must never change, disappear or be
  reordered — the activity log is rendered straight from this array.
- `id` must be unique across runs; `"{run_id}-evt-{seq:02d}"` is a fine scheme.
- `status` is `running` until the run finishes, then `awaiting_approval` once a
  plan exists (or the plan's current status if decisions have already been
  made), or `failed` if the agent errored.
- `is_complete: true` is the single signal that stops the poll loop and triggers
  the one `/plan` fetch. Do not set it before the plan is durably saved — the
  `/plan` call follows within milliseconds.
- On failure: emit an `error` event (`tool_name: null`, `message` explaining what
  broke), set `status: "failed"` and `is_complete: true` so the client stops
  polling. The client surfaces the message and does not fetch a plan.
- `payload` is free-form JSON or `null`; the UI renders it as collapsed detail
  under `message`. `duration_ms` is `null` when not measured — typically on
  `tool_call`, which is stamped before the tool runs.
- Keep this handler cheap: a 4 s timeout applies and it is hit once per second.

---

## `GET /api/gridshift/{run_id}/plan`

The optimized action plan produced by the run. Fetched **once**, immediately
after `/events` first reports `is_complete: true`.

**Request** — path parameter `run_id`; no query parameters, no body.

```
GET /api/gridshift/run-9f2c1a/plan
```

**Response `200`** — `ActionPlan`. `impact` holds **24 hourly points**; three
are shown here — 10:00, the 15:00 baseline peak, and the 18:00 interval that
becomes the new optimized peak.

```json
{
  "run_id": "run-9f2c1a",
  "status": "awaiting_approval",
  "created_at": "2025-09-18T10:00:00-07:00",
  "summary": "Today's forecast peaks at 522 kW at 15:00, 72 kW above the 450 kW threshold, and stays over it for four hours. No single resource covers that gap, so the plan stacks three: the battery carries 90 kW through the 14:00-17:00 core, four of the six EV sessions move to the evening where they have deadline slack, and an 11:00-13:00 pre-cool lets the HVAC setpoint float to 75°F during the worst two hours without leaving the comfort band. Together they cut the billing peak from 522 kW to 438 kW. Day-ahead energy cost falls only $22.22 once the overnight battery recharge is paid back -- the real prize is the demand charge, where an 84 kW lower peak avoids about $714.00 on this month's bill at $8.50/kW. The HVAC action is the only one occupants can feel, which is why this plan is routed for approval rather than dispatched.",
  "baseline_peak_kw": 522,
  "optimized_peak_kw": 438,
  "peak_reduction_kw": 84,
  "baseline_cost_usd": 869.59,
  "optimized_cost_usd": 847.37,
  "savings_usd": 22.22,
  "actions": [
    {
      "id": "act-battery-01",
      "run_id": "run-9f2c1a",
      "type": "battery_discharge",
      "title": "Discharge battery at 90 kW, 14:00-17:00",
      "description": "Dispatch 270 kWh from the 500 kWh pack across the three core peak hours, taking SOC from 82% to 28% and staying clear of the 20% reserve floor. Recharges overnight at the $0.09/kWh off-peak rate.",
      "start_time": "2025-09-18T14:00:00-07:00",
      "end_time": "2025-09-18T17:00:00-07:00",
      "magnitude": 90,
      "unit": "kW",
      "estimated_peak_reduction_kw": 90,
      "estimated_savings_usd": 18.9,
      "status": "pending",
      "constraints_checked": [
        "soc_reserve_floor_20pct",
        "max_discharge_250kw",
        "single_cycle_per_day",
        "recharge_window_available_overnight"
      ]
    },
    {
      "id": "act-ev-02",
      "run_id": "run-9f2c1a",
      "type": "ev_charging_shift",
      "title": "Shift 4 of 6 EV sessions to 18:00-20:00",
      "description": "Move 92 kWh of fleet-van charging (4 sessions at 11.5 kW) out of the 14:00-16:00 window. Those vans only need 80% by 22:00, while the two staff vehicles departing at 18:00 keep their current schedule. Energy cost is unchanged because both windows are on-peak -- this action exists purely to take load out of the peak-setting interval.",
      "start_time": "2025-09-18T18:00:00-07:00",
      "end_time": "2025-09-18T20:00:00-07:00",
      "magnitude": 46,
      "unit": "kW",
      "estimated_peak_reduction_kw": 46,
      "estimated_savings_usd": 0,
      "status": "pending",
      "constraints_checked": [
        "ev_target_soc_80pct_met",
        "deadline_1800_respected_for_2_departing",
        "deadline_2200_respected_for_4_fleet",
        "site_charger_limit_69kw"
      ]
    },
    {
      "id": "act-hvac-03",
      "run_id": "run-9f2c1a",
      "type": "hvac_setpoint",
      "title": "Pre-cool 11:00-13:00, then float setpoint +3°F",
      "description": "Drop to 70°F from 11:00 to 13:00 to bank thermal mass, then let the setpoint rise from 72°F to 75°F for the 14:00-16:00 peak. Drift is capped at the permitted two hours and stays inside the 68-75°F occupied comfort band.",
      "start_time": "2025-09-18T14:00:00-07:00",
      "end_time": "2025-09-18T16:00:00-07:00",
      "magnitude": 3,
      "unit": "°F",
      "estimated_peak_reduction_kw": 18,
      "estimated_savings_usd": 3.32,
      "status": "pending",
      "constraints_checked": [
        "zone_temp_max_75f",
        "max_drift_duration_2h",
        "occupied_comfort_band_68_75f",
        "precool_min_setpoint_70f"
      ]
    }
  ],
  "impact": [
    {
      "timestamp": "2025-09-18T10:00:00-07:00",
      "baseline_kw": 396,
      "optimized_kw": 396,
      "baseline_flows": {
        "grid_kw": 396,
        "solar_kw": 49.2,
        "battery_kw": 0,
        "ev_kw": 69,
        "hvac_kw": 124.3,
        "base_kw": 251.9,
        "battery_soc_pct": 82
      },
      "optimized_flows": {
        "grid_kw": 396,
        "solar_kw": 49.2,
        "battery_kw": 0,
        "ev_kw": 69,
        "hvac_kw": 124.3,
        "base_kw": 251.9,
        "battery_soc_pct": 82
      }
    },
    {
      "timestamp": "2025-09-18T15:00:00-07:00",
      "baseline_kw": 522,
      "optimized_kw": 368,
      "baseline_flows": {
        "grid_kw": 522,
        "solar_kw": 40.7,
        "battery_kw": 0,
        "ev_kw": 69,
        "hvac_kw": 180.6,
        "base_kw": 313.1,
        "battery_soc_pct": 82
      },
      "optimized_flows": {
        "grid_kw": 368,
        "solar_kw": 40.7,
        "battery_kw": 90,
        "ev_kw": 23,
        "hvac_kw": 162.6,
        "base_kw": 313.1,
        "battery_soc_pct": 46
      }
    },
    {
      "timestamp": "2025-09-18T18:00:00-07:00",
      "baseline_kw": 392,
      "optimized_kw": 438,
      "baseline_flows": {
        "grid_kw": 392,
        "solar_kw": 4.6,
        "battery_kw": 0,
        "ev_kw": 0,
        "hvac_kw": 128.9,
        "base_kw": 267.7,
        "battery_soc_pct": 82
      },
      "optimized_flows": {
        "grid_kw": 438,
        "solar_kw": 4.6,
        "battery_kw": 0,
        "ev_kw": 46,
        "hvac_kw": 128.9,
        "base_kw": 267.7,
        "battery_soc_pct": 28
      }
    }
  ]
}
```

**Errors**

| Status | When |
| ------ | ---- |
| `404` | The run exists but has not finished. `detail`: "Plan is not ready yet. The agent run is still in progress." |
| `404` | Unknown `run_id`. |

**Notes**

- Required top-level fields: `actions` (array), `impact` (array).
- **The `404`-before-complete case is part of the contract**, not an error. The
  client never falls back on this endpoint precisely so that meaning survives.
  In practice the client only calls it after `is_complete: true`, so a `404`
  here in normal operation means the plan was not saved before the run was
  marked complete.
- `impact` holds exactly 24 hourly points, aligned one-for-one with the forecast
  timestamps. `baseline_kw` must equal the forecast's `predicted_load_kw` at the
  same hour.
- The optimized peak is **not** necessarily at the baseline peak hour. Here the
  baseline peaks at 522 kW at 15:00 but the optimized curve peaks at 438 kW at
  18:00, set by the shifted EV load. That is why the per-action
  `estimated_peak_reduction_kw` values (90 + 46 + 18 = 154) do not sum to
  `peak_reduction_kw` (84).
- `peak_reduction_kw = baseline_peak_kw - optimized_peak_kw` and
  `savings_usd = baseline_cost_usd - optimized_cost_usd`. Costs are day-ahead
  energy cost over the 24 hours, and `optimized_cost_usd` includes recharging
  the battery overnight at the off-peak rate — which is why cutting 84 kW of
  peak yields only $22.22 of energy savings. The demand-charge prize
  (84 kW × $8.50/kW ≈ $714/month) is narrated in `summary`, not a field.
- `status` on a fresh plan is `awaiting_approval`. Plan transitions:
  `awaiting_approval → approved | rejected`, driven entirely by the per-action
  decisions below.
- Every action starts `pending`. Action transitions:
  `pending → approved | rejected → executed`. Nothing reaches hardware until an
  action is `approved`; `executed` is set by the backend after dispatch.
- The plan must be stable. Repeated GETs on the same completed run return the
  same plan, with only `Action.status` and `ActionPlan.status` changing as
  decisions land.

---

## `POST /api/actions/{id}/approve`

Approve one action. No `building_id` and no `run_id` — the action id identifies
both.

**Request** — path parameter `id`; **no body**. The client still sends
`Content-Type: application/json`.

```
POST /api/actions/act-battery-01/approve
```

**Response `200`** — `ActionDecisionResponse`: the decided action, plus the whole
plan recomputed. The `plan.impact` array is the same 24 points returned by
`GET /plan`; one is shown here to keep the example readable.

```json
{
  "action": {
    "id": "act-battery-01",
    "run_id": "run-9f2c1a",
    "type": "battery_discharge",
    "title": "Discharge battery at 90 kW, 14:00-17:00",
    "description": "Dispatch 270 kWh from the 500 kWh pack across the three core peak hours, taking SOC from 82% to 28% and staying clear of the 20% reserve floor. Recharges overnight at the $0.09/kWh off-peak rate.",
    "start_time": "2025-09-18T14:00:00-07:00",
    "end_time": "2025-09-18T17:00:00-07:00",
    "magnitude": 90,
    "unit": "kW",
    "estimated_peak_reduction_kw": 90,
    "estimated_savings_usd": 18.9,
    "status": "approved",
    "constraints_checked": [
      "soc_reserve_floor_20pct",
      "max_discharge_250kw",
      "single_cycle_per_day",
      "recharge_window_available_overnight"
    ]
  },
  "plan": {
    "run_id": "run-9f2c1a",
    "status": "awaiting_approval",
    "created_at": "2025-09-18T10:00:00-07:00",
    "summary": "Today's forecast peaks at 522 kW at 15:00, 72 kW above the 450 kW threshold, and stays over it for four hours. ...",
    "baseline_peak_kw": 522,
    "optimized_peak_kw": 438,
    "peak_reduction_kw": 84,
    "baseline_cost_usd": 869.59,
    "optimized_cost_usd": 847.37,
    "savings_usd": 22.22,
    "actions": [
      {
        "id": "act-battery-01",
        "run_id": "run-9f2c1a",
        "type": "battery_discharge",
        "title": "Discharge battery at 90 kW, 14:00-17:00",
        "description": "Dispatch 270 kWh from the 500 kWh pack across the three core peak hours, taking SOC from 82% to 28% and staying clear of the 20% reserve floor. Recharges overnight at the $0.09/kWh off-peak rate.",
        "start_time": "2025-09-18T14:00:00-07:00",
        "end_time": "2025-09-18T17:00:00-07:00",
        "magnitude": 90,
        "unit": "kW",
        "estimated_peak_reduction_kw": 90,
        "estimated_savings_usd": 18.9,
        "status": "approved",
        "constraints_checked": [
          "soc_reserve_floor_20pct",
          "max_discharge_250kw",
          "single_cycle_per_day",
          "recharge_window_available_overnight"
        ]
      },
      {
        "id": "act-ev-02",
        "run_id": "run-9f2c1a",
        "type": "ev_charging_shift",
        "title": "Shift 4 of 6 EV sessions to 18:00-20:00",
        "description": "Move 92 kWh of fleet-van charging (4 sessions at 11.5 kW) out of the 14:00-16:00 window. ...",
        "start_time": "2025-09-18T18:00:00-07:00",
        "end_time": "2025-09-18T20:00:00-07:00",
        "magnitude": 46,
        "unit": "kW",
        "estimated_peak_reduction_kw": 46,
        "estimated_savings_usd": 0,
        "status": "pending",
        "constraints_checked": [
          "ev_target_soc_80pct_met",
          "deadline_1800_respected_for_2_departing",
          "deadline_2200_respected_for_4_fleet",
          "site_charger_limit_69kw"
        ]
      },
      {
        "id": "act-hvac-03",
        "run_id": "run-9f2c1a",
        "type": "hvac_setpoint",
        "title": "Pre-cool 11:00-13:00, then float setpoint +3°F",
        "description": "Drop to 70°F from 11:00 to 13:00 to bank thermal mass, then let the setpoint rise from 72°F to 75°F for the 14:00-16:00 peak. ...",
        "start_time": "2025-09-18T14:00:00-07:00",
        "end_time": "2025-09-18T16:00:00-07:00",
        "magnitude": 3,
        "unit": "°F",
        "estimated_peak_reduction_kw": 18,
        "estimated_savings_usd": 3.32,
        "status": "pending",
        "constraints_checked": [
          "zone_temp_max_75f",
          "max_drift_duration_2h",
          "occupied_comfort_band_68_75f",
          "precool_min_setpoint_70f"
        ]
      }
    ],
    "impact": [
      {
        "timestamp": "2025-09-18T15:00:00-07:00",
        "baseline_kw": 522,
        "optimized_kw": 368,
        "baseline_flows": {
          "grid_kw": 522,
          "solar_kw": 40.7,
          "battery_kw": 0,
          "ev_kw": 69,
          "hvac_kw": 180.6,
          "base_kw": 313.1,
          "battery_soc_pct": 82
        },
        "optimized_flows": {
          "grid_kw": 368,
          "solar_kw": 40.7,
          "battery_kw": 90,
          "ev_kw": 23,
          "hvac_kw": 162.6,
          "base_kw": 313.1,
          "battery_soc_pct": 46
        }
      }
    ]
  }
}
```

**Errors**

| Status | When |
| ------ | ---- |
| `409` | The action is not `pending`. `detail`: "Action act-battery-01 was already approved." (or `rejected`, or `executed`). |
| `404` | Unknown action id, or no plan owns it. |

**Notes**

- Required top-level fields: `action` (object), `plan` (object).
- The response must carry the **full** plan, not a patch. The client replaces
  its plan state with `plan` and its run status with `plan.status`.
- Plan status is derived from the actions, not stored independently:
  - any action still `pending` → `awaiting_approval`
  - all decided, at least one `approved` → `approved`
  - all decided, none approved → `rejected`
- Actions are decided one at a time. A three-action plan needs three calls, and
  the plan stays `awaiting_approval` until the last one lands — as in the
  example above, where one action is approved and two are still pending.
- `409` on a repeat decision is what makes the buttons idempotent in practice:
  the second click changes nothing and the user is told why.
- Do not dispatch to hardware inside this handler. Approval records intent; a
  separate dispatcher moves the action to `executed`.

---

## `POST /api/actions/{id}/reject`

Reject one action. Identical in shape to `/approve`.

**Request** — path parameter `id`; no body.

```
POST /api/actions/act-hvac-03/reject
```

**Response `200`** — `ActionDecisionResponse`, exactly as above, with
`action.status: "rejected"`. When the other two actions have already been
approved, the plan settles at `approved`:

```json
{
  "action": {
    "id": "act-hvac-03",
    "run_id": "run-9f2c1a",
    "type": "hvac_setpoint",
    "title": "Pre-cool 11:00-13:00, then float setpoint +3°F",
    "description": "Drop to 70°F from 11:00 to 13:00 to bank thermal mass, then let the setpoint rise from 72°F to 75°F for the 14:00-16:00 peak. ...",
    "start_time": "2025-09-18T14:00:00-07:00",
    "end_time": "2025-09-18T16:00:00-07:00",
    "magnitude": 3,
    "unit": "°F",
    "estimated_peak_reduction_kw": 18,
    "estimated_savings_usd": 3.32,
    "status": "rejected",
    "constraints_checked": [
      "zone_temp_max_75f",
      "max_drift_duration_2h",
      "occupied_comfort_band_68_75f",
      "precool_min_setpoint_70f"
    ]
  },
  "plan": {
    "run_id": "run-9f2c1a",
    "status": "approved",
    "created_at": "2025-09-18T10:00:00-07:00",
    "summary": "Today's forecast peaks at 522 kW at 15:00, 72 kW above the 450 kW threshold, ...",
    "baseline_peak_kw": 522,
    "optimized_peak_kw": 438,
    "peak_reduction_kw": 84,
    "baseline_cost_usd": 869.59,
    "optimized_cost_usd": 847.37,
    "savings_usd": 22.22,
    "actions": [],
    "impact": []
  }
}
```

> `actions` and `impact` are shown empty **only** to keep this second example
> short. A real response always carries all three actions and all 24 impact
> points, exactly as in `/approve` above.

**Errors**

| Status | When |
| ------ | ---- |
| `409` | The action is not `pending`. `detail`: "Action act-hvac-03 was already rejected." |
| `404` | Unknown action id, or no plan owns it. |

**Notes**

- Rejecting one action does **not** reject the plan. With one rejection and two
  approvals the plan is `approved`, and the two approved actions still run.
- The plan only becomes `rejected` when **every** action has been rejected.
- `baseline_*`, `optimized_*`, `peak_reduction_kw` and `savings_usd` describe the
  plan **as optimized** and are not recomputed after a partial rejection. They
  are what the optimizer found, not what was approved.

---

## `POST /api/demo/reset`

Returns one building to its pre-run state: clears its run, its events and its
plan, and restores the forecast. Used by the "Reset demo" control between
walkthroughs.

**Request**

```
POST /api/demo/reset
Content-Type: application/json
```

```json
{ "building_id": "sea-office-001" }
```

**Response `200`** — `ResetResponse`.

```json
{
  "ok": true,
  "message": "Demo reset for Cascade Commerce Center. Forecast and building state restored; no run in progress."
}
```

**Errors**

| Status | When |
| ------ | ---- |
| `422` | `building_id` missing, malformed, or not a known building. |

**Notes**

- Required top-level field: `ok` (boolean).
- **Scoped to one building.** A run in flight on another building must survive
  untouched — the building selector depends on this.
- `message` is shown to the user; name the building in it.
- Resetting a building with no run is not an error; return `ok: true`.
- After a reset, that building's old `run_id` and action ids may stop resolving
  (`404`). The client has already dropped them.

---

## Backend implementation notes

**Return first, work later.** `POST /api/gridshift/run` inserts a run row with
`status = 'running'`, schedules the agent (FastAPI `BackgroundTasks` or
`asyncio.create_task`) and returns. The agent writes events as it goes, and the
client discovers them through the 1 s poll. Nothing about the run is delivered
synchronously, and no endpoint in this contract may block for more than a few
hundred milliseconds — `/events` and `/plan` are abandoned by the client after
4 s.

**Wrap every tool call in two events.** Write a `tool_call` event *before*
invoking a tool, with the arguments in `payload`, and a `tool_result` event
*after* it returns, with the tool's output in `payload` and the measured
`duration_ms`. `thinking` events carry the agent's reasoning between tools;
`decision` marks `save_action_plan`; `complete` is the last event of a healthy
run, `error` the last event of a failed one. The 14-event office script in the
fixtures is a condensed dramatisation — it omits some of the `tool_call` halves
to keep the demo log readable. The backend should emit both halves; the frontend
renders whatever it is given and does not require pairing.

**The agent must not compute numbers.** Every kW, kWh and dollar figure in a
plan comes from the optimizer, and every constraint verdict comes from
`validate_schedule`. The agent chooses which tools to call, in what order and
with what arguments, and writes the prose — `message`, `Action.title`,
`Action.description`, `ActionPlan.summary`. It never does arithmetic. A number
in a `tool_result` `payload` must be the tool's own output, and a number in a
`message` must be quoting a payload some tool already returned. This is what
keeps the narrated log and the charts from disagreeing.

**Flows come from the optimizer, not the forecaster.** The forecaster produces a
single `predicted_load_kw` series. The per-hour decomposition into
`base_kw` / `ev_kw` / `hvac_kw` / `solar_kw` / `battery_kw` is the optimizer's
model of the site, and the optimizer is the only component that can produce the
*optimized* side of `ImpactPoint`. Compute both `baseline_flows` and
`optimized_flows` there, in one place, and assert the identity before returning
— the fixtures do exactly that in `validateFixtures()` and hold the worst
residual to float noise.

**Slug vs UUID.** `public.buildings` keys on `building_id UUID`, but the API's
`building_id` is the slug. Accept either on input, always emit the slug, and add
`slug TEXT UNIQUE NOT NULL` to `public.buildings` rather than mapping in
application code.

**Schema additions needed.** The ingestion schema
(`data/scripts/db/schema.sql`) covers buildings, readings, weather, tariffs and
model forecasts. It does not yet cover anything this contract returns beyond the
forecast curve. Still needed:

- On `public.buildings`: the nameplate/asset fields `Building` exposes — `slug`,
  `address`, `floors`, `area_sqft`, `peak_threshold_kw`,
  `battery_capacity_kwh`, `battery_max_kw`, `ev_bays`, `solar_capacity_kw`,
  `hvac_zones`. (`building_type` already exists but is nullable and
  unconstrained; the API needs one of the four `BuildingType` values.)
- `agent_runs` — `run_id`, `building_id`, `status`, `started_at`,
  `completed_at`. One addressable run per building.
- `agent_events` — `event_id`, `run_id`, `seq`, `timestamp`, `type`,
  `tool_name`, `message`, `payload JSONB`, `duration_ms`, unique on
  `(run_id, seq)`. Append-only; rows are never updated.
- `action_plans` — `run_id`, `status`, `created_at`, `summary`, the six
  baseline/optimized/savings figures, and the 24 impact points (a JSONB column
  is fine, or a child `plan_impact` table keyed by `(run_id, timestamp)`).
- `actions` — `action_id`, `run_id`, `type`, `title`, `description`,
  `start_time`, `end_time`, `magnitude`, `unit`,
  `estimated_peak_reduction_kw`, `estimated_savings_usd`, `status`,
  `constraints_checked TEXT[]`.

Store all timestamps as `TIMESTAMPTZ` and render them in `buildings.timezone`
(already on the table, defaulting to `America/Los_Angeles`) on the way out.

**Reference implementation.** A runnable FastAPI implementation of this contract
is being written in parallel at [`backend/reference/`](../backend/reference).
Where a detail here is ambiguous, that code is the tiebreaker after
`frontend/src/types/api.ts`.

---

## Frontend integration modes

`NEXT_PUBLIC_USE_MOCK` picks one of three behaviours, parsed once in
`frontend/src/lib/apiMode.ts`:

| Value | Mode | Behaviour |
| ----- | ---- | --------- |
| `true` (default) | `mock` | Every call is served from `frontend/src/mocks/`. No backend needed. |
| `false` | `real` | Every call is a `fetch`. Any failure is visible. |
| `partial` | `partial` | Try the backend; fall back to the mock **per endpoint** when it is plainly not there. |

`partial` is the integration mode. Each endpoint that is missing logs **once**
per page load — `[api] /api/forecast not available, using mock` — and
`endpointStatus` holds the same information as data
(`'live' | 'fallback' | 'unknown'` per endpoint). When the console is quiet,
every endpoint is live and you can flip to `false`.

Two rules in `partial` mode shape the bring-up order:

- A **run** cannot be mixed. If `POST /api/gridshift/run` falls back, the run id
  comes back `mock-` prefixed and that run's `/events`, `/plan`, `/approve` and
  `/reject` all go to the mock. If the run started on the backend, every later
  call for it stays on the backend and **never** falls back, because the mock
  has never heard of that run id. So a backend that serves `/run` but not
  `/events` surfaces an error instead of splicing in a fixture run.
- `/plan` never falls back at all, so its `404` keeps its contract meaning.

**Recommended bring-up order**

1. `GET /api/buildings` — no dependencies; proves CORS, the base URL and the
   slug mapping in one call.
2. `GET /api/dashboard/summary` — the KPI row lights up.
3. `GET /api/forecast` — the main chart lights up. Check the flows identity, and
   that `predicted_load_kw` at "now" matches `current_load_kw` from step 2.
4. `POST /api/gridshift/run`, `GET .../events`, `GET .../plan`,
   `POST /api/actions/{id}/approve`, `POST /api/actions/{id}/reject` — **as one
   group**, for the reason above. Do not ship `/run` before `/events` and
   `/plan` work.
5. `POST /api/demo/reset` — last; it is the only endpoint that is useful only
   once everything else is live.

---

_Changelog — 2026-09-19: first authoritative version, derived from
`frontend/src/types/api.ts`, `frontend/src/lib/api.ts` and
`frontend/src/mocks/`. Supersedes placeholder._
