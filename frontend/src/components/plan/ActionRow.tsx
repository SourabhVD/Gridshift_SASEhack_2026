'use client';

/**
 * One row of the recommended action plan.
 *
 * Presentational only: the decision handlers and the in-flight flag are owned by
 * <ActionPlan>, which is the single place that talks to the store.
 *
 * The 36px icon tile became a 7px dot in the channel's own colour -- the same
 * key the 3D stage uses, so a row and the conduit it controls are visibly the
 * same object. Approve is the accent, never green: green on this page means the
 * grid came in under threshold, and a green button in the same viewport as a
 * green grid line taught people the wrong lesson.
 */

import clsx from 'clsx';
import { Check, ChevronRight, LoaderCircle, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatHour, formatKw, formatUsd } from '@/lib/format';
import type { Action, ActionType } from '@/types/api';

export type Decision = 'approve' | 'reject';

/** The channel each action acts on, in the palette's own colours. */
const TYPE_DOT: Record<ActionType, string> = {
  battery_discharge: 'bg-battery',
  ev_charging_shift: 'bg-ev',
  hvac_setpoint: 'bg-hvac',
};

/** "90 kW", "+3 °F" -- `unit` is shown verbatim, the sign is only added to setpoints. */
function magnitudeLabel(action: Action): string {
  const signed =
    action.type === 'hvac_setpoint' && action.magnitude > 0
      ? `+${action.magnitude}`
      : `${action.magnitude}`;
  return `${signed} ${action.unit}`;
}

function metaParts(action: Action): string[] {
  const parts = [
    `${formatHour(action.start_time)}–${formatHour(action.end_time)}`,
    magnitudeLabel(action),
    `−${formatKw(action.estimated_peak_reduction_kw)} at peak`,
  ];
  if (action.estimated_savings_usd > 0) {
    parts.push(`${formatUsd(action.estimated_savings_usd)} saved`);
  }
  return parts;
}

function StatusBadge({ status }: { status: Action['status'] }) {
  if (status === 'approved') {
    return (
      <Badge tone="good">
        <Check className="h-3 w-3" />
        Approved
      </Badge>
    );
  }
  if (status === 'rejected') return <Badge tone="neutral">Rejected</Badge>;
  return <Badge tone="info">Executed</Badge>;
}

export interface ActionRowProps {
  action: Action;
  /** Which of this row's buttons is waiting on the server, if any. */
  busy: Decision | null;
  /** True while any decision on this row (or a bulk run) is in flight. */
  disabled: boolean;
  onDecide: (actionId: string, decision: Decision) => void;
}

export function ActionRow({ action, busy, disabled, onDecide }: ActionRowProps) {
  const pending = action.status === 'pending';

  return (
    <li
      className={clsx(
        'flex flex-col gap-3 border-t border-line py-4',
        'transition-colors duration-[var(--dur)] ease-[var(--ease)] hover:bg-surface-2/40',
        'sm:flex-row sm:items-start sm:gap-4',
      )}
    >
      <span
        className={clsx(
          'mt-2 h-[7px] w-[7px] shrink-0 rounded-full',
          TYPE_DOT[action.type],
        )}
        aria-hidden="true"
      />

      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium text-ink">{action.title}</h3>
        <p className="mt-1 text-[13px] text-ink-2">{action.description}</p>

        <p className="mt-2 text-xs text-muted tabular-nums">
          {metaParts(action).join(' · ')}
        </p>

        {action.constraints_checked.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {action.constraints_checked.map((constraint) => (
              <li
                key={constraint}
                className="inline-flex items-center gap-1 text-[11px] text-muted"
              >
                <ShieldCheck className="h-3 w-3 text-good" aria-hidden="true" />
                {constraint}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:pt-0.5">
        {pending ? (
          <>
            <Button
              variant="primary"
              size="sm"
              aria-label={`Approve: ${action.title}`}
              onClick={() => onDecide(action.id, 'approve')}
              disabled={disabled}
              icon={
                busy === 'approve' ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : undefined
              }
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Reject: ${action.title}`}
              onClick={() => onDecide(action.id, 'reject')}
              disabled={disabled}
              icon={
                busy === 'reject' ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : undefined
              }
            >
              Reject
            </Button>
          </>
        ) : (
          <>
            <StatusBadge status={action.status} />
            <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
          </>
        )}
      </div>
    </li>
  );
}

export default ActionRow;
