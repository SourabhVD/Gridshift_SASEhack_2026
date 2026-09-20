"""
Reads the artifacts `ml/evaluate_forecast_date.py` writes.

That script is a backtest harness, not a live forecaster. It refuses to run on
a date unless the database already holds 24 hours of measured load for it, and
it retrains from scratch on every call -- a feature ablation that fits a model
per feature group, then a final fit. Neither fits inside an HTTP request, so
the backend never calls it. It runs offline, against the hosted database, and
leaves a directory behind:

    data/processed/backtests/<YYYY-MM-DD>/
        forecast_vs_actual.csv    timestamp, predicted_load_kw, actual_load_kw, ...
        metrics.json              includes peak_threshold_kw
        metadata.json             building id, timezone, algorithm
        load_forecaster.joblib    the trained bundle (not read here)

This module reads those files and nothing else. No database, no credential, no
model load, no retraining. It uses only the standard library, so pandas and
scikit-learn stay out of the request path and this mode works on an install
that has neither.

The directory name is the building-local date, and the CSV holds that whole
local day in UTC, one contiguous row per hour. Those two facts are enough to
place every row on a local hour and to derive the day's UTC offset by simple
subtraction -- which is why nothing here consults a timezone database. Python's
`zoneinfo` has none of its own on Windows, and a reader that needs an extra
package to parse a CSV is a reader that will fail on somebody's laptop.
"""

from __future__ import annotations

import csv
import json
import logging
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

log = logging.getLogger("gridshift.backtest")

HOURS = 24

CSV_NAME = "forecast_vs_actual.csv"
METRICS_NAME = "metrics.json"
METADATA_NAME = "metadata.json"

DATE_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class BacktestUnavailable(Exception):
    """No usable backtest at the requested location. Always falls back."""


@dataclass(frozen=True)
class Backtest:
    """One day of real predicted-versus-measured load, in local hour order."""

    #: Building-local calendar date, YYYY-MM-DD.
    date: str
    #: IANA zone from metadata, purely informational. May be empty.
    timezone: str
    #: UTC offset for that day, e.g. '-07:00'. Derived, not assumed.
    utc_offset: str
    #: Whatever produced it, e.g. 'LightGBM'. Logged, not published.
    algorithm: str
    #: The database's building id. Not a frontend slug. May be empty.
    building_id: str
    #: 24 predictions, index 0 = local midnight.
    predicted_kw: list[float]
    #: 24 measured values, same ordering.
    actual_kw: list[float]
    #: The 95th-percentile training threshold the harness recorded, if present.
    #: Reported, not published: the served curve is billed against the site's
    #: own threshold, because it is mapped onto the site's scale.
    threshold_kw: float | None
    directory: Path


def available(root: Path) -> list[str]:
    """Every date-named backtest directory under `root`, oldest first."""
    try:
        entries = list(root.iterdir())
    except OSError:
        return []
    return sorted(
        entry.name
        for entry in entries
        if entry.is_dir() and DATE_DIR.match(entry.name) and (entry / CSV_NAME).is_file()
    )


def _read_json(path: Path) -> dict:
    """Optional enrichment. A missing or broken file is not fatal."""
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _parse_timestamp(raw: object) -> datetime:
    """
    Parse what pandas writes for a UTC-aware column.

    to_csv renders '2018-07-15 00:00:00+00:00'. fromisoformat wants the 'T',
    and some writers emit 'Z' instead of an offset.

    `raw` is typed loosely on purpose: csv.DictReader hands back None for a
    short row and a list for a long one, and neither may reach `.strip()`.
    """
    if not isinstance(raw, str):
        raise BacktestUnavailable(f"timestamp is not a single value: {raw!r}")
    text = raw.strip().replace(" ", "T", 1)
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError as exc:
        raise BacktestUnavailable(f"unparseable timestamp {raw!r}") from exc
    if stamp.utcoffset() is None:
        raise BacktestUnavailable(
            f"timestamp {raw!r} carries no offset; refusing to guess a zone"
        )
    return stamp


def _finite(raw: object, column: str) -> float:
    """`raw` is loosely typed for the same reason as the timestamp above."""
    if not isinstance(raw, (str, int, float)):
        raise BacktestUnavailable(f"{column} is not a single value: {raw!r}")
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise BacktestUnavailable(f"{column} is not a number: {raw!r}") from exc
    if not math.isfinite(value):
        raise BacktestUnavailable(f"{column} is not finite: {raw!r}")
    if value < 0:
        raise BacktestUnavailable(f"{column} is negative: {raw!r}")
    return value


def _read_rows(path: Path) -> list[tuple[datetime, float, float]]:
    """The CSV as 24 contiguous hourly rows, ascending. Anything else raises."""
    try:
        with path.open(newline="", encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        # csv.Error covers a field past the 128k limit and a NUL byte;
        # UnicodeDecodeError covers a file that is not UTF-8 at all. Both are
        # "this is not a backtest", not "crash the request".
        # utf-8-sig also strips a byte-order mark, which would otherwise
        # rename the first column and fail the header check below.
        raise BacktestUnavailable(f"cannot read {path.name}: {exc}") from exc

    if not rows:
        raise BacktestUnavailable(f"{path.name} has no rows")
    for column in ("timestamp", "predicted_load_kw", "actual_load_kw"):
        if column not in rows[0]:
            raise BacktestUnavailable(f"{path.name} has no {column} column")

    parsed = sorted(
        (
            _parse_timestamp(row["timestamp"]),
            _finite(row["predicted_load_kw"], "predicted_load_kw"),
            _finite(row["actual_load_kw"], "actual_load_kw"),
        )
        for row in rows
    )

    if len(parsed) != HOURS:
        raise BacktestUnavailable(f"{path.name} has {len(parsed)} rows, expected {HOURS}")

    hour = timedelta(hours=1)
    for earlier, later in zip(parsed, parsed[1:]):
        gap = later[0] - earlier[0]
        if gap != hour:
            raise BacktestUnavailable(
                f"{path.name} is not contiguous hourly: {gap} between "
                f"{earlier[0].isoformat()} and {later[0].isoformat()}"
            )
    return parsed


def _offset_for(date: str, first: datetime) -> str:
    """
    The day's UTC offset, by subtraction rather than by timezone lookup.

    The first row is local midnight on `date` and carries its own UTC instant,
    so the offset is just the difference. A July day in Los Angeles gives
    -07:00 and a December one -08:00, with no table of special cases and no
    dependency on a system timezone database.

    Informational only: the served curve is published on the demo day, so a
    zone this cannot pin down costs a line in /health and nothing else. It
    returns "" rather than raising, because refusing a whole day over a label
    would be the wrong trade.

    On the two daylight-saving transition days this offset is the one in force
    at midnight rather than for the whole day. The harness selects
    `local_start + Timedelta(days=1)`, which is 24 hours of elapsed time rather
    than a calendar day, so those files still hold exactly 24 contiguous hours
    and load cleanly -- the label is approximate, the data is not.
    """
    try:
        midnight = datetime.fromisoformat(f"{date}T00:00:00+00:00")
    except ValueError:
        return ""

    seconds = int((midnight - first).total_seconds())
    if abs(seconds) > 14 * 3600 or seconds % 60:
        return ""

    sign = "-" if seconds < 0 else "+"
    minutes = abs(seconds) // 60
    return "%s%02d:%02d" % (sign, minutes // 60, minutes % 60)


def load(root: Path, date: str = "") -> Backtest:
    """
    Load one backtest. `date` empty means the most recent one present.

    Raises BacktestUnavailable for anything missing or malformed. Every caller
    treats that as "fall back to fixtures", so a half-written directory can
    never take the dashboard down.
    """
    dates = available(root)
    if not dates:
        raise BacktestUnavailable(f"no backtest directories under {root}")

    wanted = date or dates[-1]
    if wanted not in dates:
        raise BacktestUnavailable(f"no backtest for {wanted}; have {', '.join(dates)}")

    directory = root / wanted
    rows = _read_rows(directory / CSV_NAME)
    utc_offset = _offset_for(wanted, rows[0][0])

    metadata = _read_json(directory / METADATA_NAME)
    recorded = str(metadata.get("forecast_date_local") or "").strip()
    if recorded and recorded != wanted:
        raise BacktestUnavailable(
            f"{METADATA_NAME} says {recorded} but the directory says {wanted}"
        )

    threshold: float | None = None
    raw_threshold = _read_json(directory / METRICS_NAME).get("peak_threshold_kw")
    if isinstance(raw_threshold, (int, float)) and math.isfinite(raw_threshold) and raw_threshold > 0:
        threshold = float(raw_threshold)

    return Backtest(
        date=wanted,
        timezone=str(metadata.get("timezone") or ""),
        utc_offset=utc_offset,
        algorithm=str(metadata.get("algorithm") or "unknown"),
        building_id=str(metadata.get("building_id") or ""),
        predicted_kw=[row[1] for row in rows],
        actual_kw=[row[2] for row in rows],
        threshold_kw=threshold,
        directory=directory,
    )
