# GridShift database

The database foundation uses PostgreSQL and the root `DATABASE_URL` environment
variable. The connection module reads the project's ignored `.env`; an existing
environment variable takes precedence. No credentials are stored in source code.

From the repository root in PowerShell:

```powershell
.\.venv\Scripts\python.exe -m pip install -r data/scripts/db/requirements.txt
.\.venv\Scripts\python.exe -m data.scripts.db.init_db
.\.venv\Scripts\python.exe -m data.scripts.db.verify_db
```

Direct execution of `data/scripts/db/init_db.py` and `verify_db.py` also works.
Use the existing GridShift Docker database on host port 5433, as configured in
your local `.env`. The older root Docker Compose file describes a separate
instance on port 5432; it is not needed for this existing container.

Initialization is transactional and safe to repeat. It creates missing tables
and indexes, but does not alter existing definitions. Future schema changes need
explicit migrations. Verification writes temporary records and always rolls back
its transaction (identity sequences may still advance).

| Table | Purpose |
| --- | --- |
| buildings | Building identity, coordinates, timezone, utility and rate class |
| energy_readings | Demand in kW and interval energy in kWh |
| weather_observations | Historical Celsius, humidity percent and wind m/s |
| weather_forecasts | Hourly weather forecasts, versioned by issue time |
| tariff_rates | Energy and demand rates with effective dates and hour windows |
| model_forecasts | Predicted demand, peak information and model version |
| raw_building_load | Original building-load payloads as JSONB |
| raw_weather_history | Original historical-weather payloads as JSONB |
| raw_weather_forecast | Original forecast-weather payloads as JSONB |
| raw_tariffs | Original tariff payloads as JSONB |

All timestamp columns use TIMESTAMPTZ; Python connections use UTC. Ingestion must
convert source timestamps with known timezone/interval conventions, normalize
units, and aggregate to hourly intervals before creating ML inputs. Energy is
interval kWh; demand is average interval kW. This schema models nonnegative
building consumption, not signed net import/export. Missing historical weather
must remain in the raw archive until it can be normalized or explicitly imputed.
Forecast humidity and wind may be absent and must be handled before inference.

Historical readings have one canonical row per building and timestamp; use
`ON CONFLICT (building_id, timestamp) DO UPDATE` for corrections. Raw tables
retain each received payload; repeat ingestion may create multiple raw records.
They preserve parsed JSON, not the byte-for-byte HTTP response or CSV file.
Register a building before ingesting its data. Tariffs may have a null building
for shared rates; assigning shared rates to buildings is an ingestion/service
responsibility. Foreign keys prevent deletion of buildings with stored data.

Tariff hour windows use building-local time, start-inclusive and end-exclusive.
Split overnight windows at midnight. Effective date endpoints are inclusive;
null `effective_to` means ongoing. Rates default to USD. This initial table does
not yet model holiday calendars, tiered billing or enforce nonoverlapping rates;
the tariff connector must interpret those rules before optimizer integration.

Reusable application connection:

```python
from data.scripts.db.connection import get_engine
from sqlalchemy import text

engine = get_engine()
with engine.connect() as connection:
    rows = connection.execute(text("SELECT building_id, name FROM public.buildings"))
    print(rows.all())
engine.dispose()
```

Ingestion connectors, ML retraining and agent/optimizer tables are separate next
steps. No real building or tariff data is seeded by initialization.
