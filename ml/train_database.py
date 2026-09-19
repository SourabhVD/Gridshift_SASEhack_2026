"""Train/validate by complete 24-hour blocks, then evaluate a locked holdout."""

import argparse
import hashlib
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error

from data.scripts.run_selected_sources import CONFIG, selected_building_id
from ml.database_adapter import load_training_data
from ml.day_ahead import HISTORY_HOURS, HORIZON, fit_candidates, forecast_next_24_hours, weather_for_origin

ROOT = Path(__file__).resolve().parents[1]


def score(frame):
    error = np.abs(frame.actual_kw - frame.predicted_load_kw)
    peaks = frame.groupby("origin")[["actual_kw", "predicted_load_kw"]].max()
    return {"mae_kw": float(error.mean()),
            "rmse_kw": float(np.sqrt(mean_squared_error(frame.actual_kw, frame.predicted_load_kw))),
            "wape_pct": float(100 * error.sum() / frame.actual_kw.abs().sum()),
            "daily_peak_mae_kw": float(mean_absolute_error(peaks.actual_kw, peaks.predicted_load_kw)),
            "days": int(len(peaks)), "hours": int(len(frame))}


def evaluate(bundle, frame, start, end, mode="persistence"):
    results = []
    for origin in range(HISTORY_HOURS, len(frame) - HORIZON + 1, HORIZON):
        index = frame.index[origin:origin + HORIZON]
        if index[0] < start or index[-1] >= end:
            continue
        history = frame.iloc[:origin]
        weather = weather_for_origin(frame, origin, mode)
        result = forecast_next_24_hours(bundle, history, weather)
        result["actual_kw"] = frame.load_kw.iloc[origin:origin + HORIZON].to_numpy()
        result["origin"] = index[0]
        results.append(result)
    if not results:
        raise ValueError("No complete evaluation days")
    return pd.concat(results, ignore_index=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "processed" / "selected_model")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    config = json.loads(CONFIG.read_text())
    building_id = selected_building_id(config)
    frame, provenance = load_training_data(building_id)
    timezone = config["building"]["timezone"]
    if len(frame) < 8000:
        raise ValueError("This selected-building experiment requires approximately a year of data")
    year = frame.index[0].year
    stamp = lambda month: pd.Timestamp(year=year, month=month, day=1, tz="UTC")
    folds = [(stamp(7), stamp(9)), (stamp(9), stamp(11))]
    validation = []
    for start, end in folds:
        print(f"Validation {start.date()} to {end.date()} (24-hour blocks)", flush=True)
        bundles = fit_candidates(frame.loc[frame.index < start], timezone)
        for name, bundle in bundles.items():
            predictions = evaluate(bundle, frame, start, end)
            metrics = score(predictions)
            validation.append({"model": name, "start": str(start), "end": str(end), **metrics})
            print(name, metrics, flush=True)
    validation_table = pd.DataFrame(validation)
    validation_table.to_csv(args.output / "validation.csv", index=False)
    # Selection is frozen before touching the November/December holdout.
    mean_mae = validation_table.groupby("model").mae_kw.mean().sort_values()
    winner = mean_mae.index[0]
    print(f"Selected on validation only: {winner}", flush=True)
    test_start = stamp(11)
    names = list(dict.fromkeys([winner, "recursive_lightgbm", "naive_24", "naive_168"]))
    bundles = fit_candidates(frame.loc[frame.index < test_start], timezone, names)
    test = {}
    for name, bundle in bundles.items():
        predictions = evaluate(bundle, frame, test_start, frame.index[-1] + pd.Timedelta(hours=1))
        test[name] = score(predictions)
        predictions.to_csv(args.output / f"test_{name}.csv", index=False)
        print("HOLDOUT", name, test[name], flush=True)
    # Diagnostic upper-information scenario, not a deployed-accuracy estimate.
    observed = score(evaluate(bundles[winner], frame, test_start,
                             frame.index[-1] + pd.Timedelta(hours=1), mode="observed"))
    fingerprint = hashlib.sha256(frame.to_csv().encode()).hexdigest()
    metadata = {"building_id": str(building_id), "selected_model": winner,
                "dataset_sha256": fingerprint, "provenance": provenance,
                "load_is_simulated": True, "training_rows": int((frame.index < test_start).sum()),
                "data_start": str(frame.index[0]), "data_end": str(frame.index[-1]),
                "holdout_start": str(test_start), "validation_mean_mae_kw": mean_mae.to_dict(),
                "test": test, "observed_weather_diagnostic": observed,
                "weather_evaluation": "Last-week weather persistence proxy, available at forecast origin; NOT archived NWS forecasts",
                "baseline": "Same-data retraining of reviewed feature/ml-forecasting LightGBM parameters/features, rolled recursively for 24h",
                "limitations": ["Simulated ComStock load is not measured building validation",
                                "One building and one year; no multi-building generalization claim",
                                "NOAA nearby-station weather is not the exact original simulation weather",
                                "Forecast weather persistence is a proxy; real NWS forecast errors not measured",
                                "Artifact stops training before holdout; 2018 history cannot support a current live forecast"]}
    artifact = bundles[winner]
    artifact["metadata"] = metadata
    joblib.dump(artifact, args.output / "load_forecaster.joblib")
    (args.output / "metrics.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    frame.reset_index().to_csv(args.output / "ml_ready_hourly.csv", index=False)
    print(f"Saved model and evaluation under {args.output}", flush=True)


if __name__ == "__main__":
    main()
