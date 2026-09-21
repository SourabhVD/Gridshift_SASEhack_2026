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
 *                       then load summary + forecast for EVERY building at
 *                       once (the portfolio layer below)
 *   selectBuilding() -> abort polling and playback, clear the run, and serve
 *                       the new building straight out of `sites` -- no null
 *                       gap, because the 3D campus must not unmount mid-flight
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
 *
 * ## The portfolio layer
 *
 * One campus, four sites. `sites` holds every building's summary, forecast and
 * (once it exists) plan, so the world can be drawn and summed without the
 * active building being special. The single-building fields above are untouched
 * -- they still mean "the site you are standing in" -- and `level` says whether
 * anybody is standing in one:
 *
 *   'portfolio'  the top-down campus. The entry point, always: a remembered
 *                building still opens on the world, because the world is what
 *                the page is about.
 *   'site'       one building's dashboard, flown down to.
 *
 * `portfolioAt(hour)` is the sum, and it reads each site the way `flowsAt`
 * reads the active one: the plan's optimized flows when that site has a plan
 * and the page is showing the optimized day, the forecast otherwise.
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
  BacktestReport,
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

/** Default travel time for `playTo`, the cold open's one-shot scrub. */
export const PLAY_TO_DURATION_MS = 2400;

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

/** Which of the two worlds the page is showing. */
export type ViewLevel = 'portfolio' | 'site';

/** Everything the campus knows about one site, active or not. */
export interface SiteState {
  building: Building;
  summary: DashboardSummary | null;
  forecast: ForecastResponse | null;
  /** The plan this site is holding, if its agent has run. */
  plan: ActionPlan | null;
}

/** One site's line in a portfolio reading. */
export interface PortfolioSite {
  id: string;
  grid_kw: number;
  /** `grid_kw` is above this site's own billed cap. */
  over: boolean;
  threshold: number;
}

/** The whole campus at one hour. */
export interface PortfolioReading {
  total_grid_kw: number;
  /** Building ids over their own cap, in registry order. */
  sites_over_cap: string[];
  per_site: PortfolioSite[];
}

export interface GridShiftValue {
  /* ---- buildings ---- */
  buildings: Building[];
  /** The selected building's record, or null until the list has loaded. */
  building: Building | null;
  buildingId: string;
  selectBuilding: (id: string) => Promise<void>;

  /* ---- portfolio ---- */
  /** Every site, keyed by building id. Empty until the bootstrap lands. */
  sites: Record<string, SiteState>;
  level: ViewLevel;
  setLevel: (level: ViewLevel) => void;
  /** Select a building AND fly down to it. */
  enterSite: (id: string) => Promise<void>;
  /** Back up to the campus. The active building stays selected. */
  exitToPortfolio: () => void;
  /** The campus summed at one hour, with each site's own cap applied. */
  portfolioAt: (hour: number) => PortfolioReading;
  /** `flowsAt` for any site, active or not. */
  siteFlowsAt: (id: string, hour: number) => EnergyFlows | null;

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
  /**
   * One-shot scrub from 00:00 to `hour`, eased over `durationMs` on rAF rather
   * than on the 700ms tick. Used by the cold open; `pause()` cancels it, so any
   * transport press or store reset stops it the same way it stops playback.
   */
  playTo: (hour: number, durationMs?: number) => void;

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
  /** Real metered days the backend can plan, oldest first. Empty in mock mode. */
  backtestDates: string[];
  /** The day being shown. '' means whatever the backend defaults to. */
  selectedDate: string;
  selectDate: (date: string) => Promise<void>;
  /** Every available day solved. Null until asked for, or when unavailable. */
  report: BacktestReport | null;
  isReportLoading: boolean;
  loadReport: () => Promise<void>;
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

/**
 * One site's flows for one hour, with the same rule `flowsAt` applies to the
 * active building: the plan wins in optimized mode, the forecast otherwise.
 * Pure, so both the active cursor and the portfolio sum can share it.
 */
/**
 * One site's flows at an hour, for the campus view.
 *
 * An APPROVED plan is not a proposal any more -- it is what that site will do
 * -- so it counts whether or not the preview toggle is asking to see it.
 * Without this, approving plans on three of four sites left the campus still
 * announcing "4 of 4 sites exceed their cap today", because every campus
 * number was read off the untouched forecast. An unapproved plan stays a
 * proposal and only shows while the toggle asks for it.
 *
 * The single-site view has its own `flowsAt` and is deliberately not this: its
 * Baseline/Optimized toggle is a before-and-after control and has to keep
 * showing the before.
 */
function flowsOf(site: SiteState | undefined, hour: number, mode: ViewMode): EnergyFlows | null {
  if (!site) return null;
  const baseline = site.forecast?.points[hour]?.flows ?? null;
  if (!site.plan) return baseline;
  const committed = site.plan.status === 'approved';
  if (committed || mode === 'optimized') {
    return site.plan.impact[hour]?.optimized_flows ?? baseline;
  }
  return baseline;
}

/** True once this site's plan has been approved by a human. */
export function isCommitted(site: SiteState | undefined): boolean {
  return site?.plan?.status === 'approved';
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

  const [backtestDates, setBacktestDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [isReportLoading, setIsReportLoading] = useState(false);
  /* Read by callbacks that must not be re-created when the date changes.
     Written only where the date actually changes -- selectDate and the
     bootstrap -- never during render. */
  const selectedDateRef = useRef('');

  const [sites, setSites] = useState<Record<string, SiteState>>({});
  /* The world is the entry point. A remembered building decides WHICH site the
     breadcrumb and the dashboards below are about; it never opens it. */
  const [level, setLevel] = useState<ViewLevel>('portfolio');

  const [viewHour, setViewHourState] = useState<number>(FALLBACK_NOW_HOUR);
  const [isPlaying, setIsPlaying] = useState(false);
  const [viewMode, setViewModeState] = useState<ViewMode>('baseline');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Frame handle for `playTo`; the only other thing `pause()` has to cancel. */
  const scrubRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  /** Mirrors viewHour so the playback tick can read it without re-subscribing. */
  const viewHourRef = useRef(FALLBACK_NOW_HOUR);
  /** Mirrors buildingId for the poll loop, which only carries a run id. */
  const buildingIdRef = useRef(DEFAULT_BUILDING_ID);
  /** Mirrors sites, so `selectBuilding` can read the cache without re-binding. */
  const sitesRef = useRef<Record<string, SiteState>>({});
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
    if (scrubRef.current !== null) {
      cancelAnimationFrame(scrubRef.current);
      scrubRef.current = null;
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
      if (scrubRef.current !== null) {
        cancelAnimationFrame(scrubRef.current);
        scrubRef.current = null;
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

  /** The single writer for `sites`, so the ref and the state never disagree. */
  const writeSites = useCallback(
    (update: (prev: Record<string, SiteState>) => Record<string, SiteState>) => {
      const next = update(sitesRef.current);
      sitesRef.current = next;
      setSites(next);
    },
    [],
  );

  /**
   * Sets the active plan AND the copy the campus reads. Every place a plan
   * arrives or changes goes through here; `clearRun` deliberately does not, so
   * walking away from a site leaves its plan on the campus.
   */
  const commitPlan = useCallback(
    (nextPlan: ActionPlan | null) => {
      setPlan(nextPlan);
      const id = buildingIdRef.current;
      writeSites((prev) => {
        const current = prev[id];
        if (!current || current.plan === nextPlan) return prev;
        return { ...prev, [id]: { ...current, plan: nextPlan } };
      });
    },
    [writeSites],
  );

  /** Loads one building's dashboard and parks the scrubber on its "now". */
  const loadDashboard = useCallback(
    async (id: string) => {
      try {
        const date = selectedDateRef.current;
        const [nextSummary, nextForecast] = await Promise.all([
          api.getSummary(id, date),
          api.getForecast(id, date),
        ]);
        if (!mountedRef.current) return;
        setSummary(nextSummary);
        setForecast(nextForecast);
        commitViewHour(summaryHour(nextSummary));
        writeSites((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, summary: nextSummary, forecast: nextForecast } };
        });
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(errorMessage(err));
      }
    },
    [commitViewHour, writeSites],
  );

  /**
   * Eight requests, one await: every building's summary and forecast, so the
   * campus can be drawn and summed before anybody picks a site.
   *
   * Plans are preserved across a reload -- a site that has run its agent keeps
   * its answer -- because only the two payloads are being refreshed here.
   */
  const loadPortfolio = useCallback(
    async (list: readonly Building[], activeId: string) => {
      if (list.length === 0) {
        await loadDashboard(activeId);
        return;
      }
      try {
        const loaded = await Promise.all(
          list.map(async (b) => {
            const [nextSummary, nextForecast] = await Promise.all([
              api.getSummary(b.id),
              api.getForecast(b.id),
            ]);
            return { building: b, summary: nextSummary, forecast: nextForecast };
          }),
        );
        if (!mountedRef.current) return;

        writeSites((prev) => {
          const next: Record<string, SiteState> = {};
          for (const entry of loaded) {
            next[entry.building.id] = {
              building: entry.building,
              summary: entry.summary,
              forecast: entry.forecast,
              plan: prev[entry.building.id]?.plan ?? null,
            };
          }
          return next;
        });

        const active = loaded.find((entry) => entry.building.id === activeId) ?? loaded[0];
        setSummary(active.summary);
        setForecast(active.forecast);
        commitViewHour(summaryHour(active.summary));
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(errorMessage(err));
      }
    },
    [commitViewHour, loadDashboard, writeSites],
  );

  // isLoading starts true, so the bootstrap only has to clear it.
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      let startId = DEFAULT_BUILDING_ID;
      let list: Building[] = [];
      try {
        const res = await api.getBuildings();
        if (cancelled || !mountedRef.current) return;
        list = res.buildings;
        setBuildings(list);

        const stored = readStoredBuildingId();
        if (stored && list.some((b) => b.id === stored)) startId = stored;
        else if (list.length > 0 && !list.some((b) => b.id === startId)) {
          startId = list[0].id;
        }
        buildingIdRef.current = startId;
        setBuildingId(startId);
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setError(errorMessage(err));
      }

      await loadPortfolio(list, startId);

      // Which real days the backend can plan. Not fatal if it cannot answer:
      // an empty list simply means no picker, which is the right outcome in
      // mock mode and on a backend serving authored curves.
      try {
        const listing = await api.getBacktestDates(startId);
        if (!cancelled && mountedRef.current) {
          setBacktestDates(listing.dates);
          setSelectedDate(listing.serving);
          selectedDateRef.current = listing.serving;
        }
      } catch {
        /* no picker, no problem */
      }
      if (!cancelled && mountedRef.current) setIsLoading(false);
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadPortfolio]);

  /* --------------------------------------------------------------- playback */

  const setViewHour = commitViewHour;

  const play = useCallback(() => {
    if (playRef.current !== null || scrubRef.current !== null) return;
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

  /**
   * Walks the hour 0 -> `hour` once, on rAF, writing only when the integer
   * hour actually changes -- ~16 store writes for a whole day, not one a frame.
   * Refuses to start if anything is already driving the cursor.
   */
  const playTo = useCallback(
    (hour: number, durationMs: number = PLAY_TO_DURATION_MS) => {
      if (playRef.current !== null || scrubRef.current !== null) return;

      const target = clampHour(hour);
      if (target <= 0 || durationMs <= 0) {
        commitViewHour(target);
        return;
      }

      commitViewHour(0);
      setIsPlaying(true);

      const started = performance.now();
      const step = (now: number) => {
        if (!mountedRef.current) return;
        const progress = Math.min(1, (now - started) / durationMs);
        const next = Math.round(progress * target);
        if (next !== viewHourRef.current) commitViewHour(next);
        if (progress < 1) {
          scrubRef.current = requestAnimationFrame(step);
          return;
        }
        // Lands on the target and hands the transport back to the viewer.
        scrubRef.current = null;
        setIsPlaying(false);
      };

      scrubRef.current = requestAnimationFrame(step);
    },
    [commitViewHour],
  );

  const togglePlay = useCallback(() => {
    if (playRef.current !== null || scrubRef.current !== null) pause();
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
      commitPlan(nextPlan);
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
  }, [commitPlan]);

  /* ---------------------------------------------------------------- actions */

  const startRun = useCallback(async () => {
    stopPolling();
    setError(null);
    setEvents([]);
    commitPlan(null);
    setRunStatus('running');

    let id: string;
    try {
      const res = await api.startRun(buildingId, selectedDateRef.current);
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
  }, [buildingId, commitPlan, pollOnce, stopPolling]);

  const decide = useCallback(
    async (actionId: string, decision: 'approve' | 'reject') => {
      setIsLoading(true);
      try {
        const res =
          decision === 'approve'
            ? await api.approveAction(actionId)
            : await api.rejectAction(actionId);
        if (!mountedRef.current) return;
        commitPlan(res.plan);
        setRunStatus(res.plan.status);
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(errorMessage(err));
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
    },
    [commitPlan],
  );

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

  /**
   * Show a different day.
   *
   * Clears the run first: a plan belongs to the day it was solved for, and
   * leaving one on screen beside another day's chart is exactly the mismatch
   * the backend was fixed to prevent.
   */
  const selectDate = useCallback(
    async (date: string) => {
      selectedDateRef.current = date;
      setSelectedDate(date);
      clearRun();
      setIsLoading(true);
      try {
        await loadDashboard(buildingIdRef.current);
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
    },
    [clearRun, loadDashboard],
  );

  const loadReport = useCallback(async () => {
    setIsReportLoading(true);
    try {
      const next = await api.getBacktestReport(buildingIdRef.current);
      if (mountedRef.current) setReport(next);
    } finally {
      if (mountedRef.current) setIsReportLoading(false);
    }
  }, []);

  const reset = useCallback(async () => {
    clearRun();
    /* The API resets one building, but the campus is what the page opens on,
       so every site's two payloads are re-read. Only the site being reset
       loses its plan. */
    writeSites((prev) => {
      const current = prev[buildingId];
      if (!current) return prev;
      return { ...prev, [buildingId]: { ...current, plan: null } };
    });
    setIsLoading(true);
    try {
      await api.resetDemo(buildingId);
      if (!mountedRef.current) return;
      await loadPortfolio(buildings, buildingId);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [buildingId, buildings, clearRun, loadPortfolio, writeSites]);

  /**
   * Switch sites.
   *
   * The cached path is the important one: the campus already holds every
   * site's summary and forecast, so the swap is synchronous. Nothing is ever
   * set to null, which is what keeps the WebGL canvas mounted while the camera
   * flies from one lot to another -- a skeleton in the middle of that flight
   * would read as a crash.
   *
   * The scrubber does NOT rewind. One clock for the whole campus.
   */
  const selectBuilding = useCallback(
    async (id: string) => {
      if (id === buildingId) return;

      clearRun();
      buildingIdRef.current = id;
      setBuildingId(id);
      writeStoredBuildingId(id);

      const cached = sitesRef.current[id];
      if (cached?.summary && cached.forecast) {
        setSummary(cached.summary);
        setForecast(cached.forecast);
        /* A site you have already visited keeps the answer its agent found. */
        setPlan(cached.plan);
        setRunStatus(cached.plan?.status ?? 'idle');
        setError(null);
        return;
      }

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

  /* -------------------------------------------------------------- the level */

  const enterSite = useCallback(
    async (id: string) => {
      /* Level first: clicking the site you are already on still has to land. */
      setLevel('site');
      await selectBuilding(id);
    },
    [selectBuilding],
  );

  const exitToPortfolio = useCallback(() => setLevel('portfolio'), []);

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

  const siteFlowsAt = useCallback(
    (id: string, hour: number): EnergyFlows | null =>
      flowsOf(sites[id], clampHour(hour), viewMode),
    [sites, viewMode],
  );

  /**
   * The campus at one hour.
   *
   * Registry order, not insertion order, so the labels, the chapter column and
   * the KPI row all list the four sites the same way. A site whose payloads
   * have not landed reads as 0 kW and never as "over".
   */
  const portfolioAt = useCallback(
    (hour: number): PortfolioReading => {
      const h = clampHour(hour);
      const per_site: PortfolioSite[] = [];
      const sites_over_cap: string[] = [];
      let total = 0;

      for (const b of buildings) {
        const flows = flowsOf(sites[b.id], h, viewMode);
        const grid_kw = flows?.grid_kw ?? 0;
        const threshold = b.peak_threshold_kw;
        const over = flows !== null && grid_kw > threshold;
        total += grid_kw;
        if (over) sites_over_cap.push(b.id);
        per_site.push({ id: b.id, grid_kw, over, threshold });
      }

      return { total_grid_kw: total, sites_over_cap, per_site };
    },
    [buildings, sites, viewMode],
  );

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
      sites,
      level,
      setLevel,
      enterSite,
      exitToPortfolio,
      portfolioAt,
      siteFlowsAt,
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
      playTo,
      viewMode,
      setViewMode,
      flowsAt,
      currentFlows,
      activeTool,
      backtestDates,
      selectedDate,
      selectDate,
      report,
      isReportLoading,
      loadReport,
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
      sites,
      level,
      setLevel,
      enterSite,
      exitToPortfolio,
      portfolioAt,
      siteFlowsAt,
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
      playTo,
      viewMode,
      setViewMode,
      flowsAt,
      currentFlows,
      activeTool,
      backtestDates,
      selectedDate,
      selectDate,
      report,
      isReportLoading,
      loadReport,
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
