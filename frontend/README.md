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
(~17 seconds, 14 events, then the action plan appears). All three buildings are
served from the mock, each with its own run, plan and 14-event script.

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

| Variable                   | Default                 | Meaning                                                      |
| -------------------------- | ----------------------- | ------------------------------------------------------------ |
| `NEXT_PUBLIC_USE_MOCK`     | `true`                  | Anything but `'false'` serves the in-memory fixtures.         |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8000` | Origin of the FastAPI backend. No trailing slash.             |

The backend must send CORS headers allowing `http://localhost:3000`, serve
`GET /api/buildings`, and accept `building_id` on every building-scoped
endpoint (see the table below). The exact payloads it has to return are in
[`../docs/API_CONTRACT.md`](../docs/API_CONTRACT.md).

One value is not an env var: `DEFAULT_BUILDING_ID` in `src/lib/store.tsx`
(`sea-office-001`), the site the app opens on before anything is stored in
`localStorage`. It is duplicated there rather than imported from the fixtures so
that a real-backend build does not pull the mock data into the bundle.

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
│   ├── format.ts           Display formatters (kW, USD, hours, temps, flows)
│   └── errors.ts           ApiError
├── mocks/
│   ├── fixtures.ts         Entry point — re-exports the registry
│   ├── mockServer.ts       In-memory backend: replays the run in real time,
│   │                       one run + one plan per building
│   └── buildings/
│       ├── shared.ts       Deterministic generator + the flow identity
│       ├── office.ts       sea-office-001    Cascade Commerce Center
│       ├── hospital.ts     sea-hospital-002  Harborview Medical Annex
│       ├── warehouse.ts    sea-warehouse-003 Duwamish Logistics Hub
│       └── index.ts        Registry, getFixture(), validateFixtures()
└── types/
    └── api.ts              Wire types, snake_case, mirror the Pydantic models
```

### Endpoints

| Endpoint                          | Scope    | Building id passed as   |
| --------------------------------- | -------- | ----------------------- |
| `GET /api/buildings`              | global   | —                       |
| `GET /api/dashboard/summary`      | building | `?building_id=`         |
| `GET /api/forecast`               | building | `?building_id=`         |
| `POST /api/gridshift/run`         | building | body `{ building_id }`  |
| `POST /api/demo/reset`            | building | body `{ building_id }`  |
| `GET /api/gridshift/{id}/events`  | run      | — (run id implies it)   |
| `GET /api/gridshift/{id}/plan`    | run      | — (run id implies it)   |
| `POST /api/actions/{id}/approve`  | action   | — (action id implies it)|
| `POST /api/actions/{id}/reject`   | action   | — (action id implies it)|

`reset` clears only the building you pass; a run in progress on another
building survives.

---

## How to build a component

Each file in `src/components/` opens with a comment block naming exactly which
fields of `useGridShift()` it consumes and what it must render. Replace the body,
keep the comment block accurate.

Two rules:

1. **Never call `src/lib/api.ts` from a component.** `src/lib/store.tsx` owns all
   fetching, the 1-second poll loop, and error state. Components read:

   ```tsx
   const {
     // buildings
     buildings, building, buildingId, selectBuilding,
     // data
     summary, forecast, runId, runStatus, events, plan,
     error, isLoading, isMock,
     // time cursor
     nowHour, viewHour, setViewHour, isPlaying, play, pause, togglePlay,
     // flows
     viewMode, setViewMode, flowsAt, currentFlows,
     // agent
     activeTool,
     // actions
     startRun, approve, reject, reset,
   } = useGridShift();
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

## Buildings and flows

### The three sites

Three Seattle buildings on the same September weekday, pinned to `2025-09-18`
with "now" at `10:00`, on the same tariff ($0.09/kWh off-peak, $0.16/kWh
14:00–20:00, $8.50/kW monthly demand charge).

| id                  | Building                | Type      | Threshold | Baseline peak | Optimized peak | Actions |
| ------------------- | ----------------------- | --------- | --------: | ------------: | -------------: | ------: |
| `sea-office-001`    | Cascade Commerce Center | office    |    450 kW | 522 kW @ 15:00 |        438 kW |       3 |
| `sea-hospital-002`  | Harborview Medical Annex| hospital  |    800 kW | 884 kW @ 14:00 |        792 kW |       3 |
| `sea-warehouse-003` | Duwamish Logistics Hub  | warehouse |    350 kW | 426 kW @ 15:00 |        311 kW |       2 |

`sea-office-001` is the default and is unchanged from the original
single-building demo: same curves, same 14 events, same three actions, energy
cost $869.59 → $847.37 (**$22.22**/day) and 84 kW × $8.50/kW ≈ **$714/month**
of demand charge avoided.

The other two exist to give the UI something with a different shape to say.
The hospital is six hours over threshold and its battery carries a 30%
critical-care reserve floor, so the plan is limited by *duration*, not power.
The warehouse's entire peak is 24 delivery vans charging at once, so its plan
re-queues half of them into the evening and the agent explicitly declines to
invent an HVAC action for an unconditioned high bay — two actions, not three.

### Flows and the sign convention

Every forecast point and every impact point carries an `EnergyFlows` breakdown:

```ts
{ grid_kw, solar_kw, battery_kw, ev_kw, hvac_kw, base_kw, battery_soc_pct }
```

`battery_kw` is **the only signed field**:

- `> 0` — discharging **into** the building (reduces the grid draw)
- `< 0` — charging **from** the grid (increases the grid draw)
- `= 0` — idle

Everything else is a non-negative magnitude. The identity below holds at every
hour of every building, to within 0.1 kW — the three consumers are served first
by the two on-site sources, and the grid covers the remainder:

```
grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw
```

Two more invariants the UI can rely on:

- `forecast.points[h].flows.grid_kw === forecast.points[h].predicted_load_kw`
- `plan.impact[h].baseline_flows.grid_kw === plan.impact[h].baseline_kw` and
  `plan.impact[h].optimized_flows.grid_kw === plan.impact[h].optimized_kw`

`validateFixtures()` in `src/mocks/buildings/index.ts` checks all of this once
per process in development and `console.warn`s anything that drifts. The worst
residual across all three buildings is currently ~1e-13 kW, i.e. float noise.

Nothing is random: every curve comes from a handful of control points in
`src/mocks/buildings/shared.ts`, so the charts, the KPI tiles, the flow diagram
and the action plan are reading the same arithmetic and cannot disagree.

### Store fields for the new UI

| Field                                | Type                         | Notes                                                        |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| `buildings`                          | `Building[]`                 | From `GET /api/buildings`.                                    |
| `building`                           | `Building \| null`           | The selected record.                                          |
| `buildingId`                         | `string`                     | Persisted in `localStorage` under `gridshift.buildingId`.      |
| `selectBuilding(id)`                 | `=> Promise<void>`           | Aborts polling + playback, clears the run, loads the new site. |
| `nowHour`                            | `number`                     | Hour of `summary.timestamp`; `10` before the summary lands.    |
| `viewHour` / `setViewHour(h)`        | `number` / `(h) => void`     | 0–23, clamped. Rewinds to `nowHour` on select and reset.       |
| `isPlaying` / `play` / `pause` / `togglePlay` | `boolean` / `() => void` | 1 hour per 700 ms; restarts from 0 at 23 and stops at 23.  |
| `viewMode` / `setViewMode(m)`        | `'baseline' \| 'optimized'`  | Flips to `optimized` when a plan lands, unless you set it.     |
| `flowsAt(h)`                         | `(h) => EnergyFlows \| null` | Plan in `optimized` mode, forecast otherwise. Stable identity. |
| `currentFlows`                       | `EnergyFlows \| null`        | `flowsAt(viewHour)`, memoised.                                 |
| `activeTool`                         | `AgentToolName \| null`      | In-flight tool during a run; `null` otherwise.                 |

`flowsAt` only changes identity when `forecast`, `plan` or `viewMode` change —
the 1 s events poll and the 700 ms playback tick do not invalidate it, so
consumers can safely memoise on it.
