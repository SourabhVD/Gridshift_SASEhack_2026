# Selected GridShift data and model evaluation

## Decisions

- ComStock 2025 Release 3, AMY2018 baseline, building **13847**, MediumOffice, 46,000 ft2, electric heating.
- Native simulation geography: King County, tract 53033001900 (Seattle Northgate). Avoided profiles merely reweighted into King County from another simulation geography.
- Coordinates 47.6965349, -122.3262160 are a Census tract reference point, not an actual building address.
- Building selected by size, HVAC and geography before model comparisons; no search for a building with favorable test scores.
- NOAA Boeing Field station 72793524234: closer than Sea-Tac and complete required fields in winter/summer spot checks. Nearest Sand Point station failed field-completeness checks.
- Historical range: 2018-01-01 through 2019-01-02 exclusive, allowing for ComStock fixed-EST to UTC conversion.
- NWS: 24 current hours at the tract reference point; stored separately from 2018 training data.
- Tariff: City Light medium C flat, 2026 effective period, explicitly a demo scenario. It does not establish actual account eligibility or reconstruct 2018 bills.
- GridShift building UUID: `6ee36e26-40d4-5408-b93a-840ad2fdd412`.

The complete reproducible configuration is `data/selected_sources.json`.

## Stored data

| Table | Rows for selected building |
| --- | ---: |
| energy_readings | 8,760 |
| weather_observations | 8,637 |
| weather_forecasts | 24 |
| tariff_rates | 1 |
| model_forecasts | 24 |

## Evaluation design

The local ML files were empty; the implementation on the feature/ml-forecasting branch was inspected, not merged. Its LightGBM parameters and feature definitions were reproduced as the same-data recursive reference. This is not a comparison with the old synthetic-data MAE.
Reference commit: [d41eb9d294fe84ff8394e2e768384f4458396c28](https://github.com/SourabhVD/Gridshift_SASEHack_2026/tree/d41eb9d294fe84ff8394e2e768384f4458396c28/ml).

Candidates: prior-day and prior-week baselines, recursive LightGBM, direct LightGBM, and two regularized weekly-residual LightGBM models. All candidates use identical evaluation origins and load targets.
Training expands chronologically. Validation folds: train before July/evaluate July-August, then train before September/evaluate September-October. Choose lowest mean validation MAE, including naive baselines as eligible winners. Freeze selection, refit before November, then evaluate November-December once.
Every evaluation issues 24 hours at once. During a forecast, no actual load inside its horizon is exposed to features. Actual loads from previously completed days become available at subsequent daily origins. Windows crossing fold boundaries are omitted.
Main metrics use last-week weather persistence as a proxy available at issue time. Historical observed weather is used in training. This introduces a weather-input distribution difference; it is not a test of archived NWS forecast errors. Observed holdout weather is reported separately as an upper-information diagnostic, never used to select the model.
Calendar features in direct models use building-local time and known federal holidays. They use only origin-available lagged loads, rolling history, horizon and weather inputs; no recursive load feedback. Longest history requirement is 336 hours.
Weather rows missing before bounded past-only filling: 128; after filling up to 3 hours: 69. Longer gaps remain NaN for LightGBM; no load values are imputed.

## Results

Selected model: **direct_lightgbm**.

| Model | Mean validation MAE (kW) |
| --- | ---: |
| direct_lightgbm | 6.051 |
| residual_shallow | 6.357 |
| residual_regularized | 6.389 |
| recursive_lightgbm | 6.433 |
| naive_168 | 6.660 |
| naive_24 | 12.763 |

Locked holdout, complete 24-hour predictions:

| Model | MAE kW | RMSE kW | WAPE % | Daily peak MAE kW | Days |
| --- | ---: | ---: | ---: | ---: | ---: |
| direct_lightgbm | 6.844 | 9.205 | 11.95 | 10.603 | 61 |
| recursive_lightgbm | 8.381 | 11.045 | 14.63 | 11.492 | 61 |
| naive_24 | 10.793 | 17.634 | 18.85 | 21.088 | 61 |
| naive_168 | 9.282 | 12.193 | 16.21 | 14.222 | 61 |

Selected-model MAE reduction against the retrained recursive reference: **18.34%** (negative means worse).
Observed-weather diagnostic for selected model: MAE 4.172 kW.

## Limits

- Simulated ComStock load is not measured building validation.
- One building and one year; no multi-building generalization claim.
- NOAA nearby-station weather is not the exact original simulation weather.
- Forecast weather persistence is a proxy; real NWS forecast errors not measured.
- Artifact stops training before holdout; 2018 history cannot support a current live forecast.
- Reported improvement is a point estimate; no statistical-significance claim or confidence interval.
- ComStock modeled schedules and nearby NOAA weather do not establish real-building forecast accuracy. Measured recent meter data is required for a live deployment claim.

## Reproduce

```powershell
.\.venv\Scripts\python.exe -m pip install -r ml/requirements.txt
.\.venv\Scripts\python.exe -m data.scripts.run_selected_sources
.\.venv\Scripts\python.exe -m ml.train_database
.\.venv\Scripts\python.exe -m ml.replay_database
.\.venv\Scripts\python.exe -m ml.write_report
```

Run the training command from the repository root. Raw caches and model/data artifacts are ignored by Git. Re-running ingestion appends raw fetch archives and upserts normalized values. NWS and published tariff sources can change with time. Replays add a new explicitly labeled historical snapshot to `model_forecasts`.

Artifacts: `data/processed/selected_model/` contains the model, metrics JSON, validation CSV, holdout predictions and ML-ready CSV. The model deliberately remains trained only before the holdout cutoff; it is not refit on holdout data.
Data fingerprint: `68b6e7274dd3371744b4d980c4d71574d4643e8d07fc42394a1ec1212451adf7`.

Package versions: pandas 3.0.6, numpy 2.5.3, scikit-learn 1.9.1, lightgbm 4.7.0, joblib 1.6.0.

Sources: [ComStock](https://natlabrockies.github.io/ComStock.github.io/docs/data.html), [NOAA](https://www.ncei.noaa.gov/access/search/documentation/data-service/), [NWS](https://www.weather.gov/documentation/services-web-api), [City Light](https://www.seattle.gov/city-light/business-solutions/business-billing-and-account-information/business-rates), [Census tract service](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2010/MapServer/14).
