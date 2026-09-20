"""
GridShift reference backend.

    uvicorn app.main:app --reload --port 8000

Serves the nine endpoints in frontend/src/lib/api.ts against four demo
buildings, with a Gemini function-calling agent that writes its own reasoning
to an event stream. Runs with no API key at all in GRIDSHIFT_AGENT=fake mode.

This is a reference, not the deployment: it is single-process, stores state in
an in-memory SQLite database, and has no authentication. See README.md for
what has to change on the way to production.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import router
from .config import get_settings
from .fixtures import BUILDING_IDS

#: uvicorn's own format, so the agent's event log interleaves cleanly with the
#: access log instead of looking like output from a different program.
LOG_FORMAT = "%(levelname)s:     %(message)s"


def configure_logging() -> None:
    root = logging.getLogger("gridshift")
    if root.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    root.propagate = False


def create_app() -> FastAPI:
    configure_logging()
    settings = get_settings()

    app = FastAPI(
        title="GridShift API (reference)",
        version="0.1.0",
        description=(
            "Reference implementation of the GridShift backend contract. "
            "Endpoint shapes mirror frontend/src/types/api.ts exactly."
        ),
    )

    # The dashboard is a browser app on a different origin, so every response
    # it reads needs these headers -- including the preflight on the POSTs.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
    )

    app.include_router(router)

    @app.get("/health", tags=["meta"])
    def health() -> dict[str, object]:
        """
        Liveness plus the configuration actually in force.

        Read fresh rather than closed over, so this reports what the process is
        really doing after a test or a reload has changed the environment.
        """
        settings = get_settings()
        extra: dict[str, object] = {}
        if settings.forecast_mode == "backtest":
            # The fallback to fixtures is silent by design, and which day is on
            # screen is not on the wire anywhere else. This is where you check
            # whether the backtest actually took.
            from .services import backtest as backtest_reader  # noqa: PLC0415

            block: dict[str, object] = {
                "path": str(settings.backtest_path),
                "available": backtest_reader.available(settings.backtest_path),
                "requested_date": settings.backtest_date or "latest",
                "building": settings.backtest_building,
            }
            # The curve is mapped onto the site's scale so the plan and the
            # agent stay coherent with it. That is a presentational choice and
            # it must not be invisible: the real kW and the factor applied are
            # reported here, next to the day they came from.
            try:
                result = backtest_reader.load(
                    settings.backtest_path, settings.backtest_date
                )
            except backtest_reader.BacktestUnavailable as exc:
                block["serving"] = None
                block["why_not"] = str(exc)
            else:
                from .fixtures import get_fixture  # noqa: PLC0415
                from .services.forecast import onto_site_scale  # noqa: PLC0415

                fixture = get_fixture(settings.backtest_building)
                block["serving"] = {
                    "date": result.date,
                    "timezone": result.timezone or "unknown",
                    "algorithm": result.algorithm,
                    "real_peak_kw": round(max(result.predicted_kw), 1),
                    "real_measured_peak_kw": round(max(result.actual_kw), 1),
                    "scaled_onto_site_by": (
                        round(onto_site_scale(fixture, result.predicted_kw), 4)
                        if fixture is not None
                        else None
                    ),
                }
            extra["backtest"] = block
        return {
            "status": "ok",
            "agent": settings.effective_agent_mode,
            "agent_requested": settings.agent_mode,
            "gemini_key_present": settings.gemini_available,
            "forecast": settings.forecast_mode,
            "buildings": list(BUILDING_IDS),
            "cors_origins": settings.cors_origins,
            **extra,
        }

    logging.getLogger("gridshift").info(
        "GridShift reference backend ready: agent=%s forecast=%s cors=%s",
        settings.effective_agent_mode,
        settings.forecast_mode,
        ",".join(settings.cors_origins),
    )
    return app


app = create_app()
