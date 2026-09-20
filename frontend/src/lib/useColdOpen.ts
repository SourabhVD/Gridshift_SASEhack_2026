'use client';

/**
 * useColdOpen -- the page plays the day to itself, once, before anyone touches
 * the laptop.
 *
 * Roughly a second after the entrance stagger has settled the scrubber walks
 * 00:00 -> the baseline peak hour over 2.4s and stops there, so the dashboard
 * opens *on the problem* rather than on an arbitrary "now". It is a first
 * impression, not a feature: it happens at most once per browser session and
 * gets out of the way the instant a human does anything.
 *
 * It never runs when:
 *   - the app is talking to a real backend. This is a demo flourish: against
 *     live data an unattended dashboard that scrubs itself away from "now" is a
 *     bug, so it is gated on `isMock`;
 *   - this session has already played it (sessionStorage latch, which is also
 *     why switching building does not replay it -- the store remounts the grid,
 *     not the tab);
 *   - there is no summary/forecast yet, or the summary has no peak time (the
 *     2D-fallback-without-forecast case has nothing to scrub through);
 *   - `prefers-reduced-motion: reduce` is set. The page still opens on the peak
 *     hour; it just does not travel there.
 *
 * Cancellation is a pointerdown or keydown anywhere, captured so the scrubber's
 * own handler still wins the same gesture: the autoplay stops, the hour snaps to
 * the peak, and whatever the viewer did lands on top of that.
 */

import { useEffect, useRef } from 'react';

import { hourFromIso } from '@/lib/format';
import { useGridShift } from '@/lib/store';

/** Delay after mount, so the load stagger is finished before anything moves. */
export const COLD_OPEN_DELAY_MS = 900;

/** Travel time for the whole 00:00 -> peak scrub. */
export const COLD_OPEN_SCRUB_MS = 2400;

/** One latch per tab. Not localStorage: a reload is a new demo. */
export const COLD_OPEN_SESSION_KEY = 'gridshift.coldOpenPlayed';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** sessionStorage throws in some privacy modes; a failed read just replays it. */
function hasPlayed(): boolean {
  try {
    return window.sessionStorage.getItem(COLD_OPEN_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markPlayed(): void {
  try {
    window.sessionStorage.setItem(COLD_OPEN_SESSION_KEY, '1');
  } catch {
    /* storage disabled; the latch below still holds for this page load */
  }
}

/**
 * Mount once, near the top of the page. Returns nothing: everything it does it
 * does through the store's own cursor, so the scrubber, the scene, the KPI row
 * and the chart marker all travel together for free.
 */
export function useColdOpen(): void {
  const { summary, forecast, isMock, playTo, setViewHour, pause } = useGridShift();

  /** Belt and braces beside the session latch: never arm twice in one mount. */
  const armedRef = useRef(false);

  const peakHour = summary ? hourFromIso(summary.predicted_peak_time) : null;
  const hasForecast = forecast != null && forecast.points.length > 0;

  useEffect(() => {
    if (armedRef.current) return;
    if (!isMock) return;
    if (peakHour === null || !hasForecast) return;
    if (hasPlayed()) return;

    armedRef.current = true;
    markPlayed();

    // The recolour carries information; the travel does not. Under reduced
    // motion we keep the destination and drop the journey.
    if (prefersReducedMotion()) {
      setViewHour(peakHour);
      return;
    }

    const cancel = () => {
      pause();
      setViewHour(peakHour);
    };
    // Capture: this fires before the scrubber's own pointerdown, so a viewer who
    // grabs the playhead mid-scrub ends up where they clicked, not at the peak.
    const options: AddEventListenerOptions = { once: true, capture: true };
    window.addEventListener('pointerdown', cancel, options);
    window.addEventListener('keydown', cancel, options);

    const timer = window.setTimeout(() => {
      playTo(peakHour, COLD_OPEN_SCRUB_MS);
    }, COLD_OPEN_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', cancel, options);
      window.removeEventListener('keydown', cancel, options);
    };
  }, [isMock, peakHour, hasForecast, playTo, setViewHour, pause]);
}

export default useColdOpen;
