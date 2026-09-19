# Repository Guidelines

## Technology stack

- Frontend: Next.js, TypeScript, Tailwind CSS, and Recharts.
- Backend: FastAPI and PostgreSQL.
- Machine learning: scikit-learn.
- Optimization: OR-Tools.
- Agent: Gemini API tool calling.

## Architecture rules

- Gemini must orchestrate tools but must not calculate schedules itself.
- The frontend must never directly access `GEMINI_API_KEY`.
- API routes should call services instead of containing business logic.
