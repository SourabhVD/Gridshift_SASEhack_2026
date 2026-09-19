import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Allow imports such as:
# from features.engineering import ...
ML_DIR = Path(__file__).resolve().parents[1]
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from evaluation.metrics import mape, regression_metrics
from features.engineering import (
    add_lag_features,
    add_rolling_features,
    build_feature_frame,
    create_features,
)
from models.load_forecaster import Naive24, chronological_split


def make_hourly_data(hours=200):
    timestamps = pd.date_range(
        "2026-01-01 00:00:00",
        periods=hours,
        freq="h",
    )

    return pd.DataFrame(
        {
            "timestamp": timestamps,
            "load_kw": np.arange(hours, dtype=float) + 100,
            "temperature_c": np.full(hours, 20.0),
            "humidity_pct": np.full(hours, 50.0),
            "wind_speed_mps": np.full(hours, 2.0),
        }
    )


def test_lag_features_use_previous_values():
    df = make_hourly_data()

    result = add_lag_features(df.copy())

    assert result.loc[24, "load_lag_24"] == df.loc[0, "load_kw"]
    assert result.loc[168, "load_lag_168"] == df.loc[0, "load_kw"]


def test_rolling_features_do_not_use_current_target():
    df = make_hourly_data()

    result = add_rolling_features(df.copy())

    # At row 24, the 3-hour rolling mean must use rows 21, 22, 23,
    # not row 24.
    expected = df.loc[21:23, "load_kw"].mean()

    assert result.loc[24, "rolling_mean_3h"] == expected


def test_feature_creation_drops_rows_without_enough_history():
    df = make_hourly_data()

    X, y, timestamps = create_features(df)

    # The longest lag is 168 hours, so the first 168 rows
    # do not have enough history.
    assert len(X) == len(df) - 168
    assert len(y) == len(X)
    assert len(timestamps) == len(X)

    assert "load_lag_168" in X.columns
    assert "temperature_squared" in X.columns
    assert "hour_sin" in X.columns


def test_mape():
    y_true = np.array([100.0, 200.0])
    y_pred = np.array([110.0, 180.0])

    result = mape(y_true, y_pred)

    assert np.isclose(result, 10.0)


def test_regression_metrics():
    y_true = np.array([100.0, 200.0, 300.0])
    y_pred = np.array([100.0, 210.0, 290.0])

    metrics = regression_metrics(y_true, y_pred)

    assert set(metrics) == {"MAE_kW", "RMSE_kW", "MAPE_pct", "R2"}
    assert metrics["MAE_kW"] > 0
    assert metrics["RMSE_kW"] > 0


def test_naive_24_uses_24_hour_lag():
    X = pd.DataFrame(
        {
            "load_lag_24": [100.0, 200.0, 300.0],
        }
    )

    model = Naive24()
    model.fit(X)

    predictions = model.predict(X)

    np.testing.assert_array_equal(
        predictions,
        np.array([100.0, 200.0, 300.0]),
    )


def test_chronological_split_preserves_time_order():
    df = make_hourly_data()

    X, y, timestamps = create_features(df)

    split = chronological_split(X, y, timestamps)

    assert len(split.X_train) > 0
    assert len(split.X_val) > 0
    assert len(split.X_test) > 0

    assert split.ts_train.max() < split.ts_val.min()
    assert split.ts_val.max() < split.ts_test.min()


def test_build_feature_frame_contains_expected_features():
    df = make_hourly_data()

    frame = build_feature_frame(df.copy())

    expected_columns = {
        "hour",
        "day_of_week",
        "day_of_year",
        "month",
        "is_weekend",
        "hour_sin",
        "hour_cos",
        "dow_sin",
        "dow_cos",
        "temperature_squared",
        "heating_degree",
        "cooling_degree",
        "load_lag_1",
        "load_lag_24",
        "load_lag_168",
        "rolling_mean_3h",
        "rolling_mean_6h",
        "rolling_mean_24h",
        "rolling_std_24h",
    }

    assert expected_columns.issubset(frame.columns)