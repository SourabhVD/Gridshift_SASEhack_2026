'use client';

/**
 * Recommended actions -- the human-in-the-loop panel.
 *
 * Reads plan / runStatus / error from useGridShift() and calls approve(id) and
 * reject(id); the store swaps in the server's recomputed plan, so every row
 * re-renders from `plan` rather than from local optimistic state. The only local
 * state here is the set of decisions currently in flight, which drives the
 * per-button spinners.
 *
 * NOTE: action.estimated_peak_reduction_kw is the per-action impact during the
 * BASELINE peak interval; those values deliberately do not sum to
 * plan.peak_reduction_kw, so no total of them is ever displayed.
 */

import { useCallback, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { CircleAlert, ClipboardList } from 'lucide-react';
import { ActionRow, type Decision } from '@/components/plan/ActionRow';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatKw, formatUsd } from '@/lib/format';
import { useGridShift } from '@/lib/store';
import type {
  ActionPlan as ActionPlanData,
  ForecastResponse,
  RunStatus,
} from '@/types/api';

const ARROW = '→';
const MINUS = '−';
const DOT = '·';

function planBadge(status: RunStatus): ReactNode {
  switch (status) {
    case 'awaiting_approval':
      return <Badge tone="warn">Awaiting approval</Badge>;
    case 'approved':
      return <Badge tone="good">Approved</Badge>;
    case 'rejected':
      return <Badge tone="neutral">Rejected</Badge>;
    default:
      return null;
  }
}

function Stat({
  label,
  value,
  foot,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <div className="rounded-md bg-surface-2 p-3">
      <p className="text-[11px] tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-1 text-sm font-medium text-ink tabular-nums">{value}</p>
      {foot && <div className="mt-1.5">{foot}</div>}
    </div>
  );
}

function ThresholdFoot({
  optimizedPeakKw,
  thresholdKw,
}: {
  optimizedPeakKw: number;
  thresholdKw: number | null;
}) {
  if (thresholdKw === null) return null;
  return optimizedPeakKw < thresholdKw ? (
    <Badge tone="good">Under threshold</Badge>
  ) : (
    <Badge tone="alert">Still over</Badge>
  );
}

function HeadlineStrip({
  plan,
  forecast,
}: {
  plan: ActionPlanData;
  forecast: ForecastResponse | null;
}) {
  const thresholdKw = forecast?.peak_threshold_kw ?? null;
  const approved = plan.actions.filter(
    (a) => a.status === 'approved' || a.status === 'executed',
  ).length;

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <Stat
        label="Peak"
        value={[
          plan.baseline_peak_kw.toFixed(0),
          ARROW,
          formatKw(plan.optimized_peak_kw),
        ].join(' ')}
        foot={
          <span className="text-xs font-medium text-good tabular-nums">
            {MINUS}
            {formatKw(plan.peak_reduction_kw)}
          </span>
        }
      />
      <Stat
        label="Daily energy cost"
        value={[
          formatUsd(plan.baseline_cost_usd),
          ARROW,
          formatUsd(plan.optimized_cost_usd),
        ].join(' ')}
        foot={
          <span className="text-xs font-medium text-good tabular-nums">
            {MINUS}
            {formatUsd(plan.savings_usd)}
          </span>
        }
      />
      <Stat
        label="Threshold"
        value={thresholdKw === null ? '—' : formatKw(thresholdKw)}
        foot={
          <ThresholdFoot
            optimizedPeakKw={plan.optimized_peak_kw}
            thresholdKw={thresholdKw}
          />
        }
      />
      <Stat
        label="Actions"
        value={approved + '/' + plan.actions.length + ' approved'}
      />
    </div>
  );
}

function Rationale({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-4">
      <p
        className={clsx(
          'border-l-2 border-forecast pl-3 text-sm text-muted',
          !expanded && 'line-clamp-3',
        )}
      >
        {text}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="mt-1.5 ml-3 text-xs font-medium text-forecast transition hover:brightness-110"
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}

function PlanSkeleton() {
  return (
    <div>
      <p className="text-sm text-muted">Waiting for optimizer{'…'}</p>
      <div className="mt-4 space-y-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex animate-pulse gap-4 rounded-md border border-line p-4"
            aria-hidden="true"
          >
            <div className="h-9 w-9 shrink-0 rounded-md bg-surface-2" />
            <div className="flex-1 space-y-2 py-0.5">
              <div className="h-3 w-2/5 rounded bg-surface-2" />
              <div className="h-3 w-4/5 rounded bg-surface-2" />
              <div className="h-3 w-1/3 rounded bg-surface-2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-center">
      <ClipboardList className="h-6 w-6 text-muted" aria-hidden="true" />
      <p className="text-sm text-muted">No plan yet. Run GridShift to generate one.</p>
    </div>
  );
}

export function ActionPlan() {
  const { plan, forecast, runStatus, error, approve, reject } = useGridShift();
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());

  const runDecision = useCallback(
    async (actionId: string, decision: Decision) => {
      const key = actionId + ':' + decision;
      setInFlight((prev) => new Set(prev).add(key));
      try {
        await (decision === 'approve' ? approve(actionId) : reject(actionId));
      } finally {
        setInFlight((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [approve, reject],
  );

  const runBulk = useCallback(
    async (actionIds: string[], decision: Decision) => {
      for (const actionId of actionIds) {
        await runDecision(actionId, decision);
      }
    },
    [runDecision],
  );

  const busyDecision = (actionId: string): Decision | null => {
    if (inFlight.has(actionId + ':approve')) return 'approve';
    if (inFlight.has(actionId + ':reject')) return 'reject';
    return null;
  };

  const anyInFlight = inFlight.size > 0;
  const pendingIds = plan
    ? plan.actions.filter((a) => a.status === 'pending').map((a) => a.id)
    : [];

  return (
    <Card
      title="Recommended actions"
      subtitle={'Optimizer output ' + DOT + ' requires approval'}
      right={planBadge(plan?.status ?? runStatus)}
      className="min-h-[300px]"
    >
      {plan === null ? (
        runStatus === 'running' ? (
          <PlanSkeleton />
        ) : (
          <EmptyState />
        )
      ) : (
        <div>
          <HeadlineStrip plan={plan} forecast={forecast} />

          {error && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-alert">
              <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}

          <Rationale text={plan.summary} />

          <ul className="mt-4 space-y-3">
            {plan.actions.map((action) => (
              <ActionRow
                key={action.id}
                action={action}
                busy={busyDecision(action.id)}
                disabled={anyInFlight}
                onDecide={(id, decision) => void runDecision(id, decision)}
              />
            ))}
          </ul>

          {pendingIds.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <span className="text-xs text-muted tabular-nums">
                {pendingIds.length} pending
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Approve all pending actions"
                  onClick={() => void runBulk(pendingIds, 'approve')}
                  disabled={anyInFlight}
                  className="rounded-md bg-good px-3 py-1.5 text-xs font-medium text-[color:var(--color-base)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Approve all
                </button>
                <button
                  type="button"
                  aria-label="Reject all pending actions"
                  onClick={() => void runBulk(pendingIds, 'reject')}
                  disabled={anyInFlight}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Reject all
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export default ActionPlan;
