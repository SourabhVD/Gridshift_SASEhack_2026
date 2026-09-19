"""Extract published Seattle City Light small/medium flat business rates."""

import re
from datetime import date
from decimal import Decimal
from uuid import NAMESPACE_URL, uuid5

from bs4 import BeautifulSoup

try:
    from .ingestion_common import archive, building, cache_bytes, fetch, get_engine, parser, report, session, upsert
except ImportError:
    from ingestion_common import archive, building, cache_bytes, fetch, get_engine, parser, report, session, upsert

URL = "https://www.seattle.gov/city-light/business-solutions/business-billing-and-account-information/business-rates"
SOURCE = "Seattle City Light"
LOCATIONS = {"C": "City of Seattle", "D": "Downtown Network", "B": "Burien", "E": "SeaTac",
             "H": "Shoreline", "K": "Unincorporated King County", "L": "Lake Forest Park",
             "N": "Normandy Park", "T": "Tukwila", "S": "Renton"}


def money(value):
    match = re.fullmatch(r"\s*\$(\d+(?:\.\d+)?)\s*", value)
    if not match:
        raise ValueError(f"Unrecognized published price: {value!r}; review source layout")
    return Decimal(match[1])


def normalize(html, building_id, rate_class, location, effective_from, effective_to=None):
    soup = BeautifulSoup(html, "html.parser")
    label = f"{rate_class.title()} Business Rates"
    heading = next((item for item in soup.find_all(re.compile("^h[1-6]$")) if label in item.get_text(" ", strip=True)), None)
    if heading is None:
        raise ValueError("Rate heading not found; website layout changed")
    # Read only the first (flat-rate) table in the selected class section.
    selected = heading.find_next("table")
    if selected is None:
        raise ValueError("Rate table missing")
    between = heading.find_next(re.compile("^h[1-6]$"))
    if between and "Business Rates" in between.get_text() and label not in between.get_text():
        raise ValueError("Selected rate class has no table")
    rows = [[cell.get_text(" ", strip=True) for cell in tr.find_all(["td", "th"])]
            for tr in selected.find_all("tr")]
    column = next((i for i, header in enumerate(rows[0]) if LOCATIONS[location] in header), None)
    if column is None:
        raise ValueError("Location column missing; review published rate table")
    energy, demand = None, None
    for row in rows[1:]:
        if len(row) <= column:
            raise ValueError("Unexpected merged or missing tariff cells")
        label_text = row[0].lower()
        if re.fullmatch(r"energy charger? per kwh", label_text):
            energy = money(row[column])
        elif label_text == "demand charge per kw":
            demand = money(row[column])
    if energy is None or (rate_class == "medium" and demand is None):
        raise ValueError("Expected flat energy/demand charges missing; refusing to guess")
    if effective_to is not None and effective_to < effective_from:
        raise ValueError("Effective end date precedes start date")
    identity = f"{SOURCE}|{building_id}|{rate_class}|{location}|{effective_from}|flat"
    return [{"tariff_id": uuid5(NAMESPACE_URL, identity), "building_id": building_id,
             "rate_name": f"SCL {rate_class} {location} flat", "period_type": "flat",
             "energy_rate_per_kwh": energy, "demand_rate_per_kw": demand,
             "start_hour": 0, "end_hour": 24, "effective_from": effective_from,
             "effective_to": effective_to, "source": SOURCE, "currency": "USD"}]


def main():
    cli = parser(__doc__)
    cli.add_argument("--rate-class", choices=("small", "medium"), required=True)
    cli.add_argument("--location", choices=tuple(LOCATIONS), required=True)
    cli.add_argument("--effective-from", type=date.fromisoformat, required=True,
                     help="Confirmed effective date for the currently published rates; not an archive selector")
    cli.add_argument("--effective-to", type=date.fromisoformat)
    args = cli.parse_args()
    engine = get_engine()
    try:
        target = building(engine, args.building_id)
        if target["utility"] != SOURCE:
            raise ValueError("Building utility must be registered as 'Seattle City Light'")
        with session() as client:
            content = fetch(client, URL)
        cached, digest = cache_bytes("tariffs", content, ".html")
        html = content.decode("utf-8-sig")
        archive(engine, "raw_tariffs", args.building_id, SOURCE,
                {"url": URL, "sha256": digest, "html": html, "rate_class": args.rate_class,
                 "location": args.location, "effective_from": args.effective_from.isoformat()}, args.dry_run)
        rows = normalize(html, args.building_id, args.rate_class, args.location, args.effective_from, args.effective_to)
        count = upsert(engine, "tariff_rates", rows, ["tariff_id"], args.dry_run)
        report(SOURCE, count, args.dry_run, rates=rows,
               excluded="Daily/minimum charges, taxes, transformer credits, undergrounding and other adjustments")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
