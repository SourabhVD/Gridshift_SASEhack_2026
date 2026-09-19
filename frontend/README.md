# GridShift Frontend

The **Energy Command Center** — a single-page dashboard where a facility manager
watches the 24-hour demand forecast, launches the GridShift agent, reads its
reasoning, and approves or rejects the optimized action plan.

Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · Recharts · lucide-react

---

## Run it

```bash
cd frontend
npm install
npm run dev      # http://localhost:3000
```

No backend is required. `NEXT_PUBLIC_USE_MOCK` defaults to `true`, so the app
serves fixtures from `src/mocks/` and simulates the agent run in memory
(~17 seconds, 14 events, then the action plan appears).

```bash
npm run lint     # eslint
npm run build    # production build
```

## Flip to the real backend

```bash
cp .env.example .env.local
```

Then set:

```
NEXT_PUBLIC_USE_MOCK=false
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
```

Restart the dev server — these are `NEXT_PUBLIC_*` vars and are inlined at build
time. Nothing else changes: `src/lib/api.ts` swaps the mock server for `fetch`
behind the same function signatures.

The backend must send CORS headers allowing `http://localhost:3000`. The exact
payloads it has to return are in [`../docs/API_CONTRACT.md`](../docs/API_CONTRACT.md).

---

## Folder map

```
src/
├── app/
│   ├── layout.tsx          Root layout. Fonts + <GridShiftProvider>.
│   ├── page.tsx            Header bar and the dashboard grid. Layout only.
│   └── globals.css         Tailwind v4 @theme — every colour token lives here.
├── components/
│   ├── KpiRow.tsx          STUB — KPI tiles
│   ├── PeakAlert.tsx       STUB — peak banner + "Run agent" button
│   ├── DemandChart.tsx     STUB — 24h forecast vs actual (Recharts)
│   ├── AgentActivity.tsx   STUB — live agent tool log
│   ├── ActionPlan.tsx      STUB — recommended actions + approve/reject
│   ├── ImpactChart.tsx     STUB — baseline vs optimized (Recharts)
│   └── ui/
│       ├── Card.tsx        The one panel primitive
│       └── Badge.tsx       Status pill (neutral | good | warn | alert | info)
├── lib/
│   ├── api.ts              The only module that talks to the backend
│   ├── store.tsx           GridShiftProvider + useGridShift() — shared state
│   ├── format.ts           Display formatters (kW, USD, hours, temps)
│   └── errors.ts           ApiError
├── mocks/
│   ├── fixtures.ts         All demo data. Internally consistent numbers.
│   └── mockServer.ts       In-memory backend: replays the run in real time
└── types/
    └── api.ts              Wire types, snake_case, mirror the Pydantic models
```

---

## How to build a component

Each file in `src/components/` opens with a comment block naming exactly which
fields of `useGridShift()` it consumes and what it must render. Replace the body,
keep the comment block accurate.

Two rules:

1. **Never call `src/lib/api.ts` from a component.** `src/lib/store.tsx` owns all
   fetching, the 1-second poll loop, and error state. Components read:

   ```tsx
   const { summary, forecast, runId, runStatus, events, plan,
           error, isLoading, isMock,
           startRun, approve, reject, reset } = useGridShift();
   ```

2. **Never hardcode a colour.** Use the Tailwind utilities generated from the
   `@theme` block in `globals.css`, or `var(--color-*)` when a library such as
   Recharts needs a literal string in JS.

| Token          | Utilities                             | Use for                    |
| -------------- | ------------------------------------- | -------------------------- |
| `base`         | `bg-base`                             | page background `#0a0f1a`  |
| `surface`      | `bg-surface`                          | card background `#111827`  |
| `surface-2`    | `bg-surface-2`                        | elevated / hover `#16202f` |
| `line`         | `border-line`                         | borders, grid `#1f2937`    |
| `ink`          | `text-ink`                            | primary text `#e5e7eb`     |
| `muted`        | `text-muted`                          | secondary text `#9ca3af`   |
| `forecast`     | `text-forecast` / `stroke-forecast`   | forecast series `#38bdf8`  |
| `peak`         | `text-peak`                           | peak / warning `#f59e0b`   |
| `alert`        | `text-alert`                          | over threshold `#ef4444`   |
| `good`         | `text-good`                           | savings / approved `#10b981` |
| `battery`      | `text-battery`                        | storage `#a78bfa`          |

Opacity modifiers work as usual: `bg-good/10`, `border-alert/30`.

---

## The demo data

One medium office building (~150,000 sq ft) in Seattle on a September weekday,
pinned to `2025-09-18` with "now" at `10:00`.

- Baseline peak **522 kW at 15:00**, threshold **450 kW**, exceeded 13:00–17:00.
- Optimizer cuts the peak to **438 kW** (−84 kW). The new peak is set by 18:00,
  not 15:00 — the shifted EV load becomes the binding interval.
- Three actions: battery 90 kW for 14:00–17:00, four EV sessions moved to
  18:00–20:00, HVAC pre-cool then +3 °F float.
- Energy cost $869.59 → $847.37 (**$22.22**/day). The headline number is the
  demand charge: 84 kW × $8.50/kW ≈ **$714/month** avoided.

Every figure above is computed in `src/mocks/fixtures.ts` from the same hourly
arrays, so the charts, the KPI tiles and the plan cannot disagree.
