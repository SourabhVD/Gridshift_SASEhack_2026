'use client';

/**
 * One row of the recommended action plan.
 *
 * Presentational only: the decision handlers and the in-flight flag are owned by
 * <ActionPlan>, which is the single place that talks to the store.
 */

import clsx from 'clsx';
import {
  BatteryCharging,
  Car,
  Check,
  LoaderCircle,
  ShieldCheck,
  Thermometer,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { formatHour, formatKw, formatUsd } from '@/lib/format';
import type { Action, ActionType } from '@/types/api';

export type Decision = 'approve' | 'reject';

const TYPE_STYLE: Record<ActionType, { Icon: LucideIcon; tile: string }> = {
  battery_discharge: { Icon: BatteryCharging, tile: 'bg-battery/10 text-battery' },
  ev_charging_shift: { Icon: Car, tile: 'bg-forecast/10 text-forecast' },
  hvac_setpoint: { Icon: Thermometer, tile: 'bg-peak/10 text-peak' },
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
    `${formatHour(action.start_time)}\u2013${formatHour(action.end_time)}`,
    magnitudeLabel(action),
    `\u2212${formatKw(action.estimated_peak_reduction_kw)} at peak`,
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
  const { Icon, tile } = TYPE_STYLE[action.type];
  const pending = action.status === 'pending';

  return (
    <li className="rounded-md border border-line p-4 transition-colors hover:bg-surface-2/60">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
            tile,
          )}
          aria-hidden="true"
        >
          <Icon className="h-4.5 w-4.5" />
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-ink">{action.title}</h3>
          <p className="mt-1 text-sm text-muted">{action.description}</p>

          <p className="mt-2 text-xs text-muted tabular-nums">
            {metaParts(action).join(' \u00b7 ')}
          </p>

          {action.constraints_checked.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {action.constraints_checked.map((constraint) => (
                <li
                  key={constraint}
                  className="inline-flex items-center gap-1 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted"
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
              <button
                type="button"
                aria-label={`Approve: ${action.title}`}
                onClick={() => onDecide(action.id, 'approve')}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-md bg-good px-3 py-1.5 text-xs font-medium text-[color:var(--color-base)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === 'approve' && (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                )}
                Approve
              </button>
              <button
                type="button"
                aria-label={`Reject: ${action.title}`}
                onClick={() => onDecide(action.id, 'reject')}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-muted transition hover:border-alert/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === 'reject' && (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                )}
                Reject
              </button>
            </>
          ) : (
            <StatusBadge status={action.status} />
          )}
        </div>
      </div>
    </li>
  );
}

export default ActionRow;
