"""Initialize using: python -m data.scripts.db.init_db (or this file directly)."""

from pathlib import Path

if __package__:
    from .connection import get_engine
else:
    from connection import get_engine


def main() -> None:
    engine = get_engine()
    try:
        schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
        # One transaction: a failure leaves no partially initialized schema.
        with engine.begin() as connection:
            connection.exec_driver_sql(schema)
        print("GridShift schema initialized successfully (10 tables).")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
