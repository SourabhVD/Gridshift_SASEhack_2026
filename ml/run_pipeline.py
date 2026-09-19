"""
GridShift Component 2 — end-to-end pipeline.

    python run_pipeline.py                      # synthetic prototype data
    python run_pipeline.py --data path/to.csv   # any standard-contract CSV

Steps: load -> features -> chronological split -> train/compare -> evaluate
       -> save best model -> feature importance -> demo 24h forecast.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from data.synthetic_adapter import write_prototype_csv
from evaluation.metrics import peak_metrics, provisional_peak_threshold
from features.engineering import create_features, load_standard_frame
from models.inference import forecast_next_24_hours
from models.load_forecaster import feature_importance, load_model, save_model, train_models

ROOT = Path(__file__).parent


def main(data_path: str | None, peak_threshold: float | None, peak_quantile: float) -> None:
    if data_path is None:
        data_path = ROOT / "data" / "prototype_commercial_building.csv"
        if not Path(data_path).exists():
            write_prototype_csv(data_path)
        print(f"[data] TEMPORARY synthetic prototype data: {data_path}")
    else:
        print(f"[data] {data_path}")

    X, y, ts = create_features(data_path)
    print(f"[features] {X.shape[0]} usable rows x {X.shape[1]} features")

    result = train_models(X, y, ts)
    print("\n[model comparison] (chronological 70/15/15)")
    print(result.comparison.to_string())
    print(f"\n[best learned model by validation MAE] {result.best_name}")

    (ROOT / "evaluation").mkdir(exist_ok=True)
    result.comparison.to_csv(ROOT / "evaluation" / "model_comparison.csv")

    # --- peak classification (SECONDARY metric) ------------------------------
    if peak_threshold is None:
        peak_threshold = provisional_peak_threshold(result.split.y_train, peak_quantile)
        label = f"PROVISIONAL ({peak_quantile:.0%} of training load)"
    else:
        label = "team-configured"
    print(f"\n[peak threshold] {peak_threshold:.4f} kW — {label}")

    peak_rows = {
        name: peak_metrics(result.split.y_test, pred, peak_threshold)
        for name, pred in result.predictions.items()
    }
    peak_table = pd.DataFrame(peak_rows).T.sort_values("f1", ascending=False).round(4)
    peak_table.to_csv(ROOT / "evaluation" / "peak_metrics_provisional.csv")
    print(peak_table.to_string())

    # --- persist -------------------------------------------------------------
    artifact = save_model(
        result,
        ROOT / "artifacts" / "load_forecaster.joblib",
        extra={"peak_threshold_kw": peak_threshold, "peak_threshold_source": label},
    )
    print(f"\n[artifact] {artifact}")

    imp = feature_importance(result.best_model, result.feature_names)
    if imp is not None:
        imp.to_csv(ROOT / "evaluation" / "feature_importance.csv", index=False)
        print("\n[top features]")
        print(imp.head(10).to_string(index=False))

    # --- demo 24h forecast ---------------------------------------------------
    df = load_standard_frame(data_path)
    history = df.iloc[:-24]
    future_weather = df.iloc[-24:][
        ["timestamp", "temperature_c", "humidity_pct", "wind_speed_mps"]
    ]
    forecast = forecast_next_24_hours(load_model(artifact), history, future_weather)
    forecast.to_csv(ROOT / "evaluation" / "demo_forecast_24h.csv", index=False)
    actual = df.iloc[-24:]["load_kw"].to_numpy()
    mae = float(abs(actual - forecast["predicted_load_kw"].to_numpy()).mean())
    print(f"\n[demo 24h recursive forecast] MAE over the held-out last day: {mae:.3f} kW")
    print(forecast.head(6).to_string(index=False))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--data", default=None, help="CSV in the standard input contract")
    p.add_argument("--peak-threshold", type=float, default=None, help="kW; team-defined")
    p.add_argument("--peak-quantile", type=float, default=0.95)
    a = p.parse_args()
    main(a.data, a.peak_threshold, a.peak_quantile)
