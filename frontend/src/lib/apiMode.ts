/**
 * How `src/lib/api.ts` is allowed to talk to the backend, plus the tiny
 * observable that records what actually happened per endpoint.
 *
 * NEXT_PUBLIC_USE_MOCK is parsed exactly once, here:
 *
 *   'true' (or unset)  -> 'mock'     every call is served from src/mocks
 *   'false'            -> 'real'     every call is a fetch; failures surface
 *   'partial'          -> 'partial'  try the backend, fall back per endpoint
 *
 * 'partial' is the integration mode: the backend can be stood up one endpoint
 * at a time and the rest of the dashboard keeps working off the mock. Which
 * endpoint is on which side is recorded in `endpointStatus` so a badge can show
 * it -- nothing renders it yet.
 *
 * This module has no imports on purpose: api.ts, and later a header badge, both
 * read it, and neither should drag the mock server into a real-backend bundle.
 */

/* -------------------------------------------------------------------------- */
/* Mode                                                                        */
/* -------------------------------------------------------------------------- */

export type ApiMode = 'mock' | 'real' | 'partial';

function parseApiMode(raw: string | undefined): ApiMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'false') return 'real';
  if (value === 'partial') return 'partial';
  if (value !== '' && value !== 'true') {
    console.warn(
      `[api] NEXT_PUBLIC_USE_MOCK="${raw}" is not one of true | false | partial; using the mock.`,
    );
  }
  return 'mock';
}

/** The one parse of NEXT_PUBLIC_USE_MOCK. Inlined at build time by Next. */
export const apiMode: ApiMode = parseApiMode(process.env.NEXT_PUBLIC_USE_MOCK);

/**
 * True whenever fixture data can reach the UI -- i.e. in 'mock' AND 'partial'.
 * This is what the MOCK badge in the header keys off; a future badge can use
 * `endpointStatus` to say "3 of 9 live" instead.
 */
export const isMockMode: boolean = apiMode !== 'real';

/* -------------------------------------------------------------------------- */
/* Per-endpoint status                                                         */
/* -------------------------------------------------------------------------- */

/** One key per logical endpoint. `actions` covers approve and reject both. */
export type EndpointKey =
  | 'buildings'
  | 'summary'
  | 'forecast'
  | 'run'
  | 'events'
  | 'plan'
  | 'actions'
  | 'reset';

/**
 * 'live'     the last call for this endpoint was answered by the backend
 * 'fallback' the last call was served by the mock instead
 * 'unknown'  not called yet (and the permanent value outside 'partial' mode)
 */
export type EndpointState = 'live' | 'fallback' | 'unknown';

export type EndpointStatusMap = Readonly<Record<EndpointKey, EndpointState>>;

/** Path shown in fallback logs and, later, in the badge tooltip. */
export const ENDPOINT_PATHS: Readonly<Record<EndpointKey, string>> = Object.freeze({
  buildings: '/api/buildings',
  summary: '/api/dashboard/summary',
  forecast: '/api/forecast',
  run: '/api/gridshift/run',
  events: '/api/gridshift/{run_id}/events',
  plan: '/api/gridshift/{run_id}/plan',
  actions: '/api/actions/{action_id}',
  reset: '/api/demo/reset',
});

export const ENDPOINT_KEYS: readonly EndpointKey[] = Object.freeze(
  Object.keys(ENDPOINT_PATHS) as EndpointKey[],
);

function emptyStatus(): EndpointStatusMap {
  return Object.freeze({
    buildings: 'unknown',
    summary: 'unknown',
    forecast: 'unknown',
    run: 'unknown',
    events: 'unknown',
    plan: 'unknown',
    actions: 'unknown',
    reset: 'unknown',
  });
}

/** Stable reference for useSyncExternalStore's server snapshot. */
const INITIAL_STATUS: EndpointStatusMap = emptyStatus();

let snapshot: EndpointStatusMap = INITIAL_STATUS;
const listeners = new Set<() => void>();
/** Endpoints already announced, so a 1 s poll logs its fallback exactly once. */
const announced = new Set<EndpointKey>();

function publish(key: EndpointKey, state: EndpointState): void {
  if (snapshot[key] === state) return;
  snapshot = Object.freeze({ ...snapshot, [key]: state });
  for (const listener of listeners) listener();
}

/**
 * Observable, shaped for `useSyncExternalStore(subscribe, getSnapshot,
 * getServerSnapshot)`. The snapshot is a frozen object replaced on change, so
 * identity comparison is enough to re-render.
 */
export const endpointStatus = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getSnapshot(): EndpointStatusMap {
    return snapshot;
  },

  /** SSR and hydration always start from "nothing has been called yet". */
  getServerSnapshot(): EndpointStatusMap {
    return INITIAL_STATUS;
  },

  get(key: EndpointKey): EndpointState {
    return snapshot[key];
  },

  /** The backend answered. Silent -- only the fall *back* is worth a line. */
  markLive(key: EndpointKey): void {
    publish(key, 'live');
  },

  /**
   * The mock answered instead. Logs once per endpoint per page load, never on
   * every poll tick.
   */
  markFallback(key: EndpointKey): void {
    if (!announced.has(key)) {
      announced.add(key);
      console.info(`[api] ${ENDPOINT_PATHS[key]} not available, using mock`);
    }
    publish(key, 'fallback');
  },

  /** Test/debug helper: forget everything that has been observed. */
  reset(): void {
    announced.clear();
    snapshot = INITIAL_STATUS;
    for (const listener of listeners) listener();
  },
};
