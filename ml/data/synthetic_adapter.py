"""
TEMPORARY PROTOTYPE ADAPTER.

Generates a synthetic commercial-building load + Seattle-like weather series in
the standard ML input contract. This file exists ONLY so the pipeline is
runnable before the teammate's real data lands.

Replace this module with:  real_adapter.py  ->  same output schema
    timestamp, load_kw, temperature_c, humidity_pct, wind_speed_mps

Nothing downstream (features / models / inference) needs to change.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

RANDOM_STATE = 42
BASE_TEMP_C = 18.0


def generate_synthetic_building(
    start: str = "2025-01-01", periods: int = 8760, seed: int = RANDOM_STATE
) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ts = pd.date_range(start=start, periods=periods, freq="h")
    hour = ts.hour.to_numpy()
    dow = ts.dayofweek.to_numpy()
    doy = ts.dayofyear.to_numpy()

    # --- Seattle-like weather -------------------------------------------------
    seasonal = 11.0 - 7.0 * np.cos(2 * np.pi * (doy - 15) / 365)
    daily = 3.0 * np.sin(2 * np.pi * (hour - 9) / 24)
    temperature = seasonal + daily + rng.normal(0, 1.6, periods)
    humidity = np.clip(88 - 1.4 * (temperature - 11) + rng.normal(0, 6, periods), 25, 100)
    wind = np.clip(rng.gamma(2.0, 1.6, periods), 0, 20)

    # --- commercial load pattern ---------------------------------------------
    occupancy = np.where(
        dow < 5,
        np.clip(np.sin(np.pi * (hour - 6) / 14), 0, None),  # weekday 06:00-20:00
        0.25 * np.clip(np.sin(np.pi * (hour - 8) / 10), 0, None),  # light weekend
    )
    heating = np.clip(BASE_TEMP_C - temperature, 0, None)
    cooling = np.clip(temperature - BASE_TEMP_C, 0, None)

    load = (
        140                      # base / always-on
        + 190 * occupancy        # lighting, plug loads, ventilation
        + 5.5 * heating
        + 9.0 * cooling
        + 0.8 * wind             # envelope losses
        + rng.normal(0, 7, periods)
    )
    # mild autocorrelation so lags carry real signal
    load = pd.Series(load).ewm(alpha=0.6).mean().to_numpy()
    load = np.clip(load, 60, None)

    return pd.DataFrame(
        {
            "timestamp": ts,
            "load_kw": load.round(3),
            "temperature_c": temperature.round(2),
            "humidity_pct": humidity.round(1),
            "wind_speed_mps": wind.round(2),
        }
    )


def write_prototype_csv(path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    generate_synthetic_building().to_csv(path, index=False)
    return path


if __name__ == "__main__":
    print(write_prototype_csv(Path(__file__).parent / "prototype_commercial_building.csv"))
