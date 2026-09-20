# GridShift backend

A complete, runnable implementation of the API contract the dashboard expects.
It serves the nine endpoints in `frontend/src/lib/api.ts` against four demo
buildings, runs a Gemini function-calling agent whose every tool call lands in
the event stream, and works with no API key at all.

This started life as `backend/reference/` and now *is* `backend/app/`. The
optimizer is a real CP-SAT model; the data layer is still fixtures — see
[HANDOFF.md](HANDOFF.md) for what is left, and in what order.

```
backend/
├── README.md
├── HANDOFF.md                  the production path, step by step
├── requirements.txt            what CI installs; the API itself needs only
│                               fastapi, uvicorn, pydantic, dotenv, google-genai, pytest, httpx
├── .env.example                copy to backend/.env; every value has a working default
├── Dockerfile                   one container, no Python setup needed
├── app/
│   ├── main.py                 FastAPI app, CORS from env, /health, router
│   ├── config.py               the one place the environment is read
│   ├── store.py                runs / events / plans / actions, in SQLite
│   ├── models/
│   │   └── schemas.py          Pydantic models mirroring frontend/src/types/api.ts
│   ├── api/
│   │   └── routes.py           the nine endpoints; no business logic
│   ├── agent/
│   │   ├── tools.py            the nine agent tools, as plain functions
│   │   └── runner.py           the run loop: fake and gemini
│   ├── fixtures/
│   │   ├── generator.py        deterministic curve kit + the flow identity
│   │   ├── spec.py             BuildingFixture, DispatchPolicy, Step
│   │   ├── office.py           sea-office-001    Cascade Commerce Center
│   │   ├── hospital.py         sea-hospital-002  Harborview Medical Annex
│   │   ├── warehouse.py        sea-warehouse-003 Duwamish Logistics Hub
│   │   ├── residence.py        sea-residence-004 Alder Street Residence
│   │   └── __init__.py         registry, slug/UUID resolution, assert_flows_identity
│   └── services/
│       ├── forecast.py         fixtures | ml | backtest, and the shared flow synthesis
│       ├── backtest.py         reads the ml harness's artifacts; stdlib only
│       └── optimizer.py        the CP-SAT model and the heuristic it replaced
└── tests/
    ├── conftest.py             TestClient + poll_until_complete
    ├── test_contract.py        endpoint shapes, all four buildings
    ├── test_flows.py           the flow identity, published numbers, heuristic
    ├── test_optimizer_cpsat.py the solver's properties and device limits
    ├── test_backtest.py        the real-day forecast mode
    └── test_run_flow.py        run → events → plan → approve → reject → 409 → reset
```

---

## Run it

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate        # Windows bash; .venv\Scripts\activate on cmd/PowerShell
                                     # source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
cp .env.example .env                 # optional: every default already works

uvicorn app.main:app --reload --port 8000
```

`GET http://localhost:8000/health` reports the configuration actually in force.
`http://localhost:8000/docs` is the generated OpenAPI page.

Tests run from the **repository root**, which is exactly what CI does:

```bash
python -m pytest                     # 100 backend tests, a few seconds
```

`.venv/` is already covered by the repo's `.gitignore`.

### Or in a container

```bash
docker build -t gridshift-backend backend
docker run --rm -p 8000:8000 gridshift-backend
```

That is the whole demo with no Python setup: four buildings, the scripted
agent, the CP-SAT optimizer. Pass the live agent's key at run time rather than
baking it into an image, and mount backtest artifacts read-only if you want a
real day — the header of `backend/Dockerfile` has both commands. It runs a
single worker on purpose: runs are asyncio tasks in-process and the store is in
memory, so a second worker would answer `/events` for a run it never saw.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `GRIDSHIFT_AGENT` | `fake` | `fake` replays the scripted run; `gemini` calls the model. `gemini` with no key logs a warning and degrades to `fake`. |
| `GEMINI_API_KEY` | *(empty)* | Google AI Studio key. Read only by `app/agent/runner.py`; it never leaves the backend. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model id for `GRIDSHIFT_AGENT=gemini`. |
| `GRIDSHIFT_FORECAST` | `fixtures` | `fixtures` serves the ported demo curves; `ml` calls the `ml` package in process; `backtest` serves a real day from disk. Anything unavailable falls back to fixtures with one logged warning. |
| `GRIDSHIFT_ML_MODEL_PATH` | `ml/artifacts/load_forecaster.joblib` | Trained bundle. Relative paths resolve from the repo root. |
| `GRIDSHIFT_BACKTEST_PATH` | `data/processed/backtests` | Where `ml/evaluate_forecast_date.py` writes its per-date directories. |
| `GRIDSHIFT_BACKTEST_DATE` | *(empty)* | Which day to serve. Empty means the most recent one present. |
| `GRIDSHIFT_BACKTEST_BUILDING` | `sea-office-001` | The one site the backtest speaks for; every other slug keeps its fixture curve. |
| `GRIDSHIFT_OPTIMIZER` | `ortools` | `ortools` runs the CP-SAT model; `heuristic` runs the fixed-order three-lever pass the published figures came from. |
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
`ToolInvoker.invoke` in `app/agent/runner.py`. Every tool invocation, in
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
dependencies into this venv (`pip install -r ../ml/requirements.txt`), which
pins the versions the model was trained against. The API itself imports none of
them: every ml import is inside the `ml` branch of `forecast.py` and failure
falls back to fixtures, so the backend installs and runs without them.

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

## Serving a real day: `GRIDSHIFT_FORECAST=backtest`

`ml/evaluate_forecast_date.py` is a **backtest harness, not a live
forecaster**, and it is worth being precise about that before anyone wires it
into a route. Two things in it decide the shape of this integration:

* It refuses a date unless the database already holds 24 hours of **measured**
  load for it. It can only forecast days you already know the answer to, which
  is exactly right for evaluating a model and is not a next-day prediction.
* It retrains from scratch on every call — a feature ablation that fits a model
  per feature group, then a final fit. That does not belong inside an HTTP
  request.

So the backend never calls it. You run it once, offline, and this mode reads
what it left behind:

```bash
# from the repository root, with DATABASE_URL in ./.env
python -m ml.evaluate_forecast_date --date 2018-07-15
# writes data/processed/backtests/2018-07-15/
```

```bash
cd backend
GRIDSHIFT_FORECAST=backtest uvicorn app.main:app --reload --port 8000
```

`GET /health` then carries a `backtest` block naming the directory, the dates
it found and the site they are served as — the fallback to fixtures is silent
by design, so that block is how you check the mode actually took.

### What is real, and what is not

Be precise about this, especially on a slide.

**Real:** the shape of the day, and the gap between predicted and measured.
`predicted_load_kw` is a real model's output for a real date, and
`actual_load_kw` is what the building actually drew — both straight out of the
harness, not synthesised.

**Presentational:** the absolute kW and the calendar date. Both series are
multiplied by one factor that maps the day's peak onto this site's own peak,
and they are published on the demo day. `GET /health` reports the real kW and
the factor applied, so this is not hidden:

```json
"serving": { "date": "2018-07-15", "algorithm": "LightGBM",
             "real_peak_kw": 73.4, "real_measured_peak_kw": 76.9,
             "scaled_onto_site_by": 7.1117 }
```

Because both series are scaled by the same number, the model's relative error
is untouched: the visible gap between the two lines is the real one.

**Why not publish the raw kW?** Coherence. The optimizer's levers, the device
facts `validate_schedule` checks them against, and the agent's scripted
narration are all authored at the site's scale and on the demo day. Serving 73
kW on `/forecast` put a 73 kW chart beside a 522 kW impact chart on two
different dates, and made `get_energy_forecast` compare a 73 kW day against a
450 kW billing threshold and report zero peak hours. Making the raw scale work
end to end means scaling the policy deltas, the device facts and the authored
prose too — worth doing when the optimizer stops being a heuristic, not before.

`actual_load_kw` stops at "now", the way `metered_actuals` does. The file knows
the whole day; publishing the future half would move the dashboard's time
cursor and claim a measurement that has not happened.

Three things this mode deliberately does **not** do:

* **No database access, ever.** `app/services/backtest.py` reads a CSV and two
  JSON files using only the standard library. No credential reaches the
  backend, and the mode works on an install with neither pandas nor
  scikit-learn. It also needs no timezone database, which Python does not ship
  on Windows: the day's offset is derived by subtracting the first row's UTC
  instant from the directory's date.
* **It speaks for one site.** The database holds a single building, so only
  `GRIDSHIFT_BACKTEST_BUILDING` is served from it. Every other slug keeps its
  fixture curve unchanged.
* **It does not invent flows.** The model predicts total load, so the component
  split is still synthesised through `flows_for_grid()`. The per-device numbers
  are the optimizer's output, not the forecaster's.

Known limitation, on two days a year: the harness selects a window of
`local_start + Timedelta(days=1)`, which is 24 hours of elapsed time rather
than a calendar day. On a daylight-saving transition that window is not quite
the local day, and the `utc_offset` reported in `/health` is the one in force
at midnight rather than for the whole day. Neither affects the served curve,
which is published on the demo day in file order, but pick a different date if
you want the reported metadata to be exact.

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

The heuristic never backtracks, which is its ceiling: it cannot discharge the
battery harder to buy the HVAC action a shorter drift, because by the time it
reaches the battery the HVAC decision is already made.

### The CP-SAT model — the default

`solve_with_ortools()` closes that gap. One integer variable per resource-hour
in tenths of a kW, the flow identity as a linear constraint each hour, and a
lexicographic objective solved in two passes: minimise the peak, then pin that
peak and minimise cost underneath it. Two solves rather than one weighted
objective, so "minimise cost" cannot quietly buy a worse peak by being large
enough. `solve()` picks between the two on `GRIDSHIFT_OPTIMIZER`, and the agent
calls `solve()`.

Holding all three levers at once is what buys the improvement:

| Site | Heuristic cut | CP-SAT cut | Demand charge avoided |
| --- | ---: | ---: | --- |
| `sea-office-001` | 84.0 kW | 152.2 kW | $714 → $1,294 /mo |
| `sea-hospital-002` | 92.0 kW | 139.9 kW | $782 → $1,189 /mo |
| `sea-warehouse-003` | 115.0 kW | 266.3 kW | $978 → $2,264 /mo |
| `sea-residence-004` | 9.3 kW | 10.0 kW | $79 → $85 /mo |

All four solve to `OPTIMAL` in under 35 ms.

**There is no fallback behind it, on purpose.** Every constraint admits the
untouched baseline and the baseline is fed in as a solution hint, so "no
solution" is not a state this model can reach, and the solver can never return
something worse than leaving the building alone. A fallback would only hide a
formulation bug that ought to be loud. `test_optimizer_cpsat.py` pins that
property along with the flow identity, energy conservation, the device limits
and reproducibility.

Three modelling decisions worth knowing before you change it:

* **Tenths of a kW, not watts.** Every value the solver returns is already on
  the 0.1 kW grid the wire format uses, so the flow identity stays exact after
  conversion with no float residue to round away.
* **The grid floor is the site's own export, not zero.** A site with enough PV
  exports at midday — the residence baseline runs to −4 kW — so a zero floor
  would exclude its own curve and make the model infeasible for that building
  alone. Pinning the floor at the baseline's export also stops the solver
  inventing new export: dumping the pack into the grid for an energy credit
  prices badly under this tariff and is not a schedule anyone would approve.
* **The SOC floor carries half a percent of margin.** The solver will sit
  exactly on any floor it is given, because energy held back is peak not
  shaved. Downstream, `validate_schedule` re-walks the state of charge in
  percent and rounds every hour, so an exact landing here reads as a fraction
  below the floor there and the agent rejects its own plan.

Fixed seed, single worker: the same building produces the same plan every run,
because a demo whose numbers move between takes is worse than a slower one.

---

## Adapting into `backend/app`

| Reference file | Where it goes | Notes |
| --- | --- | --- |
| `app/models/schemas.py` | `app/models/schemas.py` | Take verbatim. Keep it pinned to `types/api.ts`; change both in one commit. |
| `app/api/routes.py` | `app/api/routes.py` | Take the shape. Routes stay logic-free per `AGENTS.md`. |
| `app/agent/runner.py` | `app/agent/runner.py` | **Keep `ToolInvoker.invoke` exactly.** Split the two modes into separate modules if you like; do not split the wrapper. |
| `app/agent/tools.py` | `app/agent/tools.py` | Same nine functions; replace the fixture lookups with repository calls. `TOOL_DECLARATIONS` moves with them. |
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
