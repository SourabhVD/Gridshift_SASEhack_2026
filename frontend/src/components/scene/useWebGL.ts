'use client';

/**
 * Client capability probes for the 3D scene.
 *
 * Both hooks are `useSyncExternalStore` over a browser API with an explicit
 * server snapshot, so the server render and the hydrating client render always
 * agree — the panel is server-rendered even though the scene itself is not.
 */

import { useSyncExternalStore } from 'react';

export type WebGLSupport = 'unknown' | 'supported' | 'unsupported';

/* -------------------------------------------------------------------------- */
/* WebGL                                                                       */
/* -------------------------------------------------------------------------- */

/** Probed once per page load; creating a throwaway context is not free. */
let cached: WebGLSupport = 'unknown';

function probe(): WebGLSupport {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGLRenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) return 'unsupported';
    // Hand the context back immediately; browsers cap how many may be live.
    const lose = gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null;
    lose?.loseContext();
    return 'supported';
  } catch {
    return 'unsupported';
  }
}

/** Support never changes within a page load, so there is nothing to subscribe to. */
function subscribeNever(): () => void {
  return () => {};
}

function webglSnapshot(): WebGLSupport {
  if (cached === 'unknown') cached = probe();
  return cached;
}

function webglServerSnapshot(): WebGLSupport {
  return 'unknown';
}

/**
 * `'unknown'` on the server and for the hydrating paint, then `'supported'` or
 * `'unsupported'`. Callers should treat `'unknown'` as "not yet" rather than as
 * a failure — mounting a <Canvas> without a context throws.
 */
export function useWebGL(): WebGLSupport {
  return useSyncExternalStore(subscribeNever, webglSnapshot, webglServerSnapshot);
}

/* -------------------------------------------------------------------------- */
/* Reduced motion                                                              */
/* -------------------------------------------------------------------------- */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function motionQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : null;
}

function subscribeMotion(onChange: () => void): () => void {
  const query = motionQuery();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function motionSnapshot(): boolean {
  return motionQuery()?.matches ?? false;
}

function motionServerSnapshot(): boolean {
  return false;
}

/** True once the viewer has asked for reduced motion. False during SSR. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, motionSnapshot, motionServerSnapshot);
}
