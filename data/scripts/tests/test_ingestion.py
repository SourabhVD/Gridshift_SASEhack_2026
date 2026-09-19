"""Offline conversion tests and optional rollback-only PostgreSQL integration."""

import os
import json
import sys
from contextlib import contextmanager, nullcontext
from datetime import date, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pandas as pd
import pytest
from sqlalchemy import text

from data.scripts import ingest_building_load as load
from data.scripts import ingest_noaa_weather as noaa
from data.scripts import ingest_nws_forecast as nws
from data.scripts import ingest_tariffs as tariffs
from data.scripts.ingestion_common import UTC, archive, get_engine, upsert


def load_rows(frame, **overrides):
    options = dict(source="ComStock", timestamp_column="timestamp", value_column="kwh", unit="kwh",
                   interval_minutes=15, timestamp_position="end", source_timezone="Etc/GMT+5")
    options.update(overrides)
    return load.normalize(frame, uuid4(), **options)


def intervals():
    return pd.DataFrame({"timestamp": pd.date_range("2018-07-01 00:15", periods=4, freq="15min"),
                         "kwh": [10, 20, 30, 40]})


def test_comstock_energy_and_fixed_est_in_summer():
    rows, stats = load_rows(intervals())
    assert rows[0]["timestamp"] == datetime(2018, 7, 1, 5, tzinfo=UTC)
    assert rows[0]["load_kw"] == rows[0]["energy_kwh"] == 100
    assert rows[0]["quality_flag"] == "estimated"
    assert stats["incomplete_or_missing_hours"] == 0


def test_meter_power_is_time_weighted():
    rows, _ = load_rows(intervals(), source="meter", unit="kw")
    assert rows[0]["energy_kwh"] == 25


def test_partial_hour_is_not_a_low_load_hour():
    rows, stats = load_rows(intervals().iloc[:3])
    assert rows == []
    assert stats["incomplete_or_missing_hours"] == 1


@pytest.mark.parametrize("value", [-1, float("nan"), float("inf")])
def test_bad_energy_rejected(value):
    frame = intervals()
    frame["kwh"] = frame["kwh"].astype(float)
    frame.loc[0, "kwh"] = value
    with pytest.raises(ValueError):
        load_rows(frame)


def test_duplicate_interval_rejected():
    frame = pd.concat([intervals(), intervals().iloc[:1]])
    with pytest.raises(ValueError, match="duplicate"):
        load_rows(frame)


def test_offset_aware_meter_preserves_repeated_dst_hour():
    frame = pd.DataFrame({"timestamp": ["2025-11-02T01:00:00-07:00", "2025-11-02T01:00:00-08:00"], "kwh": [10, 20]})
    rows, _ = load_rows(frame, source="meter", interval_minutes=60, timestamp_position="start")
    assert [row["timestamp"].hour for row in rows] == [8, 9]


def test_comstock_aggregate_rejected():
    frame = intervals()
    frame["models_used"] = 5
    with pytest.raises(ValueError, match="Aggregate"):
        load_rows(frame)


def observation(stamp="2018-01-01T00:15:00", **changes):
    row = {"STATION": "72793024233", "DATE": stamp, "TMP": "+0100,1",
           "DEW": "+0050,1", "WND": "090,1,N,0030,1"}
    return {**row, **changes}


def test_noaa_quality_conversion_and_missing_hours():
    start = datetime(2018, 1, 1, tzinfo=UTC)
    rows, stats = noaa.normalize([observation(), observation("2018-01-01T00:45:00"),
                                 observation("2018-01-01T01:15:00", TMP="+9999,9")],
                                uuid4(), "72793024233", start, start + timedelta(hours=2))
    assert len(rows) == 1
    assert rows[0]["temperature_c"] == 10
    assert rows[0]["wind_speed_mps"] == 3
    assert 70 < rows[0]["humidity_pct"] < 72
    assert stats["missing_hours"] == stats["rejected_records"] == 1


def test_noaa_station_mismatch():
    start = datetime(2018, 1, 1, tzinfo=UTC)
    with pytest.raises(ValueError, match="station"):
        noaa.normalize([observation()], uuid4(), "00000000000", start, start + timedelta(days=1))


def forecast():
    start = datetime(2026, 1, 1, tzinfo=UTC)
    return {"properties": {"updateTime": start.isoformat(), "periods": [
        {"startTime": (start + timedelta(hours=i)).isoformat(),
         "endTime": (start + timedelta(hours=i + 1)).isoformat(),
         "temperature": 50, "temperatureUnit": "F", "windSpeed": "5 to 10 mph",
         "relativeHumidity": {"value": 70, "unitCode": "wmoUnit:percent"}}
        for i in range(25)]}}


def test_nws_next_24_complete_hours_and_conversions():
    rows = nws.normalize(forecast(), uuid4(), datetime(2026, 1, 1, 0, 1, tzinfo=UTC))
    assert len(rows) == 24
    assert rows[0]["forecast_timestamp"].hour == 1
    assert rows[0]["temperature_c"] == 10
    assert rows[0]["wind_speed_mps"] == pytest.approx(7.5 * .44704)


def test_nws_missing_hours_fail():
    payload = forecast()
    payload["properties"]["periods"].pop(5)
    with pytest.raises(ValueError, match="incomplete"):
        nws.normalize(payload, uuid4(), datetime(2026, 1, 1, 0, 1, tzinfo=UTC))


def test_nws_quantitative_units_and_missing_wind():
    assert nws.wind_mps({"value": 36, "unitCode": "wmoUnit:km_h-1"}) == 10
    assert nws.wind_mps(None) is None
    with pytest.raises(ValueError):
        nws.wind_mps("gusting 50")


TARIFF_HTML = """<h2>Small Business Rates</h2><h3>Flat Rate Pricing</h3>
<table><tr><th>Rate Type</th><th>City of Seattle (C)</th></tr>
<tr><td>Energy charger per kWh</td><td>$0.1241</td></tr></table>
<h2>Medium Business Rates (50 - 999 kW)</h2><h3>Flat Rate Pricing</h3>
<table><tr><th>Rate Type</th><th>City of Seattle (C)</th><th>Downtown Network (D)</th></tr>
<tr><td>Energy charge per kWh</td><td>$0.0990</td><td>$0.1106</td></tr>
<tr><td>Demand Charge per kW</td><td>$5.36</td><td>$12.19</td></tr></table>
<h3>Time of Use Rate Pricing (coming soon)</h3><table></table>"""


def test_tariff_section_location_units_and_stable_identity():
    building = uuid4()
    rows = tariffs.normalize(TARIFF_HTML, building, "medium", "D", date(2026, 1, 1))
    assert rows[0]["energy_rate_per_kwh"] == Decimal("0.1106")
    assert rows[0]["demand_rate_per_kw"] == Decimal("12.19")
    assert rows == tariffs.normalize(TARIFF_HTML, building, "medium", "D", date(2026, 1, 1))
    assert tariffs.normalize(TARIFF_HTML, building, "small", "C", date(2026, 1, 1))[0]["demand_rate_per_kw"] is None


def test_tariff_layout_change_fails_closed():
    with pytest.raises(ValueError):
        tariffs.normalize(TARIFF_HTML.replace("Energy charge per kWh", "New tiered tariff"),
                          uuid4(), "medium", "C", date(2026, 1, 1))


@pytest.mark.skipif(os.environ.get("GRIDSHIFT_TEST_DB") != "1", reason="Set GRIDSHIFT_TEST_DB=1 for local PostgreSQL tests")
def test_database_raw_archives_upserts_dry_run_and_atomicity(monkeypatch, tmp_path):
    engine = get_engine()
    building_id = uuid4()
    with engine.connect() as connection:
        transaction = connection.begin()
        class BoundEngine:
            def dispose(self):
                pass

            def connect(self):
                return nullcontext(connection)

            @contextmanager
            def begin(self):
                with connection.begin_nested():
                    yield connection
        bound = BoundEngine()
        try:
            upsert(bound, "buildings", [{"building_id": building_id, "name": "Temporary ingestion test",
                                        "latitude": 47.6, "longitude": -122.3,
                                        "utility": "Seattle City Light"}], ["building_id"])
            load_data, _ = load_rows(intervals())
            load_data[0]["building_id"] = building_id
            weather, _ = noaa.normalize([observation()], building_id, "72793024233",
                                        datetime(2018, 1, 1, tzinfo=UTC), datetime(2018, 1, 2, tzinfo=UTC))
            sets = [("energy_readings", load_data, ["building_id", "timestamp"]),
                    ("weather_observations", weather, ["building_id", "timestamp"]),
                    ("weather_forecasts", nws.normalize(forecast(), building_id, datetime(2026, 1, 1, tzinfo=UTC)),
                     ["building_id", "forecast_generated_at", "forecast_timestamp"]),
                    ("tariff_rates", tariffs.normalize(TARIFF_HTML, building_id, "medium", "C", date(2026, 1, 1)), ["tariff_id"])]
            for name, rows, keys in sets:
                upsert(bound, name, rows, keys, dry_run=True)
                assert connection.execute(text(f"SELECT count(*) FROM public.{name} WHERE building_id=:id"), {"id": building_id}).scalar_one() == 0
                upsert(bound, name, rows, keys)
                upsert(bound, name, rows, keys)
                assert connection.execute(text(f"SELECT count(*) FROM public.{name} WHERE building_id=:id"), {"id": building_id}).scalar_one() == len(rows)
            for name in ("raw_building_load", "raw_weather_history", "raw_weather_forecast", "raw_tariffs"):
                archive(bound, name, building_id, "test", {"original": [1, 2]}, dry_run=True)
                archive(bound, name, building_id, "test", {"original": [1, 2]})
                value = connection.execute(text(f"SELECT payload FROM public.{name} WHERE building_id=:id"), {"id": building_id}).scalar_one()
                assert value == {"original": [1, 2]}
            # A failed normalized write must not remove the previously archived source.
            from sqlalchemy.exc import IntegrityError
            bad = {**load_data[0], "load_kw": -1}
            with pytest.raises(IntegrityError):
                upsert(bound, "energy_readings", [bad], ["building_id", "timestamp"])
            assert connection.execute(text("SELECT count(*) FROM public.raw_building_load WHERE building_id=:id"), {"id": building_id}).scalar_one() == 1
            # Exercise complete CLI paths, including archive serialization and lookups.
            from data.scripts import ingestion_common
            monkeypatch.setattr(ingestion_common, "RAW_ROOT", tmp_path / "raw")
            for module in (load, noaa, nws, tariffs):
                monkeypatch.setattr(module, "get_engine", lambda: bound)
            source_file = tmp_path / "load.csv"
            intervals().to_csv(source_file, index=False)
            base = ["ingest", "--building-id", str(building_id)]
            monkeypatch.setattr(sys, "argv", base + ["--file", str(source_file), "--value-column", "kwh", "--unit", "kwh"])
            load.main()
            monkeypatch.setattr(noaa, "fetch", lambda *a, **kw: json.dumps([observation()]).encode())
            monkeypatch.setattr(sys, "argv", base + ["--station", "72793024233", "--start", "2018-01-01", "--end", "2018-01-02"])
            noaa.main()
            monkeypatch.setattr(tariffs, "fetch", lambda *a, **kw: TARIFF_HTML.encode())
            monkeypatch.setattr(sys, "argv", base + ["--rate-class", "medium", "--location", "C", "--effective-from", "2026-01-01"])
            tariffs.main()
            now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
            payload = forecast()
            payload["properties"]["updateTime"] = now.isoformat()
            for i, period in enumerate(payload["properties"]["periods"]):
                period["startTime"] = (now + timedelta(hours=i)).isoformat()
                period["endTime"] = (now + timedelta(hours=i + 1)).isoformat()
            def nws_fetch(client, url):
                data = {"properties": {"forecastHourly": "https://api.weather.gov/test-hourly"}} if "/points/" in url else payload
                return json.dumps(data).encode()
            monkeypatch.setattr(nws, "fetch", nws_fetch)
            monkeypatch.setattr(sys, "argv", base + ["--user-agent", "GridShift unit test"])
            nws.main()
        finally:
            transaction.rollback()
    engine.dispose()
