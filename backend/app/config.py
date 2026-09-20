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

load_dotenv(PROJECT_ROOT / ".env")


def _csv(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of the environment."""

    #: 'fake' replays the scripted run; 'gemini' calls google-genai.
    agent_mode: str = "fake"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"

    #: 'fixtures' serves the ported demo curves; 'ml' calls the ml package.
    forecast_mode: str = "fixtures"
    ml_model_path: Path = field(default_factory=lambda: REPO_ROOT / "ml" / "artifacts" / "load_forecaster.joblib")
    ml_package_path: Path = field(default_factory=lambda: REPO_ROOT / "ml")

    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:3000"])

    #: Multiplies every simulated agent delay. 0 finishes a run immediately.
    agent_speed: float = 1.0

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
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip(),
        forecast_mode=os.getenv("GRIDSHIFT_FORECAST", "fixtures").strip().lower() or "fixtures",
        ml_model_path=_resolve(
            os.getenv("GRIDSHIFT_ML_MODEL_PATH", ""),
            REPO_ROOT / "ml" / "artifacts" / "load_forecaster.joblib",
        ),
        ml_package_path=_resolve(os.getenv("GRIDSHIFT_ML_PATH", ""), REPO_ROOT / "ml"),
        cors_origins=_csv(os.getenv("CORS_ORIGINS", "http://localhost:3000")),
        agent_speed=float(os.getenv("GRIDSHIFT_AGENT_SPEED", "1.0")),
    )
