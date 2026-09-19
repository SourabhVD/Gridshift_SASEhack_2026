# Data ingestion

The four connectors fetch source data, cache downloads in ignored `data/raw/`
folders, archive source payloads in PostgreSQL JSONB, and upsert normalized rows.
Run commands from the repository root. Both `python -m data.scripts.<name>` and
`python data/scripts/<name>.py` work. Python 3.10+ is required.

## Setup

```powershell
.\.venv\Scripts\python.exe -m pip install -r data/scripts/requirements.txt
.\.venv\Scripts\python.exe -m data.scripts.db.init_db
```

The root `.env` supplies `DATABASE_URL`. Add `NWS_USER_AGENT` with an identifying
application name and your real contact, for example `GridShift (your-contact)`.
The scripts never require or expose `GEMINI_API_KEY`.

## Register the target building

Choose the actual building location and matching NOAA station. For ComStock,
use that release's metadata to select an **individual** building and its location;
a Washington building is not necessarily in Seattle or served by City Light.
Keep different buildings, release versions and upgrade scenarios under separate
GridShift UUIDs so canonical measurements are not overwritten across sources.

This example registers an explicitly labeled Seattle demo location; replace its
coordinates and descriptive fields with the selected building's metadata:

```powershell
$buildingId = .\.venv\Scripts\python.exe -m data.scripts.register_building `
  --name "Seattle demo" --latitude 47.6062 --longitude -122.3321 `
  --timezone America/Los_Angeles --building-type office `
  --utility "Seattle City Light" --rate-class medium
```

Save the printed UUID. Pass `--building-id` to `register_building` when updating
the same building; omitting it intentionally creates a new building.

## 1. Building load: ComStock download or meter file

ComStock does not provide a REST data API. Its public OEDI HTTPS files contain
**simulated** load profiles, not live meter measurements. Select the release and
building ID using its metadata, then copy the individual `.parquet` download URL
from the [ComStock dataset catalog](https://natlabrockies.github.io/ComStock.github.io/docs/data.html).

```powershell
$loadUrl = 'https://oedi-data-lake.s3.amazonaws.com/REPLACE-WITH-SELECTED-OBJECT-KEY.parquet'
.\.venv\Scripts\python.exe -m data.scripts.ingest_building_load `
  --building-id $buildingId --url $loadUrl --source ComStock `
  --value-column out.electricity.total.energy_consumption --unit kwh --dry-run
```

Remove `--dry-run` to archive and insert. Use `--file path/to/file.parquet` or
`--file path/to/file.csv` for a local source. The timestamp/value column names
are configurable because release formats differ. Defaults use `timestamp`,
15-minute interval-ending samples, and **fixed Eastern Standard Time**
(`Etc/GMT+5`, without daylight saving), following the
[ComStock timestamp documentation](https://natlabrockies.github.io/ComStock.github.io/docs/faq.html).
Use the release data dictionary to confirm the electricity total column and unit.
Do not use energy intensity, annual results, aggregate or weighted load files.

Meter CSV example (interval-average kW, timestamps at interval start):

```powershell
.\.venv\Scripts\python.exe -m data.scripts.ingest_building_load `
  --building-id $buildingId --source meter --file data/raw/meter.csv `
  --value-column load_kw --unit kw --interval-minutes 15 `
  --timestamp-position start --source-timezone America/Los_Angeles
```

Offset-aware timestamps preserve their offsets. Naive meter times require the
source timezone; ambiguous/nonexistent DST times fail instead of guessing.
Duplicate intervals and nonfinite/negative loads fail. Only complete hourly
groups are written; missing/partial hours are reported, never zero-filled.
Energy is summed in kWh and hourly average power is the same numeric value in
kW for a complete one-hour interval. ComStock records are marked `estimated`.
No live meter provider or credentials have been supplied; meter access currently
accepts CSV/Parquet over HTTPS or a local file, not a vendor-specific API.

## 2. Historical weather: NOAA NCEI Global Hourly API

```powershell
.\.venv\Scripts\python.exe -m data.scripts.ingest_noaa_weather `
  --building-id $buildingId --station 72793024233 `
  --start 2018-01-01 --end 2019-01-01 --dry-run
```

`72793024233` is the Seattle-Tacoma station example. Select the nearest suitable
station with coverage for the building. Dates are **UTC, start-inclusive and
end-exclusive**; use the load file's weather year, not its release year. The
connector requests seven-day windows from the
[NCEI Access Data Service](https://www.ncei.noaa.gov/access/search/documentation/data-service/).
This hourly service does **not** require the CDO API token from the earlier plan.

Temperature/dew point and wind values use ISD scale factors and quality flags
([format](https://www.ncei.noaa.gov/pub/data/noaa/isd-format-document.pdf)). Only
quality codes 1 and 5 are accepted. Relative humidity is derived with the Magnus
approximation from temperature/dew point and recorded as such in the code; it is
not a directly observed humidity field. Valid observations are averaged into
UTC hours, duplicate observation instants are counted once, and missing hours
are reported without imputation. Windows commit separately, making long
backfills resumable by date; repeat normalization upserts canonical hours.
Nearby station weather is a proxy, not guaranteed to match a ComStock model's
original weather input. For exact reproduction use that model's weather file.
ComStock's year-boundary timestamp wrapping also needs consideration when
aligning the first/last hours with observed weather.

## 3. Future weather: NWS hourly forecast API

```powershell
.\.venv\Scripts\python.exe -m data.scripts.ingest_nws_forecast `
  --building-id $buildingId --hours 24 --dry-run
```

The connector discovers `forecastHourly` via `/points/{latitude},{longitude}`;
it does not hard-code grid coordinates. It converts temperatures and wind to
Celsius and m/s. Wind ranges use their midpoint. It stores the next 24 complete
hours, preserves the source issue time, and rejects missing/duplicate hours.
Nullable humidity/wind remains null and is reported; the ML adapter must handle
it before inference. NWS weather alone cannot forecast a building without
recent load history (the planned ML features need at least 168 hours).
See the [NWS API documentation](https://www.weather.gov/documentation/services-web-api).

## 4. Tariffs: Seattle City Light published business-rate tables

```powershell
.\.venv\Scripts\python.exe -m data.scripts.ingest_tariffs `
  --building-id $buildingId --rate-class medium --location C `
  --effective-from 2026-01-01 --dry-run
```

The source is the official [City Light business rates page](https://www.seattle.gov/city-light/business-solutions/business-billing-and-account-information/business-rates),
not a documented JSON API. This connector parses current **small/medium flat**
energy ($/kWh) and demand ($/kW) rates; it does not invent time-of-use periods.
The building's registered utility must be `Seattle City Light`. Location codes
are C Seattle, D downtown network, B Burien, E SeaTac, H Shoreline, K unincorporated
King County, L Lake Forest Park, N Normandy Park, T Tukwila and S Renton.
Select the actual customer class/service area from the bill.

Confirm `--effective-from` against the published schedule for the rates fetched
now: it labels the current rates and **does not request historical tariffs**.
The sample date above reflects the 2026 schedule, not an automatic default.
Use `--effective-to` when known and close superseded periods when rates change.
Repeat runs for the same building/class/location/start date update a stable
tariff UUID. Different effective periods are retained. Overlap resolution,
monthly demand billing, daily/minimum charges, taxes, credits, undergrounding
charges and other bill adjustments are outside this ingestion layer. Large/high
demand and TOU schedules need weekday/holiday-aware schema support before use.
The importer fails when expected table labels/price formats are missing.

## Storage, failure and replay behavior

- `--dry-run` fetches, caches and validates, but writes **no database records**;
  the building must already be registered.
- Raw database archives are append-only; repeated runs deliberately record new
  fetches. Raw and normalized writes are separate transactions so a normalization
  failure leaves its raw payload available. Unreadable downloads remain in the
  content-addressed file cache even when no JSONB archive can be created.
- Load archives contain original parsed rows plus source URL/file, hash and
  conversion settings. Weather archives retain API payloads and query metadata;
  tariff archives retain original HTML and selection metadata.
- Normalized writes use parameterized, batched upserts, committing each source
  batch atomically. Existing rows with the same canonical keys are updated.
- HTTP GETs have timeouts, retry transient errors/429 with backoff and respect
  `Retry-After`. Downloads have a 100 MiB response cap; select individual files.
- Caches are stored under the existing `data/raw/` tree and excluded from Git.
  No secrets are required in download URLs. Do not supply signed URLs or tokens
  in URLs because provenance archives intentionally retain the source location.

## Verification

```powershell
.\.venv\Scripts\python.exe -m pip install pytest
.\.venv\Scripts\python.exe -m pytest data/scripts/tests -q
$env:GRIDSHIFT_TEST_DB = '1'
.\.venv\Scripts\python.exe -m pytest data/scripts/tests -q
Remove-Item Env:GRIDSHIFT_TEST_DB
```

The optional database test uses the configured local database and rolls back all
records. It checks raw JSONB, normalized upserts, no-write dry runs and failed
normalization preserving raw archives. Offline tests cover units, DST/fixed EST,
missing intervals, quality flags, forecast coverage and tariff section parsing.
