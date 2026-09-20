'use client';

/**
 * How expensive the scene is allowed to be.
 *
 * Two levels, and the difference is the post-processing composer:
 *   - 'high' mounts <Effects /> (SMAA + bloom + vignette) and turns the
 *     renderer's own MSAA off, because SMAA is doing that job.
 *   - 'low'  mounts no composer at all and lets the context antialias itself.
 *
 * Because the two need different `gl` flags, <Canvas> is keyed on the value:
 * switching quality re-creates the WebGL context. That is deliberate and it is
 * why the governor below is allowed to write exactly once per page load.
 *
 * The value is stored under `gridshift.sceneQuality` in localStorage, so a
 * viewer who drops to 'low' stays there across reloads. `setQuality` is
 * exported for whatever control the dashboard chrome grows later; nothing in
 * this folder renders one.
 */

import { useSyncExternalStore } from 'react';
import { useFrame } from '@react-three/fiber';

export type SceneQuality = 'high' | 'low';

export const QUALITY_STORAGE_KEY = 'gridshift.sceneQuality';

/** A machine with four cores or fewer is assumed to have an integrated GPU too. */
const LOW_CORE_COUNT = 4;
/** r3f regression factor below which the frame budget is considered blown. */
const STRAIN_PERFORMANCE = 0.7;
/** ...and the frame rate that means the same thing when nothing calls regress(). */
const STRAIN_FPS = 32;
/** How long the strain has to last before the governor acts. */
const STRAIN_SECONDS = 3;

const listeners = new Set<() => void>();

/** Snapshot cache: `useSyncExternalStore` needs a stable, cheap read. */
let cached: SceneQuality | null = null;

function isQuality(value: unknown): value is SceneQuality {
  return value === 'high' || value === 'low';
}

function readStored(): SceneQuality | null {
  try {
    const raw = window.localStorage.getItem(QUALITY_STORAGE_KEY);
    return isQuality(raw) ? raw : null;
  } catch {
    // Private mode, blocked storage, or no window at all.
    return null;
  }
}

/** The guess used when nothing has been stored yet. */
function probeQuality(): SceneQuality {
  try {
    const cores = navigator.hardwareConcurrency;
    if (typeof cores === 'number' && cores > 0 && cores <= LOW_CORE_COUNT) return 'low';
  } catch {
    /* ignore */
  }
  return 'high';
}

function snapshot(): SceneQuality {
  if (cached === null) cached = readStored() ?? probeQuality();
  return cached;
}

function serverSnapshot(): SceneQuality {
  return 'high';
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Set the quality level and remember it. Safe to call from anywhere. */
export function setQuality(next: SceneQuality): void {
  cached = next;
  try {
    window.localStorage.setItem(QUALITY_STORAGE_KEY, next);
  } catch {
    /* the in-memory value still applies for this page load */
  }
  for (const listener of listeners) listener();
}

/** Current quality level. `'high'` during SSR and the hydrating paint. */
export function useQuality(): SceneQuality {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/* -------------------------------------------------------------------------- */
/* Governor                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One-shot, per page load. Once this is true the governor never writes again,
 * which is what keeps a viewer who has manually chosen 'high' on a slow machine
 * from being dragged back down every few seconds.
 */
let governed = false;

/** Module scope rather than a ref: a Canvas remount must not reset it. */
let strainSeconds = 0;

/**
 * Watches the frame budget from inside the Canvas and drops to 'low' once.
 *
 * `performance.current` is r3f's own regression factor; it only moves when
 * something calls `regress()`, and nothing in this scene does, so a plain frame
 * rate is measured alongside it. Either signal, held for three continuous
 * seconds, is enough.
 */
export function QualityGovernor() {
  useFrame((state, delta) => {
    if (governed) return;
    if (snapshot() !== 'high') {
      // Already low (stored or probed): nothing to do, and never re-arm.
      governed = true;
      return;
    }

    // A long tab-away must not count as three seconds of strain.
    const dt = Math.min(delta, 0.1);
    const fps = dt > 0 ? 1 / dt : 60;
    const strained = state.performance.current < STRAIN_PERFORMANCE || fps < STRAIN_FPS;

    strainSeconds = strained ? strainSeconds + dt : 0;
    if (strainSeconds >= STRAIN_SECONDS) {
      governed = true;
      setQuality('low');
    }
  });

  return null;
}
