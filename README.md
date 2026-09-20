# GridShift

**An agent that moves a commercial building's electricity use off its own peak — and asks a human before it touches anything.**

Large buildings are not billed only for the energy they use. They are billed again for their single worst fifteen minutes of the month. One hot Tuesday afternoon sets a demand charge that is paid for the following thirty days. The load causing it is often movable: a battery, a row of EV chargers, an air handler with a comfort band.

GridShift forecasts tomorrow's load, finds the peak, works out what to move, and writes a plan a facility manager can approve or reject. It never dispatches anything itself.

---

## What it actually does

Given a real metered day, the optimizer returns a schedule for four sites:

| Site | Peak | Cut | Energy | Rows |
|---|---|---|---|---|
| Cascade Commerce Center (office) | 522 → 385 kW | −137 kW | $23.13/day | 2 |
| Harborview Medical Annex (hospital) | 884 → 765 kW | −119 kW | $22.94/day | 2 |
| Duwamish Logistics Hub (warehouse) | 426 → 234 kW | −192 kW | $20.69/day | 2 |
| Alder Street Residence | 13.4 → 4.7 kW | −8.7 kW | $2.68/day | 2 |

At $8.50/kW those cuts are worth $1,162, $1,008, $1,631 and $74 a month respectively.

**One of those numbers goes the wrong way, and that is the interesting one.** On 2018-08-09 — the real metered day the demo serves — the office's peak sits between 09:00 and 14:00, which this tariff prices *off*-peak. The only way out of the peak is into the expensive hours, so flattening it **costs $13.34 of energy** to save $1,374 of demand charge. The plan makes that trade deliberately and says so on screen. We left it in rather than picking a day that flattered us.

---

## What is real, and what is not

Judges ask this first, so:

**Real.** The forecast. One year of hourly interval data for a specific 46,000 ft² medium office in King County, Seattle — ComStock 2025 Release 3, AMY2018 weather, building 13847 — joined to NOAA observations from Boeing Field. A LightGBM model trained on it predicts 2018-08-09 to **3.4 kW MAE, 3.5% MAPE, R² 0.987**, and that prediction is what the dashboard draws and the optimizer plans against.

**Real.** The optimization. A mixed-integer program over battery, EV and HVAC, minimising peak and then cost, subject to inverter limits, reserve floors, charging deadlines and comfort bands. It prices round-trip battery losses at 95% each way, so the pack must buy back everything it spends. That makes the savings smaller than they would otherwise be and it is the reason to believe them.

**Real.** The agent. Gemini with function calling over read-only tools — forecast, tariff, battery state, EV requirements, HVAC constraints — deciding what to inspect, then calling the optimizer and writing the plan up. It stops at `request_human_approval`.

**Not real.** Three of the four buildings. Only the office has a measured day behind it; the hospital, warehouse and residence are authored fixtures on the same contract, there to show the same machinery reading correctly at 884 kW and at 4.7 kW. The device inventory — pack sizes, bay counts, comfort bands — is specified, not metered.

**Not real.** The dispatch. Nothing is wired to a building. Approving a plan marks it approved.

---

## How it fits together

```
ComStock + NOAA ──► PostgreSQL ──► features ──► LightGBM ──► forecast artifacts
                                                                    │
                                                                    ▼
   browser ◄──── Next.js dashboard ◄──── FastAPI ◄──── Gemini agent ─┤
                                             │                      │
                                             └──────► MIP optimizer ─┘
                                                      (battery/EV/HVAC)
```

The backend reads the forecast from files the ML harness writes offline. **No database connection exists in the request path** — no credential to leak, nothing to time out on stage, and the demo runs on a laptop with the WiFi off (with the scripted agent).

### The one rule

Every curve on every screen satisfies

```
grid_kw = base_kw + ev_kw + hvac_kw - solar_kw - battery_kw
```

`battery_kw` is the only signed field: positive discharges into the building, negative charges from the grid. The optimized curve is *derived* from the components rather than reported separately, so an action that claims 194.7 kW is 194.7 kW that moves the line. The identity is asserted in the API, in the tests, and by a script that checks the frontend's offline fixtures against the backend hour by hour.

---

## Running it

```powershell
.\run-demo.ps1
```

API on 8001, dashboard on 3000, each in its own window. Then open <http://localhost:3000>.

| | |
|---|---|
| `.\run-demo.ps1 -Agent fake` | scripted agent: ~17 s, no API key, no network, identical plan |
| `.\run-demo.ps1 -Forecast fixtures` | authored curves instead of the metered day |
| `.\run-demo.ps1 -Only dashboard` | restart the UI without dropping a run in progress |

The live agent needs `GEMINI_API_KEY` in `.env` at the repository root and takes about 80 seconds. The scripted one produces the same plan — the optimizer decides it either way, the agent only narrates — and is the one to fall back to if the venue WiFi is bad.

First-time setup:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt -r ml\requirements.txt -r data\scripts\requirements.txt
cd frontend; npm install; cd ..
```

### Tests

```powershell
.venv\Scripts\python.exe -m pytest                      # 218 tests
.venv\Scripts\python.exe backend\scripts\dump_fixture_truth.py
cd frontend; npx tsx scripts\verify-fixtures.ts         # frontend vs backend
```

---

## Layout

| Path | |
|---|---|
| `data/` | ingestion from ComStock and NOAA into PostgreSQL |
| `ml/` | features, LightGBM forecaster, backtest harness |
| `optimizer/` | the MIP engine: battery, EV and HVAC under one objective |
| `backend/` | FastAPI, the Gemini agent, the four building fixtures |
| `frontend/` | Next.js dashboard, 3D scene, offline fixtures |
| `docs/` | [architecture](docs/architecture.md) · [API contract](docs/api-contracts.md) · [data and model decisions](docs/selected-data-and-model.md) |

Deeper notes live in [`backend/README.md`](backend/README.md) — the contract, the three forecast modes, the three optimizers and why each exists.

---

## Team

Built at SASEHack 2026.

- **Sourabha Dharwad** ([@SourabhVD](https://github.com/SourabhVD)) — data pipeline, feature engineering, LightGBM forecaster
- **Minh Thang Nguyen** — the OR-Tools optimization engine
- [@wendyn06](https://github.com/wendyn06) — the initial FastAPI backend and schemas
- **Vinh Nguyen** ([@vincent3DArt](https://github.com/vincent3DArt)) — backend and API contract, Gemini agent, dashboard and 3D scene

---

## Honest limitations

- One forecast day and one building with real data behind it. More days are more directories; the reader already handles them.
- The device inventory is specified rather than metered. The optimizer has a database path for real device tables; the demo does not use it.
- `estimated_peak_reduction_kw` is measured at the *baseline* peak hour, which understates a lever that works elsewhere — the warehouse battery reads 0 kW and −$2.16 even though removing it would push the evening above the original peak. The action description explains this rather than the number being redefined.
- Nothing dispatches. That is a design decision for a demo, not an oversight, but it is the largest gap between this and a product.
