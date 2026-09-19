'use client';

/**
 * GridShift shared state.
 *
 * This is the ONLY place in the app that calls src/lib/api.ts. Components read
 * everything they need from useGridShift() and never fetch on their own -- that
 * keeps one agent run, one poll loop and one error surface for the whole page.
 *
 * Lifecycle:
 *   mount            -> load summary + forecast in parallel
 *   startRun()       -> POST run, then poll getEvents every 1000ms
 *   is_complete      -> stop polling, fetch the plan, status 'awaiting_approval'
 *   approve/reject   -> plan is replaced with the server's recomputed copy
 *   reset()          -> POST demo reset, clear the run, reload summary+forecast
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  ActionPlan,
  AgentEvent,
  DashboardSummary,
  ForecastResponse,
  RunStatus,
} from '@/types/api';
import { IS_MOCK, api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

/** How often the events endpoint is polled while a run is in flight. */
export const POLL_INTERVAL_MS = 1000;

export interface GridShiftValue {
  /* ---- data ---- */
  summary: DashboardSummary | null;
  forecast: ForecastResponse | null;
  runId: string | null;
  runStatus: RunStatus;
  events: AgentEvent[];
  plan: ActionPlan | null;
  error: string | null;
  /** True while the initial load, a decision, or a reset is in flight. */
  isLoading: boolean;
  /** True when the app is serving fixtures instead of a real backend. */
  isMock: boolean;

  /* ---- actions ---- */
  startRun: () => Promise<void>;
  approve: (actionId: string) => Promise<void>;
  reject: (actionId: string) => Promise<void>;
  reset: () => Promise<void>;
}

const GridShiftContext = createContext<GridShiftValue | null>(null);

export function GridShiftProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Never touch state after unmount, and never leave a timer running.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  /* ---------------------------------------------------------------- loading */

  const loadDashboard = useCallback(async () => {
    try {
      const [nextSummary, nextForecast] = await Promise.all([
        api.getSummary(),
        api.getForecast(),
      ]);
      if (!mountedRef.current) return;
      setSummary(nextSummary);
      setForecast(nextForecast);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorMessage(err));
    }
  }, []);

  // isLoading starts true, so the bootstrap only has to clear it.
  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      await loadDashboard();
      if (!cancelled && mountedRef.current) setIsLoading(false);
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadDashboard]);

  /* ---------------------------------------------------------------- polling */

  /** One poll tick. Resolves true when the loop should stop. */
  const pollOnce = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await api.getEvents(id);
        if (!mountedRef.current) return true;
        setEvents(res.events);

        if (!res.is_complete) return false;

        const nextPlan = await api.getPlan(id);
        if (!mountedRef.current) return true;
        setPlan(nextPlan);
        setRunStatus(nextPlan.status);
        return true;
      } catch (err) {
        if (!mountedRef.current) return true;
        setError(errorMessage(err));
        setRunStatus('failed');
        return true;
      }
    },
    [],
  );

  /* ---------------------------------------------------------------- actions */

  const startRun = useCallback(async () => {
    stopPolling();
    setError(null);
    setEvents([]);
    setPlan(null);
    setRunStatus('running');

    let id: string;
    try {
      const res = await api.startRun();
      if (!mountedRef.current) return;
      id = res.run_id;
      setRunId(id);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorMessage(err));
      setRunStatus('failed');
      return;
    }

    // Poll immediately so the first events appear without a 1s dead beat.
    const done = await pollOnce(id);
    if (done || !mountedRef.current) return;

    pollRef.current = setInterval(() => {
      void pollOnce(id).then((finished) => {
        if (finished) stopPolling();
      });
    }, POLL_INTERVAL_MS);
  }, [pollOnce, stopPolling]);

  const decide = useCallback(
    async (actionId: string, decision: 'approve' | 'reject') => {
      setIsLoading(true);
      try {
        const res =
          decision === 'approve'
            ? await api.approveAction(actionId)
            : await api.rejectAction(actionId);
        if (!mountedRef.current) return;
        setPlan(res.plan);
        setRunStatus(res.plan.status);
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(errorMessage(err));
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
    },
    [],
  );

  const approve = useCallback((actionId: string) => decide(actionId, 'approve'), [decide]);
  const reject = useCallback((actionId: string) => decide(actionId, 'reject'), [decide]);

  const reset = useCallback(async () => {
    stopPolling();
    setIsLoading(true);
    try {
      await api.resetDemo();
      if (!mountedRef.current) return;
      setRunId(null);
      setRunStatus('idle');
      setEvents([]);
      setPlan(null);
      setError(null);
      await loadDashboard();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [loadDashboard, stopPolling]);

  const value = useMemo<GridShiftValue>(
    () => ({
      summary,
      forecast,
      runId,
      runStatus,
      events,
      plan,
      error,
      isLoading,
      isMock: IS_MOCK,
      startRun,
      approve,
      reject,
      reset,
    }),
    [
      summary,
      forecast,
      runId,
      runStatus,
      events,
      plan,
      error,
      isLoading,
      startRun,
      approve,
      reject,
      reset,
    ],
  );

  return <GridShiftContext.Provider value={value}>{children}</GridShiftContext.Provider>;
}

/** Read GridShift state. Must be called inside <GridShiftProvider>. */
export function useGridShift(): GridShiftValue {
  const ctx = useContext(GridShiftContext);
  if (!ctx) {
    throw new Error('useGridShift() must be used inside <GridShiftProvider>.');
  }
  return ctx;
}
