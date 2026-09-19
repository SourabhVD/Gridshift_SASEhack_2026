# Handoff — GridShift backend

## 1. What this is

A working backend that already satisfies the contract the dashboard expects:
nine endpoints, four demo buildings, an agent that streams its reasoning as
events, and an action plan a human approves or rejects. It runs with **no API
key and no database** — `GRIDSHIFT_AGENT=fake` replays a scripted 14-step run
that calls the real tool functions, so the whole pipeline is exercised offline.
The forecast curves, the optimizer and the store are deliberately simple.
Your job is to make those three real without changing the wire format: swap
SQLite for Postgres, the heuristic for OR-Tools, the fixture curves for the
trained model, and add authentication. `README.md` next to this file explains
how each piece works; this file is the hour-one path.

## 2. Run it in 5 minutes

```powershell
# Windows PowerShell
cd backend\reference
python -m venv .venv;  .venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

```bash
# macOS / Linux
cd backend/reference
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Prove it, in a second terminal:

```bash
curl http://localhost:8000/health
# {"status":"ok","agent":"fake",...,"buildings":["sea-office-001", ...]}
curl "http://localhost:8000/api/forecast?building_id=sea-office-001"
# 24 points, peak 522 kW at 15:00
```

Then the dashboard — create `frontend/.env.local`:

```
NEXT_PUBLIC_USE_MOCK=partial
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
```

```bash
cd frontend && npm install && npm run dev      # http://localhost:3000
```

You should see the four buildings in the selector, the office's 24-hour
forecast peaking at 522 kW, and "Run agent" filling a feed over about 17
seconds, ending with a three-action plan you can approve or reject.

In the browser console: **nothing from `[api]`**. `partial` mode logs
`[api] <path> not available, using mock` once per endpoint it had to fall back
on, and stays silent when an endpoint answers for real — so silence means all
nine are live. Any such line means that endpoint is broken or the backend is
down; check the uvicorn terminal. `NEXT_PUBLIC_USE_MOCK=false` removes the
safety net entirely (failures surface as errors, not fixtures) — switch to it
once `partial` is silent.

## 3. Turn on the real agent

1. Create a key at <https://aistudio.google.com/app/apikey>.
2. `cp .env.example .env` in `backend/reference/`, then set:
   ```
   GEMINI_API_KEY=your-key-here
   GRIDSHIFT_AGENT=gemini
   ```
   `.env` is gitignored. The key is read only in `app/services/agent.py` and
   never reaches the browser.
3. Restart uvicorn, click "Run agent", and check two things in the feed:
   * **Every `tool_call` has a matching `tool_result`** with a payload and a
     `duration_ms`. That pairing is written by `ToolInvoker.invoke` in
     `app/services/agent.py` and is the one thing you must not break —
     automatic function calling in the SDK is disabled on purpose, because it
     would run the tools itself and no events would be written.
   * **The numbers in the model's prose match the payloads.** The model
     orchestrates; it never computes a schedule. Every kW and dollar comes from
     `run_schedule_optimizer`. If the prose invents a figure, tighten the system
     prompt — do not let a tool accept model-supplied numbers.

With `GRIDSHIFT_AGENT=gemini` and no key the backend logs a warning and runs
fake mode, so a missing key never breaks a demo.

## 4. Make the forecast real

```
GRIDSHIFT_FORECAST=ml
GRIDSHIFT_ML_MODEL_PATH=ml/artifacts/load_forecaster.joblib
```

`app/services/forecast.py` puts `ml/` on `sys.path` (that package imports by
bare name), calls `load_model()`, `load_standard_frame()` and
`forecast_next_24_hours(bundle, history, future_weather)`, and maps the 24
`predicted_load_kw` values onto the curve. Train first (`cd ml && python
run_pipeline.py`) and install the ml dependencies into this venv
(`pip install -r ../../ml/requirements.txt`) — pandas and scikit-learn are
deliberately not in this backend's requirements. Any failure logs one warning
and falls back to fixture curves. Two caveats:

* The prototype model is trained on one synthetic commercial building, so the
  reference scales its shape onto each site's own baseline peak. Delete that
  scaling when the model is per-building; it is marked in the code.
* **Flows are not forecast.** The model predicts total load and there are no
  device tables to split it with, so the ml path holds the component shapes and
  re-solves `base_kw` through the flow identity (`flows_for_grid()`). Keep
  synthesising flows until real device telemetry exists — the per-device split
  is the optimizer's output, not the forecaster's.

## 5. Make it production

In order:

1. **Move into `backend/app/`.** File-by-file:

   | From `backend/reference/` | To `backend/app/` | Notes |
   | --- | --- | --- |
   | `app/schemas.py` | `models/schemas.py` | Verbatim. Change with `types/api.ts`, same commit. |
   | `app/api/routes.py` | `api/routes.py` | Keep routes logic-free. |
   | `app/services/agent.py` | `agent/runner.py` | Keep `ToolInvoker.invoke` intact. |
   | `app/services/tools.py` | `agent/tools.py` | Swap fixture lookups for repositories. |
   | `app/services/optimizer.py` | `optimizer/` | Keep `OptimizationResult` as the interface. |
   | `app/services/forecast.py` | `services/forecast.py` | Keep `flows_for_grid()` and the fallback. |
   | `app/store.py` | `models/` + repositories | Table shapes carry over; the driver does not. |
   | `app/config.py` | `config.py` | Add `DATABASE_URL` and auth settings. |
   | `app/fixtures/` | `tests/fixtures/` | Except `assert_flows_identity`, which stays in production code. |

2. **Postgres.** Use `data/scripts/db/schema.sql` (on `feature/data-ingestion-db`)
   as the base, then add:

   ```sql
   -- nameplate the dashboard reads on every building; the schema has nowhere
   -- to put any of it today. A separate building_assets table ages better.
   ALTER TABLE public.buildings
       ADD COLUMN slug TEXT UNIQUE NOT NULL,          -- 'sea-office-001'
       ADD COLUMN address TEXT, ADD COLUMN floors INTEGER,
       ADD COLUMN area_sqft INTEGER, ADD COLUMN peak_threshold_kw DOUBLE PRECISION,
       ADD COLUMN battery_capacity_kwh DOUBLE PRECISION,
       ADD COLUMN battery_max_kw DOUBLE PRECISION,
       ADD COLUMN solar_capacity_kw DOUBLE PRECISION,
       ADD COLUMN ev_bays INTEGER, ADD COLUMN hvac_zones INTEGER;

   CREATE TABLE public.runs (
       run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       building_id UUID NOT NULL REFERENCES public.buildings(building_id),
       status TEXT NOT NULL,          -- running|awaiting_approval|approved|rejected|failed
       agent_mode TEXT NOT NULL DEFAULT 'gemini',
       started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       finished_at TIMESTAMPTZ, error TEXT
   );
   CREATE INDEX runs_building_started ON public.runs (building_id, started_at DESC);

   CREATE TABLE public.agent_events (
       event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       run_id UUID NOT NULL REFERENCES public.runs(run_id) ON DELETE CASCADE,
       seq INTEGER NOT NULL CHECK (seq > 0),
       timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
       type TEXT NOT NULL,            -- thinking|tool_call|tool_result|decision|error|complete
       tool_name TEXT, message TEXT NOT NULL, payload JSONB, duration_ms INTEGER,
       UNIQUE (run_id, seq)
   );

   CREATE TABLE public.action_plans (
       run_id UUID PRIMARY KEY REFERENCES public.runs(run_id) ON DELETE CASCADE,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       summary TEXT NOT NULL,
       baseline_peak_kw DOUBLE PRECISION NOT NULL,
       optimized_peak_kw DOUBLE PRECISION NOT NULL,
       peak_reduction_kw DOUBLE PRECISION NOT NULL,
       baseline_cost_usd NUMERIC(12,2) NOT NULL,
       optimized_cost_usd NUMERIC(12,2) NOT NULL,
       savings_usd NUMERIC(12,2) NOT NULL,
       impact JSONB NOT NULL          -- 24 hourly points, both flow breakdowns
   );

   CREATE TABLE public.actions (
       action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       run_id UUID NOT NULL REFERENCES public.runs(run_id) ON DELETE CASCADE,
       position INTEGER NOT NULL,
       type TEXT NOT NULL,            -- battery_discharge|ev_charging_shift|hvac_setpoint
       title TEXT NOT NULL, description TEXT NOT NULL,
       start_time TIMESTAMPTZ NOT NULL,
       end_time TIMESTAMPTZ NOT NULL CHECK (end_time > start_time),
       magnitude DOUBLE PRECISION NOT NULL, unit TEXT NOT NULL,
       estimated_peak_reduction_kw DOUBLE PRECISION NOT NULL,
       estimated_savings_usd NUMERIC(12,2) NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending',
       constraints_checked TEXT[] NOT NULL DEFAULT '{}',
       decided_by TEXT, decided_at TIMESTAMPTZ,
       UNIQUE (run_id, position)
   );
   ```

   The slug column is why both id forms work: resolve with
   `WHERE building_id::text = $1 OR slug = $1`, and keep publishing the slug as
   `id`. The DB holds one real building today (a simulated 2018 office, total
   load only, no device tables), so the four demo sites stay fixtures until
   there is more data — and flows stay synthesised.

3. **OR-Tools.** Replace `optimize()` with a CP-SAT model — one integer
   variable per resource-hour in watts, the flow identity as a linear
   constraint, lexicographic `minimize(peak, then cost)` — and return the same
   `OptimizationResult`. `solve_with_ortools()` is the stub. Nothing downstream
   changes.

4. **Auth and CORS.** Nothing is authenticated today; `approve` will accept
   anybody. Add an authenticated identity, a per-building authorisation check,
   and write `decided_by`/`decided_at` on the action. Set `CORS_ORIGINS` to the
   deployed frontend origin (not `*` — the app sends credentials).

5. **Deploy.** Render or Railway, HTTPS, `DATABASE_URL` and `GEMINI_API_KEY` as
   secrets. Runs are `asyncio.create_task` in-process and die with the worker:
   move them to a task queue with the `runs` row as source of truth, and make
   `POST /run` idempotent per building.

## 6. Contract rules you must not break

* **Nine endpoints**, exact paths — see the table in `README.md`. Building
  scope takes `building_id` as a query param on GET and a body field on POST.
* **snake_case** field names on the wire, everywhere.
* **ISO 8601 timestamps with an offset.** A naive string is parsed as
  browser-local time and silently shifts the whole dashboard.
* **`POST /api/gridshift/run` returns immediately** with
  `{run_id, status, started_at}`; the agent runs in the background.
* **Events are append-only and ordered by `seq`**, 1-based, no gaps. `/events`
  returns everything so far — cumulative, not a delta — plus `is_complete`.
* **The flows identity** holds at every hour:
  `grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw`, with
  `battery_kw` the only signed field. Also
  `flows.grid_kw == predicted_load_kw` and
  `baseline_flows.grid_kw == baseline_kw` (same for optimized). Call
  `assert_flows_identity(payload)` from `app.fixtures` on every forecast and
  plan response you build.
* **`GET /api/gridshift/{run_id}/plan` 404s until the run is complete.** Never
  return a partial plan.
* **Re-deciding an action is 409**, not a silent no-op. Plan status derives
  from its actions: any pending → `awaiting_approval`; all decided with at
  least one approval → `approved`; otherwise → `rejected`.
* **`POST /api/demo/reset` clears only the building passed.** A run on another
  building must survive.

## 7. Where to ask

* **`frontend/src/types/api.ts`** is the source of truth for every payload.
  `app/schemas.py` mirrors it one for one; if they disagree, the TypeScript is
  right until the team agrees otherwise, and both change in the same commit.
* **`docs/api-contracts.md`** is the shared contract doc and is still a set of
  placeholders — fill it from `app/schemas.py` and the OpenAPI page at
  `http://localhost:8000/docs` once the endpoints settle.
* **`frontend/README.md`** documents the four buildings, the sign convention
  and the numbers the reference reproduces.
* `pytest` in `backend/reference/` is the executable version of section 6.
