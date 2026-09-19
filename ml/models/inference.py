"""
GridShift Component 2 — 24-hour inference.

Recursive strategy (acceptable for the MVP; a direct multi-horizon model is the
alternative and is a decision for the team, not a silent switch).

    forecast_next_24_hours(bundle, history, future_weather)
        -> DataFrame[timestamp, predicted_load_kw]
"""

from __future__ import annotations

import pandas as pd

from features.engineering import (
    LAGS,
    REQUIRED_COLUMNS,
    build_feature_frame,
    load_standard_frame,
)

WEATHER_COLUMNS = ["timestamp", "temperature_c", "humidity_pct", "wind_speed_mps"]
MIN_HISTORY_HOURS = max(LAGS)


def forecast_next_24_hours(bundle: dict, history, future_weather: pd.DataFrame, horizon: int = 24):
    """
    bundle          : dict from models.load_forecaster.load_model()
    history         : CSV path or DataFrame in the standard input contract,
                      ending at the last observed hour
    future_weather  : DataFrame with timestamp + the three weather columns for
                      the next `horizon` hours (NWS forecast in production)
    """
    model = bundle["model"]
    feature_names = bundle["feature_names"]

    hist = load_standard_frame(history)
    if len(hist) < MIN_HISTORY_HOURS + 1:
        raise ValueError(
            f"Need at least {MIN_HISTORY_HOURS + 1} hours of history "
            f"(longest lag is {MIN_HISTORY_HOURS}h); got {len(hist)}."
        )

    missing = [c for c in WEATHER_COLUMNS if c not in future_weather.columns]
    if missing:
        raise ValueError(f"future_weather is missing columns: {missing}")

    future = future_weather[WEATHER_COLUMNS].copy()
    future["timestamp"] = pd.to_datetime(future["timestamp"])
    future = future.sort_values("timestamp").head(horizon).reset_index(drop=True)
    if len(future) < horizon:
        raise ValueError(f"future_weather has {len(future)} rows; {horizon} required.")

    # keep only the history the features actually need
    work = hist.tail(MIN_HISTORY_HOURS + 48).copy()
    future["load_kw"] = float("nan")
    work = pd.concat([work[REQUIRED_COLUMNS], future[REQUIRED_COLUMNS]], ignore_index=True)
    work["load_kw"] = work["load_kw"].astype(float)

    start = len(work) - horizon
    for i in range(horizon):
        row_idx = start + i
        frame = build_feature_frame(work)
        X_row = frame.loc[[row_idx], feature_names]
        pred = float(model.predict(X_row)[0])
        work.loc[row_idx, "load_kw"] = pred  # feeds the next step's lags

    return pd.DataFrame(
        {
            "timestamp": work.loc[start:, "timestamp"].reset_index(drop=True),
            "predicted_load_kw": work.loc[start:, "load_kw"].astype(float).round(3).reset_index(drop=True),
        }
    )
