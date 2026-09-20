'use client';

/**
 * useCountUp -- eases a displayed number from its previous committed value to
 * the next one.
 *
 * Deliberately small and local: the animation runs inside whichever leaf
 * component calls it, driven by requestAnimationFrame and component state, so a
 * ticking KPI never re-renders the store or the chart beside it.
 *
 * Three rules from the motion study are baked in:
 *   - it never animates on first mount (the page already has a load stagger);
 *   - it always reaches the target, even where requestAnimationFrame is
 *     starved and no frame is ever painted;
 *   - it never animates under `prefers-reduced-motion: reduce`;
 *   - it snaps, rather than eases, whenever `snapKey` changes. That is how the
 *     scrubber is kept 1:1 -- pass the viewed hour as the snap key and dragging
 *     the playhead updates the number instantly, while a plan being approved at
 *     the same hour still counts.
 *
 * Returns a raw number; format it at the call site so @/lib/format stays the
 * single source of truth for rounding.
 */

import { useEffect, useRef, useState } from 'react';

export interface UseCountUpOptions {
  /** Total easing time in ms. 400 is the motion study's value for KPIs. */
  duration?: number;
  /**
   * Changing this jumps straight to the new value instead of easing it.
   * Use it for values that follow a direct-manipulation control.
   */
  snapKey?: string | number;
  /** Below this fractional delta the change is not worth animating. */
  minDelta?: number;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** ease-out cubic: fast start, settles without overshoot. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function useCountUp(value: number, options: UseCountUpOptions = {}): number {
  const { duration = 400, snapKey, minDelta = 0.01 } = options;

  const [display, setDisplay] = useState(value);

  /** The value the next animation starts from. */
  const fromRef = useRef(value);
  const frameRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const snapKeyRef = useRef(snapKey);

  useEffect(() => {
    const snap = (next: number) => {
      fromRef.current = next;
      setDisplay(next);
    };

    const snapKeyChanged = snapKeyRef.current !== snapKey;
    snapKeyRef.current = snapKey;

    if (!mountedRef.current) {
      mountedRef.current = true;
      snap(value);
      return;
    }

    const from = fromRef.current;
    const scale = Math.max(Math.abs(from), Math.abs(value), 1);
    const tooSmall = Math.abs(value - from) / scale < minDelta;

    if (
      snapKeyChanged ||
      tooSmall ||
      duration <= 0 ||
      !Number.isFinite(value) ||
      !Number.isFinite(from) ||
      prefersReducedMotion()
    ) {
      snap(value);
      return;
    }

    const start = performance.now();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      frameRef.current = null;
      snap(value);
    };

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      if (t >= 1) {
        finish();
        return;
      }
      // Track the frame we actually painted, so an interrupted run resumes
      // from what the viewer last saw rather than jumping to the old target.
      const current = from + (value - from) * easeOut(t);
      fromRef.current = current;
      setDisplay(current);
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);

    // requestAnimationFrame only fires when the compositor is painting. An
    // occluded window, a throttled background tab and some mirrored displays
    // all starve it while `document.visibilityState` still reads "visible",
    // so there is nothing to feature-detect. Without a floor the animation
    // simply never advances, and because the effect re-runs only when the
    // value changes again, the number stays frozen wherever it started: the
    // dashboard showed "0 kW optimized" against a 360 kW plan, indefinitely.
    // Landing late on the right number beats easing to the wrong one.
    const floor = setTimeout(finish, duration + 120);

    return () => {
      clearTimeout(floor);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [value, duration, snapKey, minDelta]);

  return display;
}

export default useCountUp;
