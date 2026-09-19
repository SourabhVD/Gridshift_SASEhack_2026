"""Download/import one ComStock or meter file and produce complete UTC hours."""

import json
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd

try:
    from .ingestion_common import archive, building, cache_bytes, fetch, get_engine, parser, report, session, upsert
except ImportError:
    from ingestion_common import archive, building, cache_bytes, fetch, get_engine, parser, report, session, upsert


def normalize(frame, building_id, *, source, timestamp_column, value_column,
              unit, interval_minutes, timestamp_position, source_timezone):
    if interval_minutes <= 0 or 60 % interval_minutes:
        raise ValueError("Interval must be a positive divisor of 60 minutes")
    if frame.empty or timestamp_column not in frame or value_column not in frame:
        raise ValueError("Empty input or missing timestamp/value column; check the release data dictionary")
    if source == "ComStock":
        if "weighted" in value_column.lower() or "intensity" in value_column.lower():
            raise ValueError("Select an unweighted individual-building electricity energy column")
        if any(column in frame for column in ("models_used", "units_represented", "floor_area_represented")):
            raise ValueError("Aggregate ComStock profiles are not individual buildings")
    for identity in ("bldg_id", "building_id"):
        if identity in frame and frame[identity].nunique(dropna=False) > 1:
            raise ValueError("Input contains multiple buildings; select one building file")
    aware = [pd.Timestamp(value).tzinfo is not None for value in frame[timestamp_column]]
    if any(aware) and not all(aware):
        raise ValueError("Do not mix timezone-aware and naive timestamps")
    timestamps = pd.DatetimeIndex(pd.to_datetime(frame[timestamp_column], errors="raise", format="mixed", utc=all(aware)))
    if timestamps.tz is None:
        timestamps = timestamps.tz_localize(source_timezone, ambiguous="raise", nonexistent="raise")
    timestamps = timestamps.tz_convert("UTC")
    if timestamp_position == "end":
        timestamps -= pd.Timedelta(minutes=interval_minutes)
    if timestamps.hasnans or timestamps.has_duplicates:
        raise ValueError("Missing or duplicate interval timestamps")
    if any(timestamps != timestamps.floor(f"{interval_minutes}min")):
        raise ValueError("Intervals are not aligned to the requested duration")
    values = pd.to_numeric(frame[value_column], errors="raise").to_numpy(dtype=float)
    import numpy as np
    if not np.isfinite(values).all() or (values < 0).any():
        raise ValueError("Load values must be finite nonnegative measurements")
    energy = values * interval_minutes / 60 if unit == "kw" else values
    intervals = pd.DataFrame({"energy": energy}, index=timestamps).sort_index()
    hours = intervals.resample("h").agg(energy=("energy", "sum"), count=("energy", "count"))
    complete = hours[hours["count"] == 60 // interval_minutes]
    rows = [{"building_id": building_id, "timestamp": stamp.to_pydatetime(),
             "load_kw": float(row.energy), "energy_kwh": float(row.energy),
             "source": source, "quality_flag": "estimated" if source == "ComStock" else "valid"}
            for stamp, row in complete.iterrows()]
    return rows, {"input_intervals": len(frame), "incomplete_or_missing_hours": len(hours) - len(complete)}


def main():
    cli = parser(__doc__)
    inputs = cli.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--url", help="Direct HTTPS URL to ONE individual-building CSV/Parquet")
    inputs.add_argument("--file", type=Path)
    cli.add_argument("--source", choices=("ComStock", "meter"), default="ComStock")
    cli.add_argument("--timestamp-column", default="timestamp")
    cli.add_argument("--value-column", required=True)
    cli.add_argument("--unit", choices=("kw", "kwh"), required=True)
    cli.add_argument("--interval-minutes", type=int, default=15)
    cli.add_argument("--timestamp-position", choices=("start", "end"), default="end")
    cli.add_argument("--source-timezone", help="Required for meter files without offsets; ComStock uses fixed EST")
    args = cli.parse_args()
    source_timezone = args.source_timezone or ("Etc/GMT+5" if args.source == "ComStock" else None)
    if source_timezone is None:
        cli.error("Specify --source-timezone for meter input (UTC if timestamps already carry offsets)")
    engine = get_engine()
    try:
        building(engine, args.building_id)
        origin = args.url or str(args.file.resolve())
        suffix = Path(urlparse(args.url).path if args.url else args.file).suffix.lower()
        if suffix not in (".csv", ".parquet"):
            raise ValueError("Use a .csv or .parquet source")
        with session() as client:
            content = fetch(client, args.url) if args.url else args.file.read_bytes()
        cached, digest = cache_bytes("building_load", content, suffix)
        # Preserve even an unreadable download in the file cache before decoding.
        frame = pd.read_parquet(cached) if suffix == ".parquet" else pd.read_csv(cached)
        # Archive all original fields in bounded chunks, including source metadata.
        records = json.loads(frame.to_json(orient="records", date_format="iso"))
        for offset in range(0, len(records), 1000):
            archive(engine, "raw_building_load", args.building_id, args.source,
                    {"origin": origin, "sha256": digest, "cache_file": str(cached.relative_to(cached.parents[3])),
                     "source_timezone": source_timezone, "interval_minutes": args.interval_minutes,
                     "timestamp_position": args.timestamp_position, "timestamp_column": args.timestamp_column,
                     "value_column": args.value_column,
                     "unit": args.unit, "records": records[offset:offset + 1000]}, args.dry_run)
        rows, stats = normalize(frame, args.building_id, source=args.source,
                               timestamp_column=args.timestamp_column, value_column=args.value_column,
                               unit=args.unit, interval_minutes=args.interval_minutes,
                               timestamp_position=args.timestamp_position, source_timezone=source_timezone)
        count = upsert(engine, "energy_readings", rows, ["building_id", "timestamp"], args.dry_run)
        report(args.source, count, args.dry_run, **stats, start=rows[0]["timestamp"], end=rows[-1]["timestamp"])
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
