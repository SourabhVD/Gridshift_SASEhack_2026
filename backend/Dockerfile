# GridShift backend.
#
#   docker build -t gridshift-backend backend
#   docker run --rm -p 8000:8000 gridshift-backend
#
# That is the whole demo: four buildings, the scripted agent, the CP-SAT
# optimizer. No key, no database, no volume. Then point the dashboard at
# http://localhost:8000 and it behaves exactly as it does from a venv.
#
# To use the live agent, pass the key at run time rather than baking it in:
#   docker run --rm -p 8000:8000 -e GRIDSHIFT_AGENT=gemini -e GEMINI_API_KEY=... gridshift-backend
#
# To serve a real day, mount the backtest artifacts read-only:
#   docker run --rm -p 8000:8000 \
#     -e GRIDSHIFT_FORECAST=backtest \
#     -e GRIDSHIFT_BACKTEST_PATH=/data/backtests \
#     -v "$PWD/data/processed/backtests:/data/backtests:ro" gridshift-backend
#
# Build context is the REPOSITORY ROOT, because the image needs both backend/
# and the optimizer/ package beside it:
#
#   docker build -f backend/Dockerfile -t gridshift-backend .
#
# It still copies only those two, so the ml package, the frontend and anyone's
# .env stay out of the image.

FROM python:3.12-slim

# Bytecode files and a pip cache in a layer help nobody.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Requirements first, so a code edit does not reinstall OR-Tools every build.
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app

# Component 3, the optimization engine. It is a top-level package beside
# backend/, not a dependency of it, so it is copied in and put on the import
# path. Without it the default optimizer is simply absent and every run fails
# at the moment the agent asks for a schedule.
COPY optimizer /engine/optimizer
ENV PYTHONPATH=/engine

# Run as a non-root user. Nothing here writes to disk, so it needs no ownership
# beyond reading its own code.
RUN useradd --create-home --uid 10001 gridshift
USER gridshift

# Containers reach the API from outside, so the browser origin is not
# localhost-only by default here. Override for a real deployment.
ENV CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else 1)"

# Single worker on purpose: runs are asyncio tasks in this process and the
# store is in memory, so a second worker would answer /events for a run it has
# never heard of. Fixing that means the task queue in HANDOFF.md section 5.5.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
