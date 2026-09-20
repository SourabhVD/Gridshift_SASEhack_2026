"""
Apply optimizer/db/devices.sql without needing a psql client installed.

    python -m optimizer.db.apply_devices_schema
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import text

from data.scripts.db.connection import get_engine

SQL_FILE = Path(__file__).with_name("devices.sql")


def statements(sql_text: str) -> list[str]:
    """Strip full-line comments, then split on statement-terminating semicolons.

    Safe here because devices.sql contains no semicolons inside string
    literals or function bodies — just CREATE TABLE / CREATE INDEX.
    """
    without_comments = "\n".join(
        line for line in sql_text.splitlines() if not line.strip().startswith("--")
    )
    return [s.strip() for s in without_comments.split(";") if s.strip()]


def main() -> None:
    sql_text = SQL_FILE.read_text(encoding="utf-8")
    engine = get_engine()
    try:
        with engine.begin() as connection:
            for statement in statements(sql_text):
                connection.execute(text(statement))
        print(f"Applied {SQL_FILE.name}: battery_assets, ev_charging_sessions, "
              f"hvac_flexibility, optimization_plans (+ indexes).")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
