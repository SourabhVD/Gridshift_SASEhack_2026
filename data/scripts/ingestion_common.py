"""Shared HTTP, archive and PostgreSQL helpers for the ingestion CLIs."""

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from sqlalchemy import MetaData, Table, select
from sqlalchemy.dialects.postgresql import insert

try:
    from .db.connection import PROJECT_ROOT, get_engine
except ImportError:
    from db.connection import PROJECT_ROOT, get_engine

UTC = timezone.utc
RAW_ROOT = PROJECT_ROOT / "data" / "raw"
TABLES = {
    "buildings", "raw_building_load", "raw_weather_history", "raw_weather_forecast",
    "raw_tariffs", "energy_readings", "weather_observations", "weather_forecasts", "tariff_rates",
}


def parser(description):
    result = argparse.ArgumentParser(description=description)
    result.add_argument("--building-id", required=True, type=UUID)
    result.add_argument("--dry-run", action="store_true", help="Fetch/cache/validate without database writes")
    return result


def session(user_agent="GridShift/0.1"):
    client = requests.Session()
    retry = Retry(total=3, backoff_factor=1, status_forcelist=(429, 500, 502, 503, 504),
                  allowed_methods=("GET",), respect_retry_after_header=True)
    client.mount("https://", HTTPAdapter(max_retries=retry))
    client.headers.update({"User-Agent": user_agent})
    return client


def fetch(client, url, *, params=None, max_bytes=100 * 1024 * 1024):
    if not url.startswith("https://"):
        raise ValueError("Remote sources must use HTTPS")
    with client.get(url, params=params, timeout=(10, 60), stream=True) as response:
        response.raise_for_status()
        chunks, size = [], 0
        for chunk in response.iter_content(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise ValueError("Source exceeds download limit; select a single building or smaller date range")
            chunks.append(chunk)
        return b"".join(chunks)


def cache_bytes(category, content, suffix):
    directory = RAW_ROOT / category
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(content).hexdigest()
    path = directory / f"{digest}{suffix}"
    if not path.exists():
        path.write_bytes(content)
    return path, digest


def instant(value, *, allow_naive=False):
    value = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if value.tzinfo is None:
        if not allow_naive:
            raise ValueError("Timestamp must include a UTC offset")
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def number(value, minimum=None, maximum=None):
    if isinstance(value, bool):
        raise ValueError("Boolean is not a measurement")
    result = float(value)
    if not math.isfinite(result) or (minimum is not None and result < minimum) or (maximum is not None and result > maximum):
        raise ValueError(f"Measurement outside valid range: {value!r}")
    return result


def table(connection, name):
    if name not in TABLES:
        raise ValueError("Unknown ingestion table")
    return Table(name, MetaData(), schema="public", autoload_with=connection)


def building(engine, building_id):
    with engine.connect() as connection:
        target = table(connection, "buildings")
        row = connection.execute(select(target).where(target.c.building_id == building_id)).mappings().one_or_none()
    if row is None:
        raise ValueError("Building not registered. Run register_building.py first.")
    return dict(row)


def archive(engine, name, building_id, source, payload, dry_run=False):
    # Commit raw data first so parsing/normalization failures remain replayable.
    if not dry_run:
        with engine.begin() as connection:
            connection.execute(table(connection, name).insert(), {
                "building_id": building_id, "source": source, "payload": payload,
            })


def upsert(engine, name, rows, keys, dry_run=False):
    if not rows:
        raise ValueError("No valid normalized rows; raw input was retained")
    if dry_run:
        return len(rows)
    with engine.begin() as connection:
        target = table(connection, name)
        statement = insert(target)
        update = {column: statement.excluded[column] for column in rows[0] if column not in keys}
        if "ingested_at" in target.c:
            from sqlalchemy import func
            update["ingested_at"] = func.now()
        statement = statement.on_conflict_do_update(index_elements=keys, set_=update)
        for offset in range(0, len(rows), 1000):
            connection.execute(statement, rows[offset:offset + 1000])
    return len(rows)


def report(source, rows, dry_run, **details):
    print(json.dumps({"source": source, "normalized_rows": rows, "dry_run": dry_run, **details}, default=str, indent=2))
