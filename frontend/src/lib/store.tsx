'use client';

/**
 * GridShift shared state.
 *
 * This is the ONLY place in the app that calls src/lib/api.ts. Components read
 * everything they need from useGridShift() and never fetch on their own -- that
 * keeps one agent run, one poll loop and one error surface for the whole page.
 *
 * Lifecycle:
 *   mount            -> load the building list, restore the stored building,
 *                       then load summary + forecast in parallel
 *   selectBuilding() -> abort polling and playback, clear the run, load the
 *                       new building's summary + forecast
 *   startRun()       -> POST run, then poll getEvents every 1000ms
 *   is_complete      -> stop polling, fetch the plan, status 'awaiting_approval',
 *                       and flip the view to 'optimized' unless the user has
 *                       already chosen a side
 *   approve/reject   -> plan is replaced with the server's recomputed copy
 *   reset()          -> POST demo reset for this building only, clear the run,
 *                       reload summary+forecast, rewind the scrubber
 *
 * Three cursors sit on top of that and never touch the network:
 *   viewHour   which of the 24 hours the flow diagram and scrubber are showing
 *   isPlaying  a 700 ms interval that walks viewHour to 23 and stops
 *   viewMode   whether the hour is read from the forecast or from the plan
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
  AgentToolName,
  Building,
  DashboardSummary,
  EnergyFlows,
  ForecastResponse,
  RunStatus,
} from '@/types/api';
import { IS_MOCK, api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { hourFromIso } from '@/lib/format';

/** How often the events endpoint is polled while a run is in flight. */
export const POLL_INTERVAL_MS = 1000;

/** One simulated hour per tick while the scrubber is playing. */
export const PLAYBACK_INTERVAL_MS = 700;

/**
 * Building the app opens on before anything is stored. Duplicated from the
 * mock registry on purpose -- the store must not import fixtures, or the real
 * backend build would ship them.
 */
export const DEFAULT_BUILDING_ID = 'sea-office-001';

/** localStorage key holding the last building the user looked at. */
export const BUILDING_STORAGE_KEY = 'gridshift.buildingId';

/** Hour the scrubber falls back to before any summary has loaded. */
const FALLBACK_NOW_HOUR = 10;

const LAST_HOUR = 23;

export type ViewMode = 'baseline' | 'optimized';

export interface GridShiftValue {
  /* ---- buildings ---- */
  buildings: Building[];
  /** The selected building's record, or null until the list has loaded. */
  building: Building | null;
  buildingId: string;
  selectBuilding: (id: string) => Promise<void>;

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

  /* ---- time cursor ---- */
  /** Hour of `summary.timestamp` on the building's own clock. */
  nowHour: number;
  /** The hour (0-23) the flow diagram and scrubber are showing. */
  viewHour: number;
  setViewHour: (hour: number) => void;
  isPlaying: boolean;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;

  /* ---- flows ---- */
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  /** Flows for any hour, from the plan in 'optimized' mode and the forecast otherwise. */
  flowsAt: (hour: number) => EnergyFlows | null;
  /** `flowsAt(viewHour)`, memoised. */
  currentFlows: EnergyFlows | null;

  /* ---- agent ---- */
  /** Tool currently in flight during a run: a tool_call with no tool_result yet. */
  activeTool: AgentToolName | null;

  /* ---- actions ---- */
  startRun: () => Promise<void>;
  approve: (actionId: string) => Promise<void>;
  reject: (actionId: string) => Promise<void>;
  reset: () => Promise<void>;
}

const GridShiftContext = createContext<GridShiftValue | null>(null);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function clampHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  return Math.min(LAST_HOUR, Math.max(0, Math.trunc(hour)));
}

/** localStorage is unavailable in SSR and can throw in private mode. */
function readStoredBuildingId(): string | null {
  try {
    return window.localStorage.getItem(BUILDING_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredBuildingId(id: string): void {
  try {
    window.localStorage.setItem(BUILDING_STORAGE_KEY, id);
  } catch {
    /* storage disabled; the choice just will not survive a reload */
  }
}

function summaryHour(summary: DashboardSummary | null): number {
  if (!summary) return FALLBACK_NOW_HOUR;
  return hourFromIso(summary.timestamp) ?? FALLBACK_NOW_HOUR;
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                    */
/* -------------------------------------------------------------------------- */

export function GridShiftProvider({ children }: { children: ReactNode }) {
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [buildingId, setBuildingId] = useState<string>(DEFAULT_BUILDING_ID);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [viewHour, setViewHourState] = useState<number>(FALLBACK_NOW_HOUR);
  const [isPlaying, setIsPlaying] = useState(false);
  const [viewMode, setViewModeState] = useState<ViewMode>('baseline');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  /** Mirrors viewHour so the playback tick can read it without re-subscribing. */
  const viewHourRef = useRef(FALLBACK_NOW_HOUR);
  /** Set once the user picks a view mode; cleared on reset / building change. */
  const viewModeTouchedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pause = useCallback(() => {
    if (playRef.current !== null) {
      clearInterval(playRef.current);
      playRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  // Never touch state after unmount, and never leave a timer running.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
      if (playRef.current !== null) {
        clearInterval(playRef.current);
        playRef.current = null;
      }
    };
  }, [stopPolling]);

  /* --------------------------------------------------------------- the hour */

  /** The single writer for viewHour, so state and ref never disagree. */
  const commitViewHour = useCallback((hour: number) => {
    const h = clampHour(hour);
    viewHourRef.current = h;
    setViewHourState(h);
  }, []);

  /* ---------------------------------------------------------------- loading */

  /** Loads one building's dashboard and parks the scrubber on its "now". */
  const loadDashboard = useCallback(async (id: string) => {
    try {
      const [nextSummary, nextForecast] = await Promise.all([
        api.getSummary(id),
        api.getForecast(id),
      ]);
      if (!mountedRef.current) return;
      setSummary(nextSummary);
      setForecast(nextForecast);
      commitViewHour(summaryHour(nextSummary));
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorMessage(err));
    }
  }, [commitViewHour]);

  // isLoading starts true, so the bootstrap only has to clear it.
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      let startId = DEFAULT_BUILDING_ID;
      try {
        const { buildings: list } = await api.getBuildings();
        if (cancelled || !mountedRef.current) return;
        setBuildings(list);

        const stored = readStoredBuildingId();
        if (stored && list.some((b) => b.id === stored)) startId = stored;
        else if (list.length > 0 && !list.some((b) => b.id === startId)) {
          startId = list[0].id;
        }
        setBuildingId(startId);
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setError(errorMessage(err));
      }

      await loadDashboard(startId);
      if (!cancelled && mountedRef.current) setIsLoading(false);
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadDashboard]);

  /* --------------------------------------------------------------- playback */

  const setViewHour = commitViewHour;

  const play = useCallback(() => {
    if (playRef.current !== null) return;
    // Starting from the end rewinds, so the button always does something.
    if (viewHourRef.current >= LAST_HOUR) commitViewHour(0);
    setIsPlaying(true);
    playRef.current = setInterval(() => {
      const next = Math.min(LAST_HOUR, viewHourRef.current + 1);
      commitViewHour(next);
      // Stop at the end of the day rather than spinning on hour 23.
      if (next >= LAST_HOUR) pause();
    }, PLAYBACK_INTERVAL_MS);
  }, [commitViewHour, pause]);

  const togglePlay = useCallback(() => {
    if (playRef.current !== null) pause();
    else play();
  }, [pause, play]);

  /* ------------------------------------------------------------- view mode */

  const setViewMode = useCallback((mode: ViewMode) => {
    viewModeTouchedRef.current = true;
    setViewModeState(mode);
  }, []);

  /* ---------------------------------------------------------------- polling */

  /** One poll tick. Resolves true when the loop should stop. */
  const pollOnce = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await api.getEvents(id);
      if (!mountedRef.current) return true;
      setEvents(res.events);

      if (!res.is_complete) return false;

      const nextPlan = await api.getPlan(id);
      if (!mountedRef.current) return true;
      setPlan(nextPlan);
      setRunStatus(nextPlan.status);
      // The plan is the point of the run, so show it -- unless the user has
      // already said which side of the comparison they want to look at.
      if (!viewModeTouchedRef.current) setViewModeState('optimized');
      return true;
    } catch (err) {
      if (!mountedRef.current) return true;
      setError(errorMessage(err));
      setRunStatus('failed');
      return true;
    }
  }, []);

  /* ---------------------------------------------------------------- actions */

  const startRun = useCallback(async () => {
    stopPolling();
    setError(null);
    setEvents([]);
    setPlan(null);
    setRunStatus('running');

    let id: string;
    try {
      const res = await api.startRun(buildingId);
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
  }, [buildingId, pollOnce, stopPolling]);

  const decide = useCallback(async (actionId: string, decision: 'approve' | 'reject') => {
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
  }, []);

  const approve = useCallback((actionId: string) => decide(actionId, 'approve'), [decide]);
  const reject = useCallback((actionId: string) => decide(actionId, 'reject'), [decide]);

  /** Clears everything that belongs to a run, but not the loaded building. */
  const clearRun = useCallback(() => {
    stopPolling();
    pause();
    setRunId(null);
    setRunStatus('idle');
    setEvents([]);
    setPlan(null);
    setError(null);
    viewModeTouchedRef.current = false;
    setViewModeState('baseline');
  }, [pause, stopPolling]);

  const reset = useCallback(async () => {
    clearRun();
    setIsLoading(true);
    try {
      await api.resetDemo(buildingId);
      if (!mountedRef.current) return;
      await loadDashboard(buildingId);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [buildingId, clearRun, loadDashboard]);

  const selectBuilding = useCallback(
    async (id: string) => {
      if (id === buildingId) return;

      clearRun();
      setBuildingId(id);
      writeStoredBuildingId(id);
      setSummary(null);
      setForecast(null);
      setIsLoading(true);
      try {
        await loadDashboard(id);
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
    },
    [buildingId, clearRun, loadDashboard],
  );

  /* ---------------------------------------------------------------- derived */

  const building = useMemo(
    () => buildings.find((b) => b.id === buildingId) ?? null,
    [buildings, buildingId],
  );

  const nowHour = useMemo(() => summaryHour(summary), [summary]);

  /**
   * Stable across the 1s events poll and the 700ms playback tick: it only
   * depends on the two payloads and the mode, so a re-render caused by
   * `events` or `viewHour` does not invalidate consumers memoised on it.
   */
  const flowsAt = useCallback(
    (hour: number): EnergyFlows | null => {
      const h = clampHour(hour);
      if (viewMode === 'optimized' && plan) {
        return plan.impact[h]?.optimized_flows ?? null;
      }
      return forecast?.points[h]?.flows ?? null;
    },
    [forecast, plan, viewMode],
  );

  const currentFlows = useMemo(() => flowsAt(viewHour), [flowsAt, viewHour]);

  const activeTool = useMemo<AgentToolName | null>(() => {
    if (runStatus !== 'running') return null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== 'tool_call' || !event.tool_name) continue;
      let resolved = false;
      for (let j = i + 1; j < events.length; j += 1) {
        if (events[j].type === 'tool_result' && events[j].tool_name === event.tool_name) {
          resolved = true;
          break;
        }
      }
      if (!resolved) return event.tool_name;
    }
    return null;
  }, [events, runStatus]);

  const value = useMemo<GridShiftValue>(
    () => ({
      buildings,
      building,
      buildingId,
      selectBuilding,
      summary,
      forecast,
      runId,
      runStatus,
      events,
      plan,
      error,
      isLoading,
      isMock: IS_MOCK,
      nowHour,
      viewHour,
      setViewHour,
      isPlaying,
      play,
      pause,
      togglePlay,
      viewMode,
      setViewMode,
      flowsAt,
      currentFlows,
      activeTool,
      startRun,
      approve,
      reject,
      reset,
    }),
    [
      buildings,
      building,
      buildingId,
      selectBuilding,
      summary,
      forecast,
      runId,
      runStatus,
      events,
      plan,
      error,
      isLoading,
      nowHour,
      viewHour,
      setViewHour,
      isPlaying,
      play,
      pause,
      togglePlay,
      viewMode,
      setViewMode,
      flowsAt,
      currentFlows,
      activeTool,
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
