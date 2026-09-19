"""Register an explicitly selected building; repeat with its UUID to update."""

import argparse
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

try:
    from .ingestion_common import get_engine, upsert, number
except ImportError:
    from ingestion_common import get_engine, upsert, number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--building-id", type=UUID)
    parser.add_argument("--name", required=True)
    parser.add_argument("--latitude", required=True, type=float)
    parser.add_argument("--longitude", required=True, type=float)
    parser.add_argument("--timezone", required=True)
    parser.add_argument("--building-type")
    parser.add_argument("--utility")
    parser.add_argument("--rate-class")
    args = parser.parse_args()
    ZoneInfo(args.timezone)
    number(args.latitude, -90, 90)
    number(args.longitude, -180, 180)
    row = vars(args)
    row["building_id"] = args.building_id or uuid4()
    engine = get_engine()
    try:
        upsert(engine, "buildings", [row], ["building_id"])
        print(row["building_id"])
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
