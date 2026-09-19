/**
 * GridShift API contract.
 *
 * These types mirror the FastAPI/Pydantic models on the backend one-for-one.
 * Field names are snake_case on purpose -- they are the wire format, do not
 * rename them when consuming. See docs/API_CONTRACT.md for example payloads.
 */

/* -------------------------------------------------------------------------- */
/* GET /api/dashboard/summary                                                  */
/* -------------------------------------------------------------------------- */

export interface DashboardSummary {
  building_name: string;
  /** ISO 8601 with timezone offset. "Now" for the whole dashboard. */
  timestamp: string;
  current_load_kw: number;
  predicted_peak_kw: number;
  /** ISO 8601 timestamp of the predicted peak interval. */
  predicted_peak_time: string;
  /** Demand threshold the facility is billed against. */
  peak_threshold_kw: number;
  battery_soc_pct: number;
  battery_capacity_kwh: number;
  battery_max_kw: number;
  electricity_price_per_kwh: number;
  solar_generation_kw: number;
  /** Number of EVs currently plugged in. */
  ev_connected: number;
  hvac_setpoint_f: number;
  outdoor_temp_f: number;
}

/* -------------------------------------------------------------------------- */
/* GET /api/forecast                                                           */
/* -------------------------------------------------------------------------- */

export interface ForecastPoint {
  /** ISO 8601, start of the hourly interval. */
  timestamp: string;
  predicted_load_kw: number;
  /** Metered value. Null for intervals that have not happened yet. */
  actual_load_kw: number | null;
  price_per_kwh: number;
  /** True when predicted_load_kw exceeds peak_threshold_kw. */
  is_peak: boolean;
}

export interface ForecastResponse {
  building_name: string;
  generated_at: string;
  peak_threshold_kw: number;
  points: ForecastPoint[];
}

/* -------------------------------------------------------------------------- */
/* Agent run lifecycle                                                         */
/* -------------------------------------------------------------------------- */

export type RunStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'failed';

export type AgentEventType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'decision'
  | 'error'
  | 'complete';

/** The nine tools the Gemini agent is allowed to call. */
export type AgentToolName =
  | 'get_energy_forecast'
  | 'get_electricity_prices'
  | 'get_battery_state'
  | 'get_ev_requirements'
  | 'get_hvac_constraints'
  | 'run_schedule_optimizer'
  | 'validate_schedule'
  | 'save_action_plan'
  | 'request_human_approval';

export interface AgentEvent {
  id: string;
  run_id: string;
  /** Monotonic, 1-based ordering within a run. */
  seq: number;
  timestamp: string;
  type: AgentEventType;
  /** Null for 'thinking' / 'complete' / most 'error' events. */
  tool_name: AgentToolName | null;
  /** Human readable line for the activity log. */
  message: string;
  /** Structured data behind the message (tool args or tool output). */
  payload: Record<string, unknown> | null;
  /** Wall-clock cost of the step, when known. */
  duration_ms: number | null;
}

/** POST /api/gridshift/run */
export interface RunResponse {
  run_id: string;
  status: RunStatus;
  started_at: string;
}

/** GET /api/gridshift/{run_id}/events */
export interface EventsResponse {
  run_id: string;
  status: RunStatus;
  /** Every event emitted so far, ascending by seq. Cumulative, not a delta. */
  events: AgentEvent[];
  /** True once the agent has finished; the client then stops polling. */
  is_complete: boolean;
}

/* -------------------------------------------------------------------------- */
/* Action plan                                                                 */
/* -------------------------------------------------------------------------- */

export type ActionType = 'battery_discharge' | 'ev_charging_shift' | 'hvac_setpoint';

export type ActionStatus = 'pending' | 'approved' | 'rejected' | 'executed';

export interface Action {
  id: string;
  run_id: string;
  type: ActionType;
  title: string;
  description: string;
  /** ISO 8601, inclusive start of the dispatch window. */
  start_time: string;
  /** ISO 8601, exclusive end of the dispatch window. */
  end_time: string;
  /** Size of the action, in `unit`. */
  magnitude: number;
  /** e.g. 'kW' or '°F'. */
  unit: string;
  /**
   * kW this action removes during the BASELINE peak interval. Per-action values
   * do not necessarily sum to ActionPlan.peak_reduction_kw, because the
   * optimized peak can be set by a different interval than the baseline peak.
   */
  estimated_peak_reduction_kw: number;
  estimated_savings_usd: number;
  status: ActionStatus;
  /** Constraint identifiers validate_schedule checked and passed. */
  constraints_checked: string[];
}

export interface ImpactPoint {
  timestamp: string;
  baseline_kw: number;
  optimized_kw: number;
}

/** GET /api/gridshift/{run_id}/plan */
export interface ActionPlan {
  run_id: string;
  status: RunStatus;
  created_at: string;
  /** The agent's one-paragraph rationale, shown above the action list. */
  summary: string;
  baseline_peak_kw: number;
  optimized_peak_kw: number;
  peak_reduction_kw: number;
  baseline_cost_usd: number;
  optimized_cost_usd: number;
  savings_usd: number;
  actions: Action[];
  /** 24 hourly points, baseline vs optimized. */
  impact: ImpactPoint[];
}

/** POST /api/actions/{id}/approve | /reject */
export interface ActionDecisionResponse {
  action: Action;
  /** The whole plan after the decision, including the recomputed status. */
  plan: ActionPlan;
}

/** POST /api/demo/reset */
export interface ResetResponse {
  ok: boolean;
  message: string;
}
