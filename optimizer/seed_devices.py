"""
GridShift Component 3 — synthetic device specs and seeder.

The project brief calls for synthetic battery/EV/HVAC constraints, and no such
data exists in the branch. This module holds one definition of those scenario
assumptions, used both to seed PostgreSQL and to run the optimizer offline.

    python -m optimizer.seed_devices --building-id <uuid>            # write
    python -m optimizer.seed_devices --building-id <uuid> --dry-run  # preview

Everything here is SYNTHETIC and sized off the building's own peak demand.
Replace with real site data when it exists.
"""

from __future__ import annotations

import argparse
from datetime import timedelta
from uuid import UUID

import pandas as pd
from sqlalchemy import text

from optimizer.schemas import BatterySpec, EVSpec, HVACSpec

SOURCE = "synthetic scenario (GridShift brief)"


def default_battery(peak_kw: float, initial_soc_pct: float = 50.0) -> BatterySpec:
    """Roughly a 2-hour pack able to shave a quarter of peak demand."""
    power = round(peak_kw * 0.25, 1)
    return BatterySpec(
        asset_id="synthetic-battery",
        name="Site battery (synthetic)",
        capacity_kwh=round(power * 2, 1),
        max_charge_kw=power,
        max_discharge_kw=power,
        charge_efficiency=0.95,
        discharge_efficiency=0.95,
        min_soc_pct=10.0,
        max_soc_pct=100.0,
        initial_soc_pct=initial_soc_pct,
        final_soc_pct=50.0,
    )


def default_evs(day_start_local: pd.Timestamp, count: int = 4, timezone: str = "America/Los_Angeles") -> list[EVSpec]:
    """Workplace charging: vehicles plugged in over the office day.

    Left alone they charge on arrival, which lands squarely on the morning
    ramp — exactly the behaviour the optimizer should move.
    """
    anchor = pd.Timestamp(day_start_local).tz_convert(timezone)
    day = anchor.normalize()
    if day + timedelta(hours=8) < anchor:
        day = day + timedelta(days=1)  # first office day that fits in the horizon
    sessions = []
    for index in range(count):
        arrive = day + timedelta(hours=8, minutes=15 * index)
        sessions.append(
            EVSpec(
                asset_id=f"synthetic-ev-{index + 1}",
                name=f"Fleet EV {index + 1}",
                max_charge_kw=11.0,
                energy_required_kwh=30.0,
                available_from=arrive.tz_convert("UTC"),
                available_until=(day + timedelta(hours=17)).tz_convert("UTC"),
                charge_efficiency=0.92,
                priority=1.0,
            )
        )
    return sessions


def default_hvac(daily_energy_kwh: float) -> HVACSpec:
    return HVACSpec(
        asset_id="synthetic-hvac",
        name="HVAC flexibility (synthetic)",
        max_curtail_fraction=0.15,
        max_curtail_kw=None,
        max_consecutive_hours=3,
        recovery_fraction=0.5,
        daily_curtail_limit_kwh=round(daily_energy_kwh * 0.08, 1),
    )


def seed(engine, building_id: UUID, peak_kw: float, daily_energy_kwh: float,
         day_start_local: pd.Timestamp, timezone: str, dry_run: bool = False) -> dict:
    battery = default_battery(peak_kw)
    hvac = default_hvac(daily_energy_kwh)
    evs = default_evs(day_start_local, timezone=timezone)
    if dry_run:
        return {"battery": battery, "hvac": hvac, "evs": evs, "written": 0}

    with engine.begin() as connection:
        connection.execute(text("DELETE FROM public.battery_assets WHERE building_id = :id AND source = :src"),
                           {"id": str(building_id), "src": SOURCE})
        connection.execute(text("DELETE FROM public.hvac_flexibility WHERE building_id = :id AND source = :src"),
                           {"id": str(building_id), "src": SOURCE})
        connection.execute(text("DELETE FROM public.ev_charging_sessions WHERE building_id = :id AND source = :src"),
                           {"id": str(building_id), "src": SOURCE})
        connection.execute(
            text("""
                INSERT INTO public.battery_assets (building_id, name, capacity_kwh, max_charge_kw,
                    max_discharge_kw, charge_efficiency, discharge_efficiency, min_soc_pct,
                    max_soc_pct, current_soc_pct, target_final_soc_pct, source)
                VALUES (:id, :name, :cap, :chg, :dis, :eff_c, :eff_d, :min_soc, :max_soc, :soc, :final, :src)
            """),
            {"id": str(building_id), "name": battery.name, "cap": battery.capacity_kwh,
             "chg": battery.max_charge_kw, "dis": battery.max_discharge_kw,
             "eff_c": battery.charge_efficiency, "eff_d": battery.discharge_efficiency,
             "min_soc": battery.min_soc_pct, "max_soc": battery.max_soc_pct,
             "soc": battery.initial_soc_pct, "final": battery.final_soc_pct, "src": SOURCE},
        )
        connection.execute(
            text("""
                INSERT INTO public.hvac_flexibility (building_id, name, max_curtail_fraction,
                    max_consecutive_hours, recovery_fraction, daily_curtail_limit_kwh, source)
                VALUES (:id, :name, :frac, :hours, :recovery, :limit, :src)
            """),
            {"id": str(building_id), "name": hvac.name, "frac": hvac.max_curtail_fraction,
             "hours": hvac.max_consecutive_hours, "recovery": hvac.recovery_fraction,
             "limit": hvac.daily_curtail_limit_kwh, "src": SOURCE},
        )
        for spec in evs:
            connection.execute(
                text("""
                    INSERT INTO public.ev_charging_sessions (building_id, vehicle_name, max_charge_kw,
                        energy_required_kwh, available_from, available_until, charge_efficiency, priority, source)
                    VALUES (:id, :name, :power, :energy, :start, :end, :eff, :priority, :src)
                """),
                {"id": str(building_id), "name": spec.name, "power": spec.max_charge_kw,
                 "energy": spec.energy_required_kwh, "start": spec.available_from.to_pydatetime(),
                 "end": spec.available_until.to_pydatetime(), "eff": spec.charge_efficiency,
                 "priority": spec.priority, "src": SOURCE},
            )
    return {"battery": battery, "hvac": hvac, "evs": evs, "written": 2 + len(evs)}


def main() -> None:
    from data.scripts.db.connection import get_engine
    from optimizer.data_access import load_building, load_forecast

    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--building-id", required=True, type=UUID)
    cli.add_argument("--dry-run", action="store_true")
    args = cli.parse_args()

    engine = get_engine()
    try:
        building = load_building(engine, str(args.building_id))
        timezone = building.get("timezone") or "America/Los_Angeles"
        timestamps, forecast, _ = load_forecast(engine, str(args.building_id), 24)
        outcome = seed(engine, args.building_id, float(forecast.max()), float(forecast.sum()),
                       timestamps[0], timezone, dry_run=args.dry_run)
    finally:
        engine.dispose()

    print(f"{'DRY RUN' if args.dry_run else 'SEEDED'} — source: {SOURCE}")
    print(f"  battery: {outcome['battery'].capacity_kwh} kWh / {outcome['battery'].max_charge_kw} kW")
    print(f"  hvac:    {outcome['hvac'].max_curtail_fraction:.0%} of load, "
          f"<= {outcome['hvac'].max_consecutive_hours} consecutive hours")
    print(f"  ev:      {len(outcome['evs'])} sessions x "
          f"{outcome['evs'][0].energy_required_kwh if outcome['evs'] else 0} kWh")


if __name__ == "__main__":
    main()
