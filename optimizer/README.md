# Component 3 — Optimization Engine

Decides the cheapest feasible response to a forecast peak, using OR-Tools.

```
minimize  energy cost + demand charge + violation penalties
s.t.      battery SOC dynamics, EV energy windows, HVAC comfort limits
```

## Run

```bash
pip install -r optimizer/requirements.txt

# offline (no database) — works on the Component 2 forecast CSV
python -m optimizer.run_optimizer --forecast-csv ml/evaluation/demo_forecast_24h.csv

# database
psql "$DATABASE_URL" -f optimizer/db/devices.sql
python -m optimizer.seed_devices --building-id <uuid>
python -m optimizer.run_optimizer --building-id <uuid> --hours 24
python -m optimizer.run_optimizer --building-id <uuid> --hours 168 --pricing tou
python -m optimizer.run_optimizer --building-id <uuid> --write-plan

pytest tests/optimizer
```

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
