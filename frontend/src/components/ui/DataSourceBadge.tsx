'use client';

/**
 * What the dashboard is actually running on, said out loud in the header.
 *
 * `NEXT_PUBLIC_USE_MOCK=partial` is the integration mode: every call tries the
 * backend and falls back to the fixture per endpoint. The header used to key
 * its badge off `apiMode !== 'real'`, which meant a dashboard serving nothing
 * but live backend data still announced "Mock data" in amber -- the one claim
 * on the screen that undersells everything under it, in front of the one
 * audience that will not ask.
 *
 * `endpointStatus` has recorded live-vs-fallback per endpoint since partial
 * mode was written, and nothing rendered it. This does:
 *
 *   mock mode      "Mock data"            amber, as before
 *   real mode      nothing                the backend is the only source
 *   partial, live  "Live"                 green, once something has answered
 *   partial, mixed "Live · 5 of 7"        amber, with the fallbacks named
 *
 * Endpoints nobody has called yet are not counted: before a run there is no
 * plan and no event stream, and "2 of 8" on a working dashboard would be its
 * own kind of lie.
 */

import { useSyncExternalStore } from 'react';

import {
  ENDPOINT_KEYS,
  ENDPOINT_PATHS,
  apiMode,
  endpointStatus,
  type EndpointKey,
} from '@/lib/apiMode';

import { Badge } from './Badge';

interface Tally {
  live: number;
  fallback: number;
  /** Paths serving fixture data, for the tooltip. */
  fallbackPaths: string[];
}

function tally(status: Record<EndpointKey, string>): Tally {
  const fallbackPaths: string[] = [];
  let live = 0;
  for (const key of ENDPOINT_KEYS) {
    if (status[key] === 'live') live += 1;
    else if (status[key] === 'fallback') fallbackPaths.push(ENDPOINT_PATHS[key]);
  }
  return { live, fallback: fallbackPaths.length, fallbackPaths };
}

export function DataSourceBadge() {
  const status = useSyncExternalStore(
    endpointStatus.subscribe,
    endpointStatus.getSnapshot,
    endpointStatus.getServerSnapshot,
  );

  if (apiMode === 'real') return null;
  if (apiMode === 'mock') return <Badge tone="warn">Mock data</Badge>;

  const { live, fallback, fallbackPaths } = tally(status);

  // Nothing has answered yet. Saying anything here would be guessing.
  if (live === 0 && fallback === 0) return null;

  if (fallback === 0) {
    return (
      <span title="Every endpoint called so far was answered by the backend.">
        <Badge tone="good" dot>
          Live
        </Badge>
      </span>
    );
  }

  if (live === 0) {
    return (
      <span title={`Backend unreachable; serving fixtures for ${fallbackPaths.join(', ')}.`}>
        <Badge tone="warn">Mock data</Badge>
      </span>
    );
  }

  return (
    <span title={`Serving fixtures for ${fallbackPaths.join(', ')}.`}>
      <Badge tone="warn" dot>
        {`Live · ${live} of ${live + fallback}`}
      </Badge>
    </span>
  );
}

export default DataSourceBadge;
