'use client';

/**
 * Which real metered day the dashboard is showing.
 *
 * Only renders when the backend actually has more than one, so a demo running
 * on authored curves, or on a single backtested day, shows nothing rather than
 * a control with one entry in it -- which would advertise the limitation
 * instead of hiding it.
 *
 * Changing the day clears any run in progress. A plan belongs to the day it
 * was solved for; leaving one on screen beside a different day's chart is the
 * exact mismatch the backend was fixed to prevent.
 */

import { useGridShift } from '@/lib/store';

export function DayPicker() {
  const { backtestDates, selectedDate, selectDate, isLoading, runStatus } = useGridShift();

  if (backtestDates.length < 2) return null;

  const busy = isLoading || runStatus === 'running';

  return (
    <label className="flex items-center gap-2 text-[11px] tracking-[0.09em] text-muted uppercase">
      <span className="hidden sm:inline">Day</span>
      <select
        aria-label="Metered day to plan"
        value={selectedDate || backtestDates[backtestDates.length - 1]}
        disabled={busy}
        onChange={(event) => void selectDate(event.target.value)}
        className={[
          'rounded-full bg-surface-2 px-3 py-1',
          'text-[12px] tracking-normal text-ink normal-case tabular-nums',
          'outline-none focus-visible:outline-2 focus-visible:outline-accent',
          busy ? 'cursor-wait opacity-50' : 'cursor-pointer hover:brightness-125',
        ].join(' ')}
      >
        {backtestDates.map((date) => (
          <option key={date} value={date}>
            {date}
          </option>
        ))}
      </select>
    </label>
  );
}

export default DayPicker;
