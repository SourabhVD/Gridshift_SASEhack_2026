"""
Shared test fixtures.

The environment is set before `app` is imported anywhere, because
config.get_settings() is cached on first call. GRIDSHIFT_AGENT_SPEED=0 strips
every simulated pause out of the agent, so a run that takes 17 seconds in the
demo takes milliseconds here.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any, Iterator

import pytest

os.environ.setdefault("GRIDSHIFT_AGENT", "fake")
os.environ.setdefault("GRIDSHIFT_FORECAST", "fixtures")
os.environ.setdefault("GRIDSHIFT_AGENT_SPEED", "0")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:3000")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.fixtures import FIXTURES  # noqa: E402
from app.main import app  # noqa: E402
from app.store import store  # noqa: E402

#: Every building id, so the contract tests run against all four sites.
BUILDING_IDS = [f.id for f in FIXTURES]


@pytest.fixture()
def client() -> Iterator[TestClient]:
    store.reset_all()
    with TestClient(app) as test_client:
        yield test_client
    store.reset_all()


def poll_until_complete(client: TestClient, run_id: str, timeout_s: float = 20.0) -> dict[str, Any]:
    """Poll /events the way the dashboard does, until the run reports done."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        body = client.get(f"/api/gridshift/{run_id}/events").json()
        if body["is_complete"]:
            return body
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} did not complete within {timeout_s} s")
