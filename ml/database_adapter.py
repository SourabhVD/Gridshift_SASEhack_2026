"""Database-to-ML contract with real hourly alignment and explicit provenance."""

import numpy as np
import pandas as pd
from sqlalchemy import text

from data.scripts.db.connection import get_engine

WEATHER = ["temperature_c", "humidity_pct", "wind_speed_mps"]


def load_training_data(building_id):
    engine = get_engine()
    try:
        with engine.connect() as connection:
            frame = pd.read_sql(text("""
                SELECT e.timestamp, e.load_kw, w.temperature_c, w.humidity_pct,
                       w.wind_speed_mps, e.source AS load_source, w.source AS weather_source
                FROM public.energy_readings e
                LEFT JOIN public.weather_observations w USING (building_id, timestamp)
                WHERE e.building_id = :id AND e.quality_flag IN ('valid', 'estimated')
                ORDER BY e.timestamp
            """), connection, params={"id": building_id})
        if frame.empty:
            raise ValueError("No load data for this building")
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
        if frame["timestamp"].duplicated().any():
            raise ValueError("Duplicate timestamps in database frame")
        provenance = {"load_sources": sorted(frame.load_source.dropna().unique().tolist()),
                      "weather_sources": sorted(frame.weather_source.dropna().unique().tolist())}
        frame = frame.set_index("timestamp").asfreq("h")
        if frame.load_kw.isna().any() or not np.isfinite(frame.load_kw).all():
            raise ValueError("Load history has gaps/nonfinite values; do not shift across missing hours")
        provenance["missing_weather_hours_before_fill"] = int(frame[WEATHER].isna().any(axis=1).sum())
        # Past-only, bounded fill. Longer gaps remain NaN, handled by LightGBM.
        frame[WEATHER] = frame[WEATHER].ffill(limit=3)
        provenance["missing_weather_hours_after_fill"] = int(frame[WEATHER].isna().any(axis=1).sum())
        return frame[["load_kw", *WEATHER]], provenance
    finally:
        engine.dispose()
