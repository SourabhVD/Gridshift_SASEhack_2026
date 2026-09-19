"""Reproduce the selected demo source ingestion without manual source choices."""

import argparse
import json
import subprocess
import sys
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "data" / "selected_sources.json"


def selected_building_id(config):
    source = config["comstock"]
    return uuid5(NAMESPACE_URL, f"gridshift:{source['release']}:{source['building_id']}:{source['upgrade']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=("load", "noaa", "nws", "tariffs", "all"), default="all")
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text())
    building_id = str(selected_building_id(config))

    def run(module, *arguments):
        subprocess.run([sys.executable, "-m", f"data.scripts.{module}", *map(str, arguments)], cwd=ROOT, check=True)

    target = config["building"]
    registration = ["--building-id", building_id]
    for key in ("name", "latitude", "longitude", "timezone", "building_type", "utility", "rate_class"):
        registration.extend([f"--{key.replace('_', '-')}", str(target[key])])
    run("register_building", *registration)
    base = ["--building-id", building_id]
    if args.only in ("all", "load"):
        load = config["comstock"]
        run("ingest_building_load", *base, "--url", load["url"], "--value-column", load["value_column"],
            "--unit", load["unit"], "--source-timezone", load["source_timezone"])
    if args.only in ("all", "noaa"):
        weather = config["noaa"]
        run("ingest_noaa_weather", *base, "--station", weather["station"], "--start", weather["start"], "--end", weather["end"])
    if args.only in ("all", "nws"):
        run("ingest_nws_forecast", *base, "--user-agent", config["nws"]["user_agent"])
    if args.only in ("all", "tariffs"):
        rates = config["tariff"]
        run("ingest_tariffs", *base, "--rate-class", rates["rate_class"], "--location", rates["location"],
            "--effective-from", rates["effective_from"], "--effective-to", rates["effective_to"])
    print(f"Selected GridShift building UUID: {building_id}")


if __name__ == "__main__":
    main()
