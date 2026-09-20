import argparse
import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
ML_DIR = ROOT / "ml"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from data.scripts.run_selected_sources import CONFIG, selected_building_id
from ml.database_adapter import load_training_data

from features.engineering import create_features, get_feature_groups
from models.load_forecaster import build_models, chronological_split
from models.inference import forecast_next_24_hours

from evaluation.metrics import (
    regression_metrics,
    provisional_peak_threshold,
    peak_metrics,
)

def prepare_forecast_data(forecast_date: str):
    config = json.loads(CONFIG.read_text())
    building_id = selected_building_id(config)

    db_frame, provenance = load_training_data(building_id)
    df = db_frame.reset_index()

    timezone = config["building"]["timezone"]

    local_start = pd.Timestamp(
        f"{forecast_date} 00:00:00",
        tz=timezone,
    )

    target_start = local_start.tz_convert("UTC")
    target_end = (local_start + pd.Timedelta(days=1)).tz_convert("UTC")

    historical_df = df[
        df["timestamp"] < target_start
    ].copy()

    future_weather = df[
        (df["timestamp"] >= target_start)
        & (df["timestamp"] < target_end)
    ][[
        "timestamp",
        "temperature_c",
        "humidity_pct",
        "wind_speed_mps",
    ]].copy()

    actual = df[
        (df["timestamp"] >= target_start)
        & (df["timestamp"] < target_end)
    ][[
        "timestamp",
        "load_kw",
    ]].copy()

    return {
        "config": config,
        "building_id": building_id,
        "provenance": provenance,
        "df": df,
        "historical_df": historical_df,
        "future_weather": future_weather,
        "actual": actual,
        "target_start": target_start,
        "target_end": target_end,
    }

def evaluate_feature_sets(historical_df):
    X, y, timestamps = create_features(historical_df)

    feature_groups = get_feature_groups(
        X
    )

    results = {}

    for name, cols in feature_groups.items():
        split = chronological_split(
            X[cols],
            y,
            timestamps,
        )

        model = build_models()["LightGBM"]

        model.fit(
            split.X_train,
            split.y_train,
        )

        val_pred = model.predict(
            split.X_val
        )

        results[name] = regression_metrics(
            split.y_val,
            val_pred,
        )

    results_df = pd.DataFrame(results).T

    best_feature_set = (
        results_df["MAE_kW"]
        .idxmin()
    )

    return {
        "X": X,
        "y": y,
        "timestamps": timestamps,
        "feature_groups": feature_groups,
        "results_df": results_df,
        "best_feature_set": best_feature_set,
    }

def train_and_forecast(prepared, feature_eval):
    X = feature_eval["X"]
    y = feature_eval["y"]

    best_feature_set = feature_eval["best_feature_set"]
    selected_features = feature_eval["feature_groups"][best_feature_set]

    final_model = build_models()["LightGBM"]

    final_model.fit(
        X[selected_features],
        y,
    )

    bundle = {
        "model": final_model,
        "model_name": "LightGBM",
        "feature_names": selected_features,
    }

    forecast = forecast_next_24_hours(
        bundle,
        prepared["historical_df"],
        prepared["future_weather"],
    )

    return {
        "model": final_model,
        "bundle": bundle,
        "forecast": forecast,
        "selected_features": selected_features,
        "best_feature_set": best_feature_set,
    }

def evaluate_forecast(prepared, training_result, feature_eval):
    forecast = training_result["forecast"]

    actual = prepared["actual"].rename(
        columns={"load_kw": "actual_load_kw"}
    )

    evaluation = forecast.merge(
        actual,
        on="timestamp",
        how="inner",
    )

    regression = regression_metrics(
        evaluation["actual_load_kw"],
        evaluation["predicted_load_kw"],
    )

    threshold = provisional_peak_threshold(
        feature_eval["y"],
        quantile=0.95,
    )

    peak_result = peak_metrics(
        evaluation["actual_load_kw"],
        evaluation["predicted_load_kw"],
        threshold,
    )

    actual_values = evaluation["actual_load_kw"].to_numpy()
    predicted_values = evaluation["predicted_load_kw"].to_numpy()

    actual_peak_kw = float(actual_values.max())
    predicted_peak_kw = float(predicted_values.max())

    actual_peak_time = evaluation.iloc[
        actual_values.argmax()
    ]["timestamp"]

    predicted_peak_time = evaluation.iloc[
        predicted_values.argmax()
    ]["timestamp"]

    peak_magnitude_error_kw = abs(
        actual_peak_kw - predicted_peak_kw
    )

    peak_timing_error_hours = abs(
        (
            actual_peak_time - predicted_peak_time
        ).total_seconds() / 3600
    )

    metrics = {
        **regression,
        "peak_threshold_kw": float(threshold),
        "n_true_peaks": int(peak_result["n_true_peaks"]),
        "peak_precision": (
            float(peak_result["precision"])
            if peak_result["n_true_peaks"] > 0
            else None
        ),
        "peak_recall": (
            float(peak_result["recall"])
            if peak_result["n_true_peaks"] > 0
            else None
        ),
        "peak_f1": (
            float(peak_result["f1"])
            if peak_result["n_true_peaks"] > 0
            else None
        ),
        "actual_peak_kw": actual_peak_kw,
        "predicted_peak_kw": predicted_peak_kw,
        "peak_magnitude_error_kw": peak_magnitude_error_kw,
        "actual_peak_time": str(actual_peak_time),
        "predicted_peak_time": str(predicted_peak_time),
        "peak_timing_error_hours": peak_timing_error_hours,
    }

    evaluation["error_kw"] = (
        evaluation["actual_load_kw"]
        - evaluation["predicted_load_kw"]
    )

    evaluation["absolute_error_kw"] = (
        evaluation["error_kw"].abs()
    )

    return evaluation, metrics

def save_artifacts(
    forecast_date,
    prepared,
    feature_eval,
    training_result,
    evaluation,
    metrics,
):
    output_dir = (
        ROOT
        / "data"
        / "processed"
        / "backtests"
        / forecast_date
    )

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    # Save trained model bundle
    model_path = output_dir / "load_forecaster.joblib"

    joblib.dump(
        training_result["bundle"],
        model_path,
    )

    # Save feature-ablation results
    feature_eval["results_df"].to_csv(
        output_dir / "feature_ablation.csv"
    )

    # Save hourly predicted vs actual results
    evaluation.to_csv(
        output_dir / "forecast_vs_actual.csv",
        index=False,
    )

    metadata = {
        "forecast_date_local": forecast_date,
        "building_id": str(prepared["building_id"]),
        "timezone": prepared["config"]["building"]["timezone"],
        "algorithm": training_result["bundle"]["model_name"],
        "selected_feature_set": training_result["best_feature_set"],
        "selected_features": training_result["selected_features"],
        "number_of_features": len(
            training_result["selected_features"]
        ),
        "training_rows": len(feature_eval["X"]),
        "target_start_utc": str(prepared["target_start"]),
        "target_end_utc": str(prepared["target_end"]),
        "weather_mode": "observed_historical",
        "provenance": prepared["provenance"],
    }

    with open(
        output_dir / "metrics.json",
        "w",
        encoding="utf-8",
    ) as f:
        json.dump(
            metrics,
            f,
            indent=2,
        )

    with open(
        output_dir / "metadata.json",
        "w",
        encoding="utf-8",
    ) as f:
        json.dump(
            metadata,
            f,
            indent=2,
        )

    return output_dir

def main():
    parser = argparse.ArgumentParser(
        description="Run a historical 24-hour GridShift forecast backtest."
    )

    parser.add_argument(
        "--date",
        required=True,
        help="Forecast date in building-local YYYY-MM-DD format.",
    )

    args = parser.parse_args()

    print(f"\nPreparing forecast for {args.date}...")

    prepared = prepare_forecast_data(args.date)

    if len(prepared["future_weather"]) != 24:
        raise ValueError(
            f"Expected 24 weather rows for {args.date}, "
            f"but found {len(prepared['future_weather'])}."
        )

    if len(prepared["actual"]) != 24:
        raise ValueError(
            f"Expected 24 actual load rows for {args.date}, "
            f"but found {len(prepared['actual'])}."
        )

    print("Running feature ablation...")

    feature_eval = evaluate_feature_sets(
        prepared["historical_df"]
    )

    print(
        f"Selected feature set: "
        f"{feature_eval['best_feature_set']}"
    )

    print("Training final LightGBM model...")

    training_result = train_and_forecast(
        prepared,
        feature_eval,
    )

    print("Evaluating 24-hour forecast...")

    evaluation, metrics = evaluate_forecast(
        prepared,
        training_result,
        feature_eval,
    )

    output_dir = save_artifacts(
        args.date,
        prepared,
        feature_eval,
        training_result,
        evaluation,
        metrics,
    )

    print("\nFeature ablation results:")
    print(feature_eval["results_df"].round(4))

    print("\n24-hour forecast metrics:")
    for key, value in metrics.items():
        print(f"{key}: {value}")

    print(
        f"\nArtifacts saved to:\n{output_dir}"
    )


if __name__ == "__main__":
    main()



