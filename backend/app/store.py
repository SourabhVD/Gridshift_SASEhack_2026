"""
Per-building run state, in SQLite.

The schema is the point, not the engine. Four tables -- runs, events, plans,
actions -- with the same columns a Postgres deployment would use, so moving
this to SQLAlchemy against Postgres is a driver swap plus real migrations, not
a redesign. The connection is :memory: by default because a demo backend that
remembers yesterday's run is a nuisance; pass a path to persist.

State is keyed per building. Two buildings can hold a finished plan at the same
time, and resetting one leaves the others alone -- the building selector in the
dashboard depends on that, since switching sites must not wipe a run you are
still reading.

Everything is guarded by one lock. The agent writes events from a background
asyncio task while request handlers read them, and sqlite3 connections are not
safe to share across threads without it.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id       TEXT PRIMARY KEY,
    building_id  TEXT NOT NULL,
    status       TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    error        TEXT
);
CREATE INDEX IF NOT EXISTS runs_building ON runs (building_id);

CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    timestamp   TEXT NOT NULL,
    type        TEXT NOT NULL,
    tool_name   TEXT,
    message     TEXT NOT NULL,
    payload     TEXT,
    duration_ms INTEGER,
    UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS plans (
    run_id     TEXT PRIMARY KEY REFERENCES runs (run_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    doc        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
    id       TEXT PRIMARY KEY,
    run_id   TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    status   TEXT NOT NULL,
    doc      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_run ON actions (run_id);
"""


def now_iso() -> str:
    """UTC, ISO 8601, with an explicit offset -- never a naive timestamp."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Conflict(Exception):
    """Raised when an action has already been decided. Surfaces as HTTP 409."""


class NotFound(Exception):
    """Raised when a run, plan or action does not exist. Surfaces as HTTP 404."""


class Store:
    """One process-wide instance; see the module-level `store` below."""

    def __init__(self, path: str = ":memory:") -> None:
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(SCHEMA)
        self._db.commit()
        self._counter = 0

    # ----------------------------------------------------------------- runs

    def create_run(self, building_id: str) -> dict[str, Any]:
        """A new run supersedes this building's previous one."""
        with self._lock:
            self._counter += 1
            started = now_iso()
            run_id = "run-%s-%d" % (
                format(int(datetime.now(timezone.utc).timestamp() * 1000), "x"),
                self._counter,
            )
            self._db.execute("DELETE FROM runs WHERE building_id = ?", (building_id,))
            self._db.execute(
                "INSERT INTO runs (run_id, building_id, status, started_at) VALUES (?,?,?,?)",
                (run_id, building_id, "running", started),
            )
            self._db.commit()
            return {"run_id": run_id, "building_id": building_id, "status": "running", "started_at": started}

    def get_run(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._db.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            raise NotFound(f"Run {run_id} not found. Start a run first.")
        return dict(row)

    def latest_run_for_building(self, building_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM runs WHERE building_id = ? ORDER BY started_at DESC LIMIT 1",
                (building_id,),
            ).fetchone()
        return dict(row) if row else None

    def set_status(self, run_id: str, status: str, *, error: str | None = None) -> None:
        with self._lock:
            finished = now_iso() if status in {"awaiting_approval", "failed"} else None
            self._db.execute(
                "UPDATE runs SET status = ?, error = COALESCE(?, error), "
                "finished_at = COALESCE(?, finished_at) WHERE run_id = ?",
                (status, error, finished, run_id),
            )
            self._db.commit()

    # --------------------------------------------------------------- events

    def append_event(
        self,
        run_id: str,
        *,
        type: str,
        message: str,
        tool_name: str | None = None,
        payload: dict[str, Any] | None = None,
        duration_ms: int | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            seq = (
                self._db.execute(
                    "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE run_id = ?",
                    (run_id,),
                ).fetchone()["next"]
            )
            event = {
                "id": f"{run_id}-evt-{seq:02d}",
                "run_id": run_id,
                "seq": seq,
                "timestamp": now_iso(),
                "type": type,
                "tool_name": tool_name,
                "message": message,
                "payload": payload,
                "duration_ms": duration_ms,
            }
            self._db.execute(
                "INSERT INTO events (id, run_id, seq, timestamp, type, tool_name, message, "
                "payload, duration_ms) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    event["id"],
                    run_id,
                    seq,
                    event["timestamp"],
                    type,
                    tool_name,
                    message,
                    json.dumps(payload) if payload is not None else None,
                    duration_ms,
                ),
            )
            self._db.commit()
            return event

    def get_events(self, run_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM events WHERE run_id = ? ORDER BY seq ASC", (run_id,)
            ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            event = dict(row)
            event["payload"] = json.loads(event["payload"]) if event["payload"] else None
            out.append(event)
        return out

    # ---------------------------------------------------------------- plans

    def save_plan(self, run_id: str, plan: dict[str, Any]) -> dict[str, Any]:
        """
        Persists the plan and its actions. `plan['actions']` is stored in the
        actions table, not in the plan blob, because approve/reject update one
        row rather than rewriting the document.
        """
        actions = plan.get("actions", [])
        doc = {k: v for k, v in plan.items() if k != "actions"}
        with self._lock:
            self._db.execute("DELETE FROM actions WHERE run_id = ?", (run_id,))
            self._db.execute(
                "INSERT OR REPLACE INTO plans (run_id, created_at, doc) VALUES (?,?,?)",
                (run_id, plan["created_at"], json.dumps(doc)),
            )
            for position, action in enumerate(actions):
                self._db.execute(
                    "INSERT INTO actions (id, run_id, position, status, doc) VALUES (?,?,?,?,?)",
                    (action["id"], run_id, position, action["status"], json.dumps(action)),
                )
            self._db.commit()
        return self.get_plan(run_id)

    def has_plan(self, run_id: str) -> bool:
        with self._lock:
            row = self._db.execute("SELECT 1 FROM plans WHERE run_id = ?", (run_id,)).fetchone()
        return row is not None

    def get_plan(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._db.execute("SELECT * FROM plans WHERE run_id = ?", (run_id,)).fetchone()
            if row is None:
                raise NotFound("Plan is not ready yet. The agent run is still in progress.")
            action_rows = self._db.execute(
                "SELECT * FROM actions WHERE run_id = ? ORDER BY position ASC", (run_id,)
            ).fetchall()
        plan = json.loads(row["doc"])
        actions = []
        for action_row in action_rows:
            action = json.loads(action_row["doc"])
            action["status"] = action_row["status"]
            actions.append(action)
        plan["actions"] = actions
        plan["status"] = derive_plan_status(actions)
        return plan

    # -------------------------------------------------------------- actions

    def decide_action(self, action_id: str, decision: str) -> tuple[dict[str, Any], dict[str, Any]]:
        """
        Approve or reject one action, then recompute the plan's status.

        Raises NotFound when no plan owns the id and Conflict when the action
        has already been decided -- the frontend relies on the 409 to tell the
        difference between "gone" and "already done".
        """
        with self._lock:
            row = self._db.execute("SELECT * FROM actions WHERE id = ?", (action_id,)).fetchone()
            if row is None:
                raise NotFound("No action plan is awaiting a decision.")
            if row["status"] != "pending":
                raise Conflict(f"Action {action_id} was already {row['status']}.")
            self._db.execute("UPDATE actions SET status = ? WHERE id = ?", (decision, action_id))
            self._db.commit()
            run_id = row["run_id"]

        plan = self.get_plan(run_id)
        self.set_status(run_id, plan["status"])
        action = next(a for a in plan["actions"] if a["id"] == action_id)
        return action, plan

    # ---------------------------------------------------------------- reset

    def reset_building(self, building_id: str) -> None:
        """Clears only this building. A run on another building survives."""
        with self._lock:
            rows = self._db.execute(
                "SELECT run_id FROM runs WHERE building_id = ?", (building_id,)
            ).fetchall()
            for row in rows:
                run_id = row["run_id"]
                self._db.execute("DELETE FROM events WHERE run_id = ?", (run_id,))
                self._db.execute("DELETE FROM actions WHERE run_id = ?", (run_id,))
                self._db.execute("DELETE FROM plans WHERE run_id = ?", (run_id,))
            self._db.execute("DELETE FROM runs WHERE building_id = ?", (building_id,))
            self._db.commit()

    def reset_all(self) -> None:
        """Test helper. Never called from a route."""
        with self._lock:
            for table in ("events", "actions", "plans", "runs"):
                self._db.execute(f"DELETE FROM {table}")
            self._db.commit()


def derive_plan_status(actions: list[dict[str, Any]]) -> str:
    """
    Plan status from its actions:
        any still pending          -> awaiting_approval
        all decided, >= 1 approved -> approved
        all decided, none approved -> rejected
    """
    if not actions:
        return "awaiting_approval"
    if any(a["status"] == "pending" for a in actions):
        return "awaiting_approval"
    return "approved" if any(a["status"] == "approved" for a in actions) else "rejected"


#: The process-wide store. Swap the path for a file to persist across restarts.
store = Store()
