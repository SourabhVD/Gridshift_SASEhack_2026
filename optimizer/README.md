# Component 3 — Optimization Engine

Decides the cheapest feasible response to a forecast peak, using OR-Tools.

```
minimize  energy cost + demand charge + violation penalties
s.t.      battery SOC dynamics, EV energy windows, HVAC comfort limits
```

## Setup (one time, per database)

Your app's `gridshift_backend` role has DML rights (SELECT/INSERT/UPDATE/DELETE)
on existing tables but **not** `CREATE` — so the four new tables this component
needs have to be created by someone with dashboard access, through Supabase's
**SQL Editor** (Project → SQL Editor → New query), not through Python:

1. Paste and run `optimizer/db/devices.sql` in the SQL Editor.
   (`python -m optimizer.db.apply_devices_schema` will NOT work here —
   same role, same missing `CREATE` privilege.)
2. Supabase auto-enables Row-Level Security on every new `public` table. With
   no policy defined, that silently blocks all writes — including from your
   own backend role — with `new row violates row-level security policy`. Run
   this in the same SQL Editor (also included at the bottom of `devices.sql`):
   ```sql
   ALTER TABLE public.battery_assets DISABLE ROW LEVEL SECURITY;
   ALTER TABLE public.ev_charging_sessions DISABLE ROW LEVEL SECURITY;
   ALTER TABLE public.hvac_flexibility DISABLE ROW LEVEL SECURITY;
   ALTER TABLE public.optimization_plans DISABLE ROW LEVEL SECURITY;
   ```
3. Verify both landed:
   ```sql
   SELECT tablename, rowsecurity FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename IN ('battery_assets','ev_charging_sessions',
                        'hvac_flexibility','optimization_plans');
   ```
   All four should show `rowsecurity = false`.

If you don't have Supabase dashboard access, GitHub repo access does **not**
grant it — they're separate systems. Ask the project owner to invite you from
**Project Settings → Team** (not Authentication → Users, which creates an app
login, not a dashboard login).

## Run

```bash
pip install -r optimizer/requirements.txt

# offline (no database) — works on the Component 2 forecast CSV
python -m optimizer.run_optimizer --forecast-csv ml/evaluation/demo_forecast_24h.csv

# database — after Setup above
python -m optimizer.db.introspect                          # sanity-check what's in the DB
python -m optimizer.seed_devices --building-id <uuid>       # one-time synthetic battery/EV/HVAC
python -m optimizer.run_optimizer --building-id <uuid> --hours 24
python -m optimizer.run_optimizer --building-id <uuid> --hours 168 --pricing tou
python -m optimizer.run_optimizer --building-id <uuid> --write-plan   # persist to optimization_plans

pytest tests/optimizer
```

`seed_devices` is idempotent (deletes its own prior synthetic rows before
re-inserting), so safe to re-run after tweaking sizing assumptions.
`optimize.db.apply_devices_schema` exists for databases where `gridshift_backend`
*does* have `CREATE` — most Supabase setups won't, hence the manual step above.

## Layout

| file | role |
|---|---|
| `schemas.py` | dataclasses: BatterySpec, EVSpec, HVACSpec, TariffSchedule, Input/Result |
| `constraints.py` | per-device variables and constraints |
| `optimizer.py` | net-load balance, billable peak, objective, solve, report |
| `data_access.py` | the only module that touches PostgreSQL |
| `seed_devices.py` | synthetic device specs (sized off the building's own peak) |
| `db/devices.sql` | tables the optimizer needs; **not yet in the canonical schema** |
| `run_optimizer.py` | CLI |

## Reads

| table | used for |
|---|---|
| `model_forecasts` | predicted demand (Component 2 output) |
| `tariff_rates` | energy price per hour + demand charge |
| `energy_readings` | month-to-date billed peak |
| `battery_assets` | capacity, power, efficiency, current SOC |
| `ev_charging_sessions` | energy required inside a plug-in window |
| `hvac_flexibility` | curtailment envelope |
| `optimization_plans` | written back for the agent / frontend |

The last four tables come from `db/devices.sql`.

## Model notes

**Solver.** Linear MIP via `pywraplp` (SCIP, CBC fallback). Battery power and SOC
are continuous, so CP-SAT would force integer discretization for nothing. The
only binaries are the battery charge/discharge mode and the HVAC run-length
indicators; past `max_binary_hours` (default 336) the model relaxes to an LP
automatically and records that in `solver.relaxation_notes`.

**Demand charge.** Billed on the monthly maximum, so the objective prices only
what the horizon adds on top of `month_to_date_peak_kw`, read from
`energy_readings`. A 24 h run therefore optimises tomorrow's *marginal* demand
cost; a 720 h run optimises the whole bill. Pass
`--ignore-month-to-date-peak` to price the horizon peak from zero.

**Flat vs TOU.** `--pricing flat` (default) uses the flat Seattle City Light row
that `ingest_tariffs.py` writes. Under a flat energy rate, load-shifting saves
essentially nothing on energy — all the value is peak shaving, which the demo
numbers show clearly. `--pricing tou` uses non-flat `tariff_rates` rows if they
exist. Caveat: `tariff_rates` has `start_hour`/`end_hour` but no day-of-week
column, so a Mon–Sat peak window cannot be represented; TOU rows apply to every
day.

**Baseline for savings.** Forecast load plus *unmanaged* EV charging (full power
from plug-in), no battery, no HVAC action. That is the honest counterfactual:
the EV energy has to happen either way.

**Penalties.** Unmet EV energy ($100/kWh) is last-resort slack so an
over-committed plug schedule degrades instead of returning INFEASIBLE. HVAC
curtailment carries a comfort shadow price ($1/kWh) so the solver does not shed
for free. Neither appears in the reported dollar savings — they shape the
schedule, they are not cash.

## Limits

- Device specs are **synthetic** scenario assumptions, not site measurements.
- HVAC is a curtailable-fraction model with rebound, not a thermal RC model; it
  cannot promise an indoor temperature bound.
- Horizons beyond 24 h need a forecast that long. Component 2 issues 24 h, so a
  week or month currently requires chained daily runs or a longer ML horizon.
- Grid export is off by default (`allow_grid_export`).
