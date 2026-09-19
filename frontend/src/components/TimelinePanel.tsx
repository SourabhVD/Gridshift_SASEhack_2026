'use client';

/**
 * TimelinePanel -- store-connected wrapper around the 24-hour TimeScrubber.
 *
 * Sits directly under the demand chart. Playback ticking lives in the store;
 * this component only maps store state to the scrubber's controlled props.
 */

import { useMemo } from 'react';

import TimeScrubber from '@/components/timeline/TimeScrubber';
import { useGridShift } from '@/lib/store';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function TimelinePanel() {
  const {
    forecast,
    building,
    plan,
    viewHour,
    nowHour,
    isPlaying,
    viewMode,
    setViewHour,
    togglePlay,
    setViewMode,
    flowsAt,
  } = useGridShift();

  const peakHours = useMemo(
    () =>
      forecast
        ? forecast.points.flatMap((p, index) => (p.is_peak ? [index] : []))
        : [],
    [forecast],
  );

  const loadByHour = useMemo(
    () => HOURS.map((h) => flowsAt(h)?.grid_kw ?? 0),
    [flowsAt],
  );

  const thresholdKw =
    forecast?.peak_threshold_kw ?? building?.peak_threshold_kw ?? 0;

  if (!forecast) {
    return (
      <div className="border-y border-line-2 py-3" aria-hidden="true">
        <div className="h-[52px] animate-pulse rounded bg-surface-2" />
      </div>
    );
  }

  return (
    <TimeScrubber
      hour={viewHour}
      nowHour={nowHour}
      isPlaying={isPlaying}
      mode={viewMode}
      canToggleMode={plan != null}
      peakHours={peakHours}
      loadByHour={loadByHour}
      thresholdKw={thresholdKw}
      onHourChange={setViewHour}
      onTogglePlay={togglePlay}
      onModeChange={setViewMode}
    />
  );
}

export default TimelinePanel;
