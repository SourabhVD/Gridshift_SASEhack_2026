'use client';

/**
 * PeakAlert -- the one call to action on the dashboard.
 *
 * Rendered only when the forecast actually contains a peak interval; otherwise
 * it returns null rather than an empty card. The right-hand slot is driven
 * entirely by runStatus, so the banner is the single place a facility manager
 * watches an agent run from start to decision.
 */

import clsx from 'clsx';
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { formatHour, formatKw } from '@/lib/format';
import { useGridShift } from '@/lib/store';

const PRIMARY_BUTTON = [
  'inline-flex items-center gap-2 rounded-md px-4 py-2',
  'text-sm font-semibold tracking-wide',
  'bg-forecast text-[color:var(--color-base)]',
  'transition hover:brightness-110',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forecast',
  'disabled:cursor-not-allowed disabled:brightness-100',
].join(' ');

const LINK_BUTTON = [
  'inline-flex items-center gap-1.5 text-xs font-medium text-muted',
  'underline-offset-4 transition-colors hover:text-ink hover:underline',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forecast',
].join(' ');

export function PeakAlert() {
  const { summary, forecast, runStatus, events, plan, error, startRun, reset } =
    useGridShift();

  if (!forecast) return null;

  const peaks = forecast.points.filter((p) => p.is_peak);
  if (peaks.length === 0) return null;

  const threshold = forecast.peak_threshold_kw;
  const peakPoint = peaks.reduce((hi, p) =>
    p.predicted_load_kw > hi.predicted_load_kw ? p : hi,
  );
  const peakKw = Math.max(peakPoint.predicted_load_kw, summary?.predicted_peak_kw ?? 0);
  const firstHour = formatHour(peaks[0].timestamp);
  const lastHour = formatHour(peaks[peaks.length - 1].timestamp);

  const isApproved = runStatus === 'approved';

  /** "Run again" -- the demo reset has to land before a new run is started. */
  async function runAgain() {
    await reset();
    await startRun();
  }

  return (
    <div
      className={clsx(
        'flex flex-col gap-4 rounded-xl border px-5 py-4',
        'sm:flex-row sm:items-center sm:justify-between',
        isApproved ? 'border-good/30 bg-good/10' : 'border-alert/30 bg-alert/10',
      )}
    >
      {/* ---------------------------------------------------------- headline */}
      <div className="flex min-w-0 items-start gap-3">
        <AlertTriangle
          className={clsx('mt-0.5 h-5 w-5 shrink-0', isApproved ? 'text-good' : 'text-alert')}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">
            {`Peak demand forecast: ${formatKw(peakKw)} at ${formatHour(
              peakPoint.timestamp,
            )}`}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {`${peaks.length} ${peaks.length === 1 ? 'hour' : 'hours'} above the ${formatKw(
              threshold,
            )} threshold (${firstHour}–${lastHour})`}
          </p>
          {error && runStatus !== 'failed' && (
            <p className="mt-1 text-xs text-alert">{error}</p>
          )}
        </div>
      </div>

      {/* --------------------------------------------------------------- CTA */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end">
        {runStatus === 'idle' && (
          <button type="button" onClick={() => void startRun()} className={PRIMARY_BUTTON}>
            Run GridShift
          </button>
        )}

        {runStatus === 'running' && (
          <button type="button" disabled className={PRIMARY_BUTTON}>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {`Agent investigating… ${events.length} steps`}
          </button>
        )}

        {runStatus === 'awaiting_approval' && (
          <>
            <Badge tone="warn" dot>
              Plan ready · awaiting approval
            </Badge>
            <button type="button" onClick={() => void runAgain()} className={LINK_BUTTON}>
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Run again
            </button>
          </>
        )}

        {isApproved && (
          <Badge tone="good">
            {plan
              ? `Plan approved · peak reduced to ${formatKw(plan.optimized_peak_kw)}`
              : 'Plan approved'}
          </Badge>
        )}

        {runStatus === 'rejected' && (
          <>
            <Badge tone="neutral">Plan rejected</Badge>
            <button type="button" onClick={() => void runAgain()} className={LINK_BUTTON}>
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Run again
            </button>
          </>
        )}

        {runStatus === 'failed' && (
          <>
            <Badge tone="alert" className="max-w-[24rem] overflow-hidden text-ellipsis">
              {error ?? 'Agent run failed'}
            </Badge>
            <button type="button" onClick={() => void startRun()} className={PRIMARY_BUTTON}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default PeakAlert;
