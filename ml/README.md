# Database-backed day-ahead forecasting

Run from the repository root:

```powershell
.\.venv\Scripts\python.exe -m pip install -r ml/requirements.txt
.\.venv\Scripts\python.exe -m data.scripts.run_selected_sources
.\.venv\Scripts\python.exe -m ml.train_database
.\.venv\Scripts\python.exe -m ml.replay_database
.\.venv\Scripts\python.exe -m ml.write_report
```

The selected-source manifest is `data/selected_sources.json`. Forecasting modules:

- `database_adapter.py`: load the standard load/weather contract from PostgreSQL,
  enforce a regular hourly grid and record missing-weather/source provenance.
- `day_ahead.py`: direct 24-hour features and inference, plus a reproduction of
  the existing GitHub ML branch's recursive LightGBM reference.
- `train_database.py`: expanding validation, model selection and untouched final
  holdout evaluation. Model selection includes naive baselines, not just learners.
- `replay_database.py`: save one historical day as `historical_replay:<model>` in
  PostgreSQL. These records are explicitly not current operational forecasts.
- `write_report.py`: write decisions, database counts and measured results into
  `docs/selected-data-and-model.md`.

The existing remote `feature/ml-forecasting` branch was inspected without
merging it or disturbing the local Git rebase. These modules are additive and
do not overwrite that branch's `ml/models`, `ml/features` or pipeline code.
The old empty root-level placeholder modules remain unchanged.

## Inference contract

```python
import joblib
from ml.day_ahead import forecast_next_24_hours

bundle = joblib.load("data/processed/selected_model/load_forecaster.joblib")
forecast = forecast_next_24_hours(bundle, history, future_weather)
```

Only load trusted joblib artifacts. `history` is a DataFrame with a sorted,
timezone-aware hourly DatetimeIndex and `load_kw`, `temperature_c`, `humidity_pct`,
`wind_speed_mps` columns. At least 336 contiguous observed load hours are required.
`future_weather` has the same index convention, 24 rows beginning exactly one
hour after history, and the three weather columns. Output has `timestamp` and
`predicted_load_kw` columns. Target-hour load values are never input features.

For real forecasting, use recent measured loads and a coherent NWS issuance
covering those next 24 hours. Current NWS weather and 2018 ComStock loads cannot
be joined to produce a credible live forecast. The selected-source experiment
is a historical simulated-load backtest with real nearby-station observations.

Model outputs, raw datasets and row-level evaluation files live under ignored
`data/processed/selected_model/`. The human-readable report and reproducible
configuration are source-controlled files. Dependencies are version-bounded;
the generated report records the actual runtime versions and a dataset hash.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest ml/tests data/scripts/tests -q
```

Set `GRIDSHIFT_TEST_DB=1` to include the rollback-only ingestion integration test.
Feature tests verify forecast-origin isolation, weather-proxy isolation,
calendar timezone handling and rejection of gaps/stale weather.
