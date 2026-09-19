# GridShift ML Forecasting

## Goal
Forecast the next 24 hours of commercial-building electricity demand in kW.

## Reference data sources
NREL ComStock (building load) · NOAA/NCEI (historical weather, training) ·
NWS (future weather, inference) · BDG2 (supplementary benchmark).
Seattle City Light tariffs are deliberately **not** model inputs — they belong to
the downstream optimizer.

## Input contract (TEMPORARY)
`timestamp, load_kw, temperature_c, humidity_pct, wind_speed_mps`

## Feature framing
Each row is a **target hour** `ts`.

| group | features |
|---|---|
| calendar | hour, day_of_week, day_of_year, month, is_weekend |
| cyclical | hour_sin/cos, dow_sin/cos |
| weather @ ts | temperature_c, humidity_pct, wind_speed_mps |
| temp transforms | temperature_squared, heating_degree, cooling_degree (base 18 °C) |
| load lags | 1, 2, 3, 24, 48, 168 h before ts |
| rolling | mean 3/6/24 h and std 24 h, computed on load **shifted by 1** |

Leakage rule: no feature touches load at `ts` or later. Calendar and weather are
taken at `ts` because both are knowable in advance at inference time.

## Target and horizon
One-step-ahead regression, extended to 24 h **recursively** (each prediction
feeds the next step's lags). Direct multi-horizon is the alternative — a team
decision, not a silent switch.

## Evaluation
Chronological 70/15/15 split (never shuffled). Primary metrics: MAE, RMSE, MAPE,
R². Model selection uses **validation** MAE; the naive baseline is excluded from
selection but always reported.

Peak classification (precision/recall/F1) is a **secondary** metric and needs a
threshold. None is defined yet, so the pipeline falls back to the 95th percentile
of training load and labels it PROVISIONAL. Pass `--peak-threshold` once the team
sets a real one.

## Prototype results — SYNTHETIC DATA, NOT REAL-WORLD PERFORMANCE

8,760 hourly rows (2025), synthetic commercial load + Seattle-like weather.
8,592 usable rows after the 168 h warm-up.

| model | val MAE | test MAE | test RMSE | test R² |
|---|---:|---:|---:|---:|
| HistGradientBoosting | 4.765 | 5.088 | 6.533 | 0.988 |
| RandomForest | 5.762 | 5.459 | 7.203 | 0.986 |
| GradientBoosting | 6.116 | 5.489 | 7.096 | 0.986 |
| LightGBM | 4.593 | 5.982 | 7.508 | 0.984 |
| Naive-24h | 22.279 | 23.402 | 44.534 | 0.447 |

Selected: **LightGBM** (lowest validation MAE). HistGradientBoosting edges it on
test — the gap is within synthetic-data noise, so treat this as "the tree
ensembles are all viable", not as a permanent winner.

Provisional peak threshold = 360.075 kW (95th percentile of training load).
LightGBM: precision 0.910, recall 0.938, **F1 = 0.924**.

Correct phrasing for the presentation:
> Using a provisional 95th-percentile training-load threshold on a synthetic
> prototype, the model reached F1 = 0.92 for peak-event classification.

These numbers regenerate from `data/synthetic_adapter.py` (seed 42) and differ
from the earlier prototype run, which used a different generator. The synthetic
relationship is clean, so real ComStock/NOAA performance will be meaningfully worse.

## Limitations
Synthetic data · provisional threshold · single building · recursive error
accumulation unmeasured beyond the demo day.

## Next
1. Swap `data/synthetic_adapter.py` for the teammate's real adapter (same schema).
2. Add NOAA historical weather aligned to load timestamps; NWS for inference.
3. Retrain and re-report all metrics on real data.
4. Set the real peak threshold and recompute precision/recall/F1.
