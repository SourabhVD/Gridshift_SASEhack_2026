from __future__ import annotations

from datetime import datetime, timedelta


class UnknownBuilding(ValueError):
    pass


BUILDINGS = {
    "sea-office-001": {
        "id": "sea-office-001",
        "name": "Sea Office",
        "city": "Seattle",
        "country": "US",
    },
    "harbor-warehouse-002": {
        "id": "harbor-warehouse-002",
        "name": "Harbor Warehouse",
        "city": "Seattle",
        "country": "US",
    },
}


def require_fixture(building_id: str) -> dict[str, str]:
    fixture = BUILDINGS.get(building_id)
    if fixture is None:
        raise UnknownBuilding(f"Unknown building: {building_id}")
    return fixture


def build_summary(building_id: str) -> dict[str, float | str]:
    require_fixture(building_id)
    total_kwh = 628.5
    peak_kw = 520.0
    emissions_kg = 82.3
    return {
        "building_id": building_id,
        "total_kwh": total_kwh,
        "peak_kw": peak_kw,
        "emissions_kg": emissions_kg,
    }


def build_forecast(building_id: str) -> dict[str, object]:
    require_fixture(building_id)
    start = datetime(2026, 1, 1, 0, 0)
    points: list[dict[str, float | str]] = []
    peak_kw = 0.0
    peak_time = "00:00"

    for i in range(24):
        current = start + timedelta(hours=i)
        load_kw = 180 + 320 * (1 + (i / 23)) * (0.7 + 0.3 * abs((i - 15) / 15))
        if load_kw > peak_kw:
            peak_kw = load_kw
            peak_time = current.strftime("%H:00")
        points.append(
            {
                "timestamp": current.strftime("%Y-%m-%dT%H:00:00"),
                "load_kw": round(load_kw, 2),
                "solar_kw": round(max(0.0, 150 - abs(i - 13) * 12), 2),
                "battery_kw": round(max(0.0, 50 - abs(i - 17) * 8), 2),
                "grid_kw": round(max(0.0, load_kw - 90), 2),
            }
        )

    return {
        "building_id": building_id,
        "forecast": points,
        "peak_kw": round(peak_kw, 2),
        "peak_time": peak_time,
    }
