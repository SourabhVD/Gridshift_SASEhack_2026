"""Store an explicitly labeled historical 24-hour replay in model_forecasts."""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import pandas as pd
from sqlalchemy import text

from data.scripts.db.connection import get_engine
from data.scripts.run_selected_sources import CONFIG, selected_building_id
from ml.database_adapter import load_training_data
from ml.day_ahead import forecast_next_24_hours, weather_for_origin


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, default=Path("data/processed/selected_model/load_forecaster.joblib"))
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text())
    building_id = selected_building_id(config)
    bundle = joblib.load(args.artifact)  # Only load trusted artifacts created by this project.
    if bundle["metadata"]["building_id"] != str(building_id):
        raise ValueError("Model belongs to a different building")
    frame, _ = load_training_data(building_id)
    origin = len(frame) - 24
    if frame.index[origin] < pd.Timestamp(bundle["metadata"]["holdout_start"]):
        raise ValueError("Replay must follow the model's training period")
    result = forecast_next_24_hours(bundle, frame.iloc[:origin], weather_for_origin(frame, origin, "persistence"))
    generated_at = datetime.now(timezone.utc)
    records = [{"building": building_id, "generated": generated_at, "timestamp": row.timestamp,
                "load": float(row.predicted_load_kw), "name": "historical_replay:" + bundle["name"],
                "version": bundle["metadata"]["dataset_sha256"][:16]} for row in result.itertuples()]
    engine = get_engine()
    try:
        with engine.begin() as connection:
            connection.execute(text("""INSERT INTO public.model_forecasts
                (building_id, generated_at, forecast_timestamp, predicted_load_kw, model_name, model_version)
                VALUES (:building, :generated, :timestamp, :load, :name, :version)
            """), records)
    finally:
        engine.dispose()
    print(f"Saved {len(records)} historical-replay predictions (not current live forecasts).")


if __name__ == "__main__":
    main()
