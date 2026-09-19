'use client';

/**
 * PeakAlert -- the one call to action on the dashboard.
 *
 * Rendered only when the forecast actually contains a peak interval; otherwise
 * it returns null rather than an empty row. The right-hand slot is driven
 * entirely by runStatus, so the banner is the single place a facility manager
 * watches an agent run from start to decision.
 *
 * The tinted panel is gone. It was alerting twice -- a red wash AND a red
 * border around text that already says 522. On black, one red dot and one red
 * number is louder than both, and the row sits on the same rhythm as everything
 * else on the page. Run GridShift is the only accent object in this region.
 */

import clsx from 'clsx';
import { Loader2, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatHour, formatKw } from '@/lib/format';
import { useGridShift } from '@/lib/store';

export function PeakAlert() {
  const { summary, forecast, runStatus, events, plan, error, isLoading, startRun, reset } =
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
        'flex flex-col gap-4 border-y border-line-2 py-4',
        'sm:flex-row sm:items-center sm:justify-between sm:gap-6',
      )}
    >
      {/* ---------------------------------------------------------- headline */}
      <div className="flex min-w-0 items-start gap-3.5">
        <span
          aria-hidden="true"
          className={clsx(
            'mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full',
            isApproved
              ? 'bg-good shadow-[0_0_0_4px_rgba(90,229,150,0.14)]'
              : 'bg-alert shadow-[0_0_0_4px_rgba(255,90,82,0.14)]',
          )}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            Peak demand forecast{' '}
            <span
              className={clsx(
                'tabular-nums',
                isApproved ? 'text-good' : 'text-alert',
              )}
            >
              {formatKw(peakKw)}
            </span>{' '}
            {`at ${formatHour(peakPoint.timestamp)}`}
          </p>
          <p className="mt-1 text-xs text-muted tabular-nums">
            {`${peaks.length} ${peaks.length === 1 ? 'hour' : 'hours'} above the ${formatKw(
              threshold,
            )} threshold · ${firstHour}–${lastHour}`}
          </p>
          {error && runStatus !== 'failed' && (
            <p className="mt-1 text-xs text-alert">{error}</p>
          )}
        </div>
      </div>

      {/* --------------------------------------------------------------- CTA */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end">
        {runStatus === 'idle' && (
          <Button
            variant="primary"
            onClick={() => void startRun()}
            disabled={isLoading}
            icon={
              isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : undefined
            }
          >
            Run GridShift
          </Button>
        )}

        {runStatus === 'running' && (
          <Button
            variant="primary"
            disabled
            icon={<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          >
            {`Agent investigating… ${events.length} steps`}
          </Button>
        )}

        {runStatus === 'awaiting_approval' && (
          <>
            <Badge tone="warn" dot>
              Plan ready · awaiting approval
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void runAgain()}
              icon={<RotateCcw className="h-3 w-3" aria-hidden="true" />}
            >
              Run again
            </Button>
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void runAgain()}
              icon={<RotateCcw className="h-3 w-3" aria-hidden="true" />}
            >
              Run again
            </Button>
          </>
        )}

        {runStatus === 'failed' && (
          <>
            <Badge tone="alert" className="max-w-[24rem] overflow-hidden text-ellipsis">
              {error ?? 'Agent run failed'}
            </Badge>
            <Button
              variant="primary"
              onClick={() => void startRun()}
              icon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}
            >
              Retry
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export default PeakAlert;
