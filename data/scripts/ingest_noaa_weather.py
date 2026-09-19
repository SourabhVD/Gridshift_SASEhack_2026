"""Fetch NOAA NCEI Global Hourly observations in bounded UTC date windows."""

import json
import math
import re
from collections import defaultdict
from datetime import date, datetime, time, timedelta

try:
    from .ingestion_common import UTC, archive, building, cache_bytes, fetch, get_engine, instant, number, parser, report, session, upsert
except ImportError:
    from ingestion_common import UTC, archive, building, cache_bytes, fetch, get_engine, instant, number, parser, report, session, upsert

ENDPOINT = "https://www.ncei.noaa.gov/access/services/data/v1"
SOURCE = "NOAA_NCEI_ISD"


def decode_scalar(value):
    parts = str(value).split(",")
    if len(parts) != 2 or parts[1] not in {"1", "5"} or parts[0].lstrip("+-") == "9999":
        raise ValueError("Missing or untrusted NOAA scalar")
    return number(parts[0]) / 10


def normalize(records, building_id, station, start, end):
    buckets, seen, skipped = defaultdict(list), set(), 0
    for record in records:
        if str(record.get("STATION")) != station:
            raise ValueError("NOAA response contains a different station")
        stamp = instant(record["DATE"], allow_naive=True)  # ISD dates are UTC.
        if not start <= stamp < end:
            continue
        try:
            temperature = decode_scalar(record.get("TMP"))
            dewpoint = decode_scalar(record.get("DEW"))
            number(temperature, -100, 70)
            number(dewpoint, -100, 70)
            if dewpoint > temperature + 0.5:
                raise ValueError("Dew point exceeds temperature")
            wind = str(record.get("WND")).split(",")
            if len(wind) != 5 or wind[4] not in {"1", "5"} or wind[3] == "9999":
                raise ValueError("Missing or untrusted NOAA wind")
            speed = number(wind[3], 0) / 10
            # Magnus approximation over water; derived RH, not an observed RH field.
            humidity = min(100.0, 100 * math.exp(17.625 * dewpoint / (243.04 + dewpoint)
                                                - 17.625 * temperature / (243.04 + temperature)))
        except (ValueError, TypeError):
            skipped += 1
            continue
        if stamp in seen:
            continue
        seen.add(stamp)
        buckets[stamp.replace(minute=0, second=0, microsecond=0)].append((temperature, humidity, speed))
    rows = []
    for stamp, values in sorted(buckets.items()):
        averages = [sum(column) / len(values) for column in zip(*values)]
        rows.append({"building_id": building_id, "timestamp": stamp, "temperature_c": averages[0],
                     "humidity_pct": averages[1], "wind_speed_mps": averages[2], "source": SOURCE})
    expected = int((end - start).total_seconds() // 3600)
    return rows, {"source_records": len(records), "rejected_records": skipped,
                  "missing_hours": expected - len(rows), "humidity_method": "Magnus from temperature/dewpoint"}


def windows(start, end):
    while start < end:
        stop = min(start + timedelta(days=7), end)
        yield start, stop
        start = stop


def main():
    cli = parser(__doc__)
    cli.add_argument("--station", required=True, help="11-digit ISD station ID; choose a station near the building")
    cli.add_argument("--start", type=date.fromisoformat, required=True, help="First UTC date, inclusive")
    cli.add_argument("--end", type=date.fromisoformat, required=True, help="Last UTC date, exclusive")
    args = cli.parse_args()
    if not re.fullmatch(r"\d{11}", args.station) or args.start >= args.end:
        cli.error("Use an 11-digit station ID and start < end")
    start, end = (datetime.combine(value, time.min, UTC) for value in (args.start, args.end))
    engine = get_engine()
    try:
        building(engine, args.building_id)
        totals = {"source_records": 0, "rejected_records": 0, "missing_hours": 0}
        count = 0
        with session() as client:
            for first, stop in windows(start, end):
                params = {"dataset": "global-hourly", "stations": args.station,
                          "startDate": first.isoformat(), "endDate": (stop - timedelta(seconds=1)).isoformat(),
                          "dataTypes": "TMP,DEW,WND", "format": "json", "includeAttributes": "true"}
                content = fetch(client, ENDPOINT, params=params)
                cached, digest = cache_bytes("weather_history", content, ".json")
                records = json.loads(content)
                archive(engine, "raw_weather_history", args.building_id, SOURCE,
                        {"url": ENDPOINT, "params": params, "sha256": digest, "response": records}, args.dry_run)
                if not isinstance(records, list):
                    raise ValueError("Expected a NOAA list response; raw response cached")
                rows, stats = normalize(records, args.building_id, args.station, first, stop)
                # Empty windows are reported, never filled with synthetic weather.
                if rows:
                    count += upsert(engine, "weather_observations", rows, ["building_id", "timestamp"], args.dry_run)
                for key in totals:
                    totals[key] += stats[key]
        report(SOURCE, count, args.dry_run, **totals, station=args.station)
        if not count:
            raise ValueError("No valid hourly weather found; check station, dates and source quality flags")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
