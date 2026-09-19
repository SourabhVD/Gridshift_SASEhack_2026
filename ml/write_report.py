"""Write a reviewable source/accuracy report from completed experiment results."""

import json
from importlib.metadata import version
from pathlib import Path

from sqlalchemy import text

from data.scripts.db.connection import get_engine
from data.scripts.run_selected_sources import CONFIG, selected_building_id

ROOT = Path(__file__).resolve().parents[1]


def main():
    config = json.loads(CONFIG.read_text())
    results = json.loads((ROOT / "data/processed/selected_model/metrics.json").read_text())
    building_id = selected_building_id(config)
    tables = ("energy_readings", "weather_observations", "weather_forecasts", "tariff_rates", "model_forecasts")
    engine = get_engine()
    try:
        with engine.connect() as connection:
            counts = {table: connection.execute(text(f"SELECT count(*) FROM public.{table} WHERE building_id=:id"),
                                                {"id": building_id}).scalar_one() for table in tables}
    finally:
        engine.dispose()
    winner = results["selected_model"]
    baseline = results["test"]["recursive_lightgbm"]["mae_kw"]
    improvement = 100 * (baseline - results["test"][winner]["mae_kw"]) / baseline
    lines = ["# Selected GridShift data and model evaluation", "",
             "## Decisions", "",
             "- ComStock 2025 Release 3, AMY2018 baseline, building **13847**, MediumOffice, 46,000 ft2, electric heating.",
             "- Native simulation geography: King County, tract 53033001900 (Seattle Northgate). Avoided profiles merely reweighted into King County from another simulation geography.",
             "- Coordinates 47.6965349, -122.3262160 are a Census tract reference point, not an actual building address.",
             "- Building selected by size, HVAC and geography before model comparisons; no search for a building with favorable test scores.",
             "- NOAA Boeing Field station 72793524234: closer than Sea-Tac and complete required fields in winter/summer spot checks. Nearest Sand Point station failed field-completeness checks.",
             "- Historical range: 2018-01-01 through 2019-01-02 exclusive, allowing for ComStock fixed-EST to UTC conversion.",
             "- NWS: 24 current hours at the tract reference point; stored separately from 2018 training data.",
             "- Tariff: City Light medium C flat, 2026 effective period, explicitly a demo scenario. It does not establish actual account eligibility or reconstruct 2018 bills.",
             f"- GridShift building UUID: `{building_id}`.", "",
             "The complete reproducible configuration is `data/selected_sources.json`.", "",
             "## Stored data", "", "| Table | Rows for selected building |", "| --- | ---: |"]
    lines += [f"| {name} | {count:,} |" for name, count in counts.items()]
    lines += ["", "## Evaluation design", "",
              "The local ML files were empty; the implementation on the feature/ml-forecasting branch was inspected, not merged. Its LightGBM parameters and feature definitions were reproduced as the same-data recursive reference. This is not a comparison with the old synthetic-data MAE.",
              f"Reference commit: [{config['ml_reference']['commit']}]({config['ml_reference']['url']}).", "",
              "Candidates: prior-day and prior-week baselines, recursive LightGBM, direct LightGBM, and two regularized weekly-residual LightGBM models. All candidates use identical evaluation origins and load targets.",
              "Training expands chronologically. Validation folds: train before July/evaluate July-August, then train before September/evaluate September-October. Choose lowest mean validation MAE, including naive baselines as eligible winners. Freeze selection, refit before November, then evaluate November-December once.",
              "Every evaluation issues 24 hours at once. During a forecast, no actual load inside its horizon is exposed to features. Actual loads from previously completed days become available at subsequent daily origins. Windows crossing fold boundaries are omitted.",
              "Main metrics use last-week weather persistence as a proxy available at issue time. Historical observed weather is used in training. This introduces a weather-input distribution difference; it is not a test of archived NWS forecast errors. Observed holdout weather is reported separately as an upper-information diagnostic, never used to select the model.",
              "Calendar features in direct models use building-local time and known federal holidays. They use only origin-available lagged loads, rolling history, horizon and weather inputs; no recursive load feedback. Longest history requirement is 336 hours.",
              f"Weather rows missing before bounded past-only filling: {results['provenance']['missing_weather_hours_before_fill']}; after filling up to 3 hours: {results['provenance']['missing_weather_hours_after_fill']}. Longer gaps remain NaN for LightGBM; no load values are imputed.", "",
              "## Results", "", f"Selected model: **{winner}**.", "",
              "| Model | Mean validation MAE (kW) |", "| --- | ---: |"]
    lines += [f"| {name} | {value:.3f} |" for name, value in results["validation_mean_mae_kw"].items()]
    lines += ["", "Locked holdout, complete 24-hour predictions:", "",
              "| Model | MAE kW | RMSE kW | WAPE % | Daily peak MAE kW | Days |",
              "| --- | ---: | ---: | ---: | ---: | ---: |"]
    lines += [f"| {name} | {m['mae_kw']:.3f} | {m['rmse_kw']:.3f} | {m['wape_pct']:.2f} | {m['daily_peak_mae_kw']:.3f} | {m['days']} |"
              for name, m in results["test"].items()]
    lines += ["", f"Selected-model MAE reduction against the retrained recursive reference: **{improvement:.2f}%** (negative means worse).",
              f"Observed-weather diagnostic for selected model: MAE {results['observed_weather_diagnostic']['mae_kw']:.3f} kW.", "",
              "## Limits", ""]
    lines += [f"- {limit}." for limit in results["limitations"]]
    lines += ["- Reported improvement is a point estimate; no statistical-significance claim or confidence interval.",
              "- ComStock modeled schedules and nearby NOAA weather do not establish real-building forecast accuracy. Measured recent meter data is required for a live deployment claim.", "",
              "## Reproduce", "", "```powershell",
              ".\\.venv\\Scripts\\python.exe -m pip install -r ml/requirements.txt",
              ".\\.venv\\Scripts\\python.exe -m data.scripts.run_selected_sources",
              ".\\.venv\\Scripts\\python.exe -m ml.train_database",
              ".\\.venv\\Scripts\\python.exe -m ml.replay_database",
              ".\\.venv\\Scripts\\python.exe -m ml.write_report", "```", "",
              "Run the training command from the repository root. Raw caches and model/data artifacts are ignored by Git. Re-running ingestion appends raw fetch archives and upserts normalized values. NWS and published tariff sources can change with time. Replays add a new explicitly labeled historical snapshot to `model_forecasts`.", "",
              "Artifacts: `data/processed/selected_model/` contains the model, metrics JSON, validation CSV, holdout predictions and ML-ready CSV. The model deliberately remains trained only before the holdout cutoff; it is not refit on holdout data.",
              f"Data fingerprint: `{results['dataset_sha256']}`.", "",
              "Package versions: " + ", ".join(f"{name} {version(name)}" for name in ("pandas", "numpy", "scikit-learn", "lightgbm", "joblib")) + ".", "",
              "Sources: [ComStock](https://natlabrockies.github.io/ComStock.github.io/docs/data.html), [NOAA](https://www.ncei.noaa.gov/access/search/documentation/data-service/), [NWS](https://www.weather.gov/documentation/services-web-api), [City Light](https://www.seattle.gov/city-light/business-solutions/business-billing-and-account-information/business-rates), [Census tract service](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2010/MapServer/14).", ""]
    path = ROOT / "docs" / "selected-data-and-model.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    print(path)


if __name__ == "__main__":
    main()
