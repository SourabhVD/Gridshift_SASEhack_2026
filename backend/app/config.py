"""
Environment-driven settings.

Everything the backend can be told is read here, once, at import time.
`backend/.env` is loaded first so that running `uvicorn app.main:app` from
`backend/` picks it up without any shell exports; real environment variables
always win over the file.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

# backend/app/
PACKAGE_ROOT = Path(__file__).resolve().parent
# backend/ -- where .env and requirements.txt live
PROJECT_ROOT = PACKAGE_ROOT.parent
# the git repository root, so ml/ can be found from here
REPO_ROOT = PROJECT_ROOT.parent

# backend/.env first, then the repository root's. load_dotenv does not override
# a name that is already set, so the backend's own file wins where both declare
# one, and the root file supplies the rest. The root .env is where the data
# pipeline already keeps DATABASE_URL, so without this fallback a key pasted
# there -- the obvious place -- is silently invisible here, and the agent
# degrades to fake mode with nothing to say why.
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(REPO_ROOT / ".env")


def _csv(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of the environment."""

    #: 'fake' replays the scripted run; 'gemini' calls google-genai.
    agent_mode: str = "fake"
    gemini_api_key: str = ""
    #: Google retired gemini-2.5-flash for new API keys: the docs still list
    #: it as stable, but the API answers 404 and names 3.6-flash instead.
    gemini_model: str = "gemini-3.6-flash"

    #: 'fixtures' serves the ported demo curves, 'ml' calls the ml package in
    #: process, 'backtest' reads what ml/evaluate_forecast_date.py left on disk.
    forecast_mode: str = "fixtures"
    ml_model_path: Path = field(default_factory=lambda: REPO_ROOT / "ml" / "artifacts" / "load_forecaster.joblib")
    ml_package_path: Path = field(default_factory=lambda: REPO_ROOT / "ml")

    #: Which optimizer decides the plan.
    #:   'engine'    Component 3 in optimizer/ -- the team's real engine, and
    #:               the default. Models round-trip efficiency and prices the
    #:               demand charge against the month's billed peak.
    #:   'cpsat'     the CP-SAT model in services/optimizer.py
    #:   'heuristic' the fixed-order three-lever pass the README's published
    #:               figures were computed from
    optimizer_mode: str = "engine"

    #: Where evaluate_forecast_date writes its per-date directories.
    backtest_path: Path = field(
        default_factory=lambda: REPO_ROOT / "data" / "processed" / "backtests"
    )
    #: Which date to serve. Empty means the most recent one present.
    backtest_date: str = ""
    #: The one site the backtest speaks for. The database holds a single
    #: building; every other slug keeps its fixture curve.
    backtest_building: str = "sea-office-001"

    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:3000"])

    #: Multiplies every simulated agent delay. 0 finishes a run immediately.
    agent_speed: float = 1.0

    #: Gemini's internal thinking budget in tokens. 0 turns it off, which is
    #: the default because the prompt already names every tool and its order,
    #: so there is no plan left for the model to work out. Raise it if a
    #: harder task ever needs it. -1 hands the decision back to the model.
    agent_thinking_budget: int = 0

    @property
    def gemini_available(self) -> bool:
        return bool(self.gemini_api_key)

    @property
    def effective_agent_mode(self) -> str:
        """'gemini' silently degrades to 'fake' with no key -- the demo must run."""
        if self.agent_mode == "gemini" and not self.gemini_available:
            return "fake"
        return self.agent_mode


def _resolve(raw: str, default: Path) -> Path:
    if not raw:
        return default
    path = Path(raw)
    return path if path.is_absolute() else (REPO_ROOT / path)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings(
        agent_mode=os.getenv("GRIDSHIFT_AGENT", "fake").strip().lower() or "fake",
        gemini_api_key=(os.getenv("GEMINI_API_KEY") or "").strip(),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-3.6-flash").strip(),
        forecast_mode=os.getenv("GRIDSHIFT_FORECAST", "fixtures").strip().lower() or "fixtures",
        ml_model_path=_resolve(
            os.getenv("GRIDSHIFT_ML_MODEL_PATH", ""),
            REPO_ROOT / "ml" / "artifacts" / "load_forecaster.joblib",
        ),
        ml_package_path=_resolve(os.getenv("GRIDSHIFT_ML_PATH", ""), REPO_ROOT / "ml"),
        backtest_path=_resolve(
            os.getenv("GRIDSHIFT_BACKTEST_PATH", ""),
            REPO_ROOT / "data" / "processed" / "backtests",
        ),
        optimizer_mode=(
            os.getenv("GRIDSHIFT_OPTIMIZER", "engine").strip().lower() or "engine"
        ),
        backtest_date=os.getenv("GRIDSHIFT_BACKTEST_DATE", "").strip(),
        backtest_building=(
            os.getenv("GRIDSHIFT_BACKTEST_BUILDING", "sea-office-001").strip()
            or "sea-office-001"
        ),
        cors_origins=_csv(os.getenv("CORS_ORIGINS", "http://localhost:3000")),
        agent_speed=float(os.getenv("GRIDSHIFT_AGENT_SPEED", "1.0")),
        agent_thinking_budget=int(os.getenv("GRIDSHIFT_AGENT_THINKING", "0")),
    )
