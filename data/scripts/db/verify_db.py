"""Exercise the real schema in a transaction that always rolls back."""

from uuid import uuid4

from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

if __package__:
    from .connection import get_engine
else:
    from connection import get_engine

TABLES = {
    "buildings", "energy_readings", "weather_observations", "weather_forecasts",
    "tariff_rates", "model_forecasts", "raw_building_load", "raw_weather_history",
    "raw_weather_forecast", "raw_tariffs",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main() -> None:
    engine = get_engine()
    try:
        with engine.connect() as connection:
            transaction = connection.begin()
            try:
                missing = TABLES - set(inspect(connection).get_table_names(schema="public"))
                require(not missing, f"Missing tables: {sorted(missing)}")
                building_id = connection.execute(text("""
                    INSERT INTO public.buildings (name, latitude, longitude)
                    VALUES ('Temporary schema verification', 47.6062, -122.3321)
                    RETURNING building_id
                """)).scalar_one()
                params = {"building": building_id}
                connection.execute(text("""
                    INSERT INTO public.energy_readings
                        (building_id, timestamp, load_kw, energy_kwh, source)
                    VALUES (:building, '2026-01-01T00:00:00Z', 100, 100, 'verification')
                """), params)
                # Same instant expressed with another offset must upsert, not duplicate.
                connection.execute(text("""
                    INSERT INTO public.energy_readings
                        (building_id, timestamp, load_kw, source)
                    VALUES (:building, '2025-12-31T16:00:00-08:00', 120, 'verification')
                    ON CONFLICT (building_id, timestamp) DO UPDATE
                    SET load_kw = EXCLUDED.load_kw
                """), params)
                connection.execute(text("""
                    INSERT INTO public.weather_observations
                        (building_id, timestamp, temperature_c, humidity_pct, wind_speed_mps, source)
                    VALUES (:building, '2026-01-01T00:00:00Z', 10, 70, 3, 'verification')
                """), params)
                row = connection.execute(text("""
                    SELECT e.load_kw, w.temperature_c, w.humidity_pct, w.wind_speed_mps
                    FROM public.energy_readings e JOIN public.weather_observations w
                      USING (building_id, timestamp)
                    WHERE e.building_id = :building
                """), params).one()
                require(tuple(row) == (120, 10, 70, 3), "ML input join/upsert failed")
                connection.execute(text("""
                    INSERT INTO public.weather_forecasts
                        (building_id, forecast_generated_at, forecast_timestamp, temperature_c)
                    VALUES (:building, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 11),
                           (:building, '2026-01-01T00:30:00Z', '2026-01-01T01:00:00Z', 12)
                """), params)
                connection.execute(text("""
                    INSERT INTO public.tariff_rates
                        (building_id, rate_name, period_type, energy_rate_per_kwh,
                         demand_rate_per_kw, effective_from, source)
                    VALUES (:building, 'Test only', 'flat', 0.10, 5, '2026-01-01', 'verification')
                """), params)
                connection.execute(text("""
                    INSERT INTO public.model_forecasts
                        (building_id, forecast_timestamp, predicted_load_kw,
                         peak_threshold_kw, is_peak, model_name, model_version)
                    VALUES (:building, '2026-01-01T01:00:00Z', 125, 120, true, 'test', 'v1')
                """), params)
                # Identifiers come only from this fixed internal allowlist.
                for table in sorted(name for name in TABLES if name.startswith("raw_")):
                    payload = connection.execute(text(f"""
                        INSERT INTO public.{table} (building_id, source, payload)
                        VALUES (:building, 'verification', '{{"value": 42}}'::jsonb)
                        RETURNING payload
                    """), params).scalar_one()
                    require(payload == {"value": 42}, f"JSONB roundtrip failed: {table}")

                def rejects(sql, sqlstate, values=None):
                    try:
                        with connection.begin_nested():
                            connection.execute(text(sql), values or params)
                    except IntegrityError as error:
                        require(error.orig.sqlstate == sqlstate, "Unexpected constraint failure")
                    else:
                        raise RuntimeError("Invalid data unexpectedly accepted")

                rejects("""INSERT INTO public.energy_readings (building_id, timestamp, load_kw, source)
                    VALUES (:building, '2026-01-01T00:00:00Z', 1, 'test')""", "23505")
                for value in ("-1", "'NaN'::float8", "'Infinity'::float8"):
                    rejects(f"""INSERT INTO public.energy_readings (building_id, timestamp, load_kw, source)
                        VALUES (:building, '2026-01-01T02:00:00Z', {value}, 'test')""", "23514")
                rejects("""UPDATE public.weather_observations SET humidity_pct = 101
                    WHERE building_id = :building""", "23514")
                rejects("""UPDATE public.tariff_rates SET effective_to = '2025-01-01'
                    WHERE building_id = :building""", "23514")
                rejects("""INSERT INTO public.energy_readings (building_id, timestamp, load_kw, source)
                    VALUES (:building, now(), 1, 'test')""", "23503", {"building": uuid4()})
                rejects("DELETE FROM public.buildings WHERE building_id = :building", "23503")
            finally:
                transaction.rollback()
            remaining = connection.execute(text(
                "SELECT count(*) FROM public.buildings WHERE building_id = :building"
            ), params).scalar_one()
            require(remaining == 0, "Verification data was not rolled back")
        print("PASS: all 10 tables; inserts; JSONB; timezone-aware upsert; ML join;")
        print("forecast versions; duplicate, range, date and foreign-key constraints.")
        print("All verification records rolled back; no test data retained.")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
