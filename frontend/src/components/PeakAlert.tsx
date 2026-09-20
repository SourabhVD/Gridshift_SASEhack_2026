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
 *
 * The one piece of motion in here is the approve moment: when the plan is
 * approved the dot and the peak figure crossfade alert -> good over --dur, on
 * the shared ease, rather than cutting. Colour only, so the row cannot shift.
 *
 * At portfolio level it says the same kind of thing about the campus -- how
 * many sites cross their own cap, and when the worst of it is -- and has no
 * call to action at all, because a run belongs to one site and picking which
 * one is a decision the row cannot make for you.
 */

import clsx from 'clsx';
import { useMemo } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatHour, formatHourIndex, formatKw } from '@/lib/format';
import { isCommitted, useGridShift } from '@/lib/store';

export function PeakAlert() {
  const {
    summary,
    forecast,
    runStatus,
    events,
    plan,
    error,
    isLoading,
    startRun,
    reset,
    level,
  } = useGridShift();

  if (level === 'portfolio') return <PortfolioAlert />;

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
            'transition-[background-color,box-shadow] duration-[var(--dur)] ease-[var(--ease)]',
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
                'transition-colors duration-[var(--dur)] ease-[var(--ease)]',
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

/* -------------------------------------------------------------------------- */
/* Portfolio                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The campus version of the same row.
 *
 * "Today" is the whole 24 hours, not the hour on the scrubber: a site that only
 * crosses its cap at 17:00 still crosses it. The worst hour is the one with the
 * most kW over the caps summed, which is the hour somebody would actually go
 * and look at -- not necessarily the hour of the biggest portfolio draw.
 *
 * No Run button. A run is per site, and offering one here would have to choose
 * a site on the viewer's behalf.
 */
function PortfolioAlert() {
  const { buildings, portfolioAt, sites } = useGridShift();

  const worst = useMemo(() => {
    const offenders = new Set<string>();
    let hour = -1;
    let overKw = 0;
    let count = 0;

    for (let h = 0; h < 24; h += 1) {
      const reading = portfolioAt(h);
      let hourOver = 0;
      for (const site of reading.per_site) {
        if (!site.over) continue;
        offenders.add(site.id);
        hourOver += site.grid_kw - site.threshold;
      }
      if (hourOver > overKw) {
        overKw = hourOver;
        hour = h;
        count = reading.sites_over_cap.length;
      }
    }

    // A site whose plan has been approved is running that plan; portfolioAt
    // already reads its committed curve, so it drops out of `offenders` on
    // its own. It is still worth naming, because "one site left" is only
    // reassuring next to "three dealt with".
    const resolved = buildings
      .map((b) => b.id)
      .filter((id) => isCommitted(sites[id]) && !offenders.has(id));

    return { offenders: [...offenders], resolved, hour, overKw, count };
  }, [portfolioAt, buildings, sites]);

  const resolvedNames = worst.resolved
    .map((id) => buildings.find((b) => b.id === id)?.name ?? id)
    .join(' · ');

  // Every site is running an approved plan and none of them crosses a cap.
  if (worst.offenders.length === 0 && worst.resolved.length > 0) {
    return (
      <div
        className={clsx(
          'flex flex-col gap-4 border-y border-line-2 py-4',
          'sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        )}
      >
        <div className="flex min-w-0 items-start gap-3.5">
          <span
            aria-hidden="true"
            className="mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full bg-good shadow-[0_0_0_4px_rgba(60,200,140,0.14)]"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              <span className="tabular-nums text-good">{worst.resolved.length}</span>
              {` of ${buildings.length} sites on approved plans · none over cap`}
            </p>
            <p className="mt-1 truncate text-xs text-muted">{resolvedNames}</p>
          </div>
        </div>
      </div>
    );
  }

  if (worst.offenders.length === 0 || worst.hour < 0) return null;

  const names = worst.offenders
    .map((id) => buildings.find((b) => b.id === id)?.name ?? id)
    .join(' · ');

  return (
    <div
      className={clsx(
        'flex flex-col gap-4 border-y border-line-2 py-4',
        'sm:flex-row sm:items-center sm:justify-between sm:gap-6',
      )}
    >
      <div className="flex min-w-0 items-start gap-3.5">
        <span
          aria-hidden="true"
          className="mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full bg-alert shadow-[0_0_0_4px_rgba(255,90,82,0.14)]"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            <span className="tabular-nums text-alert">{worst.offenders.length}</span>
            {` of ${buildings.length} sites ${
              worst.resolved.length > 0 ? 'still exceed' : 'exceed'
            } their cap today`}
            {worst.resolved.length > 0 && (
              <span className="text-good">
                {` · ${worst.resolved.length} on approved plans`}
              </span>
            )}
          </p>
          <p className="mt-1 truncate text-xs text-muted tabular-nums">
            {`Worst at ${formatHourIndex(worst.hour)} · ${worst.count} over at once · +${formatKw(
              worst.overKw,
            )} above the caps · ${names}`}
          </p>
        </div>
      </div>

      <p className="shrink-0 text-xs text-muted sm:text-right">
        Open a site to run GridShift on it.
      </p>
    </div>
  );
}

export default PeakAlert;
