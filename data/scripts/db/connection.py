"""Shared database configuration; importing this module makes no connection."""

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine, make_url

PROJECT_ROOT = Path(__file__).resolve().parents[3]


def get_engine() -> Engine:
    """Read the root .env (without overriding environment variables)."""
    load_dotenv(PROJECT_ROOT / ".env")
    value = os.environ.get("DATABASE_URL")
    if not value:
        raise RuntimeError("Set DATABASE_URL in the environment or project root .env.")
    url = make_url(value)
    if url.get_backend_name() != "postgresql":
        raise ValueError("DATABASE_URL must use PostgreSQL.")
    return create_engine(
        url.set(drivername="postgresql+psycopg"),
        pool_pre_ping=True,
        connect_args={"connect_timeout": 10, "options": "-c timezone=UTC"},
    )
