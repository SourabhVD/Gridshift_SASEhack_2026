"""
Run this LOCALLY (not in Claude's container — it can't reach Supabase).

    python optimizer/db/introspect.py

Reads DATABASE_URL from your root .env. Prints table existence, row counts,
and column info for everything the optimizer touches. No secrets in output —
safe to paste back into chat.
"""

from __future__ import annotations

from data.scripts.db.connection import get_engine
from sqlalchemy import text

TABLES = [
    "buildings",
    "energy_readings",
    "weather_observations",
    "weather_forecasts",
    "tariff_rates",
    "model_forecasts",
    "battery_assets",
    "ev_charging_sessions",
    "hvac_flexibility",
    "optimization_plans",
]


def main() -> None:
    engine = get_engine()
    with engine.connect() as conn:
        print("=== existing tables (public schema) ===")
        existing = {
            row[0]
            for row in conn.execute(
                text("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
            )
        }
        for t in TABLES:
            print(f"  {'[x]' if t in existing else '[ ]'} {t}")

        print("\n=== row counts ===")
        for t in TABLES:
            if t not in existing:
                continue
            try:
                n = conn.execute(text(f"SELECT count(*) FROM public.{t}")).scalar()
                print(f"  {t}: {n}")
            except Exception as e:
                print(f"  {t}: ERROR {e}")

        print("\n=== buildings ===")
        if "buildings" in existing:
            for row in conn.execute(text("SELECT building_id, name, timezone FROM public.buildings")):
                print(f"  {row.building_id}  {row.name}  tz={row.timezone}")

        print("\n=== tariff_rates sample ===")
        if "tariff_rates" in existing:
            cols = conn.execute(
                text("SELECT column_name FROM information_schema.columns "
                     "WHERE table_schema='public' AND table_name='tariff_rates' ORDER BY ordinal_position")
            )
            print("  columns:", ", ".join(r[0] for r in cols))
            for row in conn.execute(text("SELECT * FROM public.tariff_rates LIMIT 5")):
                print(" ", dict(row._mapping))

        print("\n=== model_forecasts: latest run per building ===")
        if "model_forecasts" in existing:
            for row in conn.execute(
                text("""
                    SELECT building_id, max(generated_at) AS latest, count(*) AS rows_in_latest_run
                    FROM public.model_forecasts
                    GROUP BY building_id, generated_at
                    ORDER BY building_id, latest DESC
                """)
            ):
                print(f"  {row.building_id}  latest={row.latest}  rows={row.rows_in_latest_run}")

        print("\n=== energy_readings date range ===")
        if "energy_readings" in existing:
            row = conn.execute(
                text("SELECT min(timestamp), max(timestamp), count(*) FROM public.energy_readings")
            ).fetchone()
            print(f"  {row[0]} .. {row[1]}  ({row[2]} rows)")


if __name__ == "__main__":
    main()
