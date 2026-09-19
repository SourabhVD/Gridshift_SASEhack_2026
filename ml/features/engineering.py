"""
GridShift Component 2 — feature engineering.

Input contract (TEMPORARY — see docs/ml-forecasting.md):
    timestamp, load_kw, temperature_c, humidity_pct, wind_speed_mps

Framing: each row is a TARGET timestamp `ts`.
    - target        = load_kw at ts
    - calendar      = derived from ts (always knowable in advance)
    - weather       = weather at ts (historical for training, NWS forecast at inference)
    - lag features  = load at ts-1h, ts-2h, ts-3h, ts-24h, ts-48h, ts-168h
    - rolling stats = computed on load STRICTLY BEFORE ts (shift(1) then rolling)

This framing makes leakage structurally impossible: no feature ever touches
load at ts or later.
"""

from __future__ import annotations

import warnings
from typing import Iterable

import numpy as np
import pandas as pd

REQUIRED_COLUMNS = ["timestamp", "load_kw", "temperature_c", "humidity_pct", "wind_speed_mps"]
TARGET = "load_kw"

LAGS: tuple[int, ...] = (1, 2, 3, 24, 48, 168)
ROLLING_WINDOWS: dict[str, int] = {"rolling_mean_3h": 3, "rolling_mean_6h": 6, "rolling_mean_24h": 24}
ROLLING_STD_WINDOW = 24
BASE_TEMP_C = 18.0  # balance point for heating/cooling degree hours


def load_standard_frame(source) -> pd.DataFrame:
    """Accept a CSV path or a DataFrame and return a validated, sorted standard frame.

    This is the ONLY place the ML code touches the data source. A teammate's
    database adapter only has to produce this schema.
    """
    df = source.copy() if isinstance(source, pd.DataFrame) else pd.read_csv(source)

    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"Input frame is missing required columns: {missing}")

    df = df[REQUIRED_COLUMNS].copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = (
        df.sort_values("timestamp")
        .drop_duplicates(subset="timestamp", keep="last")
        .reset_index(drop=True)
    )

    gaps = df["timestamp"].diff().dropna()
    if not gaps.empty:
        irregular = (gaps != pd.Timedelta(hours=1)).sum()
        if irregular:
            warnings.warn(
                f"{irregular} of {len(gaps)} timestamp steps are not exactly 1 hour. "
                "Lag/rolling features assume regular hourly spacing — resample or "
                "reindex before training on real data.",
                stacklevel=2,
            )
    return df


def add_calendar_features(df: pd.DataFrame) -> pd.DataFrame:
    ts = df["timestamp"].dt
    df["hour"] = ts.hour
    df["day_of_week"] = ts.dayofweek
    df["day_of_year"] = ts.dayofyear
    df["month"] = ts.month
    df["is_weekend"] = (df["day_of_week"] >= 5).astype(int)

    # cyclical encodings so 23:00 and 00:00 are neighbours
    df["hour_sin"] = np.sin(2 * np.pi * df["hour"] / 24)
    df["hour_cos"] = np.cos(2 * np.pi * df["hour"] / 24)
    df["dow_sin"] = np.sin(2 * np.pi * df["day_of_week"] / 7)
    df["dow_cos"] = np.cos(2 * np.pi * df["day_of_week"] / 7)
    return df


def add_weather_features(df: pd.DataFrame, base_temp_c: float = BASE_TEMP_C) -> pd.DataFrame:
    df["temperature_squared"] = df["temperature_c"] ** 2
    df["heating_degree"] = (base_temp_c - df["temperature_c"]).clip(lower=0)
    df["cooling_degree"] = (df["temperature_c"] - base_temp_c).clip(lower=0)
    return df


def add_lag_features(df: pd.DataFrame, lags: Iterable[int] = LAGS) -> pd.DataFrame:
    for lag in lags:
        df[f"load_lag_{lag}"] = df[TARGET].shift(lag)
    return df


def add_rolling_features(df: pd.DataFrame) -> pd.DataFrame:
    past = df[TARGET].shift(1)  # strictly before the target hour
    for name, window in ROLLING_WINDOWS.items():
        df[name] = past.rolling(window).mean()
    df["rolling_std_24h"] = past.rolling(ROLLING_STD_WINDOW).std()
    return df


def build_feature_frame(df: pd.DataFrame, base_temp_c: float = BASE_TEMP_C) -> pd.DataFrame:
    """Full feature frame, still containing timestamp and the target column."""
    out = df.copy()
    out = add_calendar_features(out)
    out = add_weather_features(out, base_temp_c=base_temp_c)
    out = add_lag_features(out)
    out = add_rolling_features(out)
    return out


def feature_columns(frame: pd.DataFrame) -> list[str]:
    return [c for c in frame.columns if c not in ("timestamp", TARGET)]


def create_features(source, base_temp_c: float = BASE_TEMP_C):
    """Return (X, y, timestamps) ready for a chronological split.

    Rows without enough history (the first `max(LAGS)` hours) are dropped.
    """
    df = load_standard_frame(source)
    frame = build_feature_frame(df, base_temp_c=base_temp_c)
    frame = frame.dropna().reset_index(drop=True)

    cols = feature_columns(frame)
    X = frame[cols]
    y = frame[TARGET]
    timestamps = frame["timestamp"]
    return X, y, timestamps
