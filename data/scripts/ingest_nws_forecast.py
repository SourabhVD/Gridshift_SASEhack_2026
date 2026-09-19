"""Resolve NWS /points and ingest the next complete hourly forecast periods."""

import json
import os
import re
from datetime import datetime, timedelta
from urllib.parse import urlparse

try:
    from .ingestion_common import UTC, archive, building, cache_bytes, fetch, get_engine, instant, number, parser, report, session, upsert
except ImportError:
    from ingestion_common import UTC, archive, building, cache_bytes, fetch, get_engine, instant, number, parser, report, session, upsert


def temperature_c(value, unit):
    value = number(value)
    if unit in ("F", "wmoUnit:degF"):
        value = (value - 32) * 5 / 9
    elif unit not in ("C", "wmoUnit:degC"):
        raise ValueError(f"Unsupported temperature unit: {unit}")
    return number(value, -100, 70)


def wind_mps(value):
    if value is None:
        return None
    if isinstance(value, dict):
        if value.get("value") is None:
            return None
        factors = {"wmoUnit:km_h-1": 1 / 3.6, "wmoUnit:m_s-1": 1, "wmoUnit:mi_h-1": 0.44704,
                   "wmoUnit:kn": 0.514444}
        if value.get("unitCode") not in factors:
            raise ValueError("Unknown NWS quantitative wind unit")
        return number(value["value"], 0) * factors[value["unitCode"]]
    if value.lower().strip() == "calm":
        return 0.0
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)(?:\s+to\s+(\d+(?:\.\d+)?))?\s+(mph|km/h|m/s|knots)\s*", value)
    if not match:
        raise ValueError(f"Unsupported NWS wind value: {value!r}")
    low, high, unit = match.groups()
    low, high = float(low), float(high or low)
    if high < low:
        raise ValueError("Reversed wind range")
    return (low + high) / 2 * {"mph": 0.44704, "km/h": 1 / 3.6, "m/s": 1, "knots": 0.514444}[unit]


def normalize(payload, building_id, as_of, hours=24):
    props = payload["properties"]
    issued = instant(props.get("updateTime") or props["generatedAt"])
    first = as_of.replace(minute=0, second=0, microsecond=0)
    if first < as_of:
        first += timedelta(hours=1)
    by_time = {}
    for period in props["periods"]:
        stamp, stop = instant(period["startTime"]), instant(period["endTime"])
        if not first <= stamp < first + timedelta(hours=hours):
            continue
        if stop - stamp != timedelta(hours=1) or stamp.minute or stamp.second or stamp.microsecond:
            raise ValueError("NWS returned a non-hourly period")
        if stamp in by_time:
            raise ValueError("NWS returned duplicate hours")
        temperature = period["temperature"]
        if isinstance(temperature, dict):
            converted = temperature_c(temperature["value"], temperature["unitCode"])
        else:
            converted = temperature_c(temperature, period["temperatureUnit"])
        humidity = period.get("relativeHumidity") or {}
        rh = humidity.get("value")
        if rh is not None:
            if humidity.get("unitCode") != "wmoUnit:percent":
                raise ValueError("Unknown NWS humidity unit")
            rh = number(rh, 0, 100)
        by_time[stamp] = {"building_id": building_id, "forecast_generated_at": issued,
                         "forecast_timestamp": stamp, "temperature_c": converted,
                         "humidity_pct": rh, "wind_speed_mps": wind_mps(period.get("windSpeed")), "source": "NWS"}
    if len(by_time) != hours:
        raise ValueError(f"NWS forecast is stale or incomplete: expected {hours} consecutive future hours, got {len(by_time)}")
    return [by_time[stamp] for stamp in sorted(by_time)]


def main():
    cli = parser(__doc__)
    cli.add_argument("--hours", type=int, default=24)
    cli.add_argument("--user-agent", help="Identifying app and contact; or set NWS_USER_AGENT in .env")
    args = cli.parse_args()
    if not 1 <= args.hours <= 72:
        cli.error("--hours must be between 1 and 72")
    engine = get_engine()  # Also loads the root .env.
    try:
        user_agent = args.user_agent or os.environ.get("NWS_USER_AGENT")
        if not user_agent:
            raise ValueError("Set NWS_USER_AGENT to 'GridShift (your contact email or website)'")
        target = building(engine, args.building_id)
        points_url = f"https://api.weather.gov/points/{target['latitude']:.4f},{target['longitude']:.4f}"
        with session(user_agent) as client:
            points_content = fetch(client, points_url)
            cache_bytes("weather_forecast", points_content, ".json")
            points = json.loads(points_content)
            url = points["properties"]["forecastHourly"]
            if urlparse(url).hostname != "api.weather.gov":
                raise ValueError("NWS returned an unexpected forecast host")
            content = fetch(client, url)
        cache_bytes("weather_forecast", content, ".json")
        payload = json.loads(content)
        archive(engine, "raw_weather_forecast", args.building_id, "NWS",
                {"points_url": points_url, "points": points, "forecast_url": url, "response": payload}, args.dry_run)
        rows = normalize(payload, args.building_id, datetime.now(UTC), args.hours)
        count = upsert(engine, "weather_forecasts", rows,
                       ["building_id", "forecast_generated_at", "forecast_timestamp"], args.dry_run)
        report("NWS", count, args.dry_run, issue_time=rows[0]["forecast_generated_at"],
               missing_humidity_hours=sum(row["humidity_pct"] is None for row in rows),
               missing_wind_hours=sum(row["wind_speed_mps"] is None for row in rows))
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
