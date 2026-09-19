# GridShift backend — reference implementation

A complete, runnable implementation of the API contract the dashboard already
expects, meant to be **read and adapted**, not deployed. It serves the nine
endpoints in `frontend/src/lib/api.ts` against four demo buildings, runs a
Gemini function-calling agent whose every tool call lands in the event stream,
and works with no API key at all.

Nothing here touches `backend/app/` — that is the skeleton this gets folded
into. See [Adapting into `backend/app`](#adapting-into-backendapp).

```
backend/reference/
├── README.md
├── pyproject.toml              project metadata + pytest config
├── requirements.txt            fastapi, uvicorn, pydantic, dotenv, google-genai, pytest, httpx
├── .env.example                copy to .env; every value has a working default
├── app/
│   ├── main.py                 FastAPI app, CORS from env, /health, router
│   ├── config.py               the one place the environment is read
│   ├── schemas.py              Pydantic models mirroring frontend/src/types/api.ts
│   ├── store.py                runs / events / plans / actions, in SQLite
│   ├── api/
│   │   └── routes.py           the nine endpoints; no business logic
│   ├── fixtures/
│   │   ├── generator.py        deterministic curve kit + the flow identity
│   │   ├── spec.py             BuildingFixture, DispatchPolicy, Step
│   │   ├── office.py           sea-office-001    Cascade Commerce Center
│   │   ├── hospital.py         sea-hospital-002  Harborview Medical Annex
│   │   ├── warehouse.py        sea-warehouse-003 Duwamish Logistics Hub
│   │   ├── residence.py        sea-residence-004 Alder Street Residence
│   │   └── __init__.py         registry, slug/UUID resolution, assert_flows_identity
│   └── services/
│       ├── forecast.py         fixtures | ml, and the flow synthesis both share
│       ├── optimizer.py        the deterministic heuristic + the OR-Tools seam
│       ├── tools.py            the nine agent tools, as plain functions
│       └── agent.py            the run loop: fake and gemini
└── tests/
    ├── conftest.py             TestClient + poll_until_complete
    ├── test_contract.py        endpoint shapes, all four buildings
    ├── test_flows.py           the flow identity, published numbers, optimizer
    └── test_run_flow.py        run → events → plan → approve → reject → 409 → reset
```

---

## Run it

```bash
cd backend/reference
python -m venv .venv
source .venv/Scripts/activate        # Windows bash; .venv\Scripts\activate on cmd/PowerShell
                                     # source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
cp .env.example .env                 # optional: every default already works

uvicorn app.main:app --reload --port 8000
```

`GET http://localhost:8000/health` reports the configuration actually in force.
`http://localhost:8000/docs` is the generated OpenAPI page.

```bash
pytest                               # 54 tests, about 1 second
```

`.venv/` is already covered by the repo's `.gitignore`.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `GRIDSHIFT_AGENT` | `fake` | `fake` replays the scripted run; `gemini` calls the model. `gemini` with no key logs a warning and degrades to `fake`. |
| `GEMINI_API_KEY` | *(empty)* | Google AI Studio key. Read only by `app/services/agent.py`; it never leaves the backend. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model id for `GRIDSHIFT_AGENT=gemini`. |
| `GRIDSHIFT_FORECAST` | `fixtures` | `fixtures` serves the ported demo curves; `ml` calls the `ml` package and falls back to fixtures with a logged warning. |
| `GRIDSHIFT_ML_MODEL_PATH` | `ml/artifacts/load_forecaster.joblib` | Trained bundle. Relative paths resolve from the repo root. |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated browser origins allowed to call the API. |
| `GRIDSHIFT_AGENT_SPEED` | `1.0` | Multiplies every simulated agent delay. `0` finishes a run instantly — the test suite sets this. |

---

## Pointing the frontend at it

`frontend/.env.local` (not created by this work — the frontend tree was left
untouched):

```
NEXT_PUBLIC_USE_MOCK=false
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
```

Restart `npm run dev`; these are `NEXT_PUBLIC_*` and are inlined at build time.

`NEXT_PUBLIC_USE_MOCK=partial` is the integration mode being added in
`frontend/src/lib/apiMode.ts`: each endpoint is tried against the backend and
falls back to the mock only when the endpoint is plainly not there (fetch
failure, 404/501/502/503/504, or a 2xx whose body is missing the fields that
endpoint must return). This backend implements all nine, so `partial` and
`false` behave identically against it — `partial` is for the teammate's
skeleton while it is still coming up one route at a time.

Either way the backend must send CORS headers for `http://localhost:3000`,
which `CORS_ORIGINS` does. Verified by preflight:

```bash
curl -i -X OPTIONS http://localhost:8000/api/gridshift/run \
  -H 'Origin: http://localhost:3000' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
# access-control-allow-origin: http://localhost:3000
# access-control-allow-methods: GET, POST, OPTIONS
```

### Endpoints

| Endpoint | Scope | Building id passed as |
| --- | --- | --- |
| `GET /api/buildings` | global | — |
| `GET /api/dashboard/summary` | building | `?building_id=` |
| `GET /api/forecast` | building | `?building_id=` |
| `POST /api/gridshift/run` | building | body `{ building_id }` |
| `POST /api/demo/reset` | building | body `{ building_id }` |
| `GET /api/gridshift/{run_id}/events` | run | — |
| `GET /api/gridshift/{run_id}/plan` | run | — |
| `POST /api/actions/{id}/approve` | action | — |
| `POST /api/actions/{id}/reject` | action | — |

`run` returns `{run_id, status, started_at}` immediately and runs the agent as a
detached task. `events` is cumulative, not a delta. `plan` 404s until the run
finishes. `approve`/`reject` return `{action, plan}`, and 409 if that action was
already decided. `reset` clears only the building you pass.

---

## Building identifiers: slugs and UUIDs

The frontend has always used slugs (`sea-office-001`), keeps one in
`localStorage` and sends it as `building_id`. The team's Postgres schema
(`data/scripts/db/schema.sql` on `feature/data-ingestion-db`) keys `buildings`
on a `UUID`. Both are real, so both work here.

* Every building carries a stable `external_id` — a UUIDv5 derived from the
  slug, so it is identical on every process start.
* `GET /api/buildings` publishes **both**: `id` is the slug (what the frontend
  stores), `external_id` is the UUID. The extra field is invisible to
  TypeScript, so `types/api.ts` did not have to change.
* Every building-scoped endpoint accepts either form. Responses always speak
  slugs, and a run started with the UUID is the run a reset by slug clears.

Resolution lives in `app/fixtures/__init__.py::get_fixture` — an in-memory map
in the reference. **In production this is a `slug TEXT UNIQUE NOT NULL` column
on `buildings` and one extra `WHERE building_id = $1 OR slug = $1` clause.** Do
not make the frontend learn UUIDs: the slug is already in people's browsers,
and it is the thing a human can read in a URL.

---

## How the event wrapping works — keep this part

Everything the operator sees comes out of one function,
`ToolInvoker.invoke` in `app/services/agent.py`. Every tool invocation, in
both agent modes, goes through it:

1. write a `tool_call` event carrying the arguments, **before** the call;
2. time the call;
3. write a `tool_result` event carrying the returned dict and `duration_ms`,
   **after** it;
4. turn any exception into an `error` event, then re-raise.

That ordering is what the activity feed renders: the dashboard shows a tool as
in-flight when it has seen the call but not yet the result, which is where
`activeTool` in `store.tsx` comes from. A tool called outside this wrapper is
invisible to the operator — and an agent whose work is invisible is an agent
nobody will approve.

This is also why **automatic function calling in `google-genai` is switched
off**. The SDK would happily execute the tools itself and no events would ever
be written. `run_gemini` drives the call loop by hand so the wrapper always
runs. If you refactor the agent, this is the invariant to preserve.

The two modes:

* **`GRIDSHIFT_AGENT=fake`** replays a 14-step script per building, spaced
  0.8–2.4 s apart so a run takes about 17 seconds and the dashboard's 1 s poll
  loop sees the feed arrive the way it will in production. The *narration* is
  written; the *data* is not — each step marked `invoke` calls the real
  function in `services/tools.py` and the event payload is whatever that
  function returned. Tool durations in this mode are the genuine measured cost
  of an in-memory lookup (0–2 ms); the narrative's stated solver time is
  carried on the optimizer step.
* **`GRIDSHIFT_AGENT=gemini`** gives the model the nine function declarations
  from `tools.py`, a system prompt that sets the order of investigation and the
  rules it may not break, and the same wrapper. Model prose between calls
  becomes `thinking` events; prose in the turn that commits the plan becomes a
  `decision` event; `save_action_plan` persists. The loop stops after
  `request_human_approval`, or after `MAX_MODEL_TURNS`.

Both finish with a `complete` event and status `awaiting_approval`. A run that
ends without a saved plan is marked `failed`, and `/plan` keeps 404ing — the
dashboard should never show a half-built plan.

### The architecture rule

From `AGENTS.md`: *Gemini must orchestrate tools but must not calculate
schedules itself.* That is enforced in `tools.py` — no tool takes a kW, kWh or
dollar figure from the model. The model chooses **which** tool to call and
**when**; every number comes from the forecast or the optimizer.

---

## Plugging in the real forecaster

`GRIDSHIFT_FORECAST=ml` makes `app/services/forecast.py` do this:

```python
sys.path.insert(0, "<repo>/ml")          # the ml package imports by bare name
frame = load_standard_frame("ml/data/prototype_commercial_building.csv")
bundle = load_model("ml/artifacts/load_forecaster.joblib")
predicted = forecast_next_24_hours(bundle, history, future_weather)
```

and maps `predicted["predicted_load_kw"]` into the 24 `predicted_load_kw`
values. To try it, train a model first (`cd ml && python run_pipeline.py`,
which writes `ml/artifacts/load_forecaster.joblib`) and install the ml
dependencies into this venv (`pip install -r ../../ml/requirements.txt`) —
pandas, scikit-learn and joblib are deliberately **not** in this backend's
requirements, because the reference must install and run without them.

Anything missing — the package, the artifact, the history CSV, a wrong-length
prediction — logs one warning and falls back to the fixture curves. A dashboard
that cannot draw a forecast is worse than one drawing the demo's.

Two things to fix when you take this over:

* **The prototype model is one synthetic commercial building.** Its absolute
  level means nothing for a hospital or a house, so the reference scales the
  predicted shape onto each site's own baseline peak. Delete that scaling the
  moment the model is per-building; it is marked in the code.
* **The forecaster predicts total load, not flows.** A regression on `load_kw`
  says nothing about how that load splits between base, EV, HVAC, solar and
  battery — and the DB has no device or asset tables to split it with. So the
  ml path holds the authored component shapes and re-solves `base_kw` through
  the identity, using `flows_for_grid()`, the same helper the fixtures use.
  **`GRIDSHIFT_FORECAST=ml` must keep synthesising flows until there is a real
  device model behind the optimizer.** The per-device numbers are the
  optimizer's output, not the forecaster's.

---

## The flow identity

```
grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw
```

`battery_kw` is the only signed field: positive discharges into the building,
negative charges from the grid. This holds at every hour of every building, on
the baseline and the optimized curve, to within half a rounding step — plus:

* `forecast.points[h].flows.grid_kw == points[h].predicted_load_kw`
* `plan.impact[h].baseline_flows.grid_kw == impact[h].baseline_kw`
* `plan.impact[h].optimized_flows.grid_kw == impact[h].optimized_kw`

`app/fixtures/__init__.py` exports **`assert_flows_identity(payload)`** for
exactly this. It takes a whole `ForecastResponse` or `ActionPlan` dict, a list
of points, or bare flow dicts, and raises `AssertionError` naming the first
hour that disagrees:

```python
from app.fixtures import assert_flows_identity

assert_flows_identity(forecast_payload, label="forecast(sea-office-001)")
assert_flows_identity(plan_payload, label="plan(sea-office-001)")
```

**Run it against every forecast and impact response you build.** It is 24
subtractions, it is the invariant the entire dashboard is drawn from, and a
violation is always a backend bug. The services here call it as a non-fatal
self-check (a logged error, so a slightly wrong chart still beats a blank one);
the test suite calls it directly and lets it raise.

---

## The optimizer

`app/services/optimizer.py` is a deterministic heuristic, applied in a fixed
order because each lever changes the curve the next one sees:

1. **EV shift** — move flexible charging out of the peak-setting hours into a
   window that still meets every deadline. Energy conserved exactly.
2. **HVAC** — pre-cool while it is cheap, then drift for the permitted hours.
3. **Battery** — flat discharge across the hours still over threshold, sized by
   whichever binds first: the inverter, the energy above the SOC reserve floor,
   or the height of the exceedance.

Each lever is either *pinned* by the site's `DispatchPolicy` or *derived* here.
The four demo buildings pin theirs, because the published demo has a known
answer that the frontend README documents; a site with an empty policy gets the
derivation, and `test_heuristic_path_without_a_pinned_policy` runs that path for
all four. The optimized curve is always re-derived from the components through
the identity, so an action's stated kW really is what moves the line.

The heuristic never backtracks, so it cannot trade one lever against another —
it will not discharge the battery harder to buy the HVAC action a shorter
drift. `solve_with_ortools()` is the stub where a CP-SAT model belongs (one
integer variable per resource-hour in watts, the identity as a linear
constraint, lexicographic `minimize(peak, then cost)`), returning the same
`OptimizationResult` so nothing downstream changes. It raises
`NotImplementedError` today, and the `TODO: replace with OR-Tools` in the module
docstring marks the seam.

---

## Adapting into `backend/app`

| Reference file | Where it goes | Notes |
| --- | --- | --- |
| `app/schemas.py` | `app/models/schemas.py` | Take verbatim. Keep it pinned to `types/api.ts`; change both in one commit. |
| `app/api/routes.py` | `app/api/routes.py` | Take the shape. Routes stay logic-free per `AGENTS.md`. |
| `app/services/agent.py` | `app/agent/runner.py` | **Keep `ToolInvoker.invoke` exactly.** Split the two modes into separate modules if you like; do not split the wrapper. |
| `app/services/tools.py` | `app/agent/tools.py` | Same nine functions; replace the fixture lookups with repository calls. `TOOL_DECLARATIONS` moves with them. |
| `app/services/optimizer.py` | `optimizer/` | Replace `optimize()` with the OR-Tools model; keep `OptimizationResult` as the interface. |
| `app/services/forecast.py` | `app/services/forecast.py` | Keep `flows_for_grid()` and the fallback. Point it at the model registry instead of a path. |
| `app/store.py` | `app/models/` + repositories | The table shapes carry over; the driver does not. |
| `app/fixtures/` | `tests/fixtures/` | Demo data, not production data — but keep `assert_flows_identity` on the production side. |
| `app/config.py` | `app/config.py` | Take verbatim; add the database URL and the auth settings. |

### What has to change before this is production

**Authentication and authorisation.** There is none. Every endpoint is open
and `POST /api/actions/{id}/approve` will accept anybody. Approval is the one
irreversible human decision in the product: it needs an authenticated
identity, a check that the identity may approve *that building*, and the
approver recorded on the action row (`approved_by`, `approved_at`). The
hospital fixture already names two approvers for one plan — the data model
should carry that, not just the prose.

**Postgres.** `app/store.py` is SQLite with a lock, single process, in memory
by default. Move it to SQLAlchemy + asyncpg against the schema in
`data/scripts/db/schema.sql` and add real migrations (Alembic). That schema
has `buildings`, `energy_readings`, `weather_observations`,
`weather_forecasts`, `tariff_rates`, `model_forecasts` and the raw archives —
and one real building, a simulated 2018 office with total load only. It needs:

* `buildings.slug TEXT UNIQUE NOT NULL` — see
  [Building identifiers](#building-identifiers-slugs-and-uuids).
* **Nameplate/asset columns** the dashboard reads on every building and the
  schema has nowhere to put: `peak_threshold_kw`, `floors`, `area_sqft`,
  `address`, `battery_capacity_kwh`, `battery_max_kw`, `solar_capacity_kw`,
  `ev_bays`, `hvac_zones`. Either widen `buildings` or add a `building_assets`
  table — the second ages better, because a site gains a battery.
* **Device/telemetry tables** for the flow breakdown: there is no per-device
  data at all today, so `solar_kw`, `battery_kw`, `ev_kw`, `hvac_kw`,
  `base_kw` and `battery_soc_pct` have nothing behind them. Until those exist,
  flows stay synthesised (see the forecaster section).
* **Run tables**, which do not exist in that schema: `runs` (run_id,
  building_id, status, started_at, finished_at, error), `agent_events`
  (id, run_id, seq, timestamp, type, tool_name, message, payload JSONB,
  duration_ms, with `UNIQUE (run_id, seq)`), `action_plans` (run_id, created_at,
  summary, the headline kW/USD columns) and `actions` (id, run_id, position,
  type, title, description, window, magnitude, unit, estimates, status,
  constraints_checked, and the approver columns above). `app/store.py` already
  uses these names and columns.
* Device constraints — reserve floors, locked clinical zones, EV deadlines —
  are hard-coded in the fixtures. They belong in the database, because they are
  the difference between a safe plan and an unsafe one.

**The optimizer.** Replace the heuristic with OR-Tools; see above. Until then
the per-site `DispatchPolicy` is configuration, not intelligence, and it should
not ship as if it were.

**Model loading.** `forecast.py` loads a joblib bundle from disk on every ml
request. Load it once at startup (or behind an LRU cache), version it, and
record which model produced a forecast — `model_forecasts` already has
`model_name` and `model_version` columns for exactly that.

**Run execution.** Runs are `asyncio.create_task` in the same process, so they
die with the worker and do not survive a restart or scale past one instance.
Move them to a task queue (Celery/RQ/arq) with the run row as the source of
truth, and make `POST /run` idempotent per building so a double-click cannot
start two.

**Also:** rate-limit the Gemini calls and set a per-run token budget; add
structured request logging with a request id; add a real `/health` split into
liveness and readiness (readiness should check the database and the model).
